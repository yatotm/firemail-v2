# 配置参考

FireMail 的配置只有一个来源：**环境变量**。没有配置文件，没有数据库里的隐藏开关。

进程启动时会用 zod 一次性校验全部变量（`apps/server/src/config.ts`），
任何一项不合法就打印人话错误并以退出码 1 中止——不会带着错配置把服务跑起来。

> 空字符串按「没设置」处理。`docker-compose.yml` 里的 `FOO: ${FOO:-}` 传的是空串而不是不传，
> 这个约定让 compose 里可以安全地列出所有可选项。

> **`.env` 生效靠的是 `env_file`。** Compose 的 `.env` 本身只做 `${}` 变量替换，不会把变量注入容器。
> 本仓库的 `docker-compose.yml` 已经声明了 `env_file: [{path: .env, required: false}]`，
> 所以本文列出的变量直接写进 `.env` 即可生效，文件不存在也不会报错。
> `environment:` 块里显式列出的项（`TZ`、`FIREMAIL_ENCRYPTION_KEY` 等）优先级更高。

---

## 1. 网络

| 变量 | 默认值 | 取值 | 说明 |
| --- | --- | --- | --- |
| `PORT` | `3000` | 1–65535 的整数 | HTTP 监听端口。API 与前端静态资源共用这一个端口。 |
| `HOST` | `0.0.0.0` | 主机名或 IP | 监听地址。只想本机访问就设 `127.0.0.1`。 |
| `FIREMAIL_CORS_ORIGINS` | 空 | 逗号分隔的 `scheme://host[:port]` | 跨源白名单。**不接受 `*`**：本服务用 cookie 认证，通配来源等于把会话交给任意站点。同源部署时留空，此时根本不注册 CORS 插件。 |
| `FIREMAIL_TRUST_PROXY` | `false` | `true`/`false`/`1`/`0`/`yes`/`no`/`on`/`off` | 是否信任 `X-Forwarded-*`。**只有真的在反向代理后面才开**，否则客户端可以伪造 IP 绕过按 IP 的限流。 |
| `FIREMAIL_COOKIE_SECURE` | `auto` | `auto`/`true`/`false` | 会话 cookie 的 `Secure` 标志。`auto` 按当前请求是否 HTTPS 决定（配合 `FIREMAIL_TRUST_PROXY` 使用）。 |

## 2. 数据与密钥

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `FIREMAIL_DATA_DIR` | `data`（相对工作目录）<br>镜像内 `/app/data` | 数据目录。存放自动生成的密钥文件 `.encryption-key` 与附件目录 `attachments/`。 |
| `FIREMAIL_DB_PATH` | `<FIREMAIL_DATA_DIR>/firemail.db`<br>镜像内 `/app/data/firemail.db` | SQLite 数据库路径。 |
| `FIREMAIL_ENCRYPTION_KEY` | 空 | **账号凭据的 AES-256-GCM 主密钥**。32 字节，写成 64 位 hex 或 base64/base64url。留空时服务端首次启动会生成一把并写入 `<FIREMAIL_DATA_DIR>/.encryption-key`（权限 600）。详见下方 §5。 |
| `FIREMAIL_WEB_DIR` | `public`（相对工作目录）<br>镜像内 `/app/public` | 前端构建产物目录。目录里没有 `index.html` 时只提供 API，并打一条 warn 日志。 |
| `FIREMAIL_MIGRATIONS_DIR` | 源码同级的 `apps/server/drizzle`<br>镜像内 `/app/drizzle` | 数据库迁移 SQL 目录。在 `apps/server/src/db/migrate.ts` 里读取，不参与 `config.ts` 的校验，通常不需要改。 |

## 3. 同步与配额

同步分三层，优先级从低到高：

| 层级 | 触发方式 | 并发 | 抢占关系 |
| --- | --- | --- | --- |
| **后台基线** background | 定时（按「设置 → 同步」的全局间隔） | **串行**，一次一个账号，账号之间留 `FIREMAIL_SYNC_GAP_MS` | 被批量同步抢占 |
| **批量同步** bulk | `POST /api/accounts/sync`（「全部同步」/ 多选） | 并行，上限 `FIREMAIL_SYNC_CONCURRENCY` | 抢占后台基线，批次结束后恢复 |
| **单账号同步** interactive | `POST /api/accounts/:id/sync` | 并行且插队 | 不抢占，但抢并发名额时排在批量任务前面 |

后台基线的意义是「你打开界面时，离开这段时间收到的信已经在了」。它串行是因为实测：
并发越高越容易被 Outlook 限流，而限流表现为一条和「凭据失效」无法区分的 `AUTHENTICATIONFAILED`。

