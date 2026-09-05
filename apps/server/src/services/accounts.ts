import {
  bulkImportAccountsRequestSchema,
  createAccountRequestSchema,
  SYNC_INTERVAL_DEFAULT_SECONDS,
  updateAccountRequestSchema,
  type Account,
  type AccountListQuery,
  type AccountSmtpStatus,
  type AccountStatus,
  type AccountSuspension,
  type BulkImportResult,
} from '@firemail/shared';
import { and, eq, inArray, like, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { SecretBox } from '../crypto/secretBox.ts';
import type { Db } from '../db/client.ts';
import { accounts, folders } from '../db/schema.ts';
import { applyProviderDefaults, supportsAuthType } from '../providers/defaults.ts';
import type { AccountRow } from '../providers/types.ts';
import { SyncSuspensionStore } from '../sync/suspension.ts';
import { SmtpHealthStore, UNKNOWN_SMTP_HEALTH, type SmtpHealth } from './smtpHealth.ts';

export type AccountErrorCode = 'bad_request' | 'not_found' | 'conflict';

export class AccountServiceError extends Error {
  readonly code: AccountErrorCode;
  constructor(code: AccountErrorCode, message: string) {
    super(message);
    this.name = 'AccountServiceError';
    this.code = code;
  }
}

export type CreateAccountInput = z.input<typeof createAccountRequestSchema>;
export type UpdateAccountInput = z.input<typeof updateAccountRequestSchema>;
export type BulkImportInput = z.input<typeof bulkImportAccountsRequestSchema>;

/** 单行导入结果。比 shared 的 BulkImportResult 多出逐行明细，供 UI 精确定位问题行。 */
export interface BulkImportLineOutcome {
  line: number;
  email: string | null;
  status: 'created' | 'skipped' | 'failed';
  message: string | null;
  accountId: number | null;
}

/**
 * `created + skipped + (errors 中非重复的行数) = 非空行总数`。
 * 重复邮箱同时计入 `skipped` 和 `errors`——前者给汇总数字，后者给"哪一行为什么没进来"。
 */
export interface BulkImportOutcome extends BulkImportResult {
  lines: BulkImportLineOutcome[];
}

export interface AccountServiceOptions {
  db: Db;
  box: SecretBox;
  now?: () => number;
  /** 该用户当前的全局同步间隔（秒）。不给就用出厂默认值，测试里可以省掉。 */
  syncIntervalSeconds?: (userId: number) => number;
}

/**
 * 邮箱账号的 CRUD。
 *
 * 两条铁律：
 *  1. 写入时凭据一律加密（passwordEnc / oauthRefreshTokenEnc / oauthAccessTokenEnc）；
 *  2. 读取接口**永不**返回明文或密文凭据，只给 hasPassword / hasOAuthToken 两个布尔。
 * 需要真凭据的只有 providers 层，它走 getRow() 拿原始行。
 */
export class AccountService {
  readonly #db: Db;
  readonly #box: SecretBox;
  readonly #now: () => number;
  readonly #smtp: SmtpHealthStore;
  readonly #suspensions: SyncSuspensionStore;
  readonly #intervalFor: (userId: number) => number;

  constructor(options: AccountServiceOptions) {
    this.#db = options.db;
    this.#box = options.box;
    this.#now = options.now ?? Date.now;
    this.#smtp = new SmtpHealthStore({ db: options.db, now: this.#now });
    this.#suspensions = new SyncSuspensionStore({ db: options.db });
    this.#intervalFor = options.syncIntervalSeconds ?? (() => SYNC_INTERVAL_DEFAULT_SECONDS);
  }

  /**
   * 把同步间隔铺到该用户的**每一个**账号上。「设置 → 同步」改完就调它。
   *
   * 同步间隔是全局的：调度器读的仍然是 accounts.sync_interval_seconds 那一列，
   * 而这个方法保证那一列永远等于用户设置里的值。让调度器反过来去查设置也行，
   * 但那样每个 tick 都要为每个账号解一次 JSON，而这件事一天也发生不了一次。
   *
   * 返回被改到的账号 id：调用方要拿它去把调度器里那份按旧间隔算的排期清掉，
   * 否则改完还得等一整个旧周期才生效。
   */
  setSyncInterval(userId: number, seconds: number): number[] {
    return this.#db
      .update(accounts)
      .set({ syncIntervalSeconds: seconds, updatedAt: new Date(this.#now()) })
      .where(eq(accounts.userId, userId))
      .returning({ id: accounts.id })
      .all()
      .map((row) => row.id);
  }

  list(userId: number, query: AccountListQuery = {}): Account[] {
    const filters: SQL[] = [eq(accounts.userId, userId)];
    if (query.status) filters.push(eq(accounts.status, query.status));
    if (query.provider) filters.push(eq(accounts.provider, query.provider));
    if (query.q) {
      // 参数化绑定，用户输入的 % / _ 只会放宽他自己的搜索，无注入风险
      const pattern = `%${query.q}%`;
      filters.push(
        or(like(accounts.email, pattern), like(accounts.displayName, pattern)) as SQL,
      );
    }

    const rows = this.#db
      .select()
      .from(accounts)
      .where(and(...filters))
      .orderBy(accounts.id)
      .all();
    const ids = rows.map((r) => r.id);
    const unread = this.#unreadCounts(ids);
    const smtp = this.#smtp.getMany(ids);
    const suspended = this.#suspensions.getMany(ids);
    return rows.map((row) =>
      toView(row, unread.get(row.id) ?? 0, smtp.get(row.id), suspended.get(row.id) ?? null),
    );
  }

  get(userId: number, accountId: number): Account | null {
    const row = this.#find(userId, accountId);
    if (!row) return null;
    return toView(
      row,
      this.#unreadCounts([row.id]).get(row.id) ?? 0,
      this.#smtp.get(row.id),
      this.#suspensions.get(row.id),
    );
  }

  /** 发信能力，与收信健康度（status）互不影响。 */
  smtpHealth(accountId: number): SmtpHealth {
    return this.#smtp.get(accountId);
  }

  /**
   * 记录一次发信通道的结论。
   * 刻意**不**碰 `accounts.status`：发信被服务端关掉的账号收信仍然完全正常。
   */
  setSmtpHealth(accountId: number, status: AccountSmtpStatus, message: string | null = null): void {
    this.#smtp.set(accountId, status, message);
  }

  /** 内部用：带密文的原始行。只给 providers / 同步层，绝不出现在 HTTP 响应里。 */
  getRow(accountId: number): AccountRow | null {
    return this.#db.select().from(accounts).where(eq(accounts.id, accountId)).get() ?? null;
  }

  create(userId: number, input: CreateAccountInput): Account {
    const data = parse(createAccountRequestSchema, input);
    this.#assertAuthTypeSupported(data.provider, data.authType);
    if (data.authType === 'oauth2' && !data.oauthClientId) {
      throw new AccountServiceError('bad_request', 'OAuth 账号必须提供 oauth client id');
    }
    if (this.#findByEmail(userId, data.email)) {
      throw new AccountServiceError('conflict', `邮箱 ${data.email} 已存在`);
    }

    // *Secure 读**原始入参**而不是 data：shared 的 schema 给它们配了 default(true)，
    // 用 data 会把 Outlook/Gmail 的 587（STARTTLS，secure=false）改写成隐式 TLS，发信直接连不上。
    const servers = applyProviderDefaults(data.provider, {
      imapHost: data.imapHost ?? null,
      imapPort: data.imapPort ?? null,
      ...pickSecure(input),
      smtpHost: data.smtpHost ?? null,
      smtpPort: data.smtpPort ?? null,
    });

    const at = new Date(this.#now());
    const row = this.#db
      .insert(accounts)
      .values({
        userId,
        email: data.email,
        displayName: data.displayName ?? null,
        provider: data.provider,
        authType: data.authType,
        ...servers,
        passwordEnc: this.#box.encryptNullable(data.password),
        oauthClientId: data.oauthClientId ?? null,
        oauthRefreshTokenEnc: this.#box.encryptNullable(data.oauthRefreshToken),
        oauthScope: data.oauthScope ?? null,
        syncEnabled: data.syncEnabled,
        // 间隔是全局的，建号时按该用户此刻的设置落一份
        syncIntervalSeconds: this.#intervalFor(userId),
        status: 'active',
        createdAt: at,
        updatedAt: at,
      })
      .returning()
      .get();
    return toView(row, 0);
  }



  update(userId: number, accountId: number, input: UpdateAccountInput): Account {
    const current = this.#requireRow(userId, accountId);
    const data = parse(updateAccountRequestSchema, input);

    const provider = data.provider ?? (current.provider as Account['provider']);
    const authType = data.authType ?? (current.authType as Account['authType']);
    if (data.provider !== undefined || data.authType !== undefined) {
      this.#assertAuthTypeSupported(provider, authType);
    }
    if (data.email !== undefined && data.email !== current.email) {
      if (this.#findByEmail(userId, data.email)) {
        throw new AccountServiceError('conflict', `邮箱 ${data.email} 已存在`);
      }
    }

    // 换了服务商就重新套用新服务商的默认服务器参数：沿用旧的会得到
    // "outlook 主机 + qq 端口" 这种连不上的组合。调用方显式给的字段仍然优先。
    const inherited = provider === current.provider ? current : EMPTY_SERVERS;
    const servers = applyProviderDefaults(provider, {
      imapHost: data.imapHost ?? inherited.imapHost,
      imapPort: data.imapPort ?? inherited.imapPort,
      imapSecure: data.imapSecure ?? inherited.imapSecure,
      smtpHost: data.smtpHost ?? inherited.smtpHost,
      smtpPort: data.smtpPort ?? inherited.smtpPort,
      smtpSecure: data.smtpSecure ?? inherited.smtpSecure,
    });

    // 换了 refresh token 就必须丢掉旧 access token：它属于上一份授权
    const refreshToken = data.oauthRefreshToken;

    const row = this.#db
      .update(accounts)
      .set({
        email: data.email ?? current.email,
        displayName: data.displayName ?? current.displayName,
        provider,
        authType,
        ...servers,
        ...(data.password === undefined
          ? {}
          : { passwordEnc: this.#box.encrypt(data.password) }),
        ...(data.oauthClientId === undefined ? {} : { oauthClientId: data.oauthClientId }),
        ...(refreshToken === undefined
          ? {}
          : {
              oauthRefreshTokenEnc: this.#box.encrypt(refreshToken),
              oauthAccessTokenEnc: null,
              oauthTokenExpiresAt: null,
            }),
        ...(data.oauthScope === undefined ? {} : { oauthScope: data.oauthScope }),
        ...(data.syncEnabled === undefined ? {} : { syncEnabled: data.syncEnabled }),
        ...(data.status === undefined ? {} : { status: data.status }),
        updatedAt: new Date(this.#now()),
      })
      .where(eq(accounts.id, accountId))
      .returning()
      .get();
    // 换了凭据/服务器就重新验证发信，旧结论不再作数
    if (data.oauthRefreshToken !== undefined || data.password !== undefined) {
      this.#smtp.clear(accountId);
    }
    return toView(
      row,
      this.#unreadCounts([accountId]).get(accountId) ?? 0,
      this.#smtp.get(accountId),
      this.#suspensions.get(accountId),
    );
  }

  remove(userId: number, accountId: number): boolean {
    this.#requireRow(userId, accountId);
    this.#smtp.clear(accountId);
    this.#suspensions.clear(accountId);
    return this.#db.delete(accounts).where(eq(accounts.id, accountId)).run().changes > 0;
  }

  setStatus(accountId: number, status: AccountStatus, lastError: string | null = null): void {
    const at = new Date(this.#now());
    this.#db
      .update(accounts)
      .set({
        status,
        lastError,
        lastErrorAt: lastError === null ? null : at,
        updatedAt: at,
      })
      .where(eq(accounts.id, accountId))
      .run();
  }

  /**
   * 旧格式批量导入：一行一条 `email----password----client_id----refresh_token`。
   * 解析规则与旧 Python 实现逐字节一致（见 parseBulkImportPayload），
   * 在此之上补了邮箱格式校验与重复检测——旧实现会把 `abc----x----y----z` 原样塞进库。
   */
  bulkImport(userId: number, input: BulkImportInput): BulkImportOutcome {
    const request = parse(bulkImportAccountsRequestSchema, input);
    const parsed = parseBulkImportPayload(request.payload, request.separator);

    const outcome: BulkImportOutcome = { created: 0, skipped: 0, errors: [], lines: [] };
    const seen = new Set<string>();

    for (const item of parsed) {
      if (!item.ok) {
        this.#recordImport(outcome, {
          line: item.line,
          email: null,
          status: 'failed',
          message: item.reason,
          accountId: null,
        });
        continue;
      }

      const key = item.email.toLowerCase();
      if (seen.has(key) || this.#findByEmail(userId, item.email)) {
        this.#recordImport(outcome, {
          line: item.line,
          email: item.email,
          status: 'skipped',
          message: '邮箱已存在，已跳过',
          accountId: null,
        });
        continue;
      }
      seen.add(key);

      try {
        const account = this.create(userId, {
          email: item.email,
          provider: request.provider,
          authType: request.authType,
          password: item.password,
          oauthClientId: item.clientId,
          oauthRefreshToken: item.refreshToken,
        });
        this.#recordImport(outcome, {
          line: item.line,
          email: item.email,
          status: 'created',
          message: null,
          accountId: account.id,
        });
      } catch (error) {
        this.#recordImport(outcome, {
          line: item.line,
          email: item.email,
          status: 'failed',
          message: error instanceof Error ? error.message : '导入失败',
          accountId: null,
        });
      }
    }

    return outcome;
  }

  #recordImport(outcome: BulkImportOutcome, line: BulkImportLineOutcome): void {
    outcome.lines.push(line);
    if (line.status === 'created') {
      outcome.created += 1;
      return;
    }
    if (line.status === 'skipped') outcome.skipped += 1;
    outcome.errors.push({ line: line.line, message: line.message ?? '导入失败' });
  }

  #assertAuthTypeSupported(provider: Account['provider'], authType: Account['authType']): void {
    if (!supportsAuthType(provider, authType)) {
      throw new AccountServiceError('bad_request', `${provider} 不支持 ${authType} 认证方式`);
    }
  }

  #find(userId: number, accountId: number): AccountRow | null {
    return (
      this.#db
        .select()
        .from(accounts)
        .where(and(eq(accounts.id, accountId), eq(accounts.userId, userId)))
        .get() ?? null
    );
  }

  #requireRow(userId: number, accountId: number): AccountRow {
    const row = this.#find(userId, accountId);
    if (!row) throw new AccountServiceError('not_found', `账号 ${accountId} 不存在`);
    return row;
  }

  #findByEmail(userId: number, email: string): AccountRow | null {
    return (
      this.#db
        .select()
        .from(accounts)
        .where(and(eq(accounts.userId, userId), eq(accounts.email, email)))
        .get() ?? null
    );
  }

  #unreadCounts(accountIds: number[]): Map<number, number> {
    if (accountIds.length === 0) return new Map();
    const rows = this.#db
      .select({
        accountId: folders.accountId,
        unread: sql<number>`coalesce(sum(${folders.unreadCount}), 0)`,
      })
      .from(folders)
      .where(inArray(folders.accountId, accountIds))
      .groupBy(folders.accountId)
      .all();
    return new Map(rows.map((r) => [r.accountId, Number(r.unread)]));
  }
}

