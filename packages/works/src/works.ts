/**
 * 作品核心业务逻辑（M2-A）。
 *
 * 权限与隔离（硬约束）：
 * - 所有读写都以 `authorId` 为边界：列表只返回自己的作品；
 *   读取/修改他人作品一律按"不存在"处理（404），不泄露作品是否存在；
 * - `authorId` **只**来自服务端会话，绝不接受客户端传入；
 * - 管理员不能通过本模块的任何接口读取或修改作者作品；
 * - 写操作与审计写入在**同一事务**内完成：审计失败则业务修改回滚。
 *
 * 范围限制：本阶段只涉及"作品本身"与"作品设定"，
 * 不创建章节、人物、境界等任何正文业务表，也不调用模型。
 */

import type { PrismaClient } from '@novel/db';
import { AUDIT_ACTIONS, AuthError, writeAuditLog, type RequestMeta } from '@novel/auth';

import { assertUuid } from './ids.js';

/** 目标章数默认与范围。 */
export const DEFAULT_TARGET_CHAPTERS = 10;
export const MIN_TARGET_CHAPTERS = 1;
export const MAX_TARGET_CHAPTERS = 100;

/** 单章目标字数默认与范围。 */
export const DEFAULT_TARGET_WORDS_PER_CHAPTER = 3000;
export const MIN_TARGET_WORDS_PER_CHAPTER = 1200;
export const MAX_TARGET_WORDS_PER_CHAPTER = 10_000;

/** 标题长度上限（避免把超长文本塞进数据库与列表）。 */
export const MAX_TITLE_LENGTH = 120;

/** 简介长度上限。 */
export const MAX_SUMMARY_LENGTH = 2000;

/** 第一版唯一允许的题材。 */
export const ALLOWED_RULE_PACKAGE_CODE = 'xuanhuan';

/** 题材规则包对外视图。 */
export interface RulePackageView {
  readonly code: string;
  readonly name: string;
  readonly version: string;
  readonly active: boolean;
}

