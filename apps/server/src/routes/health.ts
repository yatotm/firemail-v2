import type { Health } from '@firemail/shared';
import type { FastifyInstance } from 'fastify';
import { ok } from '../http/reply.ts';

export const VERSION = '2.1.1';

/**
 * 健康检查。免鉴权，且**不碰数据库**：
 * 探针的作用是判断进程是否还能接受请求，把它接到业务查询上只会让一次慢查询触发重启。
 */
export function registerHealthRoutes(app: FastifyInstance, startedAt: number): void {
  const handler = async (): Promise<{ ok: true; data: Health }> =>
    ok({
      status: 'ok' as const,
      version: VERSION,
      uptimeSeconds: Math.max(0, Math.round((Date.now() - startedAt) / 1000)),
    });

  app.get('/health', { config: { rateLimit: false } }, handler);
}
