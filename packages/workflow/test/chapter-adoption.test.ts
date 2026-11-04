/**
 * 章节候选采纳与正式版本（A1-3A）。
 *
 * 使用真实 PostgreSQL，覆盖：
 * - 正常采纳（版本号、父版本、章节状态、正文逐字节一致）；
 * - 重复采纳幂等（不新增版本、不重复审计）；
 * - 并发同候选 / 同章节不同候选（版本号唯一）；
 * - 章节状态拒绝、跨作品 / 跨章节 404、非 candidate 状态拒绝；
 * - 审计写入失败整体回滚；
 * - 正式版本 append-only 与 adopted 候选不可修改（直接 SQL 也不行）。
 */

import { randomUUID } from 'node:crypto';

import { AUDIT_ACTIONS, AuthError } from '@novel/auth';
import type { PrismaClient } from '@novel/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { adoptChapterCandidate } from '../src/chapter/adoption.js';
import { countWords } from '../src/chapter/agents.js';
import { adoptionDraft, seedCandidate } from './helpers/adoption.js';
import { createChapterFixture, type ChapterFixture } from './helpers/chapter.js';
import { cleanupWork, closeTestDb, testDb } from './helpers/db.js';

let db: PrismaClient;
let fixtures: ChapterFixture[] = [];

beforeAll(() => {
  db = testDb();
});

afterEach(async () => {
  for (const fixture of fixtures) {
    await cleanupWork(db, fixture.workId);
  }
  fixtures = [];
});

afterAll(async () => {
  await closeTestDb();
});

async function newFixture(): Promise<ChapterFixture> {
  const fixture = await createChapterFixture(db, { tag: `adopt-${randomUUID().slice(0, 8)}` });
  fixtures.push(fixture);
  return fixture;
}

function adoptWith(input: {
  readonly workId: string;
  readonly chapterId: string;
  readonly candidateId: string;
  readonly authorId: string;
}) {
  return adoptChapterCandidate({ db, ...input });
}

function adopt(fixture: ChapterFixture, candidateId: string) {
  return adoptWith({
    workId: fixture.workId,
    chapterId: fixture.chapterId,
    candidateId,
    authorId: fixture.authorId,
  });
}

async function chapterStatus(chapterId: string): Promise<string> {
  return (await db.chapter.findUniqueOrThrow({ where: { id: chapterId } })).status;
}

async function adoptionAuditCount(chapterId: string): Promise<number> {
  return db.auditLog.count({
    where: { action: AUDIT_ACTIONS.CHAPTER_CANDIDATE_ADOPTED, targetId: chapterId },
  });
}

