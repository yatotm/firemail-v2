import type { AccountSuspension, SyncTier, SyncTierState } from '@firemail/shared';
import { and, eq, inArray, ne } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { accounts } from '../db/schema.ts';
import type { SyncRound } from './attempts.ts';
import { sleep } from './concurrency.ts';
import { SyncCooldown } from './cooldown.ts';
import { SyncEscalation, type SuspendDecision } from './escalation.ts';
import {
  backgroundPolicy,
  bulkPolicy,
  interactivePolicy,
  DEFAULT_RESUME_DELAY_MS,
  DEFAULT_TIER_GAP_MS,
  type PolicyOverrides,
} from './policy.ts';
import type { RoundOptions, SyncRunner } from './runner.ts';
import { SyncSuspensionStore } from './suspension.ts';
import type { AccountRow, AccountSyncResult, SyncLogger } from './types.ts';

/** 与 shared 的 accountSchema 保持一致：低于 60 秒的轮询对邮件毫无意义，只会招节流。 */
export const MIN_INTERVAL_SECONDS = 60;
export const MAX_INTERVAL_SECONDS = 86_400;

export interface SyncSchedulerOptions {
  /** 检查「谁到期了」的节奏，不是同步周期本身。 */
  tickMs?: number;
  now?: () => number;
  random?: () => number;
  log?: SyncLogger;
  /** 被限流账号的最大降频倍数。 */
  maxCooldownMultiplier?: number;

  /** 后台基线里两个账号之间的间隔。 */
  gapMs?: number;
  /** 批量同步结束后隔多久恢复后台基线。 */
  resumeDelayMs?: number;
  /** 重试与预算，三层共用。 */
  policy?: PolicyOverrides;
  /** 连续失败多少轮判定自动暂停。 */
  suspendAfterRounds?: number;
  /** true 才真的暂停；默认只记录判定。 */
  suspendEnforce?: boolean;
  /** 等待的注入点（账号间隔、恢复延迟、退避），测试用它跳过真实等待。 */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** 层级状态变化，用来推 SSE。 */
  onTier?: (event: { tier: SyncTier; state: SyncTierState; accounts: number }) => void;
  /** 自动暂停的判定结果（含只观察模式），用来推 SSE 与告警。 */
  onSuspend?: (decision: SuspendDecision, account: AccountRow) => void;
}

export interface TickResult {
  /** 本轮判定到期的账号。 */
  due: number[];
  /** 实际启动了同步的账号（排除掉正在同步中的）。 */
  started: number[];
  /** 因为上一轮还没跑完而跳过的账号。 */
  skipped: number[];
  /** 用完全部重试仍然失败的账号。 */
  failed: number[];
  /** true = 被批量同步抢占，本轮没走完就让位了。 */
  preempted: boolean;
}

export interface BulkResult {
  requested: number[];
  ok: number[];
  failed: number[];
}

const DEFAULTS = {
  tickMs: 15_000,
} satisfies Pick<SyncSchedulerOptions, 'tickMs'>;

/**
 * 三层同步调度。
 *
 * ## 层级
 *
 * | 层级 | 触发 | 并发 | 抢占 | 失败处理 |
 * | --- | --- | --- | --- | --- |
 * | background  | 定时 | **串行**，账号间留固定间隔 | 被 bulk 抢占 | 退避重试 → 标记 → 连续多轮后升级 |
 * | bulk        | 用户点「全部同步」 | 并行，上限 = 并发配置 | 抢占 background | 退避重试 → 标记，**不再排后续重试** |
 * | interactive | 用户点单个账号「立即同步」 | 并行且插队 | 不抢占 | 退避重试 → 标记 |
 *
 * ## 排期
 *
 * 账号配置的间隔就是它两次后台同步之间的**绝对**时长，不叠随机抖动。
 * 账号之间的错开由串行那一圈产生、由排期锚点保持，详见 `#reschedule`。
 *
 * ## 状态机
 *
 * ```
 *              start()                 pause()（bulk 开始）
 *   stopped ──────────► idle ◄──────────────────────────── paused
 *      ▲                 │ 到期                    恢复延迟   ▲
 *      │                 ▼                           └───────┘
 *      └──── stop() ── syncing ── 完成 + 间隔 ──► idle
 * ```
 *
 * 抢占**不打断**正在跑的那个账号，只是不再开始下一个。理由有三条：
 *  1. 打断意味着把一次本来会成功的同步变成一条 error 的 sync_runs 和一次界面上的失败，
 *     而这个账号什么错都没犯——那是升级计数最不该被喂进去的东西；
 *  2. 中断路径（signal → client.close()）是给超时用的，把它挪来当常规控制流，
 *     等于让「用户点了全部同步」这件正常操作去制造一次异常终止；
 *  3. 后台层的每账号预算（默认 90 秒）本来就给了这个等待一个上界，
 *     而且总闸门是同一个信号量——bulk 根本不必等 background 排空就能开跑。
 */
