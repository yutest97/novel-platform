/**
 * Reviewer 结果响应解析（A2-C-D）。
 *
 * 只测纯逻辑 + 客户端封装：
 * - 合法响应（run=null / running / succeeded）能解析成稳定结构；
 * - 形状不符、状态未知、结论不自洽、问题顺序倒退 → 整份拒绝；
 * - `fetchChapterReview` 把解析失败收敛为 `INTERNAL_ERROR`，404 保留 `REVIEW_NOT_FOUND`。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError, fetchChapterReview } from '../src/lib/api.js';
import {
  ReviewPayloadError,
  parseChapterReview,
  type ChapterReviewView,
} from '../src/lib/chapter-review-view.js';

const CANDIDATE_ID = '11111111-1111-4111-8111-111111111111';
const TASK_ID = '22222222-2222-4222-8222-222222222222';
const RUN_ID = '33333333-3333-4333-8333-333333333333';

const QUEUED: ChapterReviewView = {
  candidateId: CANDIDATE_ID,
  task: {
    id: TASK_ID,
    status: 'queued',
    currentStep: null,
    attemptCount: 0,
    errorCode: null,
  },
  run: null,
};

const SUCCEEDED: ChapterReviewView = {
  candidateId: CANDIDATE_ID,
  task: {
    id: TASK_ID,
    status: 'succeeded',
    currentStep: 'persist_review_result',
    attemptCount: 1,
    errorCode: null,
  },
  run: {
    id: RUN_ID,
    status: 'succeeded',
    passed: false,
    issueCount: 2,
    errorCode: null,
    agentName: 'reviewer.chapter',
    agentVersion: '1.0.0',
    startedAt: '2026-11-06T01:00:00.000Z',
    finishedAt: '2026-11-06T01:00:30.000Z',
    issues: [
      {
        id: '44444444-4444-4444-8444-444444444444',
        ordinal: 0,
        severity: 'high',
        type: 'setting_contradiction',
        evidence: '他握紧了手中的剑。',
        suggestion: '与上一章设定冲突。',
      },
      {
        id: '55555555-5555-4555-8555-555555555555',
        ordinal: 1,
        severity: 'low',
        type: 'prose_quality',
        evidence: '风从演武场尽头吹来。',
        suggestion: '可减少重复描写。',
      },
    ],
  },
};

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function payload(review: unknown): unknown {
  return { review };
}

function succeededWith(mutate: (view: Record<string, unknown>) => void): unknown {
  const view = clone(SUCCEEDED) as unknown as Record<string, unknown>;
  mutate(view);
  return payload(view);
}

describe('parseChapterReview', () => {
  it('解析 queued（run=null）与 succeeded（含问题）', () => {
    expect(parseChapterReview(payload(clone(QUEUED)))).toEqual(QUEUED);
    expect(parseChapterReview(payload(clone(SUCCEEDED)))).toEqual(SUCCEEDED);
  });

  it('最外层不是对象、缺少 review → 拒绝', () => {
    expect(() => parseChapterReview(null)).toThrow(ReviewPayloadError);
    expect(() => parseChapterReview({})).toThrow(ReviewPayloadError);
    expect(() => parseChapterReview({ review: [] })).toThrow(ReviewPayloadError);
    expect(() => parseChapterReview({ review: { candidateId: CANDIDATE_ID } })).toThrow(
      ReviewPayloadError,
    );
  });

  it('未知任务状态 / 未知步骤 / 未知 run 状态 → 拒绝', () => {
    expect(() =>
      parseChapterReview(
        succeededWith((view) => {
          (view['task'] as Record<string, unknown>)['status'] = 'paused';
        }),
      ),
    ).toThrow(ReviewPayloadError);

    expect(() =>
      parseChapterReview(
        succeededWith((view) => {
          (view['task'] as Record<string, unknown>)['currentStep'] = 'run_writer';
        }),
      ),
    ).toThrow(ReviewPayloadError);

    expect(() =>
      parseChapterReview(
        succeededWith((view) => {
          (view['run'] as Record<string, unknown>)['status'] = 'cancelled';
        }),
      ),
    ).toThrow(ReviewPayloadError);
  });

  it('结论不自洽（running 却有 passed / succeeded 没有 passed / issueCount 不符）→ 拒绝', () => {
    // running 不应有 passed
    expect(() =>
      parseChapterReview(
        succeededWith((view) => {
          const run = view['run'] as Record<string, unknown>;
          run['status'] = 'running';
          run['finishedAt'] = null;
          run['issues'] = [];
          run['issueCount'] = 0;
        }),
      ),
    ).toThrow(ReviewPayloadError);

    // succeeded 必须有 passed
    expect(() =>
      parseChapterReview(
        succeededWith((view) => {
          (view['run'] as Record<string, unknown>)['passed'] = null;
        }),
      ),
    ).toThrow(ReviewPayloadError);

    // issueCount 必须等于返回的问题数（不允许"说有 5 条只给 2 条"）
    expect(() =>
      parseChapterReview(
        succeededWith((view) => {
          (view['run'] as Record<string, unknown>)['issueCount'] = 5;
        }),
      ),
    ).toThrow(ReviewPayloadError);
  });

  it('问题顺序必须严格升序、字段必须齐全', () => {
    expect(() =>
      parseChapterReview(
        succeededWith((view) => {
          const run = view['run'] as Record<string, unknown>;
          const issues = run['issues'] as Record<string, unknown>[];
          issues[1]!['ordinal'] = 0;
        }),
      ),
    ).toThrow(ReviewPayloadError);

    expect(() =>
      parseChapterReview(
        succeededWith((view) => {
          const run = view['run'] as Record<string, unknown>;
          const issues = run['issues'] as Record<string, unknown>[];
          delete issues[0]!['suggestion'];
        }),
      ),
    ).toThrow(ReviewPayloadError);

    expect(() =>
      parseChapterReview(
        succeededWith((view) => {
          const run = view['run'] as Record<string, unknown>;
          const issues = run['issues'] as Record<string, unknown>[];
          issues[0]!['severity'] = '';
        }),
      ),
    ).toThrow(ReviewPayloadError);
  });

  it('时间戳必须可解析；attemptCount / ordinal 必须是非负整数', () => {
    expect(() =>
      parseChapterReview(
        succeededWith((view) => {
          (view['run'] as Record<string, unknown>)['startedAt'] = '昨天';
        }),
      ),
    ).toThrow(ReviewPayloadError);

    expect(() =>
      parseChapterReview(
        succeededWith((view) => {
          (view['task'] as Record<string, unknown>)['attemptCount'] = -1;
        }),
      ),
    ).toThrow(ReviewPayloadError);

    expect(() =>
      parseChapterReview(
        succeededWith((view) => {
          (view['task'] as Record<string, unknown>)['attemptCount'] = 1.5;
        }),
      ),
    ).toThrow(ReviewPayloadError);
  });
});

function stubFetch(status: number, body: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve({
        ok: status >= 200 && status < 300,
        status,
        json: () => Promise.resolve(body),
      }),
    ),
  );
}

describe('fetchChapterReview', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('解析成功时返回稳定结构', async () => {
    stubFetch(200, payload(clone(SUCCEEDED)));
    await expect(fetchChapterReview('w', 'c', CANDIDATE_ID)).resolves.toEqual(SUCCEEDED);
  });

  it('404 保留 REVIEW_NOT_FOUND', async () => {
    stubFetch(404, { error: { code: 'REVIEW_NOT_FOUND', message: '审阅结果不存在' } });
    await expect(fetchChapterReview('w', 'c', CANDIDATE_ID)).rejects.toMatchObject({
      code: 'REVIEW_NOT_FOUND',
      status: 404,
    });
  });

  it('响应形状不合法 → INTERNAL_ERROR（不展示半截审阅结果）', async () => {
    stubFetch(200, { review: { candidateId: CANDIDATE_ID } });
    await expect(fetchChapterReview('w', 'c', CANDIDATE_ID)).rejects.toBeInstanceOf(ApiError);
    await expect(fetchChapterReview('w', 'c', CANDIDATE_ID)).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
    });
  });
});