describe('采纳：正常路径', () => {
  it('候选 adopted、正式版本 1、章节 in_review；正文与字数逐字节一致', async () => {
    const fixture = await newFixture();
    const seeded = await seedCandidate(db, fixture);
    expect(await chapterStatus(fixture.chapterId)).toBe('planned');

    const result = await adopt(fixture, seeded.candidateId);

    expect(result.deduplicated).toBe(false);
    expect(result.versionNo).toBe(1);
    expect(result.chapterStatus).toBe('in_review');

    const candidate = await db.chapterCandidate.findUniqueOrThrow({
      where: { id: seeded.candidateId },
    });
    expect(candidate.status).toBe('adopted');

    const version = await db.chapterVersion.findUniqueOrThrow({ where: { id: result.versionId } });
    expect(version).toMatchObject({
      workId: fixture.workId,
      chapterId: fixture.chapterId,
      versionNo: 1,
      source: 'ai',
      sourceCandidateId: seeded.candidateId,
      parentVersionId: null,
      createdBy: fixture.authorId,
    });
    // 逐字节一致：内容原样复制，字数由服务端统计口径复算
    expect(version.content).toBe(seeded.content);
    expect(Buffer.from(version.content, 'utf8').equals(Buffer.from(seeded.content, 'utf8'))).toBe(
      true,
    );
    expect(version.wordCount).toBe(countWords(seeded.content));
    expect(version.wordCount).toBe(seeded.wordCount);

    expect(await chapterStatus(fixture.chapterId)).toBe('in_review');
  });

  it('保留空白与换行：byte-for-byte 复制，不 trim、不重排', async () => {
    const fixture = await newFixture();
    const content = `${'第一段：风起于青石之上。'.repeat(40)}\n\n  第二段：灵息穿过经脉。  \n${'第三段：剑鸣如龙。'.repeat(100)}\n`;
    expect(countWords(content)).toBeGreaterThanOrEqual(1200);

    const seeded = await seedCandidate(db, fixture, { content });
    const result = await adopt(fixture, seeded.candidateId);

    const version = await db.chapterVersion.findUniqueOrThrow({ where: { id: result.versionId } });
    expect(version.content).toBe(content);
    expect(version.wordCount).toBe(countWords(content));
    // 空白只影响 char_length，不影响服务端字数
    expect(version.content.length).toBeGreaterThan(version.wordCount);
  });

  it('第二个候选得到版本 2，父版本指向前一正式版本', async () => {
    const fixture = await newFixture();
    const first = await seedCandidate(db, fixture);
    const firstResult = await adopt(fixture, first.candidateId);

    const second = await seedCandidate(db, fixture);
    const secondResult = await adopt(fixture, second.candidateId);

    expect(secondResult.versionNo).toBe(2);
    const version = await db.chapterVersion.findUniqueOrThrow({
      where: { id: secondResult.versionId },
    });
    expect(version.parentVersionId).toBe(firstResult.versionId);
    expect(await db.chapterVersion.count({ where: { chapterId: fixture.chapterId } })).toBe(2);
  });

  it('审计只记 ids / 版本号 / 字数，不含正文；状态迁移另有审计', async () => {
    const fixture = await newFixture();
    const marker = '唯一标记短语-采纳测试';
    const seeded = await seedCandidate(db, fixture, {
      content: `${marker}${adoptionDraft()}`,
    });
    const result = await adopt(fixture, seeded.candidateId);

    const rows = await db.auditLog.findMany({
      where: { action: AUDIT_ACTIONS.CHAPTER_CANDIDATE_ADOPTED, targetId: fixture.chapterId },
    });
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row?.actorId).toBe(fixture.authorId);
    const detail = row?.detail as Record<string, unknown>;
    expect(Object.keys(detail).sort()).toEqual(
      ['candidateId', 'chapterId', 'versionId', 'versionNo', 'wordCount', 'workId'].sort(),
    );
    expect(detail).toMatchObject({
      workId: fixture.workId,
      chapterId: fixture.chapterId,
      candidateId: seeded.candidateId,
      versionId: result.versionId,
      versionNo: 1,
      wordCount: seeded.wordCount,
    });
    expect(JSON.stringify(rows)).not.toContain(marker);

    const statusRows = await db.auditLog.findMany({
      where: { action: AUDIT_ACTIONS.CHAPTER_STATUS_CHANGED, targetId: fixture.chapterId },
    });
    expect(statusRows).toHaveLength(1);
    expect(statusRows[0]?.detail).toMatchObject({ fromStatus: 'planned', toStatus: 'in_review' });
  });
});

describe('采纳幂等', () => {
  it('重复采纳返回既有版本：不新增版本、不新增审计', async () => {
    const fixture = await newFixture();
    const seeded = await seedCandidate(db, fixture);
    const first = await adopt(fixture, seeded.candidateId);
    const auditBefore = await adoptionAuditCount(fixture.chapterId);

    const second = await adopt(fixture, seeded.candidateId);

    expect(second.deduplicated).toBe(true);
    expect(second.versionId).toBe(first.versionId);
    expect(second.versionNo).toBe(first.versionNo);
    expect(second.wordCount).toBe(first.wordCount);
    expect(await db.chapterVersion.count({ where: { chapterId: fixture.chapterId } })).toBe(1);
    expect(await adoptionAuditCount(fixture.chapterId)).toBe(auditBefore);
  });

  it('章节后续被定稿也不影响重复采纳的幂等性', async () => {
    const fixture = await newFixture();
    const seeded = await seedCandidate(db, fixture);
    const first = await adopt(fixture, seeded.candidateId);
    await db.chapter.update({
      where: { id: fixture.chapterId },
      data: { status: 'finalized' },
    });

    const second = await adopt(fixture, seeded.candidateId);

    expect(second.deduplicated).toBe(true);
    expect(second.versionId).toBe(first.versionId);
    expect(second.chapterStatus).toBe('finalized');
    expect(await db.chapterVersion.count({ where: { chapterId: fixture.chapterId } })).toBe(1);
  });
});

