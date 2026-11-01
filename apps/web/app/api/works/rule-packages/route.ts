import { listActiveRulePackages } from '@novel/works';

import { authErrorResponse, authJson } from '@/auth-http';
import { db } from '@/auth-runtime';
import { requireAuthorSession } from '@/work-guard';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/works/rule-packages —— 可用题材（仅启用中的规则包）。
 *
 * 第一版只有 xuanhuan（玄幻升级）；题材来自数据库，
 * 新增题材时无需改动前端。
 */
export async function GET(request: Request): Promise<Response> {
  try {
    await requireAuthorSession(request);
    const rulePackages = await listActiveRulePackages(db());
    return authJson({ rulePackages }, 200);
  } catch (error) {
    return authErrorResponse(error);
  }
}
