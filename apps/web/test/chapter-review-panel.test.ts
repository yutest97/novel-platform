/**
 * Reviewer 结果面板纯展示逻辑（A2-C-E）。
 *
 * 覆盖：
 * - severity / type / step 中文标签与未知值回退；
 * - high / medium / low 统计与文案；
 * - queued / processing / succeeded / failed / cancelled / 异常 / 缺失的展示状态；
 * - 轮询判定与退避序列。
 */

import { describe, expect, it } from 'vitest';

import type { ChapterReviewView, ReviewTaskStatus } from '../src/lib/chapter-review-view';
import {
  REVIEW_POLL_DELAYS,
  REVIEW_SEVERITY_FALLBACK,
  REVIEW_STEP_FALLBACK,
  REVIEW_TYPE_FALLBACK,
  isReviewAnomaly,
  nextReviewPollDelay,
  reviewCountsLabel,
  reviewPanelView,
  reviewSeverityCounts,
  reviewSeverityLabel,
  reviewSeverityTone,
  reviewStepLabel,
  reviewTypeLabel,
  shouldPollReview,
} from '../src/lib/chapter-review-panel';

function issue(severity: string, ordinal: number, type = 'prose_quality') {
  return {
    id: `issue-${String(ordinal)}`,
    ordinal,
    severity,
    type,
    evidence: '正文原句。',
    suggestion: '改一改。',
  };
}

interface ReviewOptions {
  readonly taskStatus?: ReviewTaskStatus;
  readonly step?: string | null;
  readonly attemptCount?: number;
  readonly taskError?: string | null;
  readonly run?: {
    readonly status: 'running' | 'succeeded' | 'failed';
    readonly passed?: boolean | null;
    readonly issueCount?: number;
    readonly errorCode?: string | null;
    readonly issues?: readonly ReturnType<typeof issue>[];
  } | null;
}

function review(options: ReviewOptions = {}): ChapterReviewView {
  const run = options.run === undefined ? null : options.run;
  return {
    candidateId: 'cand-1',
    task: {
      id: 'task-1',
      status: options.taskStatus ?? 'queued',
      currentStep: (options.step ?? null) as ChapterReviewView['task']['currentStep'],
      attemptCount: options.attemptCount ?? 0,
      errorCode: options.taskError ?? null,
    },
    run:
      run === null
        ? null
        : {
            id: 'run-1',
            status: run.status,
            passed: run.passed ?? null,
            issueCount: run.issueCount ?? run.issues?.length ?? 0,
            errorCode: run.errorCode ?? null,
            agentName: 'reviewer.chapter',
            agentVersion: '1.0.0',
            startedAt: '2026-11-06T01:00:00.000Z',
            finishedAt: run.status === 'running' ? null : '2026-11-06T01:00:30.000Z',
            issues: run.issues ?? [],
          },
  };
}

describe('中文标签', () => {
  it('severity 三档映射为高 / 中 / 低', () => {
    expect(reviewSeverityLabel('high')).toBe('高');
    expect(reviewSeverityLabel('medium')).toBe('中');
    expect(reviewSeverityLabel('low')).toBe('低');
  });

  it('七类问题类型都有中文标签', () => {
    const expected: Readonly<Record<string, string>> = {
      contract_violation: '合同偏离',
      setting_contradiction: '设定矛盾',
      timeline_conflict: '时间线冲突',
      item_state_conflict: '物品状态冲突',
      plot_thread_conflict: '情节线冲突',
      character_consistency: '人物一致性',
      prose_quality: '文风问题',
    };
    for (const [type, label] of Object.entries(expected)) {
      expect(reviewTypeLabel(type)).toBe(label);
    }
  });

  it('三个工作流步骤各有文案，未知步骤不暴露内部名', () => {
    expect(reviewStepLabel('load_review_input')).toBe('准备审阅上下文…');
    expect(reviewStepLabel('run_reviewer')).toBe('模型审阅中…');
    expect(reviewStepLabel('persist_review_result')).toBe('保存审阅结果…');
    expect(reviewStepLabel(null)).toBe(REVIEW_STEP_FALLBACK);
    expect(reviewStepLabel('run_writer')).toBe(REVIEW_STEP_FALLBACK);
  });

  it('未知 severity / type 回退到安全通用文案，不抛错、不回显原始值', () => {
    expect(reviewSeverityLabel('blocker')).toBe(REVIEW_SEVERITY_FALLBACK);
    expect(reviewTypeLabel('unknown_type')).toBe(REVIEW_TYPE_FALLBACK);
    expect(reviewSeverityLabel('')).toBe(REVIEW_SEVERITY_FALLBACK);
    expect(reviewTypeLabel('')).toBe(REVIEW_TYPE_FALLBACK);
  });

  it('严重度徽章色调：高 = danger、中 = warn、其余中性', () => {
    expect(reviewSeverityTone('high')).toBe('danger');
    expect(reviewSeverityTone('medium')).toBe('warn');
    expect(reviewSeverityTone('low')).toBe('muted');
    expect(reviewSeverityTone('blocker')).toBe('muted');
  });
});

