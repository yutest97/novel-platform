import { assertTrustedOrigin, readClientIp } from '@novel/auth';
import { createWork, listWorks } from '@novel/works';

import { authErrorResponse, authJson, readJsonObject, requireString } from '@/auth-http';
import { authConfig, db } from '@/auth-runtime';
import { optionalInteger, optionalString, rejectServerOwnedFields } from '@/work-http';
import { requireAuthorSession } from '@/work-guard';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/works —— 列出当前作者自己的作品（按更新时间倒序）。
 *
 * 只返回当前会话作者的作品；不返回其他作者的任何数据。
 */
export async function GET(request: Request): Promise<Response> {
  try {
    const author = await requireAuthorSession(request);
    const works = await listWorks(db(), author.id);
    return authJson({ works }, 200);
  } catch (error) {
    return authErrorResponse(error);
  }
}

/**
 * POST /api/works —— 创建作品。
 *
 * - role 与 authorId **只**从会话获取，客户端提交这两个字段会被拒绝；
 * - 题材必须来自启用中的 rule_packages；
 * - 创建与 work.created 审计同事务。
 */
export async function POST(request: Request): Promise<Response> {
  try {
    assertTrustedOrigin(request, authConfig());
    const author = await requireAuthorSession(request);

    const body = await readJsonObject(request);
    rejectServerOwnedFields(body);

    const title = requireString(body, 'title');
    const summary = optionalString(body, 'summary');
    const targetChapters = optionalInteger(body, 'targetChapters');
    const targetWordsPerChapter = optionalInteger(body, 'targetWordsPerChapter');
    const genreRulePackage = requireString(body, 'genreRulePackage');

    const work = await createWork(db(), {
      authorId: author.id,
      title,
      ...(summary === undefined ? {} : { summary }),
      ...(targetChapters === undefined ? {} : { targetChapters }),
      ...(targetWordsPerChapter === undefined ? {} : { targetWordsPerChapter }),
      genreRulePackage,
      meta: {
        ip: readClientIp(request),
        userAgent: request.headers.get('user-agent'),
      },
    });

    return authJson({ work }, 201);
  } catch (error) {
    return authErrorResponse(error);
  }
}
