/**
 * 版本对比展示层纯逻辑（A1-4B-C-B）。
 *
 * 重点验证**严格解析**：字段缺失 / 类型不符 / 行号与 kind 不自洽 /
 * stats 与实际行数矛盾，都必须拒绝，而不是把半截数据画到界面上。
 */

import { describe, expect, it } from 'vitest';

import {
  DiffPayloadError,
  defaultDiffSelection,
  diffLineClass,
  diffLineLabel,
  diffStatsLabel,
  diffVersionLabel,
  isIdenticalDiff,
  lineNoPlaceholder,
  parseChapterVersionDiff,
  restoreConfirmMessage,
  restoredNotice,
} from '../src/lib/chapter-diff-view.js';

const FROM = {
  id: '11111111-1111-4111-8111-111111111111',
  versionNo: 1,
  source: 'ai',
  wordCount: 2000,
};
const TO = {
  id: '22222222-2222-4222-8222-222222222222',
  versionNo: 2,
  source: 'human',
  wordCount: 2100,
};

function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    diff: {
      fromVersion: FROM,
      toVersion: TO,
      lines: [
        { kind: 'equal', oldLineNo: 1, newLineNo: 1, text: '第一行' },
        { kind: 'removed', oldLineNo: 2, newLineNo: null, text: '旧句子' },
        { kind: 'added', oldLineNo: null, newLineNo: 2, text: '新句子' },
      ],
      stats: { added: 1, removed: 1, unchanged: 1 },
      ...overrides,
    },
  };
}

describe('严格解析 diff 响应', () => {
  it('合法响应：版本元信息、行、统计都被保留', () => {
    const diff = parseChapterVersionDiff(payload());
    expect(diff.fromVersion).toEqual(FROM);
    expect(diff.toVersion).toEqual(TO);
    expect(diff.lines).toHaveLength(3);
    expect(diff.stats).toEqual({ added: 1, removed: 1, unchanged: 1 });
  });

  it('缺少 diff / 不是对象 → 抛 DiffPayloadError', () => {
    expect(() => parseChapterVersionDiff(null)).toThrow(DiffPayloadError);
    expect(() => parseChapterVersionDiff({})).toThrow(DiffPayloadError);
    expect(() => parseChapterVersionDiff({ diff: [] })).toThrow(DiffPayloadError);
  });

  it('版本元信息缺字段 / 版本号非法 → 抛', () => {
    expect(() => parseChapterVersionDiff(payload({ fromVersion: { id: 'x' } }))).toThrow(
      DiffPayloadError,
    );
    expect(() => parseChapterVersionDiff(payload({ toVersion: { ...TO, versionNo: 0 } }))).toThrow(
      DiffPayloadError,
    );
    expect(() => parseChapterVersionDiff(payload({ toVersion: { ...TO, wordCount: -1 } }))).toThrow(
      DiffPayloadError,
    );
  });

  it('lines 不是数组 / 行不是对象 → 抛', () => {
    expect(() => parseChapterVersionDiff(payload({ lines: 'nope' }))).toThrow(DiffPayloadError);
    expect(() => parseChapterVersionDiff(payload({ lines: [null] }))).toThrow(DiffPayloadError);
  });

  it('未知 kind → 抛', () => {
    expect(() =>
      parseChapterVersionDiff(
        payload({ lines: [{ kind: 'changed', oldLineNo: 1, newLineNo: 1, text: 'x' }] }),
      ),
    ).toThrow(DiffPayloadError);
  });

  it('行号与 kind 不自洽 → 抛（added 带旧行号 / removed 带新行号 / equal 缺行号）', () => {
    expect(() =>
      parseChapterVersionDiff(
        payload({ lines: [{ kind: 'added', oldLineNo: 1, newLineNo: 2, text: 'x' }] }),
      ),
    ).toThrow(DiffPayloadError);
    expect(() =>
      parseChapterVersionDiff(
        payload({ lines: [{ kind: 'removed', oldLineNo: 1, newLineNo: 2, text: 'x' }] }),
      ),
    ).toThrow(DiffPayloadError);
    expect(() =>
      parseChapterVersionDiff(
        payload({ lines: [{ kind: 'equal', oldLineNo: null, newLineNo: 1, text: 'x' }] }),
      ),
    ).toThrow(DiffPayloadError);
  });

  it('行号 0 / 负数 / 非整数 → 抛', () => {
    for (const bad of [0, -1, 1.5]) {
      expect(() =>
        parseChapterVersionDiff(
          payload({ lines: [{ kind: 'removed', oldLineNo: bad, newLineNo: null, text: 'x' }] }),
        ),
      ).toThrow(DiffPayloadError);
    }
  });

  it('stats 与实际行数矛盾 → 抛（宁可报错也不显示打架的数字）', () => {
    expect(() =>
      parseChapterVersionDiff(payload({ stats: { added: 2, removed: 1, unchanged: 1 } })),
    ).toThrow(DiffPayloadError);
    expect(() => parseChapterVersionDiff(payload({ stats: { added: 1, removed: 1 } }))).toThrow(
      DiffPayloadError,
    );
  });
});

describe('默认选择器', () => {
  it('无版本 → null', () => {
    expect(defaultDiffSelection([])).toBeNull();
  });

  it('只有一个版本 → 自己比自己', () => {
    expect(defaultDiffSelection([{ id: 'only' }])).toEqual({
      fromVersionId: 'only',
      toVersionId: 'only',
    });
  });

  it('多个版本 → 目标最新、起始上一版（列表本身是 versionNo 倒序）', () => {
    expect(defaultDiffSelection([{ id: 'v3' }, { id: 'v2' }, { id: 'v1' }])).toEqual({
      fromVersionId: 'v2',
      toVersionId: 'v3',
    });
  });
});

describe('展示文案', () => {
  it('内容一致判定只看增删行数', () => {
    expect(isIdenticalDiff({ added: 0, removed: 0, unchanged: 12 })).toBe(true);
    expect(isIdenticalDiff({ added: 1, removed: 0, unchanged: 12 })).toBe(false);
    expect(isIdenticalDiff({ added: 0, removed: 1, unchanged: 12 })).toBe(false);
  });

  it('统计与行标签是中文，不依赖颜色', () => {
    expect(diffStatsLabel({ added: 3, removed: 2, unchanged: 10 })).toBe(
      '新增 3 行 · 删除 2 行 · 未变化 10 行',
    );
    expect(diffLineLabel('added')).toBe('新增');
    expect(diffLineLabel('removed')).toBe('删除');
    expect(diffLineLabel('equal')).toBe('');
  });

  it('行类名、行号占位与版本元信息', () => {
    expect(diffLineClass('added')).toBe('diff-line diff-line--added');
    expect(diffLineClass('removed')).toBe('diff-line diff-line--removed');
    expect(lineNoPlaceholder(null)).toBe('·');
    expect(lineNoPlaceholder(7)).toBe('7');
    expect(diffVersionLabel(FROM, (source) => (source === 'human' ? '人工' : 'AI'))).toBe(
      '版本 1 · AI · 2000 字',
    );
  });

  it('恢复文案明确"创建新版本、不删除历史"', () => {
    expect(restoreConfirmMessage(2)).toContain('版本 2');
    expect(restoreConfirmMessage(2)).toContain('创建');
    expect(restoreConfirmMessage(2)).toContain('不会被删除');
    expect(restoredNotice(1, 3)).toBe('已从版本 1 恢复为版本 3');
  });
});
