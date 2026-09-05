import { useState } from 'react';
import { FormSkeleton } from '@/components/common/skeletons';
import { SettingBlock, TextField } from '@/components/settings/controls';
import { Button } from '@/components/ui/button';
import { useSettingsPatch, useUserSettings } from '@/hooks/accounts/use-user-settings';
import { useAccounts } from '@/hooks/use-accounts';
import { isSyncIntervalValid, SYNC_INTERVAL_HINT } from '@/lib/accounts/provider-form';

/**
 * 同步设置。
 *
 * 间隔是**全局**的：一个值管这个用户的所有账号，账号上没有单独的间隔可调。
 * 旧版是「这里填新账号的默认值 + 每个账号再单独调」，两处都能填、两处对不上，
 * 而且这里填的那个值存下来之后**没有任何地方读它**——改了完全没效果。
 *
 * 间隔需要校验，所以它是少数几个有显式「保存」按钮的地方 ——
 * 其余开关都是立即生效（screens.md §7）。
 */
export function SyncPanel() {
  const settings = useUserSettings();
  const { patch, isSaving } = useSettingsPatch();
  const accountsQuery = useAccounts();
  const [draft, setDraft] = useState<string | null>(null);

  if (settings.isPending) {
    return (
      <div className="py-4">
        <FormSkeleton fields={2} />
      </div>
    );
  }

  const current = String(settings.data?.syncIntervalSeconds ?? 300);
  const value = draft ?? current;
  const valid = isSyncIntervalValid(value);
  const accounts = accountsQuery.data ?? [];
  const paused = accounts.filter((account) => !account.syncEnabled).length;

  return (
    <div className="divide-y">
      <SettingBlock
        title="同步间隔"
        description={`所有账号统一使用这个间隔，保存后立即生效——不用等当前这一轮走完。允许 ${SYNC_INTERVAL_HINT}。账号多的时候别调太短：29 个账号串行跑一圈约 250 秒，间隔小于它就永远追不上。`}
      >
        <div className="flex items-end gap-2">
          <TextField
            id="sync-interval"
            label="秒"
            type="number"
            className="w-40"
            value={value}
            error={valid ? undefined : `请填 ${SYNC_INTERVAL_HINT}`}
            onChange={setDraft}
          />
          <Button
            size="sm"
            disabled={!valid || draft === null || draft === current || isSaving}
            onClick={() => {
              patch({ syncIntervalSeconds: Number(value) });
              setDraft(null);
            }}
          >
            保存
          </Button>
        </div>
      </SettingBlock>

      <SettingBlock title="同步状态" description="逐个账号的开关在账号管理里。">
        <p className="text-sm text-muted-foreground">
          共 {accounts.length} 个账号
          {paused > 0 ? `，其中 ${paused} 个已暂停自动同步` : '，全部参与自动同步'}。
        </p>
      </SettingBlock>
    </div>
  );
}
