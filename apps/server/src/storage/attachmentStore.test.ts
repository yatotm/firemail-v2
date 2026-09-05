import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { Readable } from 'node:stream';
import { after, test } from 'node:test';
import {
  AttachmentNotFoundError,
  AttachmentStore,
  AttachmentStoreError,
  AttachmentTooLargeError,
  assertSha256,
  sanitizeFilename,
} from './attachmentStore.ts';

const roots: string[] = [];

function newStore(maxBytes?: number): AttachmentStore {
  const root = mkdtempSync(join(tmpdir(), 'firemail-att-'));
  roots.push(root);
  return new AttachmentStore({ root: join(root, 'attachments'), maxBytes });
}

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

test('落盘路径是 <前两位>/<完整 sha256>', async () => {
  const store = newStore();
  const bytes = Buffer.from('花火附件内容', 'utf8');
  const { sha256, size, deduped } = await store.putBuffer(bytes);

  assert.equal(sha256, sha(bytes));
  assert.equal(size, bytes.byteLength);
  assert.equal(deduped, false);
  assert.equal(relative(store.root, store.pathFor(sha256)), join(sha256.slice(0, 2), sha256));
  assert.ok(existsSync(store.pathFor(sha256)));
});

test('相同内容跨邮件只写一份', async () => {
  const store = newStore();
  const bytes = Buffer.from('同一个 PDF 被两封邮件带上');

  const first = await store.putBuffer(bytes);
  const second = await store.putBuffer(bytes);

  assert.equal(first.sha256, second.sha256);
  assert.equal(first.deduped, false);
  assert.equal(second.deduped, true);
  assert.deepEqual(readdirSync(join(store.root, first.sha256.slice(0, 2))), [first.sha256]);
});

test('流式写入与缓冲写入得到同一个 sha256', async () => {
  const store = newStore();
  const bytes = Buffer.from('a'.repeat(5000));
  const streamed = await store.putStream(Readable.from([bytes.subarray(0, 2000), bytes.subarray(2000)]));
  const buffered = await store.putBuffer(bytes);

  assert.equal(streamed.sha256, buffered.sha256);
  assert.equal(streamed.size, 5000);
  assert.equal(buffered.deduped, true);
});

test('读回的内容与写入完全一致', async () => {
  const store = newStore();
  const bytes = Buffer.from([0x00, 0xff, 0x10, 0x80, 0x7f]);
  const { sha256 } = await store.putBuffer(bytes);
  assert.deepEqual(await store.readBuffer(sha256), bytes);
  assert.equal(store.sizeOf(sha256), bytes.byteLength);
  assert.equal(store.has(sha256), true);
});

// ---------------------------------------------------------------------------
// 体积上限
// ---------------------------------------------------------------------------

test('缓冲写入超过上限时拒收', async () => {
  const store = newStore(1024);
  await assert.rejects(() => store.putBuffer(Buffer.alloc(1025)), AttachmentTooLargeError);
});

test('流式写入超限时中止且不留临时文件', async () => {
  const store = newStore(1024);
  const chunks = Array.from({ length: 4 }, () => Buffer.alloc(512));
  await assert.rejects(() => store.putStream(Readable.from(chunks)), AttachmentTooLargeError);
  assert.deepEqual(readdirSync(join(store.root, 'tmp')), []);
});

/**
 * 上面那条单跑一次抓不住真正的问题：临时文件的 open 是异步的，而超限是在流中间抛的，
 * **第一块就超限**时清理有可能跑在 open 完成之前——unlink 拿到 ENOENT 被吞掉，
 * 紧接着 open 才把文件建出来，于是漏下一个空文件。
 *
 * 这条竞态只在机器忙的时候输：本机跑几百遍都是绿的，CI 上偶发红一次。所以这里连着
 * 跑 200 遍，用次数把概率压出来——回归了的话本机也该能抓到。
 */
test('第一块就超限时也不留临时文件（open 与清理的竞态）', async () => {
  const store = newStore(64);
  const tmpDir = join(store.root, 'tmp');

  for (let i = 0; i < 200; i++) {
    await assert.rejects(
      () => store.putStream(Readable.from([Buffer.alloc(4096)])),
      AttachmentTooLargeError,
    );
  }

  assert.deepEqual(readdirSync(tmpDir), [], '漏下的空文件没有任何东西会去清理它');
});

test('恰好等于上限的内容可以写入', async () => {
  const store = newStore(1024);
  const { size } = await store.putBuffer(Buffer.alloc(1024));
  assert.equal(size, 1024);
});

test('上限必须是正整数', () => {
  assert.throws(() => new AttachmentStore({ root: '/tmp/x', maxBytes: 0 }), AttachmentStoreError);
  assert.throws(() => new AttachmentStore({ root: '', maxBytes: 10 }), AttachmentStoreError);
});

// ---------------------------------------------------------------------------
// 路径穿越
// ---------------------------------------------------------------------------

test('路径穿越尝试在 sha 校验阶段就被拒', () => {
  const store = newStore();
  const hostile = [
    '../../etc/passwd',
    '..',
    'a'.repeat(64) + '/../../x',
    '/etc/passwd',
    '0000000000000000000000000000000000000000000000000000000000000000/../evil',
    'ZZ' + '0'.repeat(62),
    '0'.repeat(63),
    '0'.repeat(65),
    '',
  ];
  for (const value of hostile) {
    assert.throws(() => store.pathFor(value), AttachmentStoreError, `应拒绝 ${value}`);
  }
});

test('sha256 校验接受大写并归一化为小写', () => {
  const digest = 'AB'.repeat(32);
  assert.equal(assertSha256(digest), digest.toLowerCase());
  assert.throws(() => assertSha256(null), AttachmentStoreError);
  assert.throws(() => assertSha256(123), AttachmentStoreError);
});

test('内容不存在时读取抛 NotFound 而不是返回空', () => {
  const store = newStore();
  assert.throws(() => store.createReadStream('0'.repeat(64)), AttachmentNotFoundError);
  assert.equal(store.sizeOf('0'.repeat(64)), null);
  assert.equal(store.has('0'.repeat(64)), false);
});

test('remove 只删存在的内容，缺失时返回 false', async () => {
  const store = newStore();
  const { sha256 } = await store.putBuffer(Buffer.from('删我'));
  assert.equal(await store.remove(sha256), true);
  assert.equal(await store.remove(sha256), false);
});

// ---------------------------------------------------------------------------
// 文件名净化
// ---------------------------------------------------------------------------

test('对外文件名剥掉路径分隔符与控制字符', () => {
  // 分隔符先变下划线，再剥掉开头的点，`.hidden` 之类也一并归一化
  assert.equal(sanitizeFilename('../../etc/passwd'), '_.._etc_passwd');
  assert.equal(sanitizeFilename('a\u0000b\u007f.txt'), 'ab.txt');
  assert.equal(sanitizeFilename('C:\\Windows\\evil.exe'), 'C:_Windows_evil.exe');
  assert.equal(sanitizeFilename('报告.pdf'), '报告.pdf');
  assert.equal(sanitizeFilename(''), 'attachment');
  assert.equal(sanitizeFilename(null), 'attachment');
  assert.equal(sanitizeFilename('...'), 'attachment');
  assert.equal(sanitizeFilename('x'.repeat(500)).length, 200);
});