describe('采纳并发', () => {
  it('同一候选并发采纳只生成 1 个正式版本', async () => {
    const fixture = await newFixture();
    const seeded = await seedCandidate(db, fixture);

    const results = await Promise.allSettled([
      adopt(fixture, seeded.candidateId),
      adopt(fixture, seeded.candidateId),
    ]);

    const fulfilled = results.filter((item) => item.status === 'fulfilled');
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);
    for (const item of results) {
      if (item.status === 'rejected') {
        // 允许"稳定并发冲突"作为后到请求的结果
        expect(item.reason).toBeInstanceOf(AuthError);
        expect(item.reason).toMatchObject({ code: 'CHAPTER_VERSION_CONFLICT' });
      }
    }

    expect(await db.chapterVersion.count({ where: { chapterId: fixture.chapterId } })).toBe(1);
    const candidate = await db.chapterCandidate.findUniqueOrThrow({
      where: { id: seeded.candidateId },
    });
    expect(candidate.status).toBe('adopted');
  });

  it('同章节两个不同候选并发采纳：版本号 1 / 2 唯一', async () => {
    const fixture = await newFixture();
    const first = await seedCandidate(db, fixture);
    const second = await seedCandidate(db, fixture);

    const [a, b] = await Promise.all([
      adopt(fixture, first.candidateId),
      adopt(fixture, second.candidateId),
    ]);

    expect([a.versionNo, b.versionNo].sort((x, y) => x - y)).toEqual([1, 2]);
    expect(a.versionId).not.toBe(b.versionId);

    const versions = await db.chapterVersion.findMany({
      where: { chapterId: fixture.chapterId },
      orderBy: { versionNo: 'asc' },
      select: { versionNo: true, parentVersionId: true },
    });
    expect(versions.map((row) => row.versionNo)).toEqual([1, 2]);
    expect(versions[0]?.parentVersionId).toBeNull();
    expect(versions[1]?.parentVersionId).not.toBeNull();
  });
});

