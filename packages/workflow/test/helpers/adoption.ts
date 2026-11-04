/**
 * 章节采纳测试辅助（A1-3A）。
 *
 * 采纳不需要跑 Planner/Writer：候选只要求"同任务、同章节、同作品的合同"，
 * 因此这里直接写入任务 → 合同 → 候选，让采纳用例聚焦在版本、并发与事务边界上。
 * （完整链路「生成 → 采纳」由 chapter-workflow + 本文件的联调用例覆盖。）
 */

import { randomUUID } from 'node:crypto';

import type { PrismaClient } from '@novel/db';

import { countWords } from '../../src/chapter/agents.js';
import { CHAPTER_DRAFT_TASK_TYPE } from '../../src/chapter/types.js';
import { createGenerationTask } from '../../src/queue.js';
import type { ChapterFixture } from './chapter.js';

/** 默认正文：1600 个非空白字符，满足 `word_count >= 1200` 的数据库下限。 */
export function adoptionDraft(repeat = 80): string {
  return '风从演武场尽头吹来，吹动了青石上的尘埃。'.repeat(repeat);
}

export interface SeededCandidate {
  readonly candidateId: string;
  readonly contractId: string;
  readonly taskId: string;
  readonly content: string;
  readonly wordCount: number;
}

/** 在指定作品 / 章节下直接种一个 `candidate` 状态的候选。 */
export async function seedCandidate(
  db: PrismaClient,
  fixture: ChapterFixture,
  options: { content?: string; chapterId?: string } = {},
): Promise<SeededCandidate> {
  const chapterId = options.chapterId ?? fixture.chapterId;
  const content = options.content ?? adoptionDraft();
  const wordCount = countWords(content);

  const latest = await db.chapterContract.aggregate({
    where: { chapterId },
    _max: { versionNo: true },
  });
  const versionNo = (latest._max.versionNo ?? 0) + 1;

  const { task } = await createGenerationTask(db, {
    authorId: fixture.authorId,
    workId: fixture.workId,
    chapterId,
    requestId: `req-${randomUUID()}`,
    taskType: CHAPTER_DRAFT_TASK_TYPE,
    inputSnapshot: { targetWords: 3000 },
    provider: 'mock',
    model: 'mock-model',
    maxAttempts: 3,
  });

  const contract = await db.chapterContract.create({
    data: {
      workId: fixture.workId,
      chapterId,
      generationTaskId: task.id,
      versionNo,
      goal: '测试用章节合同',
      mustInclude: [] as never,
      mustNotInclude: [] as never,
      sceneBeats: { version: 1, characters: [], scenes: [] } as never,
      targetWords: 3000,
      status: 'frozen',
    },
    select: { id: true },
  });

  const candidate = await db.chapterCandidate.create({
    data: {
      workId: fixture.workId,
      chapterId,
      generationTaskId: task.id,
      contractId: contract.id,
      content,
      wordCount,
      structuredPlan: { version: 1, goal: '测试用章节合同' } as never,
      status: 'candidate',
    },
    select: { id: true },
  });

  return {
    candidateId: candidate.id,
    contractId: contract.id,
    taskId: task.id,
    content,
    wordCount,
  };
}
