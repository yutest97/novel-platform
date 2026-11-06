/**
 * 事实候选决策 UI 的纯展示逻辑（A2-F-C）。
 *
 * 与 `chapter-facts-panel.ts`（列表展示）分工不同，这里只负责**决策态**：
 * - 能不能做决定（章节定稿 + 候选属于当前最新正式版本 + 尚未决定 + 没有在提交）；
 * - 已决徽章的文案与色调（accepted / rejected / 未知值回退）；
 * - 冲突、过期、网络错误的稳定中文文案。
 *
 * 硬边界：
 * - 只**记录**决定：不写回人物 / 物品 / 势力 / 关系 / 境界，也没有撤销 / 改判；
 * - 不展示 decidedBy、payload 副本、正文、prompt、provider / model；
 * - 不依赖 React、不发请求、不写存储，可直接单测。
 */

/** 决定值的稳定白名单（与服务端一致）。 */
export const FACT_DECISION_VALUES = ['accepted', 'rejected'] as const;

export type FactDecisionValue = (typeof FACT_DECISION_VALUES)[number];

/** 决定徽章的色调：接受 = 成功色，拒绝 = 中性色。 */
export type FactDecisionTone = 'ok' | 'muted';

export interface FactDecisionBadge {
  readonly label: string;
  readonly tone: FactDecisionTone;
}

/** 两个决定的稳定文案。 */
export const FACT_DECISION_LABELS: Readonly<Record<FactDecisionValue, string>> = {
  accepted: '已接受',
  rejected: '已拒绝',
};

/** 未知决定值的回退文案：不回显原始枚举，也不假装"未决定"。 */
export const FACT_DECISION_FALLBACK_LABEL = '已决定';

/** 提交中的按钮文案。 */
export const FACT_DECISION_RECORDING_LABEL = '记录中…';

/** 章节未定稿时的统一说明（面板级，只出现一次）。 */
export const FACT_DECISION_NOT_FINALIZED_HINT = '章节定稿后才能对事实候选做出决定。';

/** 候选属于旧版本时的说明（候选级）。 */
export const FACT_DECISION_STALE_VERSION_HINT = '仅当前最新定稿版本可做决定。';

/** 已决后的统一声明：决定只作记录，不写回任何设定。 */
export const FACT_DECISION_RECORDED_NOTE =
  '决定已记录；当前不会自动修改人物、物品、势力、关系或境界。';

/**
 * 决定值归一化：只接受 `accepted` / `rejected`。
 *
 * 未知值（历史枚举、脏数据）返回 `null` —— 调用方据此按"非已知决定"处理。
 */
export function factDecisionValue(raw: string | null | undefined): FactDecisionValue | null {
  return raw === 'accepted' || raw === 'rejected' ? raw : null;
}

/**
 * 已决徽章。
 *
 * - `null` / 空串 → `null`（**未决定**：没有徽章可显示）；
 * - `accepted` → 「已接受」+ 成功色；
 * - `rejected` → 「已拒绝」+ 中性色；
 * - 其它非空值 → 回退到「已决定」+ 中性色（**不回显原始枚举**）。
 */
export function factDecisionBadge(raw: string | null | undefined): FactDecisionBadge | null {
  if (raw === null || raw === undefined || raw === '') {
    return null;
  }
  const value = factDecisionValue(raw);
  if (value === null) {
    return { label: FACT_DECISION_FALLBACK_LABEL, tone: 'muted' };
  }
  if (value === 'accepted') {
    return { label: FACT_DECISION_LABELS.accepted, tone: 'ok' };
  }
  return { label: FACT_DECISION_LABELS.rejected, tone: 'muted' };
}

/** 徽章的 CSS 类：ok → 成功色，muted → 默认中性徽章。 */
export function factDecisionBadgeClass(tone: FactDecisionTone): string {
  return tone === 'ok' ? 'badge badge--ok' : 'badge';
}

/** 决定时间的展示文案（时间本身由调用方格式化）。 */
export function factDecisionTimeLabel(decidedAtLabel: string): string {
  return `决定于 ${decidedAtLabel}`;
}

/* -------------------------------------------------------------------------- */
/* 错误文案                                                                    */
/* -------------------------------------------------------------------------- */

