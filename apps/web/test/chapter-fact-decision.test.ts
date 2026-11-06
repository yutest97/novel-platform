/**
 * 事实候选决策 UI 的纯展示逻辑（A2-F-C）。
 *
 * 覆盖：
 * - canDecide 门禁（章节定稿 / 候选属于最新版本 / 未决定 / 没有在提交）；
 * - accepted / rejected 的文案与色调、未知决定值的回退；
 * - stale / already / 网络错误的稳定文案；
 * - 旧版本与未定稿时的说明文案；
 * - 请求序号判定与徽章 CSS 类。
 */

import { describe, expect, it } from 'vitest';

import {
  FACT_DECISION_ERROR_FALLBACK,
  FACT_DECISION_ERROR_TEXTS,
  FACT_DECISION_FALLBACK_LABEL,
  FACT_DECISION_LABELS,
  FACT_DECISION_NOT_FINALIZED_HINT,
  FACT_DECISION_RECORDED_NOTE,
  FACT_DECISION_RECORDING_LABEL,
  FACT_DECISION_STALE_VERSION_HINT,
  canDecideFact,
  factDecisionBadge,
  factDecisionBadgeClass,
  factDecisionErrorText,
  factDecisionTimeLabel,
  factDecisionValue,
  factDecisionView,
  type FactDecisionInput,
} from '../src/lib/chapter-fact-decision';

const DECIDED_AT = '2026-11-06T03:00:00.000Z';

function input(overrides: Partial<FactDecisionInput> = {}): FactDecisionInput {
  return {
    chapterStatus: 'finalized',
    candidateSourceVersionId: 'v3',
    latestVersionId: 'v3',
    decision: null,
    submitting: false,
    ...overrides,
  };
}

describe('决定值归一化', () => {
  it('只接受 accepted / rejected', () => {
    expect(factDecisionValue('accepted')).toBe('accepted');
    expect(factDecisionValue('rejected')).toBe('rejected');
  });

  it('未知值 / 空值一律归一为 null（不当作已知决定）', () => {
    expect(factDecisionValue('approved')).toBeNull();
    expect(factDecisionValue('')).toBeNull();
    expect(factDecisionValue(null)).toBeNull();
    expect(factDecisionValue(undefined)).toBeNull();
  });
});

describe('已决徽章', () => {
  it('accepted 是成功色，rejected 是中性色', () => {
    expect(factDecisionBadge('accepted')).toEqual({ label: '已接受', tone: 'ok' });
    expect(factDecisionBadge('rejected')).toEqual({ label: '已拒绝', tone: 'muted' });
    expect(FACT_DECISION_LABELS).toEqual({ accepted: '已接受', rejected: '已拒绝' });
  });

  it('未决定没有徽章', () => {
    expect(factDecisionBadge(null)).toBeNull();
    expect(factDecisionBadge(undefined)).toBeNull();
    expect(factDecisionBadge('')).toBeNull();
  });

  it('未知决定值回退到中性文案，不回显原始枚举', () => {
    const badge = factDecisionBadge('approved');
    expect(badge).toEqual({ label: FACT_DECISION_FALLBACK_LABEL, tone: 'muted' });
    expect(badge?.label).not.toContain('approved');
  });

  it('徽章 CSS 类：成功色用 badge--ok，中性色用默认徽章', () => {
    expect(factDecisionBadgeClass('ok')).toBe('badge badge--ok');
    expect(factDecisionBadgeClass('muted')).toBe('badge');
  });

  it('决定时间文案带上"决定于"', () => {
    expect(factDecisionTimeLabel('2026/11/06 03:00')).toBe('决定于 2026/11/06 03:00');
  });
});

describe('错误文案', () => {
  it('冲突与过期各有稳定中文', () => {
    expect(factDecisionErrorText('CONTINUITY_FACT_ALREADY_DECIDED')).toBe(
      '该候选已做出不同决定，不能改判。',
    );
    expect(factDecisionErrorText('CONTINUITY_FACT_DECISION_STALE')).toBe(
      '章节或版本已变化，不能继续决定。',
    );
    expect(Object.keys(FACT_DECISION_ERROR_TEXTS)).toHaveLength(2);
  });

  it('未知错误码与网络异常都回退到通用文案，不回显原始异常', () => {
    expect(factDecisionErrorText('SOME_INTERNAL_DETAIL')).toBe(FACT_DECISION_ERROR_FALLBACK);
    expect(factDecisionErrorText(null)).toBe(FACT_DECISION_ERROR_FALLBACK);
    expect(FACT_DECISION_ERROR_FALLBACK).not.toContain('INTERNAL');
  });
});

