import { updateUserSettingsSchema } from '@firemail/shared';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../http/context.ts';
import { parseOrThrow } from '../http/errors.ts';
import { ok } from '../http/reply.ts';
import { requireContext } from '../plugins/auth.ts';

/**
 * 用户偏好。只放「换设备要保留」或「有安全含义」的项——
 * 远程图片策略与信任域名两者都占，主题/密度这类留在浏览器本地。
 */
export function registerSettingsRoutes(app: FastifyInstance, ctx: AppContext): void {
  const guard = { preHandler: app.requireAuth };

  app.get('/settings', guard, async (request) => {
    const auth = requireContext(request);
    return ok(ctx.settings.get(auth.user.id));
  });

  app.patch('/settings', guard, async (request) => {
    const auth = requireContext(request);
    const patch = parseOrThrow(updateUserSettingsSchema, request.body);
    const next = ctx.settings.update(auth.user.id, patch);

    /*
      同步间隔是**全局**的：一个值管这个用户的所有账号，账号上没有单独的间隔可调。
      调度器读的仍然是 accounts.sync_interval_seconds 那一列，所以改完设置要就地
      铺到每一行去，否则设置页显示的和实际跑的就是两回事——那正是这次要修掉的老毛病
      （旧版这个值存下来之后没有任何地方读它，改了完全没效果）。
    */
    if (patch.syncIntervalSeconds !== undefined) {
      const affected = ctx.accounts.setSyncInterval(auth.user.id, next.syncIntervalSeconds);
      // 光改库不够：调度器把「下次什么时候到期」缓存在进程内，不清掉的话它还揣着
      // 按旧间隔算出来的时刻，最长要等一整个**旧**周期才换到新节奏。
      ctx.scheduler.resetSchedule(affected);
    }
    return ok(next);
  });
}
