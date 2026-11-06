/**
 * 连续性事实面板纯展示逻辑（A2-E）。
 *
 * 覆盖：
 * - 六类标签、过滤项顺序与未知值回退；
 * - total / truncated 文案（截断必须显式提示，不静默）；
 * - 两种空态（完全没有候选 vs 当前筛选为空）；
 * - 提取失败的稳定中文文案与成功提示；
 * - 能否提取的判定与说明；
 * - 请求序号边界；引用标签只给简短 id / 安全名称。
 */

import { describe, expect, it } from 'vitest';

import type { ChapterFactListItem } from '../src/lib/api';
import {
  FACT_FILTER_ALL,
  FACT_FILTER_OPTIONS,
  FACT_TYPE_LABELS,
  FACTS_LIST_LIMIT,
  canExtractFacts,
  factExtractErrorText,
  factExtractNotice,
  factFilterLabel,
  factFilterQuery,
  factRefLabels,
  factThreadStatusLabel,
  factTypeLabel,
  factsEmptyView,
  factsExtractHint,
  factsTotalLabel,
  factsTruncatedNotice,
  isCurrentFactRequest,
  shortFactId,
} from '../src/lib/chapter-facts-panel';

function fact(overrides: Partial<ChapterFactListItem> = {}): ChapterFactListItem {
  return {
    id: '4b1d0f6a-0f1e-4a1c-9d3b-6f2e8a7c5b40',
    runId: '9d0e6f42-1111-4222-8333-444455556666',
    sourceVersionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    sourceVersionNo: 3,
    factType: 'character_state',
    summary: '主角在演武场突破到炼气三层。',
    reason: '正文写到气海扩张、气息变化。',
    subjectId: '11111111-2222-4333-8444-555555555555',
    objectId: null,
    name: null,
    threadStatus: null,
    createdAt: '2026-11-06T03:00:00.000Z',
    decision: null,
    ...overrides,
  };
}

describe('六类标签与过滤项', () => {
  it('六类 factType 都有中文标签', () => {
    expect(FACT_TYPE_LABELS).toEqual({
      character_state: '人物状态',
      relationship_change: '关系变化',
      item_change: '物品变化',
      realm_progress: '境界进展',
      plot_thread: '情节线索',
      location_change: '人物位置',
    });
    for (const [type, label] of Object.entries(FACT_TYPE_LABELS)) {
      expect(factTypeLabel(type)).toBe(label);
    }
  });

  it('未知 / 空 factType 回退到安全文案，不回显原始枚举', () => {
    expect(factTypeLabel('unknown_type')).toBe('其它事实');
    expect(factTypeLabel('')).toBe('其它事实');
  });

  it('过滤项顺序固定为「全部 + 六类」，标签与类型一致', () => {
    expect(FACT_FILTER_OPTIONS.map((option) => option.value)).toEqual([
      'all',
      'character_state',
      'relationship_change',
      'item_change',
      'realm_progress',
      'plot_thread',
      'location_change',
    ]);
    expect(FACT_FILTER_OPTIONS.map((option) => option.label)).toEqual([
      '全部',
      '人物状态',
      '关系变化',
      '物品变化',
      '境界进展',
      '情节线索',
      '人物位置',
    ]);
    expect(factFilterLabel('plot_thread')).toBe('情节线索');
    expect(factFilterLabel('all')).toBe('全部');
    expect(factFilterLabel('nope')).toBe('全部');
  });

  it('过滤值 → 查询参数：all / 未知值都不传 factType', () => {
    expect(factFilterQuery('all')).toBeUndefined();
    expect(factFilterQuery('nope')).toBeUndefined();
    expect(factFilterQuery('character_state')).toBe('character_state');
    expect(factFilterQuery('location_change')).toBe('location_change');
  });

  it('线索状态中文化，未知值回退', () => {
    expect(factThreadStatusLabel('new')).toBe('新线索');
    expect(factThreadStatusLabel('advanced')).toBe('有推进');
    expect(factThreadStatusLabel('resolved')).toBe('已解决');
    expect(factThreadStatusLabel('archived')).toBe('状态未知');
  });
});

