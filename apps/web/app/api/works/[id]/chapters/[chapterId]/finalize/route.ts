import { assertTrustedOrigin } from '@novel/auth';
import {
  createModelProvider,
  finalizeChapter,
  isModelProviderError,
  readProviderConfig,
} from '@novel/workflow';

import { authErrorResponse, authJson, readJsonObject } from '@/auth-http';
import { authConfig, db } from '@/auth-runtime';
import { FINALIZE_FIELDS, requireFinalizeVersionId } from '@/chapter-http';
import { rejectUnknownFields } from '@/settings-http';
import { requireAuthorSession } from '@/work-guard';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * 摘要任务所需 provider / model 的 **best-effort** 解析。
 *
 * 摘要只是派生数据：模型服务没配置（缺 Base URL / Key / 模型名）时，
 * 定稿必须照常成功，只是不创建摘要任务。因此这里捕获
 * `ModelProviderError('MODEL_NOT_CONFIGURED')` 并返回 `null`：
 * - 不把错误抛给 `finalizeChapter`，也不让它进入响应或日志；
 * - 不伪造 provider / model 占位值（那会生成一个永远无法执行的脏任务）；
 * - 不构造任何模型请求、不联网、不读取 Key 到内存之外。
 *
 * 配置恢复后，作者对同一版本再次调用幂等 finalize 即会补齐任务。
 */
function resolveSummarySpec(): { provider: string; model: string } | null {
  try {
    const provider = createModelProvider(readProviderConfig());
    return { provider: provider.name, model: provider.defaultModel };
  } catch (error) {
    if (isModelProviderError(error) && error.code === 'MODEL_NOT_CONFIGURED') {
      return null;
    }
    throw error;
  }
}

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
 * 模型配置缺失 / 非法时**只跳过摘要任务**，定稿照常成功（摘要只是派生数据）。
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
    // 客户端无法覆盖，响应里也不会出现。配置不可用时返回 null，只跳过摘要调度。
    const summary = resolveSummarySpec();

    const finalized = await finalizeChapter({
      db: db(),
      workId: id,
      chapterId,
      authorId: author.id,
      versionId,
      summary,
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
