import { getItemState } from '@novel/works';

import { authErrorResponse, authJson } from '@/auth-http';
import { db } from '@/auth-runtime';
import { requireAuthorSession } from '@/work-guard';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/works/:id/items/:itemId/state —— 派生状态。
 *
 * 返回值全部由事件流水回放得出，**不读任何 holder 属性**：
 * - `status`：unrecorded / held / consumed / lost；
 * - `holder`：当前持有人（只含 id / name / deleted）；
 * - `eventCount`：全部事件行数（含冲正行）；
 * - `lastSeq`：最后一条事件的 seq，0 表示还没有事件。
 *
 * 软删除的物品也可以查（历史可读），只是不能再写入。
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string; itemId: string }> },
): Promise<Response> {
  try {
    const author = await requireAuthorSession(request);
    const { id, itemId } = await context.params;

    const state = await getItemState(db(), {
      workId: id,
      authorId: author.id,
      itemId,
    });

    return authJson({ state }, 200);
  } catch (error) {
    return authErrorResponse(error);
  }
}