describe('严重度统计', () => {
  it('按 high / medium / low 计数，未知值进 other', () => {
    const counts = reviewSeverityCounts([
      issue('high', 0),
      issue('high', 1),
      issue('medium', 2),
      issue('low', 3),
      issue('blocker', 4),
    ]);
    expect(counts).toEqual({ high: 2, medium: 1, low: 1, other: 1, total: 5 });
  });

  it('空列表为全 0', () => {
    expect(reviewSeverityCounts([])).toEqual({ high: 0, medium: 0, low: 0, other: 0, total: 0 });
  });

  it('统计文案固定顺序，未标注有值时才出现', () => {
    expect(reviewCountsLabel(reviewSeverityCounts([issue('high', 0), issue('low', 1)]))).toBe(
      '高 1 · 中 0 · 低 1',
    );
    expect(reviewCountsLabel(reviewSeverityCounts([issue('blocker', 0)]))).toBe(
      '高 0 · 中 0 · 低 0 · 未标注 1',
    );
  });
});

describe('面板状态', () => {
  it('loading / notfound / error 三种本地状态文案', () => {
    expect(reviewPanelView({ state: 'loading', review: null, errorText: '' })).toMatchObject({
      text: '正在读取审阅结果…',
      tone: 'info',
      canRetry: false,
    });
    expect(reviewPanelView({ state: 'notfound', review: null, errorText: '' })).toMatchObject({
      text: '暂无审阅结果',
      tone: 'muted',
      canRetry: false,
    });
    expect(
      reviewPanelView({ state: 'error', review: null, errorText: '网络异常，请稍后重试' }),
    ).toMatchObject({
      text: '审阅结果读取失败',
      detail: '网络异常，请稍后重试',
      tone: 'danger',
      canRetry: true,
    });
  });

  it('queued → 等待审阅；processing → 按步骤显示', () => {
    expect(reviewPanelView({ state: 'ready', review: review(), errorText: '' })).toMatchObject({
      text: '等待审阅…',
      tone: 'info',
      canRetry: false,
    });

    expect(
      reviewPanelView({
        state: 'ready',
        review: review({ taskStatus: 'processing', step: 'run_reviewer' }),
        errorText: '',
      }),
    ).toMatchObject({ text: '模型审阅中…', tone: 'info' });

    // 未知步骤不暴露内部值
    expect(
      reviewPanelView({
        state: 'ready',
        review: review({ taskStatus: 'processing', step: 'unknown_step' }),
        errorText: '',
      }),
    ).toMatchObject({ text: REVIEW_STEP_FALLBACK });
  });

  it('succeeded + passed → 未发现结构性问题', () => {
    const view = reviewPanelView({
      state: 'ready',
      review: review({
        taskStatus: 'succeeded',
        step: 'persist_review_result',
        run: { status: 'succeeded', passed: true, issueCount: 0, issues: [] },
      }),
      errorText: '',
    });
    expect(view).toMatchObject({ text: '未发现结构性问题', tone: 'ok', canRetry: false });
    // 通过时不显示全 0 的分档统计
    expect(view.counts).toBeNull();
  });

  it('succeeded + 有问题 → 总数 + 分档统计', () => {
    const view = reviewPanelView({
      state: 'ready',
      review: review({
        taskStatus: 'succeeded',
        run: {
          status: 'succeeded',
          passed: false,
          issueCount: 3,
          issues: [issue('high', 0), issue('medium', 1), issue('low', 2)],
        },
      }),
      errorText: '',
    });
    expect(view.text).toBe('发现 3 个问题');
    expect(view.detail).toBe('高 1 · 中 1 · 低 1');
    expect(view.tone).toBe('warn');
    // 有问题也不给"重新读取"：本轮不做手动重检
    expect(view.canRetry).toBe(false);
  });

  it('failed / cancelled 都给出"不影响采纳"的安全说明', () => {
    expect(
      reviewPanelView({
        state: 'ready',
        review: review({
          taskStatus: 'failed',
          taskError: 'MODEL_NETWORK_ERROR',
          run: { status: 'failed', errorCode: 'MODEL_NETWORK_ERROR' },
        }),
        errorText: '',
      }),
    ).toMatchObject({ text: '审阅未完成，不影响当前候选采纳', tone: 'warn', canRetry: false });

    expect(
      reviewPanelView({
        state: 'ready',
        review: review({
          taskStatus: 'cancelled',
          run: { status: 'failed', errorCode: 'TASK_CANCELLED' },
        }),
        errorText: '',
      }),
    ).toMatchObject({ text: '审阅已取消', tone: 'muted', canRetry: false });
  });

  it('task succeeded 但 run=null 属于异常：稳定错误态 + 可重新读取，不轮询', () => {
    const anomaly = review({ taskStatus: 'succeeded', step: 'persist_review_result' });
    expect(isReviewAnomaly(anomaly)).toBe(true);
    expect(shouldPollReview(anomaly)).toBe(false);

    expect(reviewPanelView({ state: 'ready', review: anomaly, errorText: '' })).toMatchObject({
      text: '审阅结果异常',
      tone: 'danger',
      canRetry: true,
    });
  });

  it('未知任务状态也不会让面板崩溃（走保守分支）', () => {
    const weird = review({ taskStatus: 'queued' });
    const patched: ChapterReviewView = {
      ...weird,
      task: { ...weird.task, status: 'paused' as ReviewTaskStatus },
    };
    const view = reviewPanelView({ state: 'ready', review: patched, errorText: '' });
    expect(typeof view.text).toBe('string');
    expect(view.text.length).toBeGreaterThan(0);
    expect(shouldPollReview(patched)).toBe(false);
  });
});

