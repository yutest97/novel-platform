/**
 * 章节版本摘要响应解析与客户端封装（A2-D-D）。
 *
 * 覆盖：
 * - 合法响应解析成稳定结构；
 * - 字段缺失 / 类型不符 / 摘要为空或超长 / 时间戳不可解析 → 整份拒绝；
 * - `fetchChapterVersionSummary` 解析失败收敛为 `INTERNAL_ERROR`，404 保留 `SUMMARY_NOT_FOUND`。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError, fetchChapterVersionSummary } from '../src/lib/api.js';
import {
  MAX_SUMMARY_TEXT_CHARS,
  SummaryPayloadError,
  parseChapterVersionSummary,
  type ChapterSummaryRecord,
} from '../src/lib/chapter-summary-view.js';

const RECORD: ChapterSummaryRecord = {
  id: '11111111-1111-4111-8111-111111111111',
  chapterId: '22222222-2222-4222-8222-222222222222',
  sourceVersionId: '33333333-3333-4333-8333-333333333333',
  versionNo: 3,
  summary: '主角在演武场初次显露天赋，并立下三月之约。',
  agentName: 'summarizer.chapter',
  agentVersion: '1.0.0',
  createdAt: '2026-11-06T02:00:00.000Z',
};

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function payload(record: unknown): unknown {
  return { summary: record };
}

function withRecord(mutate: (record: Record<string, unknown>) => void): unknown {
  const record = clone(RECORD) as unknown as Record<string, unknown>;
  mutate(record);
  return payload(record);
}

describe('parseChapterVersionSummary', () => {
  it('解析合法响应', () => {
    expect(parseChapterVersionSummary(payload(clone(RECORD)))).toEqual(RECORD);
  });

  it('最外层或 summary 不是对象 → 拒绝', () => {
    expect(() => parseChapterVersionSummary(null)).toThrow(SummaryPayloadError);
    expect(() => parseChapterVersionSummary({})).toThrow(SummaryPayloadError);
    expect(() => parseChapterVersionSummary({ summary: [] })).toThrow(SummaryPayloadError);
    expect(() => parseChapterVersionSummary({ summary: '字符串' })).toThrow(SummaryPayloadError);
  });

  it('字段缺失或为空串 → 拒绝', () => {
    for (const key of [
      'id',
      'chapterId',
      'sourceVersionId',
      'summary',
      'agentName',
      'agentVersion',
      'createdAt',
    ]) {
      expect(() =>
        parseChapterVersionSummary(
          withRecord((record) => {
            record[key] = '';
          }),
        ),
      ).toThrow(SummaryPayloadError);
      expect(() =>
        parseChapterVersionSummary(
          withRecord((record) => {
            delete record[key];
          }),
        ),
      ).toThrow(SummaryPayloadError);
    }
  });

  it('versionNo 必须是正整数，createdAt 必须可解析', () => {
    for (const versionNo of [0, -1, 1.5, '3']) {
      expect(() =>
        parseChapterVersionSummary(
          withRecord((record) => {
            record['versionNo'] = versionNo;
          }),
        ),
      ).toThrow(SummaryPayloadError);
    }
    expect(() =>
      parseChapterVersionSummary(
        withRecord((record) => {
          record['createdAt'] = '刚刚';
        }),
      ),
    ).toThrow(SummaryPayloadError);
  });

  it('摘要超长 → 拒绝（不把异常数据当正常摘要展示）', () => {
    expect(() =>
      parseChapterVersionSummary(
        withRecord((record) => {
          record['summary'] = '字'.repeat(MAX_SUMMARY_TEXT_CHARS + 1);
        }),
      ),
    ).toThrow(SummaryPayloadError);

    // 边界值本身合法
    const boundary = withRecord((record) => {
      record['summary'] = '字'.repeat(MAX_SUMMARY_TEXT_CHARS);
    });
    expect(parseChapterVersionSummary(boundary).summary).toHaveLength(MAX_SUMMARY_TEXT_CHARS);
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

describe('fetchChapterVersionSummary', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('解析成功时返回稳定结构', async () => {
    stubFetch(200, payload(clone(RECORD)));
    await expect(fetchChapterVersionSummary('w', 'c', 'v')).resolves.toEqual(RECORD);
  });

  it('404 保留 SUMMARY_NOT_FOUND', async () => {
    stubFetch(404, { error: { code: 'SUMMARY_NOT_FOUND', message: '章节摘要不存在' } });
    await expect(fetchChapterVersionSummary('w', 'c', 'v')).rejects.toMatchObject({
      code: 'SUMMARY_NOT_FOUND',
      status: 404,
    });
  });

  it('响应形状不合法 → INTERNAL_ERROR', async () => {
    stubFetch(200, { summary: { id: 'x' } });
    await expect(fetchChapterVersionSummary('w', 'c', 'v')).rejects.toBeInstanceOf(ApiError);
    await expect(fetchChapterVersionSummary('w', 'c', 'v')).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
    });
  });
});
