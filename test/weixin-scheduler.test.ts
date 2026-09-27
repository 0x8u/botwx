import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BotwxScheduler, parseBotwxScheduleCommand } from '../src/im/weixin/scheduler.js';

const roots: string[] = [];
const ownerKey = 'a'.repeat(43);

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(now: () => Date): { root: string; filePath: string; scheduler: BotwxScheduler } {
  const root = mkdtempSync(join(tmpdir(), 'botwx-weixin-scheduler-'));
  roots.push(root);
  const filePath = join(root, 'weixin-schedules.json');
  return {
    root,
    filePath,
    scheduler: new BotwxScheduler({ filePath, timeZone: 'Asia/Shanghai', now }),
  };
}

describe('Botwx WeChat scheduler', () => {
  it('recognizes the reported natural-language daily task without invoking the Agent', () => {
    const parsed = parseBotwxScheduleCommand(
      '帮我写一个定时任务，每天晚上11点执行，用钉钉 dws cli 查今天的美股、港股、A股、币圈4h和小猫咪信号并评分。记得是定期任务，每次运行完成后都需要通过微信ClawBot返回结果给我',
    );
    expect(parsed).toMatchObject({
      kind: 'create',
      cron: '0 23 * * *',
      display: '每天 23:00',
    });
    const prompt = parsed && parsed.kind === 'create' ? parsed.prompt : '';
    expect(prompt).toContain('钉钉 dws cli');
    expect(prompt).not.toContain('定时任务');
    expect(prompt).not.toContain('ClawBot');
    expect(prompt.startsWith('用钉钉')).toBe(true);
  });

  it('leaves ambiguous non-scheduling prose for the Agent', () => {
    expect(parseBotwxScheduleCommand('帮我分析每天的 K 线对这个策略有什么影响')).toBeUndefined();
    expect(parseBotwxScheduleCommand('请解释这个定时任务为什么每天晚上 11 点执行')).toBeUndefined();
  });

  it('persists a private, deduplicated task and supports list/pause/resume/remove', async () => {
    const now = () => new Date('2026-09-27T12:00:00.000Z');
    const { filePath, scheduler } = fixture(now);
    const request = '帮我创建定时任务，每天晚上11点执行，生成市场复盘';
    const created = await scheduler.handleMessage({ ownerKey, text: request });
    expect(created).toContain('已创建微信定时任务');
    expect(scheduler.list(ownerKey)).toHaveLength(1);
    expect(scheduler.list(ownerKey)[0]).toMatchObject({
      cron: '0 23 * * *',
      nextRunAt: '2026-09-27T15:00:00.000Z',
      enabled: true,
    });
    expect(await scheduler.handleMessage({ ownerKey, text: request })).toContain('已经存在');

    const id = scheduler.list(ownerKey)[0]!.id;
    expect(await scheduler.handleMessage({ ownerKey, text: '/schedule list' })).toContain(`[${id}]`);
    expect(await scheduler.handleMessage({ ownerKey, text: `/schedule pause ${id}` })).toContain('已暂停');
    expect(scheduler.list(ownerKey)[0]!.enabled).toBe(false);
    expect(await scheduler.handleMessage({ ownerKey, text: `/schedule resume ${id}` })).toContain('已恢复');
    expect(await scheduler.handleMessage({ ownerKey, text: `/schedule remove ${id}` })).toContain('已删除');
    expect(scheduler.list(ownerKey)).toHaveLength(0);

    const persisted = readFileSync(filePath, 'utf8');
    expect(persisted).not.toContain('wx-user');
  });

  it('executes due work and retries a proactive result after the next inbound message', async () => {
    let clock = new Date('2026-09-27T12:00:00.000Z');
    const { scheduler } = fixture(() => clock);
    await scheduler.handleMessage({
      ownerKey,
      text: '/schedule 每天 23:00 生成五个市场的信号评分',
    });
    const execute = vi.fn(async () => '美股 TOP1：示例机会，评分 88');
    const unavailable = vi.fn(async () => { throw new Error('context_token expired'); });
    scheduler.setHandlers(execute, unavailable);

    clock = new Date('2026-09-27T15:00:01.000Z');
    await scheduler.runDueTasks(clock);
    expect(execute).toHaveBeenCalledOnce();
    expect(scheduler.list(ownerKey)[0]).toMatchObject({
      lastStatus: 'delivery_pending',
      nextRunAt: '2026-09-28T15:00:00.000Z',
    });

    const sent: string[] = [];
    scheduler.setHandlers(execute, async message => { sent.push(message); });
    await scheduler.noteInbound();
    expect(sent.join('')).toContain('美股 TOP1');
    expect(scheduler.list(ownerKey)[0]).toMatchObject({ lastStatus: 'ok' });
    expect(scheduler.list(ownerKey)[0]!.pendingDelivery).toBeUndefined();
  });
});
