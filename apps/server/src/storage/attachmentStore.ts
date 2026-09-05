import { createHash, randomBytes } from 'node:crypto';
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  statSync,
  type WriteStream,
} from 'node:fs';
import { rename, rm, unlink } from 'node:fs/promises';
import { isAbsolute, join, resolve, sep } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/** 单个附件的默认体积上限（25 MiB）。超限直接拒收，避免一封邮件撑爆磁盘。 */
export const DEFAULT_MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

const SHA256_RE = /^[0-9a-f]{64}$/;

export class AttachmentStoreError extends Error {}
export class AttachmentTooLargeError extends AttachmentStoreError {}
export class AttachmentNotFoundError extends AttachmentStoreError {}

export interface AttachmentStoreOptions {
  /** 附件根目录，通常是 `<dataDir>/attachments`。 */
  root: string;
  maxBytes?: number;
}

export interface StoredBlob {
  sha256: string;
  size: number;
  /** true 表示这份内容之前已经存在，本次没有新写盘。 */
  deduped: boolean;
}

/**
 * 内容寻址的附件仓库：`<root>/<sha[0:2]>/<sha>`。
 *
 * - 二进制永远落盘，不进 SQLite——SQLite 里塞 blob 会让整库备份和 WAL 一起膨胀。
 * - 同一份内容（同一封转发邮件里的 logo、群发的同一个 PDF）天然只存一份。
 * - 路径只由 sha256 生成，且强制 `^[0-9a-f]{64}$`，
 *   调用方传进来的任何 `../` 在校验阶段就被拒，构造不出仓库外的路径。
 */
export class AttachmentStore {
  readonly root: string;
  readonly maxBytes: number;
  readonly #tmpDir: string;

  constructor({ root, maxBytes = DEFAULT_MAX_ATTACHMENT_BYTES }: AttachmentStoreOptions) {
    if (!root) throw new AttachmentStoreError('附件目录不能为空');
    if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
      throw new AttachmentStoreError(`附件体积上限必须是正整数，收到 ${maxBytes}`);
    }
    this.root = resolve(root);
    this.maxBytes = maxBytes;
    this.#tmpDir = join(this.root, 'tmp');
    mkdirSync(this.#tmpDir, { recursive: true });
  }

  /** 内容 -> 磁盘路径。非法 sha 直接抛，不做「尽力而为」。 */
  pathFor(sha256: string): string {
    const digest = assertSha256(sha256);
    const path = join(this.root, digest.slice(0, 2), digest);
    // 纵深防御：即便上面的正则将来被放宽，也不允许算出仓库外的路径
    if (!path.startsWith(this.root + sep)) {
      throw new AttachmentStoreError(`附件路径越界: ${sha256}`);
    }
    return path;
  }

  has(sha256: string): boolean {
    return existsSync(this.pathFor(sha256));
  }

  sizeOf(sha256: string): number | null {
    try {
      return statSync(this.pathFor(sha256)).size;
    } catch {
      return null;
    }
  }

  async putBuffer(bytes: Uint8Array): Promise<StoredBlob> {
    if (bytes.byteLength > this.maxBytes) {
      throw new AttachmentTooLargeError(
        `附件 ${bytes.byteLength} 字节，超过上限 ${this.maxBytes} 字节`,
      );
    }
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const target = this.pathFor(sha256);
    if (existsSync(target)) return { sha256, size: bytes.byteLength, deduped: true };

    const tmp = this.#tmpPath();
    const sink = createWriteStream(tmp);
    try {
      mkdirSync(join(this.root, sha256.slice(0, 2)), { recursive: true });
      await pipeline(async function* () {
        yield bytes;
      }, sink);
      await this.#commit(tmp, target);
    } finally {
      await discard(tmp, sink);
    }
    return { sha256, size: bytes.byteLength, deduped: false };
  }

