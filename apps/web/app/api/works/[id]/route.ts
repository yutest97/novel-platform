import { assertTrustedOrigin, readClientIp } from '@novel/auth';
import { getWork, updateWork } from '@novel/works';

import { authErrorResponse, authJson, readJsonObject } from '@/auth-http';
import { authConfig, db } from '@/auth-runtime';
import { optionalInteger, optionalString, rejectImmutableWorkFields } from '@/work-http';
import { requireAuthorSession } from '@/work-guard';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/works/:id —— 读取作品详情。
 *
 * 只允许作品所有者访问；他人访问一律 404（不泄露作品是否存在）。
 * 管理员同样不能通过本接口读取作者作品。
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const author = await requireAuthorSession(request);
    const { id } = await context.params;

    const work = await getWork(db(), { workId: id, authorId: author.id });
    return authJson({ work }, 200);
  } catch (error) {
    return authErrorResponse(error);
  }
}

/**
 * PATCH /api/works/:id —— 修改作品的基础配置。
 *
 * 只允许改 title / summary / targetChapters / targetWordsPerChapter；
 * authorId 与 genreRulePackage 由服务端掌握，客户端提交会被拒绝。
 */
export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    assertTrustedOrigin(request, authConfig());
    const author = await requireAuthorSession(request);
    const { id } = await context.params;

    const body = await readJsonObject(request);
    // 归属、题材与时间戳都是不可变字段：出现在请求体里一律 400，不静默忽略
    rejectImmutableWorkFields(body);

    const title = optionalString(body, 'title');
    const summary = optionalString(body, 'summary');
    const targetChapters = optionalInteger(body, 'targetChapters');
    const targetWordsPerChapter = optionalInteger(body, 'targetWordsPerChapter');

    const work = await updateWork(db(), {
      workId: id,
      authorId: author.id,
      ...(title === undefined ? {} : { title }),
      ...(summary === undefined ? {} : { summary }),
      ...(targetChapters === undefined ? {} : { targetChapters }),
      ...(targetWordsPerChapter === undefined ? {} : { targetWordsPerChapter }),
      meta: {
        ip: readClientIp(request),
        userAgent: request.headers.get('user-agent'),
      },
    });

    return authJson({ work }, 200);
  } catch (error) {
    return authErrorResponse(error);
  }
}