/** 作品对外视图（固定字段，绝不含 authorId 之外的东西）。 */
export interface WorkView {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly targetChapters: number;
  readonly targetWordsPerChapter: number;
  readonly genreRulePackage: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** 作品设定对外视图（值以 JSON 形式给出）。 */
export interface WorkSettingView {
  readonly settingKey: string;
  readonly settingValue: unknown;
  readonly schemaRef: string;
  readonly updatedAt: string;
}

/** 作品详情：基础信息 + 安全的作品设定。 */
export interface WorkDetailView extends WorkView {
  readonly settings: readonly WorkSettingView[];
}

/** 数据库行 → 作品视图。 */
function toWorkView(work: {
  id: string;
  title: string;
  summary: string;
  targetChapters: number;
  targetWordsPerChapter: number;
  genreRulePackage: string;
  createdAt: Date;
  updatedAt: Date;
}): WorkView {
  return {
    id: work.id,
    title: work.title,
    summary: work.summary,
    targetChapters: work.targetChapters,
    targetWordsPerChapter: work.targetWordsPerChapter,
    genreRulePackage: work.genreRulePackage,
    createdAt: work.createdAt.toISOString(),
    updatedAt: work.updatedAt.toISOString(),
  };
}

/** 规范化标题：去首尾空白；空标题与超长标题直接拒绝。 */
export function normalizeTitle(input: string): string {
  const title = input.trim();
  if (title === '') {
    throw new AuthError('VALIDATION_FAILED', '标题不能为空');
  }
  if (title.length > MAX_TITLE_LENGTH) {
    throw new AuthError('VALIDATION_FAILED', `标题最长 ${MAX_TITLE_LENGTH} 个字符`);
  }
  return title;
}

/** 规范化简介：去首尾空白，可为空。 */
export function normalizeSummary(input: string): string {
  const summary = input.trim();
  if (summary.length > MAX_SUMMARY_LENGTH) {
    throw new AuthError('VALIDATION_FAILED', `简介最长 ${MAX_SUMMARY_LENGTH} 个字符`);
  }
  return summary;
}

/** 校验目标章数。 */
export function assertTargetChapters(value: number): number {
  if (!Number.isInteger(value)) {
    throw new AuthError('VALIDATION_FAILED', '目标章数必须是整数');
  }
  if (value < MIN_TARGET_CHAPTERS || value > MAX_TARGET_CHAPTERS) {
    throw new AuthError(
      'VALIDATION_FAILED',
      `目标章数必须在 ${MIN_TARGET_CHAPTERS}—${MAX_TARGET_CHAPTERS} 之间`,
    );
  }
  return value;
}

/** 校验单章目标字数。 */
export function assertTargetWordsPerChapter(value: number): number {
  if (!Number.isInteger(value)) {
    throw new AuthError('VALIDATION_FAILED', '单章目标字数必须是整数');
  }
  if (value < MIN_TARGET_WORDS_PER_CHAPTER || value > MAX_TARGET_WORDS_PER_CHAPTER) {
    throw new AuthError(
      'VALIDATION_FAILED',
      `单章目标字数必须在 ${MIN_TARGET_WORDS_PER_CHAPTER}—${MAX_TARGET_WORDS_PER_CHAPTER} 之间`,
    );
  }
  return value;
}

/**
 * 校验题材：必须对应 `rule_packages` 中**已启用**的规则包。
 *
 * 第一版只允许 xuanhuan，但校验走数据库，保证"只允许 active 规则包"这条规则
 * 由数据驱动，而不是写死在业务逻辑里。
 */
export async function assertUsableRulePackage(
  db: PrismaClient,
  code: string,
): Promise<RulePackageView> {
  const normalized = code.trim();
  if (normalized === '') {
    throw new AuthError('VALIDATION_FAILED', '缺少字段 genreRulePackage');
  }
  const rulePackage = await db.rulePackage.findUnique({ where: { code: normalized } });
  if (rulePackage === null || !rulePackage.active) {
    throw new AuthError('INVALID_RULE_PACKAGE');
  }
  return {
    code: rulePackage.code,
    name: rulePackage.name,
    version: rulePackage.version,
    active: rulePackage.active,
  };
}

/** 列出可用的题材规则包（只返回启用中的）。 */
export async function listActiveRulePackages(db: PrismaClient): Promise<RulePackageView[]> {
  const rows = await db.rulePackage.findMany({
    where: { active: true },
    orderBy: [{ code: 'asc' }],
    select: { code: true, name: true, version: true, active: true },
  });
  return rows;
}

/**
 * 列出当前作者的作品（按更新时间倒序）。
 *
 * 查询条件必须带 `authorId` —— 这是数据隔离的第一道闸门。
 */
export async function listWorks(db: PrismaClient, authorId: string): Promise<WorkView[]> {
  const rows = await db.work.findMany({
    where: { authorId },
    orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
    select: {
      id: true,
      title: true,
      summary: true,
      targetChapters: true,
      targetWordsPerChapter: true,
      genreRulePackage: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  return rows.map(toWorkView);
}

/** 读取单个作品（仅所有者；他人一律 404）。 */
export async function getWork(
  db: PrismaClient,
  input: { workId: string; authorId: string },
): Promise<WorkDetailView> {
  assertUuid(input.workId, '作品 id');
  const work = await db.work.findFirst({
    where: { id: input.workId, authorId: input.authorId },
    select: {
      id: true,
      title: true,
      summary: true,
      targetChapters: true,
      targetWordsPerChapter: true,
      genreRulePackage: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  if (work === null) {
    // 不区分"不存在"与"不属于你"：避免泄露作品是否存在
    throw new AuthError('NOT_FOUND', '作品不存在');
  }

  const settings = await db.workSetting.findMany({
    where: { workId: work.id },
    orderBy: [{ settingKey: 'asc' }, { schemaRef: 'asc' }],
    select: { settingKey: true, settingValue: true, schemaRef: true, updatedAt: true },
  });

  return {
    ...toWorkView(work),
    settings: settings.map((setting) => ({
      settingKey: setting.settingKey,
      settingValue: setting.settingValue,
      schemaRef: setting.schemaRef,
      updatedAt: setting.updatedAt.toISOString(),
    })),
  };
}

/** 创建作品的输入。 */
export interface CreateWorkInput {
  readonly authorId: string;
  readonly title: string;
  readonly summary?: string;
  readonly targetChapters?: number;
  readonly targetWordsPerChapter?: number;
  readonly genreRulePackage: string;
  readonly meta: RequestMeta;
}

/**
 * 创建作品。
 *
 * 作品写入与 `work.created` 审计在**同一事务**内完成：
 * 审计写失败 → 作品回滚，不会出现"建了作品但没有审计"。
 */
export async function createWork(db: PrismaClient, input: CreateWorkInput): Promise<WorkView> {
  const title = normalizeTitle(input.title);
  const summary = normalizeSummary(input.summary ?? '');
  const targetChapters = assertTargetChapters(input.targetChapters ?? DEFAULT_TARGET_CHAPTERS);
  const targetWordsPerChapter = assertTargetWordsPerChapter(
    input.targetWordsPerChapter ?? DEFAULT_TARGET_WORDS_PER_CHAPTER,
  );
  const rulePackage = await assertUsableRulePackage(db, input.genreRulePackage);

  try {
    const created = await db.$transaction(async (tx) => {
      const work = await tx.work.create({
        data: {
          authorId: input.authorId,
          title,
          summary,
          targetChapters,
          targetWordsPerChapter,
          genreRulePackage: rulePackage.code,
        },
        select: {
          id: true,
          title: true,
          summary: true,
          targetChapters: true,
          targetWordsPerChapter: true,
          genreRulePackage: true,
          createdAt: true,
          updatedAt: true,
        },
      });

      await writeAuditLog(tx, {
        action: AUDIT_ACTIONS.WORK_CREATED,
        actorId: input.authorId,
        targetType: 'work',
        targetId: work.id,
        // 只记录非敏感信息：作品 id / 标题 / 作者 id / 配置摘要。
        // **不记录**简介与任何正文内容。
        detail: {
          workId: work.id,
          title: work.title,
          authorId: input.authorId,
          genreRulePackage: work.genreRulePackage,
          targetChapters: work.targetChapters,
          targetWordsPerChapter: work.targetWordsPerChapter,
        },
        ip: input.meta.ip,
        userAgent: input.meta.userAgent,
      });

      return work;
    });

    return toWorkView(created);
  } catch (error) {
    throw translateUniqueViolation(error);
  }
}

/** 更新作品的输入：只允许改标题、简介与两个目标值。 */
export interface UpdateWorkInput {
  readonly workId: string;
  readonly authorId: string;
  readonly title?: string;
  readonly summary?: string;
  readonly targetChapters?: number;
  readonly targetWordsPerChapter?: number;
  readonly meta: RequestMeta;
}

/**
 * 更新作品。
 *
 * - 不允许修改 authorId 与 genreRulePackage（接口层面根本不接受这两个字段）；
 * - 更新与 `work.updated` 审计同事务。
 */
export async function updateWork(db: PrismaClient, input: UpdateWorkInput): Promise<WorkView> {
  assertUuid(input.workId, '作品 id');
  const title = input.title === undefined ? undefined : normalizeTitle(input.title);
  const summary = input.summary === undefined ? undefined : normalizeSummary(input.summary);
  const targetChapters =
    input.targetChapters === undefined ? undefined : assertTargetChapters(input.targetChapters);
  const targetWordsPerChapter =
    input.targetWordsPerChapter === undefined
      ? undefined
      : assertTargetWordsPerChapter(input.targetWordsPerChapter);

  // 先确认作品存在且属于当前作者（他人一律 404）
  const existing = await db.work.findFirst({
    where: { id: input.workId, authorId: input.authorId },
    select: { id: true, title: true },
  });
  if (existing === null) {
    throw new AuthError('NOT_FOUND', '作品不存在');
  }

  try {
    const updated = await db.$transaction(async (tx) => {
      const work = await tx.work.update({
        where: { id: input.workId },
        data: {
          ...(title === undefined ? {} : { title }),
          ...(summary === undefined ? {} : { summary }),
          ...(targetChapters === undefined ? {} : { targetChapters }),
          ...(targetWordsPerChapter === undefined ? {} : { targetWordsPerChapter }),
        },
        select: {
          id: true,
          title: true,
          summary: true,
          targetChapters: true,
          targetWordsPerChapter: true,
          genreRulePackage: true,
          createdAt: true,
          updatedAt: true,
        },
      });

      await writeAuditLog(tx, {
        action: AUDIT_ACTIONS.WORK_UPDATED,
        actorId: input.authorId,
        targetType: 'work',
        targetId: work.id,
        detail: {
          workId: work.id,
          title: work.title,
          authorId: input.authorId,
          genreRulePackage: work.genreRulePackage,
          targetChapters: work.targetChapters,
          targetWordsPerChapter: work.targetWordsPerChapter,
        },
        ip: input.meta.ip,
        userAgent: input.meta.userAgent,
      });

      return work;
    });

    return toWorkView(updated);
  } catch (error) {
    throw translateUniqueViolation(error);
  }
}

/**
 * 把"同一作者下标题重复"的数据库唯一约束错误翻译成稳定的业务错误码。
 *
 * 底层是 PostgreSQL 23505（unique_violation）；Prisma 侧表现为 P2002。
 * Prisma 7 的 meta 结构是 `driverAdapterError.cause.constraint.index`
 * （旧版本是 `meta.target`），两种都兼容。
 *
 * 只把"作品表的 (author_id, title) 唯一约束"翻译成 WORK_TITLE_TAKEN，
 * 其它唯一冲突原样抛出。
 */
function translateUniqueViolation(error: unknown): unknown {
  if (typeof error !== 'object' || error === null) {
    return error;
  }
  const candidate = error as { code?: unknown; meta?: Record<string, unknown> };
  if (candidate.code !== 'P2002') {
    return error;
  }

  const meta = candidate.meta ?? {};
  const adapter = meta['driverAdapterError'] as
    { cause?: { constraint?: { index?: unknown; fields?: unknown } } } | undefined;
  const constraint = adapter?.cause?.constraint;

  const markers = [constraint?.index, constraint?.fields, meta['target']]
    .filter((value) => value !== undefined && value !== null)
    .map((value) => {
      if (Array.isArray(value)) {
        return value
          .map((item) => (typeof item === 'string' ? item : JSON.stringify(item)))
          .join(',');
      }
      return typeof value === 'string' ? value : (JSON.stringify(value) ?? '');
    })
    .join(' ');

  if (markers.includes('author_id') && markers.includes('title')) {
    return new AuthError('WORK_TITLE_TAKEN');
  }
  return error;
}
