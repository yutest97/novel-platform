/**
 * 作品核心业务逻辑测试（M2-A）。
 *
 * 覆盖：作者隔离、标题唯一、参数校验、审计原子性、权限边界。
 */

import { AuthError } from '@novel/auth';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  assertUsableRulePackage,
  createWork,
  getWork,
  listActiveRulePackages,
  listWorks,
  updateWork,
} from '../src/works.js';
import { closeTestDb, testDb, uniqueEmail } from './helpers/db.js';

const META = { ip: '203.0.113.10', userAgent: 'vitest' };

/** 创建作者账号（role=author，已改密，active）。 */
async function createAuthor(email = uniqueEmail('author')) {
  const db = testDb();
  return db.user.create({
    data: {
      email,
      passwordHash: '$argon2id$stub$not-used-here',
      role: 'author',
      status: 'active',
      mustChangePassword: false,
    },
  });
}

/** 创建管理员账号。 */
async function createAdmin(email = uniqueEmail('admin')) {
  const db = testDb();
  return db.user.create({
    data: {
      email,
      passwordHash: '$argon2id$stub$not-used-here',
      role: 'admin',
      status: 'active',
      mustChangePassword: false,
    },
  });
}

describe('作品核心（M2-A）', () => {
  beforeAll(() => {
    testDb();
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it('作者创建作品成功：authorId 来自调用方（服务端会话），字段落库正确', async () => {
    const db = testDb();
    const author = await createAuthor();

    const work = await createWork(db, {
      authorId: author.id,
      title: '  玄天问道  ',
      summary: '一个少年踏上修行之路。',
      targetChapters: 20,
      targetWordsPerChapter: 4000,
      genreRulePackage: 'xuanhuan',
      meta: META,
    });

    expect(work.title).toBe('玄天问道');
    expect(work.summary).toBe('一个少年踏上修行之路。');
    expect(work.targetChapters).toBe(20);
    expect(work.targetWordsPerChapter).toBe(4000);
    expect(work.genreRulePackage).toBe('xuanhuan');

    const row = await db.work.findUniqueOrThrow({ where: { id: work.id } });
    expect(row.authorId).toBe(author.id);
  });

  it('默认目标值：10 章、每章 3000 字', async () => {
    const db = testDb();
    const author = await createAuthor();

    const work = await createWork(db, {
      authorId: author.id,
      title: '默认配置',
      genreRulePackage: 'xuanhuan',
      meta: META,
    });

    expect(work.targetChapters).toBe(10);
    expect(work.targetWordsPerChapter).toBe(3000);
    expect(work.summary).toBe('');
  });

  it('同一作者重复标题返回 WORK_TITLE_TAKEN', async () => {
    const db = testDb();
    const author = await createAuthor();

    await createWork(db, {
      authorId: author.id,
      title: '同名作品',
      genreRulePackage: 'xuanhuan',
      meta: META,
    });

    await expect(
      createWork(db, {
        authorId: author.id,
        title: '同名作品',
        genreRulePackage: 'xuanhuan',
        meta: META,
      }),
    ).rejects.toMatchObject({ code: 'WORK_TITLE_TAKEN' });
  });

  it('不同作者可以有相同标题', async () => {
    const db = testDb();
    const authorA = await createAuthor();
    const authorB = await createAuthor();

    await createWork(db, {
      authorId: authorA.id,
      title: '同名作品',
      genreRulePackage: 'xuanhuan',
      meta: META,
    });
    const workB = await createWork(db, {
      authorId: authorB.id,
      title: '同名作品',
      genreRulePackage: 'xuanhuan',
      meta: META,
    });

    expect(workB.title).toBe('同名作品');
  });

  it('列表只包含当前作者自己的作品', async () => {
    const db = testDb();
    const authorA = await createAuthor();
    const authorB = await createAuthor();

    await createWork(db, {
      authorId: authorA.id,
      title: 'A 的作品',
      genreRulePackage: 'xuanhuan',
      meta: META,
    });
    await createWork(db, {
      authorId: authorB.id,
      title: 'B 的作品',
      genreRulePackage: 'xuanhuan',
      meta: META,
    });

    const listA = await listWorks(db, authorA.id);
    expect(listA.map((work) => work.title)).toContain('A 的作品');
    expect(listA.map((work) => work.title)).not.toContain('B 的作品');
  });

  it('列表按更新时间倒序', async () => {
    const db = testDb();
    const author = await createAuthor();

    const first = await createWork(db, {
      authorId: author.id,
      title: '先创建',
      genreRulePackage: 'xuanhuan',
      meta: META,
    });
    const second = await createWork(db, {
      authorId: author.id,
      title: '后创建',
      genreRulePackage: 'xuanhuan',
      meta: META,
    });

    const list = await listWorks(db, author.id);
    const ids = list.map((work) => work.id);
    expect(ids.indexOf(second.id)).toBeLessThan(ids.indexOf(first.id));
  });

  it('作者 B 读取作者 A 的作品按不存在处理（404）', async () => {
    const db = testDb();
    const authorA = await createAuthor();
    const authorB = await createAuthor();

    const workA = await createWork(db, {
      authorId: authorA.id,
      title: 'A 私有作品',
      genreRulePackage: 'xuanhuan',
      meta: META,
    });

    await expect(getWork(db, { workId: workA.id, authorId: authorB.id })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('作者 B 修改作者 A 的作品同样 404，且不产生修改', async () => {
    const db = testDb();
    const authorA = await createAuthor();
    const authorB = await createAuthor();

    const workA = await createWork(db, {
      authorId: authorA.id,
      title: 'A 的作品',
      genreRulePackage: 'xuanhuan',
      meta: META,
    });

    await expect(
      updateWork(db, {
        workId: workA.id,
        authorId: authorB.id,
        title: '被篡改的标题',
        meta: META,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    const row = await db.work.findUniqueOrThrow({ where: { id: workA.id } });
    expect(row.title).toBe('A 的作品');
  });

  it('参数校验：空标题、超长标题、章数越界、字数越界都被拒绝', async () => {
    const db = testDb();
    const author = await createAuthor();

    await expect(
      createWork(db, {
        authorId: author.id,
        title: '   ',
        genreRulePackage: 'xuanhuan',
        meta: META,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    await expect(
      createWork(db, {
        authorId: author.id,
        title: 'x'.repeat(121),
        genreRulePackage: 'xuanhuan',
        meta: META,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    await expect(
      createWork(db, {
        authorId: author.id,
        title: '章数为零',
        targetChapters: 0,
        genreRulePackage: 'xuanhuan',
        meta: META,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    await expect(
      createWork(db, {
        authorId: author.id,
        title: '章数超上限',
        targetChapters: 101,
        genreRulePackage: 'xuanhuan',
        meta: META,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    await expect(
      createWork(db, {
        authorId: author.id,
        title: '字数过少',
        targetWordsPerChapter: 1199,
        genreRulePackage: 'xuanhuan',
        meta: META,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    await expect(
      createWork(db, {
        authorId: author.id,
        title: '字数过多',
        targetWordsPerChapter: 10001,
        genreRulePackage: 'xuanhuan',
        meta: META,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('题材必须是启用中的规则包；不存在或停用的规则包被拒绝', async () => {
    const db = testDb();
    const author = await createAuthor();

    await expect(
      createWork(db, {
        authorId: author.id,
        title: '未知题材',
        genreRulePackage: 'no-such-genre',
        meta: META,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_RULE_PACKAGE' });

    // 临时停用一个规则包，验证只允许 active
    const temporary = await db.rulePackage.create({
      data: {
        code: `inactive-${Date.now().toString(36)}`,
        name: '停用题材',
        version: '1.0.0',
        active: false,
        fieldSchema: {},
      },
    });
    try {
      await expect(
        createWork(db, {
          authorId: author.id,
          title: '停用题材作品',
          genreRulePackage: temporary.code,
          meta: META,
        }),
      ).rejects.toMatchObject({ code: 'INVALID_RULE_PACKAGE' });
    } finally {
      await db.rulePackage.delete({ where: { id: temporary.id } });
    }
  });

  it('可用的题材列表只包含启用中的规则包，且包含 xuanhuan', async () => {
    const db = testDb();
    const packages = await listActiveRulePackages(db);
    expect(packages.map((item) => item.code)).toContain('xuanhuan');
    expect(packages.every((item) => item.active)).toBe(true);
  });

  it('assertUsableRulePackage 返回规则包元信息', async () => {
    const db = testDb();
    const rulePackage = await assertUsableRulePackage(db, 'xuanhuan');
    expect(rulePackage.code).toBe('xuanhuan');
    expect(rulePackage.name).toBe('玄幻升级');
    expect(rulePackage.active).toBe(true);
  });

  it('创建作品写 work.created 审计，detail 不含简介正文', async () => {
    const db = testDb();
    const author = await createAuthor();

    const work = await createWork(db, {
      authorId: author.id,
      title: '审计作品',
      summary: '这段简介不应该进审计',
      genreRulePackage: 'xuanhuan',
      meta: META,
    });

    const audit = await db.auditLog.findFirst({
      where: { action: 'work.created', targetId: work.id },
      orderBy: { createdAt: 'desc' },
    });
    expect(audit).not.toBeNull();
    expect(audit?.actorId).toBe(author.id);
    const detail = JSON.stringify(audit?.detail ?? {});
    expect(detail).toContain(work.id);
    expect(detail).toContain('审计作品');
    expect(detail).not.toContain('这段简介不应该进审计');
  });

  it('更新作品写 work.updated 审计，且不修改 authorId 与题材', async () => {
    const db = testDb();
    const author = await createAuthor();

    const work = await createWork(db, {
      authorId: author.id,
      title: '待更新作品',
      genreRulePackage: 'xuanhuan',
      meta: META,
    });

    const updated = await updateWork(db, {
      workId: work.id,
      authorId: author.id,
      title: '新标题',
      summary: '新简介',
      targetChapters: 30,
      meta: META,
    });

    expect(updated.title).toBe('新标题');
    expect(updated.targetChapters).toBe(30);
    expect(updated.genreRulePackage).toBe('xuanhuan');

    const row = await db.work.findUniqueOrThrow({ where: { id: work.id } });
    expect(row.authorId).toBe(author.id);
    expect(row.genreRulePackage).toBe('xuanhuan');

    const audit = await db.auditLog.findFirst({
      where: { action: 'work.updated', targetId: work.id },
      orderBy: { createdAt: 'desc' },
    });
    expect(audit).not.toBeNull();
    expect(audit?.actorId).toBe(author.id);
  });

  it('更新时重复标题返回 WORK_TITLE_TAKEN', async () => {
    const db = testDb();
    const author = await createAuthor();

    await createWork(db, {
      authorId: author.id,
      title: '占位标题',
      genreRulePackage: 'xuanhuan',
      meta: META,
    });
    const other = await createWork(db, {
      authorId: author.id,
      title: '另一个标题',
      genreRulePackage: 'xuanhuan',
      meta: META,
    });

    await expect(
      updateWork(db, {
        workId: other.id,
        authorId: author.id,
        title: '占位标题',
        meta: META,
      }),
    ).rejects.toMatchObject({ code: 'WORK_TITLE_TAKEN' });
  });

  it('审计写入失败时创建作品回滚（不留下作品）', async () => {
    const db = testDb();
    const author = await createAuthor();

    // 故障注入：临时给 audit_logs 加一个禁止 INSERT 的触发器
    await db.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION works_block_audit() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'audit blocked';
      END;
      $$ LANGUAGE plpgsql;
    `);
    await db.$executeRawUnsafe(`
      CREATE TRIGGER works_block_audit_trigger
      BEFORE INSERT ON audit_logs
      FOR EACH ROW EXECUTE FUNCTION works_block_audit();
    `);

    try {
      await expect(
        createWork(db, {
          authorId: author.id,
          title: '会被回滚的作品',
          genreRulePackage: 'xuanhuan',
          meta: META,
        }),
      ).rejects.toBeTruthy();

      const rows = await db.work.findMany({ where: { authorId: author.id } });
      expect(rows).toHaveLength(0);
    } finally {
      await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS works_block_audit_trigger ON audit_logs`);
      await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS works_block_audit()`);
    }
  });

  it('审计写入失败时更新作品回滚（标题保持原值）', async () => {
    const db = testDb();
    const author = await createAuthor();

    const work = await createWork(db, {
      authorId: author.id,
      title: '原标题',
      genreRulePackage: 'xuanhuan',
      meta: META,
    });

    await db.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION works_block_audit() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'audit blocked';
      END;
      $$ LANGUAGE plpgsql;
    `);
    await db.$executeRawUnsafe(`
      CREATE TRIGGER works_block_audit_trigger
      BEFORE INSERT ON audit_logs
      FOR EACH ROW EXECUTE FUNCTION works_block_audit();
    `);

    try {
      await expect(
        updateWork(db, {
          workId: work.id,
          authorId: author.id,
          title: '不应生效的标题',
          meta: META,
        }),
      ).rejects.toBeTruthy();

      const row = await db.work.findUniqueOrThrow({ where: { id: work.id } });
      expect(row.title).toBe('原标题');
    } finally {
      await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS works_block_audit_trigger ON audit_logs`);
      await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS works_block_audit()`);
    }
  });

  it('管理员账号不能通过作品模块读取或修改作品（隔离由 author_id 保证）', async () => {
    const db = testDb();
    const admin = await createAdmin();
    const author = await createAuthor();

    const work = await createWork(db, {
      authorId: author.id,
      title: '作者的作品',
      genreRulePackage: 'xuanhuan',
      meta: META,
    });

    // 管理员的 id 作为 authorId 查不到任何作品
    const adminList = await listWorks(db, admin.id);
    expect(adminList).toHaveLength(0);

    await expect(getWork(db, { workId: work.id, authorId: admin.id })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('业务层以 authorId 为唯一边界：账号状态校验在接口层完成', async () => {
    // 业务层只认 authorId；"未登录 / 已停用 / 首登未改密 / 非作者"
    // 由接口层（apps/web/src/work-guard.ts）在**每次请求**时重新校验。
    // 这里验证业务层不会因为调用方传了别的 id 而越权。
    const db = testDb();
    const authorA = await createAuthor();
    const authorB = await createAuthor();

    const workA = await createWork(db, {
      authorId: authorA.id,
      title: '边界作品',
      genreRulePackage: 'xuanhuan',
      meta: META,
    });

    // 用 B 的 id 读取 A 的作品：拒绝
    await expect(getWork(db, { workId: workA.id, authorId: authorB.id })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    // 用 B 的 id 列表：只有 B 自己的作品
    const listB = await listWorks(db, authorB.id);
    expect(listB.map((item) => item.title)).not.toContain('边界作品');
  });

  it('作品设定以 (work_id, setting_key, schema_ref) 唯一', async () => {
    const db = testDb();
    const author = await createAuthor();
    const work = await createWork(db, {
      authorId: author.id,
      title: '带设定的作品',
      genreRulePackage: 'xuanhuan',
      meta: META,
    });

    const setting = await db.workSetting.create({
      data: {
        workId: work.id,
        settingKey: 'cultivation_system',
        settingValue: { note: '示例' },
        schemaRef: 'xuanhuan@1.0.0',
      },
    });
    expect(setting.id).toBeTruthy();

    await expect(
      db.workSetting.create({
        data: {
          workId: work.id,
          settingKey: 'cultivation_system',
          settingValue: { note: '重复' },
          schemaRef: 'xuanhuan@1.0.0',
        },
      }),
    ).rejects.toBeTruthy();

    const detail = await getWork(db, { workId: work.id, authorId: author.id });
    expect(detail.settings).toHaveLength(1);
    expect(detail.settings[0]?.settingKey).toBe('cultivation_system');
  });

  it('AuthError 覆盖作品相关错误码（稳定契约）', () => {
    expect(new AuthError('WORK_TITLE_TAKEN').status).toBe(409);
    expect(new AuthError('INVALID_RULE_PACKAGE').status).toBe(400);
    expect(new AuthError('NOT_FOUND').status).toBe(404);
  });
});
