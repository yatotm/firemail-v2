import type { AccountAuthType, AccountSmtpStatus } from '@firemail/shared';
import { ImapFlow } from 'imapflow';
import { createTransport, type Transporter } from 'nodemailer';
import { PROVIDER_AUTH_TYPES, PROVIDER_DEFAULTS } from './defaults.ts';
import { classifyMailFailure, SMTP_SUBMISSION_DISABLED_MESSAGE } from './failures.ts';
import {
  ProviderError,
  type AccountRow,
  type ConnectionSettings,
  type CredentialResolver,
  type MailProvider,
  type ProviderDefaults,
  type ProviderId,
  type VerifyResult,
} from './types.ts';

/** 建连相关的超时。任何一个环节都必须有上限，否则一条卡死的连接会一直占着同步槽位。 */
export interface ProviderTimeouts {
  connectionMs: number;
  greetingMs: number;
  socketMs: number;
}

export const DEFAULT_TIMEOUTS: ProviderTimeouts = {
  connectionMs: 30_000,
  greetingMs: 20_000,
  socketMs: 120_000,
};

export interface BaseProviderDeps {
  credentials: CredentialResolver;
  timeouts?: Partial<ProviderTimeouts>;
  clientName?: string;
}

const CLIENT_INFO = { name: 'FireMail', version: '2.0.0' };

/**
 * 四个服务商共享的建连逻辑。差异只有三处：默认服务器、允许的认证方式、失败提示文案，
 * 因此子类只需要提供 id 和（可选的）错误翻译。
 */
export abstract class BaseMailProvider implements MailProvider {
  readonly id: ProviderId;
  readonly defaults: ProviderDefaults;
  readonly supportedAuthTypes: readonly AccountAuthType[];

  readonly #credentials: CredentialResolver;
  readonly #timeouts: ProviderTimeouts;

  protected constructor(id: ProviderId, deps: BaseProviderDeps) {
    this.id = id;
    this.defaults = PROVIDER_DEFAULTS[id];
    this.supportedAuthTypes = PROVIDER_AUTH_TYPES[id];
    this.#credentials = deps.credentials;
    this.#timeouts = { ...DEFAULT_TIMEOUTS, ...deps.timeouts };
  }

  async connectImap(account: AccountRow): Promise<ImapFlow> {
    this.assertUsable(account);
    const { host, port, secure } = this.imapSettings(account);
    const auth = await this.#credentials.resolve(account);

    const client = new ImapFlow({
      host,
      port,
      secure,
      auth:
        auth.kind === 'oauth2'
          ? { user: auth.user, accessToken: auth.accessToken }
          : { user: auth.user, pass: auth.pass },
      // imapflow 自带日志会打出协议流量，可能带上认证帧；一律关掉
      logger: false,
      clientInfo: CLIENT_INFO,
      connectionTimeout: this.#timeouts.connectionMs,
      greetingTimeout: this.#timeouts.greetingMs,
      socketTimeout: this.#timeouts.socketMs,
    });
    // 库会关闭连接并拒绝 connect/命令 Promise；error 事件还可能在关闭后迟到。
    // 监听器随 client 保留，避免重复事件退出进程，重试仍由同步层负责。
    client.on('error', () => {});

    try {
      await client.connect();
    } catch (cause) {
      client.close();
      // 凭据是上面 resolve() 出来的，走到这里说明它成功了：OAuth 账号意味着
      // 刷新与轮换落库刚刚发生过。同步层靠这个标记区分「refresh token 死了」
      // 和「握着有效 token 仍被服务端拒绝」，后者多半是限流。
      throw new ProviderError(this.describeFailure(cause, 'imap'), cause, { credentialsResolved: true });
    }
    return client;
  }

  async createTransport(account: AccountRow): Promise<Transporter> {
    this.assertUsable(account);
    const { host, port, secure } = this.smtpSettings(account);
    const auth = await this.#credentials.resolve(account);

    return createTransport({
      host,
      port,
      secure,
      // STARTTLS 端口上必须真的升级成功，不接受静默退回明文
      requireTLS: !secure,
      connectionTimeout: this.#timeouts.connectionMs,
      greetingTimeout: this.#timeouts.greetingMs,
      socketTimeout: this.#timeouts.socketMs,
      auth:
        auth.kind === 'oauth2'
          ? // 只给 accessToken、不给 refreshToken/clientSecret：token 生命周期由我们自己管，
            // 让 nodemailer 去刷新会绕过轮换落库
            { type: 'OAuth2', user: auth.user, accessToken: auth.accessToken }
          : { user: auth.user, pass: auth.pass },
    });
  }