describe('总数与截断文案', () => {
  it('全部过滤显示总数，指定过滤时说明是筛选结果', () => {
    expect(factsTotalLabel(12, FACT_FILTER_ALL)).toBe('共 12 条候选');
    expect(factsTotalLabel(3, 'plot_thread')).toBe('当前筛选共 3 条候选');
  });

  it('非法 / 负数总数按 0 处理，不出现 NaN', () => {
    expect(factsTotalLabel(Number.NaN, FACT_FILTER_ALL)).toBe('共 0 条候选');
    expect(factsTotalLabel(-5, FACT_FILTER_ALL)).toBe('共 0 条候选');
    expect(factsTotalLabel(2.7, FACT_FILTER_ALL)).toBe('共 2 条候选');
  });

  it('截断提示带完整 total 与上限，绝不静默', () => {
    expect(factsTruncatedNotice(240)).toBe('结果较多：共 240 条候选，仅显示最近 200 条。');
    expect(FACTS_LIST_LIMIT).toBe(200);
    expect(factsTruncatedNotice(Number.NaN)).toContain('共 0 条候选');
  });
});

describe('空态文案', () => {
  it('全部过滤且没有候选：提示去提取', () => {
    const view = factsEmptyView({ filter: FACT_FILTER_ALL, allTotal: 0 });
    expect(view.title).toBe('还没有事实候选');
    expect(view.detail).toContain('章节定稿后可以提取');
  });

  it('当前过滤为空但确实有候选：提示切换筛选', () => {
    const view = factsEmptyView({ filter: 'plot_thread', allTotal: 5 });
    expect(view.title).toBe('当前筛选下没有候选');
    expect(view.detail).toContain('情节线索');
    expect(view.detail).toContain('「全部」');
  });

  it('已知整体为 0 时，筛选为空也属于"还没有候选"', () => {
    const view = factsEmptyView({ filter: 'item_change', allTotal: 0 });
    expect(view.title).toBe('还没有事实候选');
    expect(view.detail).toContain('还没有任何事实候选');
  });

  it('整体总数未知时不声称"没有任何候选"', () => {
    const view = factsEmptyView({ filter: 'item_change', allTotal: null });
    expect(view.title).toBe('当前筛选下没有候选');
  });

  it('未知过滤值按筛选空态处理，不抛错', () => {
    expect(factsEmptyView({ filter: 'nope', allTotal: 3 }).title).toBe('当前筛选下没有候选');
  });
});

describe('提取提示与错误文案', () => {
  it('六类连续性错误码都有稳定中文文案', () => {
    expect(factExtractErrorText('CONTINUITY_EXTRACTION_IN_PROGRESS')).toBe(
      '该版本正在提取连续性事实，请稍后重试。',
    );
    expect(factExtractErrorText('CONTINUITY_EXTRACTION_LEASE_LOST')).toContain('新的尝试接管');
    expect(factExtractErrorText('CONTINUITY_CHAPTER_NOT_FINALIZED')).toContain('尚未定稿');
    expect(factExtractErrorText('CONTINUITY_SOURCE_VERSION_STALE')).toContain('最新版本已变化');
    expect(factExtractErrorText('CONTINUITY_FACTS_INVALID')).toContain('没有写入任何候选');
    expect(factExtractErrorText('CONTINUITY_EXTRACTION_FAILED')).toContain('稍后重试');
  });

  it('未知错误码 / 非 API 错误回退到通用文案，不回显原始值', () => {
    expect(factExtractErrorText('SOME_INTERNAL_DETAIL')).toBe('提取失败，请稍后重试。');
    expect(factExtractErrorText(null)).toBe('提取失败，请稍后重试。');
  });

  it('created=true 是"已提取"，created=false 是"已读取既有结果"', () => {
    expect(factExtractNotice(true, 4)).toContain('已提取 4 条候选');
    expect(factExtractNotice(false, 4)).toContain('已读取既有结果');
    expect(factExtractNotice(false, 4)).toContain('4 条候选');
    expect(factExtractNotice(true, 0)).toContain('已提取 0 条候选');
  });
});