三层共用同一套重试语义：任何失败都退避重试，每个账号每轮最多 `FIREMAIL_SYNC_MAX_ATTEMPTS` 次。
**重试没用完之前，界面上不会出现失败**——中途的一次失败不写 `status`、不写 `lastError`、
不发 `sync:error`，只发一条 `sync:retry`。一轮真的失败了才标记账号并展示错误。
抢占**不打断**正在跑的账号，只是不再开始下一个：打断会把一次本来会成功的同步变成一条假失败。

| 变量 | 默认值 | 取值 | 说明 |
| --- | --- | --- | --- |
| `FIREMAIL_SYNC_SCHEDULER` | `true` | 布尔 | 周期同步总开关。关掉后只能手动触发 `POST /api/accounts/:id/sync`。 |
| `FIREMAIL_SYNC_CONCURRENCY` | `2` | 1–32 | **用户发起的**同步（批量 / 单账号）的并发上限，每个账号占一条 IMAP 连接。后台基线按定义是串行的，不受它影响。默认值经生产 A/B 实测（29 账号 / 5 分钟一轮）：并发 4 的同步失败率 **17.7%**（n=62，波及 8 个账号），并发 2 为 **3.0%**（n=66，2 个账号），部署后在 2 上复测为 **2.2%**（n=45，0 个账号）。外推显示串行（并发 1）应当趋近于零——后台基线改成串行正是这条外推的兑现。账号数量差异较大时值得重新实测。 |
| `FIREMAIL_SYNC_MAX_ATTEMPTS` | `3` | 1–5 | 每个账号每轮的尝试次数（含首次）。三层共用。 |
| `FIREMAIL_SYNC_GAP_MS` | `2000` | 0–60000 | 后台基线里两个账号之间的间隔。29 个账号串行一圈约 29 × (6.6 + 2) ≈ 250 秒，仍装得进 300 秒的同步周期；同时把两次建连的间隔拉到约 8.6 秒，比失败率 3.0% 的「并发 2」更温和。 |
| `FIREMAIL_SYNC_ACCOUNT_BUDGET_MS` | `90000` | 5000–600000 | 后台基线中单个账号一轮的**总**时间预算，覆盖它的全部尝试与退避等待。串行意味着慢账号会挡住后面的每一个，超预算就把这一轮记为失败并立刻让位。90 秒明显高于实测最慢的一次成功同步（46.7 秒，p99 14.6 秒），不会误杀只是慢的账号；最坏情况一个完全连不上的账号只花 90 秒而不是 3 × 120 = 360 秒。 |
| `FIREMAIL_SYNC_SUSPEND_AFTER_ROUNDS` | `8` | 2–100 | 连续失败多少轮之后判定自动暂停。一轮 = 用完全部尝试仍然失败。见下方 §3.1。 |
| `FIREMAIL_SYNC_SUSPEND_ENFORCE` | `false` | 布尔 | 上面的判定要不要**真的执行**。默认只记录不暂停。见下方 §3.1。 |
| `FIREMAIL_SESSION_TTL_DAYS` | `30` | 1–365 | 会话有效期（天）。 |
| `FIREMAIL_MAX_UPLOAD_MB` | `25` | 1–200 | 单个附件上传上限（MB）。 |
| `FIREMAIL_SSE_MAX_PER_USER` | `6` | 1–64 | 单用户同时保持的 SSE 事件连接数上限。多标签页各占一条。 |
| `FIREMAIL_SHUTDOWN_TIMEOUT_MS` | `15000` | 1000–120000 | 优雅停机的宽限期（毫秒）。超时强制退出。 |

同步间隔不是环境变量，在**界面的「设置 → 同步」**里改（60–86400 秒，默认 300），
对应 `PATCH /api/settings` 的 `syncIntervalSeconds`。

它是**全局**的：一个值管这个用户的所有账号，账号上没有单独的间隔可调。
服务端在改设置时把新值写到该用户的每一行 `accounts.sync_interval_seconds` 上，
并把调度器里那份按旧间隔算出来的排期清掉（`SyncScheduler.resetSchedule`），
所以**改完立刻生效**，不用等当前这一轮走完——改短时尤其重要，
用户改短就是想让邮件来得更快。旧版是「设置里填新账号的默认值 + 每个账号再单独调」，
两处都能填、两处对不上，而且设置里那个值存下来之后没有任何地方读它——改了完全没效果。

### 3.1 自动暂停（默认只观察，不执行）

一个账号连续 `FIREMAIL_SYNC_SUSPEND_AFTER_ROUNDS` 轮全部失败时，系统判定「该停掉它了」。

