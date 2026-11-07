import { describe, expect, it } from 'vitest';

import {
  NOVEL_POLL_DELAYS_MS,
  canCancelNovelRun,
  isPageHidden,
  isTerminalNovelStatus,
  nextNovelPollDelay,
  novelStatusLabel,
  novelStatusNotice,
  shouldPollNovelRun,
} from '../src/lib/novel-run-view.js';
import type { NovelRunStatus } from '../src/lib/api.js';

const ALL_STATUSES: readonly NovelRunStatus[] = [
  'queued',
  'running',
  'waiting_user',
  'completed',
  'failed',
  'cancelled',
];

describe('动态问答页轮询策略（C1-A）', () => {
  it('退避序列固定为 1s → 2s → 5s，之后保持 5s', () => {
    expect([...NOVEL_POLL_DELAYS_MS]).toEqual([1_000, 2_000, 5_000]);
    expect(nextNovelPollDelay(0)).toBe(1_000);
    expect(nextNovelPollDelay(1)).toBe(2_000);
    expect(nextNovelPollDelay(2)).toBe(5_000);
    expect(nextNovelPollDelay(3)).toBe(5_000);
    expect(nextNovelPollDelay(100)).toBe(5_000);
    expect(nextNovelPollDelay(-1)).toBe(1_000);
  });

  it('可见性判定只认隐藏态；无 document 时不阻塞', () => {
    expect(isPageHidden({ visibilityState: 'hidden' })).toBe(true);
    expect(isPageHidden({ visibilityState: 'visible' })).toBe(false);
    expect(isPageHidden({ visibilityState: 'prerender' })).toBe(false);
    expect(isPageHidden(null)).toBe(false);
    expect(isPageHidden(undefined)).toBe(false);
  });

  it('只有 queued / running 需要继续轮询', () => {
    expect(shouldPollNovelRun('queued')).toBe(true);
    expect(shouldPollNovelRun('running')).toBe(true);
    expect(shouldPollNovelRun('waiting_user')).toBe(false);
    expect(shouldPollNovelRun('completed')).toBe(false);
    expect(shouldPollNovelRun('failed')).toBe(false);
    expect(shouldPollNovelRun('cancelled')).toBe(false);
  });

  it('终态判定与取消按钮可用性一致', () => {
    for (const status of ALL_STATUSES) {
      const terminal = isTerminalNovelStatus(status);
      expect(canCancelNovelRun(status)).toBe(!terminal);
    }
    expect(isTerminalNovelStatus('completed')).toBe(true);
    expect(isTerminalNovelStatus('failed')).toBe(true);
    expect(isTerminalNovelStatus('cancelled')).toBe(true);
    expect(isTerminalNovelStatus('waiting_user')).toBe(false);
  });

  it('每个状态都有稳定的中文标签与说明', () => {
    for (const status of ALL_STATUSES) {
      expect(novelStatusLabel(status).length).toBeGreaterThan(0);
      expect(novelStatusNotice(status).length).toBeGreaterThan(0);
      // 文案不得泄漏内部标识或错误细节。
      for (const forbidden of ['SQL', 'prisma', 'prompt', 'provider', 'stack', 'Error']) {
        expect(novelStatusNotice(status)).not.toContain(forbidden);
      }
    }
  });
});
