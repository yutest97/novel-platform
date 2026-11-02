'use client';

/**
 * item 卡片上的「持有人 / 事件」入口（M2-B3-B2）。
 *
 * 只在物品分区出现：入口自带当前归属摘要（未登记 / 持有中 · 某人 / 已消耗 / 已丢失），
 * 面板里做的任何变更都会通过父级回传的状态即时反映到这里。
 *
 * 摘要只含状态与持有人姓名（DTO 仅 `{ id, name, deleted }`），不含人物属性或秘密。
 */

import type { ItemStateView } from '@/lib/api';
import { holderSummary } from '@/lib/item-events';

export interface ItemHolderEntryProps {
  /** 尚未读到状态时为 null。 */
  readonly state: ItemStateView | null;
  /** 页面是否仍在加载（决定 null 显示「加载中」还是「不可用」）。 */
  readonly loading: boolean;
  readonly onOpen: () => void;
}

export function ItemHolderEntry({
  state,
  loading,
  onOpen,
}: ItemHolderEntryProps): React.ReactElement {
  // 读取失败不能一直显示「加载中」：加载结束后明确告知状态不可用，
  // 作者仍可点开面板重新读取。
  const summary =
    state !== null ? holderSummary(state) : loading ? holderSummary(null) : '持有人：状态不可用';

  return (
    <>
      <span className="badge" data-testid="item-holder-summary" title={summary}>
        {summary}
      </span>
      <button
        type="button"
        className="btn-secondary btn-small"
        onClick={onOpen}
        data-testid="item-events-open"
      >
        持有人 / 事件
      </button>
    </>
  );
}