  /**
   * 流式落盘：边写边算 sha256，写完才知道最终路径，所以先写临时文件再 rename。
   * rename 在同一文件系统内是原子的，读者永远看不到半截文件。
   */
  async putStream(source: Readable): Promise<StoredBlob> {
    const hash = createHash('sha256');
    const tmp = this.#tmpPath();
    const sink = createWriteStream(tmp);
    let size = 0;
    const maxBytes = this.maxBytes;

    try {
      await pipeline(source, async function* (chunks) {
        for await (const chunk of chunks) {
          const bytes = chunk as Uint8Array;
          size += bytes.byteLength;
          if (size > maxBytes) {
            throw new AttachmentTooLargeError(`附件超过上限 ${maxBytes} 字节，已中止下载`);
          }
          hash.update(bytes);
          yield bytes;
        }
      }, sink);

      const sha256 = hash.digest('hex');
      const target = this.pathFor(sha256);
      if (existsSync(target)) return { sha256, size, deduped: true };

      mkdirSync(join(this.root, sha256.slice(0, 2)), { recursive: true });
      await this.#commit(tmp, target);
      return { sha256, size, deduped: false };
    } finally {
      await discard(tmp, sink);
    }
  }

  createReadStream(sha256: string): Readable {
    const path = this.pathFor(sha256);
    if (!existsSync(path)) throw new AttachmentNotFoundError(`附件内容不存在: ${sha256}`);
    return createReadStream(path);
  }

  async readBuffer(sha256: string): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of this.createReadStream(sha256)) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks);
  }

  /** 只在确认没有任何 attachments 行引用该 sha 时调用。 */
  async remove(sha256: string): Promise<boolean> {
    const path = this.pathFor(sha256);
    if (!existsSync(path)) return false;
    await rm(path, { force: true });
    return true;
  }

  #tmpPath(): string {
    return join(this.#tmpDir, `${Date.now().toString(36)}-${randomBytes(8).toString('hex')}`);
  }

  /** rename 可能因并发下载同一份内容而失败，此时目标已存在，视为去重成功。 */
  async #commit(tmp: string, target: string): Promise<void> {
    try {
      await rename(tmp, target);
    } catch (error) {
      if (!existsSync(target)) throw error;
    }
  }
}

/** 校验并归一化 sha256；这是仓库唯一的路径来源，因此也是唯一的越界防线。 */
export function assertSha256(value: unknown): string {
  const digest = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!SHA256_RE.test(digest)) {
    throw new AttachmentStoreError(`非法的 sha256: ${String(value).slice(0, 80)}`);
  }
  return digest;
}

/**
 * 下载时对外暴露的文件名。
 * 磁盘路径不依赖它（内容寻址），这里只是防止 `Content-Disposition` 里出现
 * 路径分隔符、控制字符或 Windows 保留名。
 */
export function sanitizeFilename(name: string | null | undefined, fallback = 'attachment'): string {
  if (typeof name !== 'string') return fallback;
  const cleaned = name
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/[/\\]/g, '_')
    .replace(/^\.+/, '')
    .trim();
  if (!cleaned || cleaned === '.' || cleaned === '..' || isAbsolute(cleaned)) return fallback;
  return cleaned.length > 200 ? cleaned.slice(0, 200) : cleaned;
}

/**
 * 删掉临时文件——但要等写入流真的关掉之后。
 *
 * `createWriteStream` 的 open 是**异步**的，而超限判定发生在流的中间：
 * 第一块就超上限时，抛错到 `finally` 可能比 open 完成还早。那时 `unlink` 拿到
 * ENOENT 被吞掉，紧接着 open 才把文件建出来——磁盘上于是留下一个空的半截文件，
 * 谁也不会再碰它。
 *
 * 这条竞态在 CI 上以「不留半截临时文件」偶发失败的形式暴露出来（本机跑几百遍都
 * 复现不了，runner 负载高的时候才输）。但它不是测试的问题：生产上每一次超限下载
 * 都会漏一个文件进 `data/attachments/tmp/`，而那个目录没有任何东西会去清理它。
 *
 * `pipeline` 出错时会 destroy 这个流，destroy 完必定发 `close`（fs.WriteStream 的
 * autoDestroy 默认开着），所以等 `close` 不会把自己等死。
 */
async function discard(tmp: string, sink: WriteStream): Promise<void> {
  if (!sink.closed) {
    await new Promise<void>((resolve) => sink.once('close', resolve));
  }
  await unlink(tmp).catch(() => {});
}