/** 换服务商时用它把"沿用旧值"整体清空，交给服务商默认表重新填。 */
const EMPTY_SERVERS = {
  imapHost: null,
  imapPort: null,
  imapSecure: undefined,
  smtpHost: null,
  smtpPort: null,
  smtpSecure: undefined,
} as const;

/**
 * 只把调用方**显式给出**的 secure 开关传下去。
 * 省略的字段留给 applyProviderDefaults，由服务商默认表决定 993/465 还是 587。
 */
function pickSecure(input: CreateAccountInput): { imapSecure?: boolean; smtpSecure?: boolean } {
  return {
    ...(input.imapSecure === undefined ? {} : { imapSecure: input.imapSecure }),
    ...(input.smtpSecure === undefined ? {} : { smtpSecure: input.smtpSecure }),
  };
}

export type BulkImportLine =
  | {
      ok: true;
      line: number;
      email: string;
      password: string;
      clientId: string;
      refreshToken: string;
    }
  | { ok: false; line: number; reason: string };

const emailSchema = z.string().email();

/**
 * 逐行解析旧格式。行为对齐旧 Python 实现：
 *   `data.strip().split('\n')` → 逐行 `strip()` → 空行跳过（但仍占行号）
 *   → 按分隔符切分，必须恰好 4 段且都非空。
 * `strip()` 会顺带吃掉 CRLF 的 `\r`，所以 Windows 换行无需特殊处理。
 */
