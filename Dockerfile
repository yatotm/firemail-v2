# syntax=docker/dockerfile:1.7
# FireMail v2 —— 单镜像：Fastify 同时提供 API 和已构建的前端静态资源，只监听一个端口。

ARG NODE_IMAGE=node:22.23.4-alpine

# ---------------------------------------------------------------------------
# base：统一 pnpm / registry 设置
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS base
ARG NPM_REGISTRY=https://registry.npmjs.org/
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    npm_config_registry=${NPM_REGISTRY} \
    CI=1
RUN corepack enable
WORKDIR /app

# ---------------------------------------------------------------------------
# deps：只拷 manifest + lockfile，依赖没变时这一层可复用
# better-sqlite3 是原生模块，但官方发布了 linuxmusl-x64 / node-v127 预编译包，
# prebuild-install 会直接下载，因此这里不需要 python3/make/g++ 工具链。
# 万一预编译包拉不到，prebuild-install 会退回 node-gyp 并因缺工具链而报错——
# 这是刻意的：宁可构建期失败，也不要运行期才发现 .node 加载不了。
# ---------------------------------------------------------------------------
FROM base AS deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/shared/package.json packages/shared/
COPY apps/web/package.json apps/web/
COPY apps/server/package.json apps/server/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile

# ---------------------------------------------------------------------------
# build：shared -> web -> server，然后裁出仅含 production 依赖的部署目录
# ---------------------------------------------------------------------------
FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/web apps/web
COPY apps/server apps/server
RUN pnpm build
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm deploy --filter=@firemail/server --prod --legacy /prod/server
# 原生模块必须能在纯运行时镜像里加载，编译阶段就先验一次
RUN node -e "new (require('/prod/server/node_modules/better-sqlite3'))(':memory:').exec('create table t(x)');console.log('better-sqlite3 ok')"

# ---------------------------------------------------------------------------
# runtime：只带 production 依赖 + 构建产物，无编译工具链
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    FIREMAIL_DATA_DIR=/app/data \
    FIREMAIL_DB_PATH=/app/data/firemail.db \
    FIREMAIL_WEB_DIR=/app/public \
    FIREMAIL_MIGRATIONS_DIR=/app/drizzle
RUN apk add --no-cache su-exec tini
WORKDIR /app

COPY --from=build --chown=node:node /prod/server/node_modules ./node_modules
COPY --from=build --chown=node:node /prod/server/package.json ./package.json
COPY --from=build --chown=node:node /app/apps/server/dist ./dist
COPY --from=build --chown=node:node /app/apps/server/drizzle ./drizzle
COPY --from=build --chown=node:node /app/apps/web/dist ./public

# 数据目录归非 root 用户；bind mount 时由 entrypoint 再修一次属主
RUN mkdir -p /app/data && chown node:node /app /app/data

# entrypoint 内联在此处，避免额外的脚本文件
RUN <<'SH' cat > /usr/local/bin/firemail-entrypoint && chmod +x /usr/local/bin/firemail-entrypoint
#!/bin/sh
set -e
if [ "$(id -u)" = "0" ]; then
  # bind mount 的宿主目录通常是 root 所有，交还给 node 后再降权
  chown -R node:node /app/data 2>/dev/null || true
  exec su-exec node "$@"
fi
exec "$@"
SH

EXPOSE 3000
VOLUME ["/app/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1 || exit 1

ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/firemail-entrypoint"]
CMD ["node", "dist/index.js"]