/** 决策相关的稳定错误码 → 中文文案。 */
export const FACT_DECISION_ERROR_TEXTS: Readonly<Record<string, string>> = {
  CONTINUITY_FACT_ALREADY_DECIDED: '该候选已做出不同决定，不能改判。',
  CONTINUITY_FACT_DECISION_STALE: '章节或版本已变化，不能继续决定。',
};

/** 未知错误码 / 非 API 错误（网络异常）的通用文案。 */
export const FACT_DECISION_ERROR_FALLBACK = '决定提交失败，请稍后重试。';

/**
 * 决策失败的稳定文案。
 *
 * `code === null` 表示不是可识别的 API 错误（网络 / 解析失败），
 * 与未知错误码一样回退到通用文案，不回显原始异常。
 */
export function factDecisionErrorText(code: string | null): string {
  if (code === null) {
    return FACT_DECISION_ERROR_FALLBACK;
  }
  return FACT_DECISION_ERROR_TEXTS[code] ?? FACT_DECISION_ERROR_FALLBACK;
}

/* -------------------------------------------------------------------------- */
/* 决策门禁                                                                    */
/* -------------------------------------------------------------------------- */

/** 候选的决定视图（与服务端读取模型同构）。 */
export interface FactDecisionView {
  readonly value: string;
  readonly decidedAt: string;
}

export interface FactDecisionInput {
  /** 章节状态（未加载时为 `null`）。 */
  readonly chapterStatus: string | null;
  /** 候选所属的正式版本 id。 */
  readonly candidateSourceVersionId: string | null;
  /** 章节当前最新正式版本 id。 */
  readonly latestVersionId: string | null;
  /** 候选已有的决定（`null` 表示未决定）。 */
  readonly decision: FactDecisionView | null;
  /** 该候选当前是否正在提交决定。 */
  readonly submitting: boolean;
}

/** 决策态的五种取值。 */
export type FactDecisionState =
  'decidable' | 'submitting' | 'decided' | 'not-finalized' | 'stale-version';

export interface FactDecisionViewModel {
  readonly state: FactDecisionState;
  /** 已决徽章（仅 `decided` 时非 null）。 */
  readonly badge: FactDecisionBadge | null;
  /** 是否渲染接受 / 拒绝按钮。 */
  readonly showButtons: boolean;
  /** 按钮是否可用（提交中或不可决定时为 false）。 */
  readonly canSubmit: boolean;
  /** 候选级说明（不可决定的原因）；空串表示没有。 */
  readonly hint: string;
}

/**
 * 由门禁推导决策态展示模型。
 *
 * 判定顺序固定：已决 → 章节未定稿 → 候选版本过期 → 提交中 → 可决定。
 *
 * - **已决**：隐藏接受 / 拒绝按钮（决定是终态，不提供撤销 / 改判）；
 * - **章节未定稿**：整块决定入口不出现（由面板级说明解释原因）；
 * - **候选版本过期**：同样不出现可用的决定入口，只给候选级说明；
 * - **提交中**：按钮保留但禁用，文案变成「记录中…」。
 */
export function factDecisionView(input: FactDecisionInput): FactDecisionViewModel {
  if (input.decision !== null) {
    return {
      state: 'decided',
      badge: factDecisionBadge(input.decision.value),
      showButtons: false,
      canSubmit: false,
      hint: '',
    };
  }
  if (input.chapterStatus !== 'finalized') {
    return {
      state: 'not-finalized',
      badge: null,
      showButtons: false,
      canSubmit: false,
      hint: '',
    };
  }
  if (
    input.candidateSourceVersionId === null ||
    input.latestVersionId === null ||
    input.candidateSourceVersionId !== input.latestVersionId
  ) {
    return {
      state: 'stale-version',
      badge: null,
      showButtons: false,
      canSubmit: false,
      hint: FACT_DECISION_STALE_VERSION_HINT,
    };
  }
  if (input.submitting) {
    return {
      state: 'submitting',
      badge: null,
      showButtons: true,
      canSubmit: false,
      hint: '',
    };
  }
  return {
    state: 'decidable',
    badge: null,
    showButtons: true,
    canSubmit: true,
    hint: '',
  };
}

/**
 * 现在能不能做决定（等价于 `factDecisionView(...).canSubmit`）。
 *
 * 门禁四件套：章节已定稿、候选属于当前最新正式版本、尚未决定、没有在提交。
 */
export function canDecideFact(input: FactDecisionInput): boolean {
  return factDecisionView(input).canSubmit;
}