describe('能否提取', () => {
  const base = {
    chapterStatus: 'finalized',
    selectedVersionId: 'v3',
    latestVersionId: 'v3',
    versionLoading: false,
    extracting: false,
  } as const;

  it('已定稿 + 选中最新版本 + 空闲 → 可以提取', () => {
    expect(canExtractFacts(base)).toBe(true);
  });

  it('未定稿 / 章节状态未知时不能提取', () => {
    expect(canExtractFacts({ ...base, chapterStatus: 'in_review' })).toBe(false);
    expect(canExtractFacts({ ...base, chapterStatus: null })).toBe(false);
  });

  it('选中历史版本 / 没有版本 / 正在读版本 / 正在提取时不能提取', () => {
    expect(canExtractFacts({ ...base, selectedVersionId: 'v2' })).toBe(false);
    expect(canExtractFacts({ ...base, selectedVersionId: null })).toBe(false);
    expect(canExtractFacts({ ...base, latestVersionId: null })).toBe(false);
    expect(canExtractFacts({ ...base, versionLoading: true })).toBe(false);
    expect(canExtractFacts({ ...base, extracting: true })).toBe(false);
  });

  it('说明文案区分"未定稿"与"不是最新版本"', () => {
    expect(factsExtractHint({ ...base, chapterStatus: 'in_review' })).toBe(
      '章节定稿后才能提取连续性事实候选。',
    );
    expect(factsExtractHint({ ...base, selectedVersionId: 'v2' })).toBe(
      '提取仅针对最新正式版本，请先选择最新版本。',
    );
    expect(factsExtractHint({ ...base, chapterStatus: null })).toBe('正在读取章节状态…');
    expect(factsExtractHint(base)).toBe('');
  });
});

describe('请求序号与引用标签', () => {
  it('只有最新序号的响应可以落地', () => {
    expect(isCurrentFactRequest(3, 3)).toBe(true);
    // 「人物状态 → 全部 → 人物状态」：首尾参数相同，中间响应必须静默
    expect(isCurrentFactRequest(2, 3)).toBe(false);
    expect(isCurrentFactRequest(0, 1)).toBe(false);
    expect(isCurrentFactRequest(4, 3)).toBe(false);
  });

  it('简短 id 只保留前 8 位，短 id 原样返回', () => {
    expect(shortFactId('4b1d0f6a-0f1e-4a1c-9d3b-6f2e8a7c5b40')).toBe('4b1d0f6a…');
    expect(shortFactId('abc')).toBe('abc');
  });

  it('引用只给简短 id / 安全名称，不展开正文', () => {
    expect(factRefLabels(fact())).toEqual(['主体 11111111…']);

    const relation = fact({
      factType: 'relationship_change',
      objectId: '99999999-8888-4777-8666-555555555555',
    });
    expect(factRefLabels(relation)).toEqual(['主体 11111111…', '客体 99999999…']);

    const location = fact({ factType: 'location_change', name: '雨夜山门' });
    expect(factRefLabels(location)).toContain('地点 雨夜山门');

    const thread = fact({
      factType: 'plot_thread',
      subjectId: null,
      threadStatus: 'advanced',
    });
    expect(factRefLabels(thread)).toEqual(['线索有推进']);

    const empty = fact({ subjectId: null, objectId: null, name: null, threadStatus: null });
    expect(factRefLabels(empty)).toEqual([]);
  });

  it('空串 id / 名称不会产生多余标签', () => {
    expect(
      factRefLabels(fact({ subjectId: '', objectId: '', name: '', threadStatus: '' })),
    ).toEqual([]);
  });
});