**这条判定默认不执行。** `FIREMAIL_SYNC_SUSPEND_ENFORCE=false` 时只把判定写进账号视图
（`GET /api/accounts` 的 `syncSuspension` 字段，`enforced: false`）与日志，账号继续照常同步。
原因是门槛还没有真实数据支撑：生产上账号 24 曾在凭据完全健康的情况下连续失败 **6 轮 / 26 分钟**
后自行恢复，另有 5 轮两例、3 轮两例——「失败 3 次再失败 3 次就停掉」那种朴素规则会误杀它。
串行模式理应让这种连续失败远比现在罕见，但那是预测不是实测。
先跑一段时间，看日志里 `连续失败达到门槛（只观察模式，未真的暂停）` 出现的频率，
确认门槛合适之后再把 `FIREMAIL_SYNC_SUSPEND_ENFORCE` 打开。

默认 8 的来历：上面那 6 轮里每一轮只尝试了一次；新模型下一轮要连着失败 3 次才算失败，
所以 8 轮 ≈ 24 次连续失败的建连、≥40 分钟，比历史上最坏的一次抖动高一个量级。
8 同时与认证连续失败门槛（`sync/authStrikes.ts`）取同一个值，两个机制看的是同一段持续性。

自动暂停**不会**写 `status: 'disabled'`。那个值的含义是「用户自己把同步关了」，
两者需要完全相反的处理（一个要保持关闭，一个要提示一键恢复），混在一起就再也分不开。
自动暂停是一条独立的记录：

```jsonc
// GET /api/accounts/:id
{
  "status": "active",          // 一个字都没被动过
  "syncEnabled": true,         // 用户的开关，同样没被动过
  "syncSuspension": {
    "since": 1788460530668,
    "rounds": 8,
    "error": "Outlook IMAP 认证被拒绝……",  // 最终错误，原样展示
    "enforced": true            // false = 只观察，账号仍在同步
  }
}
```

恢复：`POST /api/accounts/:id/resume`。它清掉暂停记录以及降频、连续失败等全部惩罚计数，
账号立刻回到轮询。它和「启用/停用」（`PUT /api/accounts/:id/sync-enabled`）是两件互不覆盖的事。

## 4. 运行时

| 变量 | 默认值 | 取值 | 说明 |
| --- | --- | --- | --- |
| `NODE_ENV` | `development` | 任意字符串 | 等于 `production` 时进入生产模式。镜像里已固定为 `production`。 |
| `TZ` | 跟随系统 | IANA 时区名，如 `Asia/Shanghai` | 影响日志与所有日期格式化。不是合法时区名会启动失败。 |
| `LOG_LEVEL` | `info` | `fatal`/`error`/`warn`/`info`/`debug`/`trace`/`silent` | **控制台**的 pino 日志级别。落库那一路（设置 → 日志）有自己的门槛，在界面上改，两者互不影响。 |

## 5. 加密主密钥（务必读完）

`FIREMAIL_ENCRYPTION_KEY` 保护数据库里**全部账号凭据**：IMAP/SMTP 密码、OAuth
`refresh_token` 与 `access_token`。它们以 AES-256-GCM 加密存储，密钥不落数据库。

### 密钥来源的优先级

1. 环境变量 `FIREMAIL_ENCRYPTION_KEY`
2. 数据目录下的 `.encryption-key` 文件
3. 都没有 → 生成一把新的写入 `.encryption-key`，并在日志里打一段醒目的备份提示

### 丢失后果

**丢了这把钥匙，所有账号必须逐个重新授权，没有任何找回手段。**

服务端为此做了两道防呆：

- 数据库 `settings` 表里存着当初那把钥匙的指纹（`sha256(key)` 前 16 位）。
  启动时指纹对不上会直接 `KeyMismatchError` 中止，而不是让 29 个账号在后台悄悄全部认证失败。
- 迁移工具的 `--verify-only` 模式禁止自动生成密钥：拿一把新钥匙去校验只会把所有账号判成失败。

### 备份

```bash
# 从运行中的容器里取出密钥
docker exec firemail-v2 cat /app/data/.encryption-key

# 或者直接从宿主的数据目录读（注意这是敏感文件，别进版本库、别进聊天记录）
sudo cat ./data/.encryption-key
```

推荐做法：**首次启动前**就自己生成一把并写进 `.env`，这样密钥的归属从一开始就是明确的。

```bash
openssl rand -base64 32
```

数据目录整体备份（含 `.encryption-key`、`firemail.db`、`attachments/`）是最稳妥的方案，
见[部署文档的备份章节](./deployment.md#6-备份与恢复)。

## 6. 没有的变量

以下名字**不被任何代码读取**，见到就是历史残留：

| 名字 | 说明 |
| --- | --- |
| `FIREMAIL_JWT_SECRET` | v2 不使用 JWT。会话令牌是 256 位随机串，数据库只存它的 sha256，因此不需要签名密钥。该变量已从 `docker-compose.yml` 移除，沿用 v1 配置的用户可以直接删掉。 |
| `JWT_SECRET_KEY`、`SECRET_KEY`、`ADMIN_*` | v1（Flask）的变量，v2 一律不读。 |