describe('轮询判定与退避', () => {
  it('queued / processing / running 需要轮询，终态停止', () => {
    expect(shouldPollReview(null)).toBe(false);
    expect(shouldPollReview(review({ taskStatus: 'queued' }))).toBe(true);
    expect(shouldPollReview(review({ taskStatus: 'processing', step: 'run_reviewer' }))).toBe(true);
    expect(shouldPollReview(review({ taskStatus: 'processing', run: { status: 'running' } }))).toBe(
      true,
    );
    expect(
      shouldPollReview(
        review({ taskStatus: 'succeeded', run: { status: 'succeeded', passed: true } }),
      ),
    ).toBe(false);
    expect(shouldPollReview(review({ taskStatus: 'failed', run: { status: 'failed' } }))).toBe(
      false,
    );
    expect(shouldPollReview(review({ taskStatus: 'cancelled' }))).toBe(false);
  });

  it('退避 1s → 2s → 5s 后保持 5s', () => {
    expect(REVIEW_POLL_DELAYS).toEqual([1_000, 2_000, 5_000]);
    expect(nextReviewPollDelay(1_000)).toBe(2_000);
    expect(nextReviewPollDelay(2_000)).toBe(5_000);
    expect(nextReviewPollDelay(5_000)).toBe(5_000);
    // 异常输入不产生 NaN / 负数间隔
    expect(nextReviewPollDelay(Number.NaN)).toBe(1_000);
    expect(nextReviewPollDelay(-1)).toBe(1_000);
  });
});
