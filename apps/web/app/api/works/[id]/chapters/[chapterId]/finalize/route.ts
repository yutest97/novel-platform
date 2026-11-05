import { assertTrustedOrigin } from '@novel/auth';
import { createModelProvider, finalizeChapter, readProviderConfig } from '@novel/workflow';

import { authErrorResponse, authJson, readJsonObject } from '@/auth-http';
import { authConfig, db } from '@/auth-runtime';
import { FINALIZE_FIELDS, requireFinalizeVersionId } from '@/chapter-http';
import { rejectUnknownFields } from '@/settings-http';
import { requireAuthorSession } from '@/work-guard';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/works/:workId/chapters/:chapterId/finalize —— 章节定稿（A1-4B-C-C）。
 *
 * 语义：
 * - 只能锁定**当前最新正式版本**（`versionId` 必须等于最新版本 id）；
 * - `in_review → finalized`；已定稿且同一版本 → 200 `deduplicated=true`，不重复写审计；
 * - 定稿后生成 / 采纳 / 恢复被拒绝；人工保存 revision 会回到 `in_review`（可重新定稿）；
 * - 不新增 `final_version_id`、不写 migration、不改版本表。
 *
 * A2-D-B：定稿与 `chapter.summarize` 任务入队同事务。provider / model 只来自
 * **服务端配置**（`readProviderConfig()` + Provider 构造结果），请求体不得提交，
 * 响应字段也不变（任务 id 只在服务端内部流转）。
 *
 * 状态码：成功 200；状态不允许 / 无版本 / 已定稿但版本不同 →
 * 409 `CHAPTER_STATE_INVALID_FOR_FINALIZE`；非最新版本 →
 * 409 `CHAPTER_VERSION_CONFLICT`；他人作品 / 跨章节 / 随机版本 id → 404 或稳定冲突；
 * 缺字段 / null / 非法 UUID / 未知字段 → 400。
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string; chapterId: string }> },
): Promise<Response> {
  try {
    assertTrustedOrigin(request, authConfig());
    const author = await requireAuthorSession(request);
    const { id, chapterId } = await context.params;

    const body = await readJsonObject(request);
    rejectUnknownFields(body, FINALIZE_FIELDS);
    const versionId = requireFinalizeVersionId(body);

    // 只读配置并构造 Provider（不发起任何网络请求）：名称与默认模型只来自服务端，
    // 客户端无法覆盖，响应里也不会出现。
    const provider = createModelProvider(readProviderConfig());

    const finalized = await finalizeChapter({
      db: db(),
      workId: id,
      chapterId,
      authorId: author.id,
      versionId,
      summary: { provider: provider.name, model: provider.defaultModel },
    });

    return authJson(
      {
        chapter: {
          chapterId: finalized.chapterId,
          status: finalized.status,
          versionId: finalized.versionId,
          versionNo: finalized.versionNo,
          deduplicated: finalized.deduplicated,
        },
      },
      200,
    );
  } catch (error) {
    return authErrorResponse(error);
  }
}
