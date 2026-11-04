/**
 * 章节人工编辑器纯逻辑（A1-4B-B）。
 *
 * 只测纯函数：字数预览、编辑基线选择、dirty 与错误码映射。
 * 真实保存链路由 `apps/web/test/chapter-human-version.test.ts`（服务 + API）
 * 与浏览器 E2E 覆盖。
 */

import { describe, expect, it } from 'vitest';

import {
  MAX_HUMAN_CONTENT_CHARS,
  MIN_HUMAN_CONTENT_CHARS,
  canEditSelectedVersion,
  countDraftChars,
  draftMetrics,
  editorErrorNotice,
  editorMetricsLabel,
  editorTarget,
  isDraftDirty,
  type VersionOption,
} from '../src/lib/chapter-editor';

function text(chars: number): string {
  return '字'.repeat(chars);
}

const versions: readonly VersionOption[] = [
  { id: 'v3', versionNo: 3 },
  { id: 'v2', versionNo: 2 },
  { id: 'v1', versionNo: 1 },
];

describe('字数预览', () => {
  it('忽略所有空白字符，按码点计数（与服务端 countWords 同口径）', () => {
    expect(countDraftChars('')).toBe(0);
    expect(countDraftChars('  \n\t\r\n')).toBe(0);
    expect(countDraftChars('他 握紧 了 剑')).toBe(5);
    // 全角空格同样算空白
    expect(countDraftChars('他\u3000握紧')).toBe(3);
    // 表情按码点计 1 个
    expect(countDraftChars('🙂')).toBe(1);
  });

  it('距离下限的差值随字符数递减，达下限后为 0', () => {
    expect(draftMetrics(text(0)).shortfall).toBe(MIN_HUMAN_CONTENT_CHARS);
    expect(draftMetrics(text(1_199)).shortfall).toBe(1);
    expect(draftMetrics(text(1_200)).shortfall).toBe(0);
    expect(draftMetrics(text(1_800)).shortfall).toBe(0);
  });

  it('只有 [1200, 200000] 区间内才可保存', () => {
    expect(draftMetrics('').canSave).toBe(false);
    expect(draftMetrics('   ').canSave).toBe(false);
    expect(draftMetrics(text(1_199)).canSave).toBe(false);
    expect(draftMetrics(text(1_200)).canSave).toBe(true);
    expect(draftMetrics(text(MAX_HUMAN_CONTENT_CHARS)).canSave).toBe(true);
    expect(draftMetrics(text(MAX_HUMAN_CONTENT_CHARS + 1)).canSave).toBe(false);
    expect(draftMetrics(text(MAX_HUMAN_CONTENT_CHARS + 1)).overLimit).toBe(true);
  });

  it('空白不计入字数：带换行的 1200 字正文仍可保存', () => {
    const content = `${text(600)}\n\n${text(600)}`;
    const metrics = draftMetrics(content);
    expect(metrics.chars).toBe(1_200);
    expect(metrics.canSave).toBe(true);
  });

  it('指标文案区分「还需 N 字」「已达下限」「超过上限」', () => {
    expect(editorMetricsLabel(draftMetrics(text(800)))).toBe(
      `非空白字符 800 · 还需 ${MIN_HUMAN_CONTENT_CHARS - 800} 字`,
    );
    expect(editorMetricsLabel(draftMetrics(text(1_200)))).toBe('非空白字符 1200 · 已达可保存下限');
    expect(editorMetricsLabel(draftMetrics(text(MAX_HUMAN_CONTENT_CHARS + 5)))).toBe(
      `非空白字符 ${MAX_HUMAN_CONTENT_CHARS + 5} · 超过上限 5 字`,
    );
  });
});

describe('dirty 判定', () => {
  it('与基线逐字符比较（不 trim，避免隐藏改动）', () => {
    expect(isDraftDirty('正文', '正文')).toBe(false);
    expect(isDraftDirty('正文 ', '正文')).toBe(true);
    expect(isDraftDirty('\n正文', '正文')).toBe(true);
    expect(isDraftDirty('', '')).toBe(false);
  });
});

describe('编辑基线', () => {
  it('没有版本时是首版：baseVersionId=null', () => {
    expect(editorTarget([])).toEqual({ baseVersionId: null, versionNo: null, mode: 'first' });
  });

  it('有版本时只能以最新版本为 base', () => {
    expect(editorTarget(versions)).toEqual({
      baseVersionId: 'v3',
      versionNo: 3,
      mode: 'latest',
    });
    // 即使传入顺序被打乱，也以列表首项（versionNo 倒序）为最新
    expect(editorTarget([{ id: 'x', versionNo: 9 }]).baseVersionId).toBe('x');
  });

  it('只有选中最新版本才允许编辑', () => {
    expect(canEditSelectedVersion('v3', versions)).toBe(true);
    expect(canEditSelectedVersion('v2', versions)).toBe(false);
    expect(canEditSelectedVersion('v1', versions)).toBe(false);
    expect(canEditSelectedVersion(null, versions)).toBe(false);
    expect(canEditSelectedVersion('v3', [])).toBe(false);
  });
});

describe('保存错误码映射', () => {
  it('正文不合法 / 状态不允许：只提示，不给重新载入', () => {
    expect(editorErrorNotice('CHAPTER_CONTENT_INVALID', 'fallback')).toEqual({
      text: '章节正文不合法，请检查字数和内容',
      reloadable: false,
    });
    expect(editorErrorNotice('CHAPTER_STATE_INVALID_FOR_SAVE', 'fallback')).toEqual({
      text: '章节当前状态不允许保存人工版本',
      reloadable: false,
    });
  });

  it('基线冲突：提示已被更新，并给出「载入最新版本」', () => {
    expect(editorErrorNotice('CHAPTER_VERSION_CONFLICT', 'fallback')).toEqual({
      text: '正文已被其他操作更新，请重新载入最新版本',
      reloadable: true,
    });
  });

  it('并发冲突：可重试提示，不需要重新载入', () => {
    expect(editorErrorNotice('CONCURRENT_MODIFICATION', 'fallback')).toEqual({
      text: '数据已被其他操作修改，请重试',
      reloadable: false,
    });
  });

  it('未知错误回落到统一文案，不透出服务端原始消息', () => {
    expect(editorErrorNotice('INTERNAL_ERROR', '服务内部错误，请稍后重试')).toEqual({
      text: '服务内部错误，请稍后重试',
      reloadable: false,
    });
    expect(editorErrorNotice('', '网络异常，请稍后重试')).toEqual({
      text: '网络异常，请稍后重试',
      reloadable: false,
    });
  });
});