export function parseBulkImportPayload(payload: string, separator = '----'): BulkImportLine[] {
  const results: BulkImportLine[] = [];
  const lines = payload.trim().split('\n');

  for (const [index, rawLine] of lines.entries()) {
    const line = index + 1;
    const trimmed = rawLine.trim();
    if (trimmed === '') continue;

    const parts = trimmed.split(separator);
    if (parts.length !== 4) {
      results.push({ ok: false, line, reason: `格式错误，需要 4 个字段，实际 ${parts.length} 个` });
      continue;
    }
    const [email, password, clientId, refreshToken] = parts as [string, string, string, string];
    if (!email || !password || !clientId || !refreshToken) {
      results.push({ ok: false, line, reason: '有空白字段' });
      continue;
    }
    if (!emailSchema.safeParse(email).success) {
      results.push({ ok: false, line, reason: `邮箱地址不合法: ${email}` });
      continue;
    }
    results.push({ ok: true, line, email, password, clientId, refreshToken });
  }

  return results;
}

/** 密文列不出现在返回值里，只留"有没有配"的布尔。 */
function toView(
  row: AccountRow,
  unreadCount: number,
  smtp: SmtpHealth = UNKNOWN_SMTP_HEALTH,
  suspension: AccountSuspension | null = null,
): Account {
  return {
    id: row.id,
    userId: row.userId,
    email: row.email,
    displayName: row.displayName,
    provider: row.provider as Account['provider'],
    authType: row.authType as Account['authType'],
    imapHost: row.imapHost,
    imapPort: row.imapPort,
    imapSecure: row.imapSecure,
    smtpHost: row.smtpHost,
    smtpPort: row.smtpPort,
    smtpSecure: row.smtpSecure,
    hasPassword: row.passwordEnc !== null,
    hasOAuthToken: row.oauthRefreshTokenEnc !== null,
    oauthClientId: row.oauthClientId,
    oauthTokenExpiresAt: row.oauthTokenExpiresAt?.getTime() ?? null,
    oauthScope: row.oauthScope,
    status: row.status as AccountStatus,
    lastError: row.lastError,
    lastErrorAt: row.lastErrorAt?.getTime() ?? null,
    smtpStatus: smtp.status,
    smtpError: smtp.message,
    smtpCheckedAt: smtp.checkedAt,
    syncEnabled: row.syncEnabled,
    syncIntervalSeconds: row.syncIntervalSeconds,
    lastSyncedAt: row.lastSyncedAt?.getTime() ?? null,
    syncSuspension: suspension,
    unreadCount,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  };
}

function parse<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue?.path.join('.') ?? '';
    throw new AccountServiceError('bad_request', `${path ? `${path}: ` : ''}${issue?.message ?? '参数不合法'}`);
  }
  return result.data;
}