export class SyncScheduler {
  readonly #db: Db;
  readonly #runner: SyncRunner;
  readonly #options: Required<
    Pick<SyncSchedulerOptions, 'tickMs' | 'now' | 'random' | 'gapMs' | 'resumeDelayMs'>
  >;
  readonly #log: SyncLogger | undefined;
  /** accountId -> 下次到期的时间戳。进程内状态，重启后按 last_synced_at 重算。 */
  readonly #dueAt = new Map<number, number>();
  readonly #cooldown: SyncCooldown;
  readonly #escalation: SyncEscalation;
  readonly #suspensions: SyncSuspensionStore;
  readonly #policy: PolicyOverrides;
  readonly #sleepFn: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly #onTier: SyncSchedulerOptions['onTier'];
  readonly #onSuspend: SyncSchedulerOptions['onSuspend'];
  /** 正在等待的「恢复后台基线」，stop() 与测试都要能等它们全部落定。 */
  readonly #resuming = new Set<Promise<void>>();

  #timer: ReturnType<typeof setInterval> | null = null;
  #ticking: Promise<TickResult> | null = null;
  /** >0 表示后台基线被抢占。用计数而不是布尔：多个批量同步可以重叠。 */
  #pauseDepth = 0;
  /** stop() 用它叫醒所有等待中的间隔/退避/恢复延迟，别让停机白等十秒。 */
  #stopping = new AbortController();