describe('采纳拒绝', () => {
  it('finalized / abandoned 章节不能采纳，且不留下任何写入', async () => {
    for (const status of ['finalized', 'abandoned'] as const) {
      const fixture = await newFixture();
      const seeded = await seedCandidate(db, fixture);
      await db.chapter.update({ where: { id: fixture.chapterId }, data: { status } });

      await expect(adopt(fixture, seeded.candidateId)).rejects.toMatchObject({
        code: 'CHAPTER_STATE_INVALID_FOR_ADOPTION',
      });

      expect(await chapterStatus(fixture.chapterId)).toBe(status);
      expect(await db.chapterVersion.count({ where: { chapterId: fixture.chapterId } })).toBe(0);
      const candidate = await db.chapterCandidate.findUniqueOrThrow({
        where: { id: seeded.candidateId },
      });
      expect(candidate.status).toBe('candidate');
    }
  });

  it('跨作品 / 跨章节候选一律 404；他人作品 404', async () => {
    const a = await newFixture();
    const b = await newFixture();
    const seededB = await seedCandidate(db, b);

    // 跨作品：候选属于 B，采纳用 A 的作品上下文
    await expect(adopt(a, seededB.candidateId)).rejects.toMatchObject({
      code: 'CHAPTER_CANDIDATE_NOT_FOUND',
    });

    // 同作品跨章节
    const chapter2 = await db.chapter.create({
      data: { workId: a.workId, chapterNo: 2, title: '第二章' },
      select: { id: true },
    });
    const seededOtherChapter = await seedCandidate(db, a, { chapterId: chapter2.id });
    await expect(adopt(a, seededOtherChapter.candidateId)).rejects.toMatchObject({
      code: 'CHAPTER_CANDIDATE_NOT_FOUND',
    });

    // 他人作品：作者 A 去采纳 B 的候选
    await expect(
      adoptWith({
        workId: b.workId,
        chapterId: b.chapterId,
        candidateId: seededB.candidateId,
        authorId: a.authorId,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    expect(await db.chapterVersion.count({ where: { workId: b.workId } })).toBe(0);
  });

  it('非 candidate 状态不能采纳（adopted 但缺少正式版本 → 版本冲突）', async () => {
    const fixture = await newFixture();
    const seeded = await seedCandidate(db, fixture);

    // 数据库允许 candidate → adopted，但"adopted 必须有版本"只能由服务层事务保证。
    // 这里模拟"被绕过服务层写成 adopted"的脏数据。
    await db.chapterCandidate.update({
      where: { id: seeded.candidateId },
      data: { status: 'adopted' },
    });

    await expect(adopt(fixture, seeded.candidateId)).rejects.toMatchObject({
      code: 'CHAPTER_VERSION_CONFLICT',
    });
    expect(await db.chapterVersion.count({ where: { chapterId: fixture.chapterId } })).toBe(0);
    expect(await chapterStatus(fixture.chapterId)).toBe('planned');
  });

  it('参数不合法（非法 UUID）在进入事务前被拒绝', async () => {
    const fixture = await newFixture();
    await expect(
      adoptWith({
        workId: fixture.workId,
        chapterId: fixture.chapterId,
        candidateId: 'not-a-uuid',
        authorId: fixture.authorId,
      }),
    ).rejects.toThrow();
    expect(await db.chapterVersion.count({ where: { chapterId: fixture.chapterId } })).toBe(0);
  });
});

describe('事务边界与不可变', () => {
  it('审计写入失败 → 候选、版本、章节状态全部回滚', async () => {
    const fixture = await newFixture();
    const seeded = await seedCandidate(db, fixture);

    await db.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION test_block_adopt_audit() RETURNS trigger AS $$
      BEGIN
        IF NEW.action = 'chapter.candidate_adopted' THEN
          RAISE EXCEPTION 'test: blocked adoption audit';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await db.$executeRawUnsafe(`
      CREATE TRIGGER test_block_adopt_audit_trigger
        BEFORE INSERT ON audit_logs
        FOR EACH ROW EXECUTE FUNCTION test_block_adopt_audit()
    `);

    try {
      await expect(adopt(fixture, seeded.candidateId)).rejects.toThrow();
    } finally {
      await db.$executeRawUnsafe(
        'DROP TRIGGER IF EXISTS test_block_adopt_audit_trigger ON audit_logs',
      );
      await db.$executeRawUnsafe('DROP FUNCTION IF EXISTS test_block_adopt_audit()');
    }

    // 前面的 candidate 状态迁移与章节状态推进都在同一事务里，必须一起回滚
    const candidate = await db.chapterCandidate.findUniqueOrThrow({
      where: { id: seeded.candidateId },
    });
    expect(candidate.status).toBe('candidate');
    expect(await db.chapterVersion.count({ where: { chapterId: fixture.chapterId } })).toBe(0);
    expect(await chapterStatus(fixture.chapterId)).toBe('planned');
    expect(await adoptionAuditCount(fixture.chapterId)).toBe(0);

    // 去掉触发器后可以正常采纳（证明失败只是审计导致的整体回滚）
    const result = await adopt(fixture, seeded.candidateId);
    expect(result.versionNo).toBe(1);
    expect(await db.chapterVersion.count({ where: { chapterId: fixture.chapterId } })).toBe(1);
  });

  it('正式版本 append-only：直接 SQL 修改或删除失败', async () => {
    const fixture = await newFixture();
    const seeded = await seedCandidate(db, fixture);
    const { versionId } = await adopt(fixture, seeded.candidateId);

    await expect(
      db.$executeRaw`UPDATE chapter_versions SET version_no = 99 WHERE id = ${versionId}::uuid`,
    ).rejects.toThrow();
    await expect(
      db.$executeRaw`UPDATE chapter_versions SET content = '被篡改' WHERE id = ${versionId}::uuid`,
    ).rejects.toThrow();
    await expect(
      db.$executeRaw`DELETE FROM chapter_versions WHERE id = ${versionId}::uuid`,
    ).rejects.toThrow();

    const version = await db.chapterVersion.findUniqueOrThrow({ where: { id: versionId } });
    expect(version.versionNo).toBe(1);
    expect(version.content).toBe(seeded.content);
  });

  it('adopted 候选不可修改正文/字数，也不可回退状态或删除', async () => {
    const fixture = await newFixture();
    const seeded = await seedCandidate(db, fixture);
    await adopt(fixture, seeded.candidateId);

    await expect(
      db.chapterCandidate.update({
        where: { id: seeded.candidateId },
        data: { content: '被篡改' },
      }),
    ).rejects.toThrow();
    await expect(
      db.chapterCandidate.update({
        where: { id: seeded.candidateId },
        data: { wordCount: 999_999 },
      }),
    ).rejects.toThrow();
    await expect(
      db.chapterCandidate.update({
        where: { id: seeded.candidateId },
        data: { status: 'candidate' },
      }),
    ).rejects.toThrow();
    await expect(
      db.chapterCandidate.delete({ where: { id: seeded.candidateId } }),
    ).rejects.toThrow();

    const candidate = await db.chapterCandidate.findUniqueOrThrow({
      where: { id: seeded.candidateId },
    });
    expect(candidate.status).toBe('adopted');
    expect(candidate.content).toBe(seeded.content);
  });
});