  async verify(account: AccountRow): Promise<VerifyResult> {
    const [imap, smtp] = await Promise.all([this.#verifyImap(account), this.#verifySmtp(account)]);
    return { imap, smtp };
  }

  async #verifyImap(account: AccountRow): Promise<{ ok: boolean; message: string | null }> {
    let client: ImapFlow | null = null;
    try {
      client = await this.connectImap(account);
      return { ok: true, message: null };
    } catch (cause) {
      return { ok: false, message: messageOf(cause, this.describeFailure(cause, 'imap')) };
    } finally {
      await client?.logout().catch(() => client?.close());
    }
  }

  /**
   * 发信通道单独给结论。
   * 收信正常而发信被邮箱侧关闭是 Outlook 上的常态，`status` 让调用方能把
   * 「重新授权也没用」和「换个 token 就好」区分开。
   */
  async #verifySmtp(
    account: AccountRow,
  ): Promise<{ ok: boolean; message: string | null; status: AccountSmtpStatus }> {
    let transporter: Transporter | null = null;
    try {
      transporter = await this.createTransport(account);
      await transporter.verify();
      return { ok: true, message: null, status: 'ok' };
    } catch (cause) {
      // IMAP 那边的 cause 已经是 connectImap 翻译过的 ProviderError，SMTP 这边拿到的是
      // nodemailer 原文，必须在这里翻译一次，否则用户只会看到一句英文的 535 应答。
      return {
        ok: false,
        message: cause instanceof ProviderError ? cause.message : this.describeFailure(cause, 'smtp'),
        status: smtpStatusOf(cause),
      };
    } finally {
      transporter?.close();
    }
  }

  imapSettings(account: AccountRow): ConnectionSettings {
    const host = account.imapHost ?? this.defaults.imapHost;
    if (!host) throw new ProviderError(`账号 ${account.email} 未配置 IMAP 服务器地址`);
    return { host, port: account.imapPort ?? this.defaults.imapPort, secure: account.imapSecure };
  }

  smtpSettings(account: AccountRow): ConnectionSettings {
    const host = account.smtpHost ?? this.defaults.smtpHost;
    if (!host) throw new ProviderError(`账号 ${account.email} 未配置 SMTP 服务器地址`);
    return { host, port: account.smtpPort ?? this.defaults.smtpPort, secure: account.smtpSecure };
  }

  protected assertUsable(account: AccountRow): void {
    if (account.provider !== this.id) {
      throw new ProviderError(`账号 ${account.email} 属于 ${account.provider}，不能用 ${this.id} 连接`);
    }
    if (!this.supportedAuthTypes.includes(account.authType as AccountAuthType)) {
      throw new ProviderError(`${this.id} 不支持 ${account.authType} 认证`);
    }
  }

  /**
   * 子类覆盖，把底层错误翻译成对该服务商有意义的提示。
   * 基类先处理所有服务商共有的两类：邮箱侧关掉 SMTP 提交、上游限流。
   */
  protected describeFailure(cause: unknown, channel: 'imap' | 'smtp'): string {
    const failure = classifyMailFailure(cause);
    if (failure.kind === 'smtp_disabled') return SMTP_SUBMISSION_DISABLED_MESSAGE;
    if (failure.kind === 'throttled') {
      return `${channel.toUpperCase()} 被服务端限流（${failure.signal}），稍后会自动重试，无需重新授权`;
    }
    return `${channel.toUpperCase()} 连接失败: ${messageOf(cause, '未知错误')}`;
  }
}

function messageOf(cause: unknown, fallback: string): string {
  if (cause instanceof ProviderError) return cause.message;
  const message = (cause as { message?: unknown })?.message;
  return typeof message === 'string' && message !== '' ? message : fallback;
}

/** 发信失败 -> 发信能力判定。 */
export function smtpStatusOf(cause: unknown): AccountSmtpStatus {
  switch (classifyMailFailure(cause).kind) {
    case 'smtp_disabled':
      return 'disabled';
    case 'auth':
      return 'auth_error';
    default:
      return 'error';
  }
}

/**
 * 认证类失败：用于给出「换应用专用密码 / 重新授权」这类提示。
 *
 * 旧实现是 `/auth|login|credential|password|xoauth/i.test(message)`，
 * 于是 "Too many login attempts"（限流）和
 * "SmtpClientAuthentication is disabled"（邮箱侧关了发信）全都被判成凭据失效。
 * 现在统一走 classifyMailFailure：限流与抖动在认证之前判掉。
 */
export function isAuthFailure(cause: unknown): boolean {
  return classifyMailFailure(cause).kind === 'auth';
}