  constructor(deps: { db: Db; runner: SyncRunner }, options: SyncSchedulerOptions = {}) {
    this.#db = deps.db;
    this.#runner = deps.runner;
    this.#log = options.log;
    this.#cooldown = new SyncCooldown(
      options.maxCooldownMultiplier === undefined
        ? {}
        : { maxMultiplier: options.maxCooldownMultiplier },
    );
    this.#escalation = new SyncEscalation({
      ...(options.suspendAfterRounds === undefined ? {} : { threshold: options.suspendAfterRounds }),
      enforce: options.suspendEnforce === true,
      now: options.now ?? Date.now,
    });
    this.#suspensions = new SyncSuspensionStore({ db: deps.db });
    this.#policy = options.policy ?? {};
    this.#sleepFn = options.sleep ?? sleep;
    this.#onTier = options.onTier;
    this.#onSuspend = options.onSuspend;
    this.#options = {
      tickMs: options.tickMs ?? DEFAULTS.tickMs,
      now: options.now ?? Date.now,
      random: options.random ?? Math.random,
      gapMs: options.gapMs ?? DEFAULT_TIER_GAP_MS,
      resumeDelayMs: options.resumeDelayMs ?? DEFAULT_RESUME_DELAY_MS,
    };
  }

  get running(): boolean {
    return this.#timer !== null;
  }

  /** 后台基线当前的状态。 */
  get tierState(): SyncTierState {
    if (this.#pauseDepth > 0) return 'paused';
    return this.#ticking === null ? 'idle' : 'running';
  }

  /** 升级判定的观察窗口，供健康面板与测试读取。 */
  get escalation(): SyncEscalation {
    return this.#escalation;
  }

  start(): void {
    if (this.#timer) return;
    if (this.#stopping.signal.aborted) this.#stopping = new AbortController();
    this.#timer = setInterval(() => {
      void this.tick().catch((error) => this.#log?.error('同步轮询失败', { error: String(error) }));
    }, this.#options.tickMs);
    // 定时器不应该拖住进程退出
    this.#timer.unref?.();
  }

  /** 停表、叫醒所有等待，并等正在进行的一轮结束。 */
  async stop(): Promise<void> {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    // 账号间隔与恢复延迟都可能是十秒量级，停机不该白等它们
    this.#stopping.abort();
    await this.drain();
  }

  /** 等待在跑的一轮与挂起的恢复延迟都落定。测试与优雅停机都要它。 */
  async drain(): Promise<void> {
    await this.#ticking?.catch(() => {});
    await Promise.all([...this.#resuming]).catch(() => {});
  }

  /** 下次到期时间，仅供测试与健康面板。 */
  dueAt(accountId: number): number | undefined {
    return this.#dueAt.get(accountId);
  }

  /** 该账号当前的降频倍数，1 表示没有被限流。 */
  cooldownMultiplier(accountId: number): number {
    return this.#cooldown.multiplier(accountId);
  }

  /**
   * 跑一轮到期检查——**串行**地把这一刻所有到期的账号依次同步完。
   *
   * 单独暴露成方法（而不是藏在定时器里）是为了让测试用注入的时钟精确驱动，
   * 不必真的等 15 秒。
   */
  tick(): Promise<TickResult> {
    // 上一轮还没结束就不开新的一轮，否则慢账号会让 due 判定基于过期数据
    this.#ticking ??= this.#runTick().finally(() => {
      this.#ticking = null;
    });
    return this.#ticking;
  }

  // -------------------------------------------------------------------------
  // 第 2 层：用户发起的批量同步
  // -------------------------------------------------------------------------

  /**
   * 「全部同步」/ 多选同步。用户要的是快，所以暂停后台基线、按并发上限并行跑。
   *
   * 失败的账号在用完重试之后就地标记并展示，**不再安排后续重试**：
   * 用户只点了一次，这一批就到此为止。它下一次被同步是后台基线自己排到它，
   * 那是基线在做基线的事，不是这一批的延续。
   */
  async syncAll(accountIds?: number[]): Promise<BulkResult> {
    const targets = this.#bulkTargets(accountIds);
    const result: BulkResult = { requested: targets.map((a) => a.id), ok: [], failed: [] };
    if (targets.length === 0) return result;

    this.#pause(targets.length);
    this.#emitTier('bulk', 'running', targets.length);
    try {
      // 并发上限由 SyncRunner 的信号量兜底，这里放心全部发出去
      await Promise.all(targets.map((account) => this.#runBulk(account, result)));
    } finally {
      this.#emitTier('bulk', 'idle', 0);
      this.#resumeLater();
    }
    return result;
  }

  // -------------------------------------------------------------------------
  // 第 3 层：单账号，用户正在等
  // -------------------------------------------------------------------------

  /** 立即同步指定账号（排队而非跳过），并把它的下次到期时间往后推。 */
  async syncNow(accountId: number): Promise<AccountSyncResult | null> {
    const account = this.#db.select().from(accounts).where(eq(accounts.id, accountId)).get();
    if (!account) return null;

    this.#emitTier('interactive', 'running', 1);
    try {
      const round = await this.#runner.runRound(
        account,
        interactivePolicy(this.#policy),
        this.#roundOptions(),
      );
      this.#settle(account, round, 'interactive');
      return round.result;
    } finally {
      this.#reschedule(account, 'now');
      this.#emitTier('interactive', 'idle', 0);
    }
  }

  /** 旧名字，等价于 `syncNow`。 */
  triggerNow(accountId: number): Promise<AccountSyncResult | null> {
    return this.syncNow(accountId);
  }

  // -------------------------------------------------------------------------
  // 第 1 层：后台基线
  // -------------------------------------------------------------------------

  async #runTick(): Promise<TickResult> {
    const result: TickResult = { due: [], started: [], skipped: [], failed: [], preempted: false };
    const candidates = this.#candidates();

    for (const account of candidates) {
      if (this.#pauseDepth > 0) {
        result.preempted = true;
        break;
      }
      // 时钟必须每次重读：串行一圈是真的会花掉几分钟的
      if (this.#options.now() < this.#dueFor(account)) continue;
      result.due.push(account.id);

      if (this.#runner.isSyncing(account.id)) {
        result.skipped.push(account.id);
        continue;
      }
      // 只在真的要动手时才播报，否则 29 个账号 × 每 15 秒一次心跳就是纯噪音
      if (result.started.length === 0) this.#emitTier('background', 'running', candidates.length);
      result.started.push(account.id);
      await this.#runBackground(account, result);
      await this.#sleep(this.#options.gapMs);
    }

    if (result.started.length > 0 && this.#pauseDepth === 0) {
      this.#emitTier('background', 'idle', 0);
    }
    return result;
  }

  async #runBackground(account: AccountRow, result: TickResult): Promise<void> {
    try {
      const round = await this.#runner.tryRunRound(
        account,
        backgroundPolicy(this.#policy),
        this.#roundOptions(),
      );
      if (round === null) {
        result.started.splice(result.started.indexOf(account.id), 1);
        result.skipped.push(account.id);
        return;
      }
      if (!round.ok) result.failed.push(account.id);
      this.#settle(account, round, 'background');
    } catch (error) {
      this.#log?.error('账号同步抛出异常', { accountId: account.id, error: String(error) });
    } finally {
      this.#reschedule(account, account.lastSyncedAt === null ? 'now' : 'grid');
    }
  }

  async #runBulk(account: AccountRow, result: BulkResult): Promise<void> {
    try {
      const round = await this.#runner.runRound(account, bulkPolicy(this.#policy), this.#roundOptions());
      (round.ok ? result.ok : result.failed).push(account.id);
      this.#settle(account, round, 'bulk');
    } catch (error) {
      result.failed.push(account.id);
      this.#log?.error('批量同步抛出异常', { accountId: account.id, error: String(error) });
    } finally {
      this.#reschedule(account, 'now');
    }
  }

  // -------------------------------------------------------------------------
  // 一轮结束之后的记账
  // -------------------------------------------------------------------------

  /**
   * 一轮（含全部重试）结束时的统一记账：降频、升级判定、日志。
   *
   * 升级只由后台基线喂：用户主动点的同步失败不该把他的账号停掉——他正盯着这件事，
   * 系统在他手底下放弃是最糟的时机。反过来任何层级的成功都算数：账号能用就是能用。
   */
  #settle(account: AccountRow, round: SyncRound, tier: SyncTier): void {
    this.#cooldown.record(account.id, round.result.failureKind);
    if (round.ok) {
      this.#escalation.succeeded(account.id);
      return;
    }
    if (round.budgetExhausted) {
      this.#log?.warn('账号用尽本轮时间预算，让位给下一个账号', {
        accountId: account.id,
        tier,
        attempts: round.attempts,
      });
    }
    if (tier !== 'background') return;

    const decision = this.#escalation.failed(account.id, round.result.error);
    if (decision) this.#suspend(account, decision);
  }

  /**
   * 达到升级门槛。默认**只记录不执行**：把判定原样写进账号视图与日志，
   * 但不真的停掉同步。门槛需要真实数据标定——生产上账号 24 曾在凭据完全健康的情况下
   * 连续失败 6 轮 / 26 分钟后自愈，「失败 3 次再失败 3 次就停掉」那种朴素规则会误杀它。
   */
  #suspend(account: AccountRow, decision: SuspendDecision): void {
    const suspension: AccountSuspension = {
      since: decision.at,
      rounds: decision.rounds,
      error: decision.error,
      enforced: decision.enforced,
    };
    this.#suspensions.set(account.id, suspension);

    const meta = {
      accountId: account.id,
      rounds: decision.rounds,
      threshold: decision.threshold,
      error: decision.error,
    };
    if (decision.enforced) this.#log?.error('连续失败达到门槛，已自动暂停该账号的同步', meta);
    else this.#log?.warn('连续失败达到门槛（只观察模式，未真的暂停）', meta);

    this.#onSuspend?.(decision, account);
  }

  /** 用户点「恢复同步」：清掉暂停记录与全部惩罚计数，账号立刻回到候选。 */
  resume(accountId: number): void {
    this.#suspensions.clear(accountId);
    this.#escalation.clear(accountId);
    this.#cooldown.clear(accountId);
    this.#dueAt.set(accountId, this.#options.now());
  }

  /**
   * 丢掉这些账号的排期，下一个 tick 按库里**当前**的间隔重新算。
   *
   * 用户在设置里改了同步间隔就该立刻生效，而 `#dueAt` 是进程内缓存——不清掉的话
   * 它还揣着按旧间隔算出来的到期时刻，最长要等一整个**旧**周期走完才换到新节奏。
   * 900 改成 300 时这尤其别扭：用户改短就是想让邮件来得更快，系统却先把那 15 分钟
   * 慢慢走完，看起来就像设置没生效。
   *
   * 清掉之后 `#dueFor` 会重算成 `last_synced_at + 新间隔`：改长则往后推，改短则
   * 往前提，已经超出新间隔的当场到期。一批账号同时到期不要紧，后台层本来就是串行的，
   * 它们会按账号间隔一个一个走。
   */
  resetSchedule(accountIds: readonly number[]): void {
    for (const id of accountIds) this.#dueAt.delete(id);
  }

  suspension(accountId: number): AccountSuspension | null {
    return this.#suspensions.get(accountId);
  }

  // -------------------------------------------------------------------------
  // 抢占
  // -------------------------------------------------------------------------

  #pause(accounts: number): void {
    this.#pauseDepth += 1;
    if (this.#pauseDepth === 1) this.#emitTier('background', 'paused', accounts);
  }

  /** 批量同步收尾：等一会儿再放后台基线回去，别刚跑完又立刻压上去。 */
  #resumeLater(): void {
    const pending = this.#waitThenResume();
    this.#resuming.add(pending);
    void pending.finally(() => this.#resuming.delete(pending));
  }

  async #waitThenResume(): Promise<void> {
    await this.#sleep(this.#options.resumeDelayMs);
    this.#pauseDepth = Math.max(0, this.#pauseDepth - 1);
    if (this.#pauseDepth === 0) this.#emitTier('background', 'idle', 0);
  }

  /** 所有调度器自己的等待都走这里，才能被 stop() 一次性叫醒。 */
  #sleep(ms: number): Promise<void> {
    return this.#sleepFn(ms, this.#stopping.signal);
  }

  #emitTier(tier: SyncTier, state: SyncTierState, accounts: number): void {
    this.#onTier?.({ tier, state, accounts });
  }

  #roundOptions(): RoundOptions {
    return {
      attempts: {
        now: this.#options.now,
        sleep: (ms) => this.#sleep(ms),
        random: this.#options.random,
        ...(this.#log ? { log: this.#log } : {}),
      },
    };
  }

  // -------------------------------------------------------------------------
  // 候选与排期
  // -------------------------------------------------------------------------

  /** 顺序必须稳定：相位错开按「第几个账号」分配，顺序一变所有账号的相位就跟着漂。 */
  #candidates(): AccountRow[] {
    const rows = this.#db
      .select()
      .from(accounts)
      .where(and(eq(accounts.syncEnabled, true), ne(accounts.status, 'disabled')))
      .orderBy(accounts.id)
      .all();
    // 被自动暂停的账号退出轮询，直到用户点恢复。只观察模式下的记录不在此列。
    const suspended = this.#suspensions.enforcedIds(rows.map((row) => row.id));
    return suspended.size === 0 ? rows : rows.filter((row) => !suspended.has(row.id));
  }

  /** 批量同步的目标：给了 id 就按 id 取（并做同样的过滤），没给就是全部候选。 */
  #bulkTargets(accountIds?: number[]): AccountRow[] {
    if (accountIds === undefined) return this.#candidates();
    if (accountIds.length === 0) return [];
    const wanted = new Set(accountIds);
    return this.#db
      .select()
      .from(accounts)
      .where(and(inArray(accounts.id, [...wanted]), ne(accounts.status, 'disabled')))
      .all();
  }

  /** 没见过的账号：按库里的 last_synced_at 推算，从没同步过的立刻到期。 */
  #dueFor(account: AccountRow): number {
    const cached = this.#dueAt.get(account.id);
    if (cached !== undefined) return cached;

    const last = account.lastSyncedAt?.getTime();
    const due = last === undefined ? this.#options.now() : last + this.#intervalMs(account);
    this.#dueAt.set(account.id, due);
    return due;
  }

  /**
   * 排下一次。两种锚点，对应「相位从哪来」和「相位怎么保住」。
   *
   * `'now'` —— 以这一刻为锚，下次 = 现在 + 间隔。用在三个地方：
   * 用户点的批量同步、用户点的单账号同步，以及**账号的第一次后台同步**。
   * 前两个是因为他刚拿到新数据，基线没理由紧接着再来一遍；第三个才是关键：
   * 一次导入 29 个账号，它们的 `last_synced_at` 全是空、于是全部立刻到期，
   * 而后台基线是串行的——第 i 个账号的完成时刻天然比第一个晚 i×(同步耗时+间隔)。
   * 以完成时刻为锚，这一圈串行本身就是相位发生器，29 个账号自动摊到 4 分钟里。
   *
   * `'grid'` —— 以**上一次的到期时刻**为锚，下次 = 上次到期 + 间隔。稳态用它，
   * 于是同步周期精确等于配置值，而且上面那一圈挣来的相位会被永久保持。
   * 换成锚在完成时刻，每轮都会把周期悄悄加长一个同步耗时（6 秒），
   * 29 个账号各漂各的，几小时后又糊回一坨。
   *
   * 落后超过一整个间隔时（同步比间隔还慢、或进程被挂起过）就地重起相位：
   * 否则 `上次到期 + 间隔` 一直落在过去，这个账号会被每一个 tick 都判成到期。
   */
  #reschedule(account: AccountRow, anchor: 'grid' | 'now'): void {
    const now = this.#options.now();
    const interval = this.#intervalMs(account);
    const previous = this.#dueAt.get(account.id);

    let next = anchor === 'grid' && previous !== undefined ? previous + interval : now + interval;
    if (next <= now) next = now + interval;

    this.#dueAt.set(account.id, next);
  }

  /**
   * 账号配置的同步间隔，就是这个账号两次后台同步之间的**绝对**时长。
   *
   * 这里刻意不再叠随机抖动。抖动本来是用来防止账号扎堆的，但它防不住：
   * 扎堆的根因是所有账号的相位相同，±20% 的噪声只把那个尖峰摊宽了 20%，
   * 该一起醒的还是一起醒；代价却是「设置里写 300 秒、实际 240~360 秒」，
   * 用户没法预期，排查限流时也说不清到底多久同步一次。
   * 相位错开（见 #dueFor）解决的是同一个问题，而且是真的解决。
   *
   * 冷却倍数保留：那是上游明确说了「慢点」之后的降频，不是调度器自作主张的噪声。
   */
  #intervalMs(account: AccountRow): number {
    const seconds = Math.min(
      MAX_INTERVAL_SECONDS,
      Math.max(MIN_INTERVAL_SECONDS, account.syncIntervalSeconds || MIN_INTERVAL_SECONDS),
    );
    // 再降频也不越过配置允许的最大周期，免得一个账号被冷却到几天不收信
    const cooled = seconds * 1000 * this.#cooldown.multiplier(account.id);
    return Math.round(Math.min(cooled, MAX_INTERVAL_SECONDS * 1000));
  }
}