describe('canDecide 门禁', () => {
  it('章节已定稿 + 候选属于最新版本 + 未决定 + 空闲 → 可以决定', () => {
    expect(canDecideFact(input())).toBe(true);
  });

  it('章节未定稿时不能决定', () => {
    expect(canDecideFact(input({ chapterStatus: 'in_review' }))).toBe(false);
    expect(canDecideFact(input({ chapterStatus: null }))).toBe(false);
  });

  it('候选不属于当前最新正式版本时不能决定', () => {
    expect(canDecideFact(input({ candidateSourceVersionId: 'v2' }))).toBe(false);
    expect(canDecideFact(input({ candidateSourceVersionId: null }))).toBe(false);
    expect(canDecideFact(input({ latestVersionId: null }))).toBe(false);
  });

  it('已决定或正在提交时不能决定', () => {
    expect(canDecideFact(input({ decision: { value: 'accepted', decidedAt: DECIDED_AT } }))).toBe(
      false,
    );
    expect(canDecideFact(input({ submitting: true }))).toBe(false);
  });
});

describe('决策态展示模型', () => {
  it('已决：显示徽章，隐藏接受 / 拒绝按钮', () => {
    const view = factDecisionView(
      input({ decision: { value: 'rejected', decidedAt: DECIDED_AT } }),
    );
    expect(view.state).toBe('decided');
    expect(view.badge).toEqual({ label: '已拒绝', tone: 'muted' });
    expect(view.showButtons).toBe(false);
    expect(view.canSubmit).toBe(false);
    expect(view.hint).toBe('');
  });

  it('已决时未知决定值也只显示回退徽章', () => {
    const view = factDecisionView(
      input({ decision: { value: 'approved', decidedAt: DECIDED_AT } }),
    );
    expect(view.state).toBe('decided');
    expect(view.badge?.label).toBe(FACT_DECISION_FALLBACK_LABEL);
  });

  it('章节未定稿：整个决定入口不出现，也不给候选级说明', () => {
    const view = factDecisionView(input({ chapterStatus: 'in_review' }));
    expect(view.state).toBe('not-finalized');
    expect(view.showButtons).toBe(false);
    expect(view.canSubmit).toBe(false);
    expect(view.hint).toBe('');
    expect(FACT_DECISION_NOT_FINALIZED_HINT).toBe('章节定稿后才能对事实候选做出决定。');
  });

  it('候选属于旧版本：给候选级说明，不提供决定按钮', () => {
    const view = factDecisionView(input({ candidateSourceVersionId: 'v2' }));
    expect(view.state).toBe('stale-version');
    expect(view.showButtons).toBe(false);
    expect(view.canSubmit).toBe(false);
    expect(view.hint).toBe(FACT_DECISION_STALE_VERSION_HINT);
    expect(FACT_DECISION_STALE_VERSION_HINT).toBe('仅当前最新定稿版本可做决定。');
  });

  it('提交中：按钮保留但禁用，文案是「记录中…」', () => {
    const view = factDecisionView(input({ submitting: true }));
    expect(view.state).toBe('submitting');
    expect(view.showButtons).toBe(true);
    expect(view.canSubmit).toBe(false);
    expect(FACT_DECISION_RECORDING_LABEL).toBe('记录中…');
  });

  it('可决定：按钮可用', () => {
    const view = factDecisionView(input());
    expect(view.state).toBe('decidable');
    expect(view.showButtons).toBe(true);
    expect(view.canSubmit).toBe(true);
    expect(view.hint).toBe('');
  });

  it('已决声明明确说明不会写回任何设定', () => {
    expect(FACT_DECISION_RECORDED_NOTE).toBe(
      '决定已记录；当前不会自动修改人物、物品、势力、关系或境界。',
    );
  });
});
