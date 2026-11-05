/**
 * 章节连续性事实提取（A2-A）。
 *
 * 定位：
 * - 只把「定稿章节正文 + 当前设定摘要」变成**结构化候选**；
 * - 不自动修改人物 / 物品 / 势力 / 关系 / 境界，也不创建任何实体；
 * - 不提供 HTTP API / UI / Worker 注册 / RAG / embedding（留待后续阶段）。
 *
 * 数据边界：
 * - 正文只进入模型请求，**不写入任何数据库列**（run / candidate / 审计都不含正文）；
 * - `secret` / `secretKnownBy` 等秘密字段永不进入模型输入摘要；
 * - 模型输出先过严格 Schema，再做语义校验（未知实体 id 直接拒绝）。
 */

import { AUDIT_ACTIONS, AuthError, writeAuditLog, type AuthErrorCode } from '@novel/auth';
import type { Prisma, PrismaClient } from '@novel/db';
import { normalizeUuid, requireOwnedWork, runWorkWrite } from '@novel/works';

import type { AgentDefinition } from '../agent.js';
import { AgentRunner } from '../agent.js';
import { AgentInputInvalidError, AgentOutputInvalidError } from '../agent.js';
import type { JsonIssue, JsonSchema } from '../json-schema.js';
import { validateJson } from '../json-schema.js';
import type { ModelProvider } from '../model-types.js';

/** 六类事实（稳定白名单）。 */
export const CHAPTER_FACT_TYPES = [
  'character_state',
  'relationship_change',
  'item_change',
  'realm_progress',
  'plot_thread',
  'location_change',
] as const;

export type ChapterFactType = (typeof CHAPTER_FACT_TYPES)[number];

/** 线索状态。 */
export const PLOT_THREAD_STATUSES = ['new', 'advanced', 'resolved'] as const;

/** 单次提取允许的最大事实条数。 */
export const MAX_CHAPTER_FACTS = 50;
/** summary / reason 的最大长度。 */
export const MAX_FACT_TEXT_LENGTH = 500;
/** 地点名最大长度（未登记地点允许保存规范化名称）。 */
export const MAX_LOCATION_NAME_LENGTH = 120;
/** 进入模型上下文的实体上限（每类）。 */
export const MAX_FACT_CONTEXT_ENTITIES = 100;
/** 摘要最大长度（每个实体）。 */
export const MAX_ENTITY_SUMMARY_LENGTH = 300;

/** 一条已校验的连续性事实候选（落库 payload 与它同构）。 */
export interface ChapterFact {
  readonly factType: ChapterFactType;
  readonly summary: string;
  readonly reason: string;
  /** 人物 / 物品 id（关系类为第一个人物）。 */
  readonly subjectId?: string;
  /** 关系类的第二个人物。 */
  readonly objectId?: string;
  /** 地点名（可以是未登记地点）。 */
  readonly name?: string;
  /** 线索状态（仅 plot_thread）。 */
  readonly threadStatus?: (typeof PLOT_THREAD_STATUSES)[number];
}

/** 组装好的模型输入（**含正文**，只在内存中流转）。 */
export interface ChapterFactInput {
  readonly work: { readonly id: string; readonly title: string };
  readonly chapter: { readonly id: string; readonly chapterNo: number; readonly title: string };
  readonly sourceVersion: { readonly versionId: string; readonly versionNo: number };
  readonly characters: readonly FactEntityRef[];
  readonly items: readonly FactEntityRef[];
  readonly realms: readonly (FactEntityRef & { readonly orderIndex: number | null })[];
  readonly factions: readonly FactEntityRef[];
  readonly chapterText: string;
}

/** 上下文实体引用。 */
export interface FactEntityRef {
  readonly id: string;
  readonly name: string;
  readonly summary: string;
}

const entityRefSchema: JsonSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', minLength: 1, maxLength: 64 },
    name: { type: 'string', minLength: 1, maxLength: 120 },
    summary: { type: 'string', maxLength: MAX_ENTITY_SUMMARY_LENGTH },
  },
  required: ['id', 'name', 'summary'],
  additionalProperties: false,
};

const realmRefSchema: JsonSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', minLength: 1, maxLength: 64 },
    name: { type: 'string', minLength: 1, maxLength: 120 },
    summary: { type: 'string', maxLength: MAX_ENTITY_SUMMARY_LENGTH },
    orderIndex: { type: 'integer', minimum: 0, maximum: 1_000_000 },
  },
  required: ['id', 'name', 'summary'],
  additionalProperties: false,
};

const factInputSchema: JsonSchema = {
  type: 'object',
  properties: {
    work: {
      type: 'object',
      properties: {
        id: { type: 'string', minLength: 1, maxLength: 64 },
        title: { type: 'string', minLength: 1, maxLength: 200 },
      },
      required: ['id', 'title'],
      additionalProperties: false,
    },
    chapter: {
      type: 'object',
      properties: {
        id: { type: 'string', minLength: 1, maxLength: 64 },
        chapterNo: { type: 'integer', minimum: 1, maximum: 100_000 },
        title: { type: 'string', minLength: 1, maxLength: 200 },
      },
      required: ['id', 'chapterNo', 'title'],
      additionalProperties: false,
    },
    sourceVersion: {
      type: 'object',
      properties: {
        versionId: { type: 'string', minLength: 1, maxLength: 64 },
        versionNo: { type: 'integer', minimum: 1, maximum: 100_000 },
      },
      required: ['versionId', 'versionNo'],
      additionalProperties: false,
    },
    characters: {
      type: 'array',
      items: entityRefSchema,
      maxItems: MAX_FACT_CONTEXT_ENTITIES,
    },
    items: {
      type: 'array',
      items: entityRefSchema,
      maxItems: MAX_FACT_CONTEXT_ENTITIES,
    },
    realms: {
      type: 'array',
      items: realmRefSchema,
      maxItems: MAX_FACT_CONTEXT_ENTITIES,
    },
    factions: {
      type: 'array',
      items: entityRefSchema,
      maxItems: MAX_FACT_CONTEXT_ENTITIES,
    },
    chapterText: { type: 'string', minLength: 1, maxLength: 200_000 },
  },
  required: [
    'work',
    'chapter',
    'sourceVersion',
    'characters',
    'items',
    'realms',
    'factions',
    'chapterText',
  ],
  additionalProperties: false,
};

const factItemSchema: JsonSchema = {
  type: 'object',
  properties: {
    factType: { type: 'string', enum: CHAPTER_FACT_TYPES },
    summary: { type: 'string', minLength: 1, maxLength: MAX_FACT_TEXT_LENGTH },
    reason: { type: 'string', minLength: 1, maxLength: MAX_FACT_TEXT_LENGTH },
    subjectId: { type: 'string', minLength: 1, maxLength: 64 },
    objectId: { type: 'string', minLength: 1, maxLength: 64 },
    name: { type: 'string', minLength: 1, maxLength: MAX_LOCATION_NAME_LENGTH },
    threadStatus: { type: 'string', enum: PLOT_THREAD_STATUSES },
  },
  required: ['factType', 'summary', 'reason'],
  additionalProperties: false,
};

const factOutputSchema: JsonSchema = {
  type: 'object',
  properties: {
    facts: {
      type: 'array',
      items: factItemSchema,
      maxItems: MAX_CHAPTER_FACTS,
    },
  },
  required: ['facts'],
  additionalProperties: false,
};

const ROLE_PROMPT = [
  '你是中文小说的连续性校对助手。',
  '阅读给定章节正文，提取本章发生的**连续性事实**，只输出事实，不改写正文、不给建议。',
  '事实类型只能是：',
  '- character_state：某个人物状态变化（subjectId 必须是给定人物 id）；',
  '- relationship_change：两个人物关系变化（subjectId / objectId 必须是给定人物 id 且不同）；',
  '- item_change：物品持有人或状态变化（subjectId 必须是给定物品 id）；',
  '- realm_progress：人物境界变化（subjectId 必须是给定人物 id）；',
  '- plot_thread：线索 / 伏笔 / 未解决问题（threadStatus = new / advanced / resolved）；',
  '- location_change：人物所在地点变化（subjectId 是人物 id，name 是地点名）。',
  '约束：',
  '- 只能使用输入里出现过的 id；不得编造 id，也不得创建新实体；',
  '- 地点允许使用未登记的名称（name），但不得把地点名放进 subjectId；',
  '- 每条事实必须有简洁 summary（≤500 字）与 reason（≤500 字，说明依据）；',
  '- 不要复述正文，不要输出 HTML / Markdown / 代码块；',
  '- 本章没有可提取的变化时输出 {"facts": []}。',
].join('\n');

/** 连续性事实提取 Agent（稳定名 + 版本）。 */
export const CONTINUITY_EXTRACTOR_AGENT: AgentDefinition = {
  name: 'continuity.extractor',
  promptVersion: '1.0.0',
  // 由 Provider 决定模型（不把 mock 模型写进业务 Agent）
  model: '',
  inputSchema: factInputSchema,
  outputSchema: factOutputSchema,
  maxOutputTokens: 4096,
  rolePrompt: ROLE_PROMPT,
};

/** 事实校验失败（只带路径与原因，不含正文或字段值）。 */
export class ChapterFactsInvalidError extends AuthError {
  readonly issues: readonly JsonIssue[];
  constructor(issues: readonly JsonIssue[]) {
    super('CONTINUITY_FACTS_INVALID', `连续性事实不合法（${issues.length} 处）`);
    this.name = 'ChapterFactsInvalidError';
    this.issues = issues;
  }
}

/**
 * 校验并规范化模型输出。
 *
 * 先跑严格 Schema（类型 / 枚举 / 长度 / 未知字段），再按 factType 做语义校验：
 * - 引用必须是上下文中出现过的 id（人物 / 物品分开校验）；
 * - 关系类必须两个人且不同；
 * - 地点名允许未登记，但必须非空；
 * - 空白 summary / reason 一律拒绝（Schema 的 minLength 挡不住纯空格）。
 *
 * @throws ChapterFactsInvalidError
 */
export function validateFactsOutput(
  raw: unknown,
  context: Pick<ChapterFactInput, 'characters' | 'items'>,
): ChapterFact[] {
  const schemaIssues = validateJson(factOutputSchema, raw);
  if (schemaIssues.length > 0) {
    throw new ChapterFactsInvalidError(schemaIssues);
  }

  const characterIds = new Set(context.characters.map((entity) => entity.id));
  const itemIds = new Set(context.items.map((entity) => entity.id));
  const body = raw as { facts: RawFact[] };
  const issues: JsonIssue[] = [];
  const facts: ChapterFact[] = [];

  body.facts.forEach((fact, index) => {
    const path = `facts[${index}]`;
    const summary = fact.summary.trim();
    const reason = fact.reason.trim();
    if (summary === '') {
      issues.push({ path: `${path}.summary`, message: 'summary 不能为空白' });
    }
    if (reason === '') {
      issues.push({ path: `${path}.reason`, message: 'reason 不能为空白' });
    }

    const subject = fact.subjectId?.trim();
    const object = fact.objectId?.trim();
    const name = fact.name?.trim();

    switch (fact.factType) {
      case 'character_state':
      case 'realm_progress': {
        if (subject === undefined || !characterIds.has(subject)) {
          issues.push({ path: `${path}.subjectId`, message: '必须是上下文中的人物 id' });
        }
        rejectExtra(issues, path, fact, ['objectId', 'name', 'threadStatus']);
        break;
      }
      case 'relationship_change': {
        if (subject === undefined || !characterIds.has(subject)) {
          issues.push({ path: `${path}.subjectId`, message: '必须是上下文中的人物 id' });
        }
        if (object === undefined || !characterIds.has(object)) {
          issues.push({ path: `${path}.objectId`, message: '必须是上下文中的人物 id' });
        }
        if (subject !== undefined && object !== undefined && subject === object) {
          issues.push({ path: `${path}.objectId`, message: '关系双方不能是同一个人物' });
        }
        rejectExtra(issues, path, fact, ['name', 'threadStatus']);
        break;
      }
      case 'item_change': {
        if (subject === undefined || !itemIds.has(subject)) {
          issues.push({ path: `${path}.subjectId`, message: '必须是上下文中的物品 id' });
        }
        rejectExtra(issues, path, fact, ['objectId', 'name', 'threadStatus']);
        break;
      }
      case 'plot_thread': {
        if (fact.threadStatus === undefined) {
          issues.push({ path: `${path}.threadStatus`, message: 'plot_thread 必须给出状态' });
        }
        rejectExtra(issues, path, fact, ['subjectId', 'objectId', 'name']);
        break;
      }
      case 'location_change': {
        if (subject === undefined || !characterIds.has(subject)) {
          issues.push({ path: `${path}.subjectId`, message: '必须是上下文中的人物 id' });
        }
        if (name === undefined || name === '') {
          issues.push({ path: `${path}.name`, message: 'location_change 必须给出地点名' });
        }
        rejectExtra(issues, path, fact, ['objectId', 'threadStatus']);
        break;
      }
      default:
        issues.push({ path: `${path}.factType`, message: '未知事实类型' });
    }

    facts.push({
      factType: fact.factType,
      summary,
      reason,
      ...(subject === undefined ? {} : { subjectId: subject }),
      ...(object === undefined ? {} : { objectId: object }),
      ...(name === undefined ? {} : { name }),
      ...(fact.threadStatus === undefined ? {} : { threadStatus: fact.threadStatus }),
    });
  });

  if (issues.length > 0) {
    throw new ChapterFactsInvalidError(issues);
  }
  return facts;
}

interface RawFact {
  readonly factType: ChapterFactType;
  readonly summary: string;
  readonly reason: string;
  readonly subjectId?: string;
  readonly objectId?: string;
  readonly name?: string;
  readonly threadStatus?: (typeof PLOT_THREAD_STATUSES)[number];
}

/** 某类事实不应出现的字段：出现即视为模型越界（而不是静默忽略）。 */
function rejectExtra(
  issues: JsonIssue[],
  path: string,
  fact: RawFact,
  forbidden: readonly ('subjectId' | 'objectId' | 'name' | 'threadStatus')[],
): void {
  for (const key of forbidden) {
    if (fact[key] !== undefined) {
      issues.push({ path: `${path}.${key}`, message: `${fact.factType} 不接受该字段` });
    }
  }
}

/** 提取结果（**不含正文**）。 */
export interface ChapterFactsResult {
  readonly runId: string;
  readonly chapterId: string;
  readonly sourceVersionId: string;
  readonly sourceVersionNo: number;
  readonly agentName: string;
  readonly agentVersion: string;
  readonly provider: string;
  readonly model: string;
  /** `true` 表示本次真的调用了模型；`false` 表示命中既有成功 run。 */
  readonly created: boolean;
  readonly facts: readonly (ChapterFact & { readonly id: string })[];
  readonly factTypeCounts: Readonly<Record<string, number>>;
}

/** 提取输入。 */
export interface ExtractChapterFactsInput {
  readonly db: PrismaClient;
  readonly provider: ModelProvider;
  /** 只能来自会话；管理员不是作者，作品归属校验会 404。 */
  readonly authorId: string;
  readonly workId: string;
  readonly chapterId: string;
  /** 可选：调用方期望提取的版本；必须等于当前最新版本，否则拒绝。 */
  readonly sourceVersionId?: string;
}

/**
 * 提取定稿章节的连续性事实候选。
 *
 * 流程：
 * 1. 作品锁内：校验归属 / 定稿 / 最新版本，命中既有 succeeded run 直接返回（幂等）；
 * 2. 锁外调用 Agent（不持锁、不占事务）；
 * 3. 作品锁内：写候选 + run 终态 + 审计（原子提交）。
 *
 * 并发：`UNIQUE(source_version_id)` 保证同一版本只有一个 run；
 * 第二个请求读到 running 时返回 `CONTINUITY_EXTRACTION_IN_PROGRESS`。
 *
 * @throws AuthError
 * - `NOT_FOUND`：作品 / 章节不属于当前作者；
 * - `CONTINUITY_CHAPTER_NOT_FINALIZED`：章节未定稿；
 * - `CONTINUITY_SOURCE_VERSION_STALE`：章节最新版本已变化（调用方传了旧版本）；
 * - `CONTINUITY_EXTRACTION_IN_PROGRESS`：同一版本已有进行中的提取；
 * - `CONTINUITY_FACTS_INVALID`：模型输出不合法（不可重试，不写候选）；
 * - `CONTINUITY_EXTRACTION_FAILED`：Provider / 内部失败（可重试）。
 */
export async function extractChapterFacts(
  input: ExtractChapterFactsInput,
): Promise<ChapterFactsResult> {
  const workId = normalizeUuid(input.workId, '作品 id');
  const chapterId = normalizeUuid(input.chapterId, '章节 id');
  const runner = new AgentRunner(input.provider);

  // ---- 1. 准备：校验 + 幂等命中 + 组装上下文 ----
  const prepared = await runWorkWrite(input.db, workId, async (tx) => {
    await requireOwnedWork(tx, workId, input.authorId);

    const chapter = await tx.chapter.findFirst({
      where: { id: chapterId, workId },
      select: { id: true, chapterNo: true, title: true, status: true },
    });
    if (chapter === null) {
      throw new AuthError('NOT_FOUND', '章节不存在');
    }
    if (chapter.status !== 'finalized') {
      throw new AuthError('CONTINUITY_CHAPTER_NOT_FINALIZED');
    }

    const latest = await tx.chapterVersion.findFirst({
      where: { workId, chapterId },
      orderBy: { versionNo: 'desc' },
      select: { id: true, versionNo: true, content: true },
    });
    if (latest === null) {
      throw new AuthError('CONTINUITY_CHAPTER_NOT_FINALIZED');
    }

    // 显式指定的版本必须是当前最新版本（旧版本一律拒绝）
    if (
      input.sourceVersionId !== undefined &&
      normalizeUuid(input.sourceVersionId, '版本 id') !== latest.id
    ) {
      throw new AuthError('CONTINUITY_SOURCE_VERSION_STALE');
    }

    const existing = await tx.chapterFactRun.findUnique({
      where: { sourceVersionId: latest.id },
      include: { candidates: { orderBy: { createdAt: 'asc' } } },
    });
    if (existing !== null && existing.status === 'succeeded') {
      return { kind: 'existing' as const, run: existing, sourceVersionNo: latest.versionNo };
    }
    if (existing !== null && existing.status === 'running') {
      throw new AuthError('CONTINUITY_EXTRACTION_IN_PROGRESS');
    }

    const work = await tx.work.findUniqueOrThrow({
      where: { id: workId },
      select: { id: true, title: true },
    });
    const context = await loadFactContext(tx, workId, {
      work,
      chapter,
      sourceVersion: { versionId: latest.id, versionNo: latest.versionNo },
      chapterText: latest.content,
    });

    const model = runner.resolveModel(CONTINUITY_EXTRACTOR_AGENT);
    const run =
      existing === null
        ? await tx.chapterFactRun.create({
            data: {
              workId,
              chapterId,
              sourceVersionId: latest.id,
              agentName: CONTINUITY_EXTRACTOR_AGENT.name,
              agentVersion: CONTINUITY_EXTRACTOR_AGENT.promptVersion,
              provider: input.provider.name,
              model,
              status: 'running',
            },
          })
        : await tx.chapterFactRun.update({
            // failed → running：重试复用同一 run，不产生第二行
            where: { id: existing.id },
            data: { status: 'running', errorCode: null, finishedAt: null },
          });

    return {
      kind: 'new' as const,
      run,
      context,
      sourceVersionNo: latest.versionNo,
    };
  });

  if (prepared.kind === 'existing') {
    const facts = prepared.run.candidates.map((candidate) => toFactView(candidate));
    return {
      runId: prepared.run.id,
      chapterId,
      sourceVersionId: prepared.run.sourceVersionId,
      sourceVersionNo: prepared.sourceVersionNo,
      agentName: prepared.run.agentName,
      agentVersion: prepared.run.agentVersion,
      provider: prepared.run.provider,
      model: prepared.run.model,
      created: false,
      facts,
      factTypeCounts: countFactTypes(facts),
    };
  }

  const { run, context, sourceVersionNo } = prepared;

  // ---- 2. 调用 Agent（事务外：不持锁、不占连接） ----
  let facts: ChapterFact[];
  try {
    const result = await runner.run<{ facts: RawFact[] }>(CONTINUITY_EXTRACTOR_AGENT, context);
    facts = validateFactsOutput(result.output, context);
  } catch (error) {
    const code = mapExtractionError(error);
    await markRunFailed(input.db, run.id, code);
    throw error instanceof AuthError ? error : new AuthError(code);
  }

  // ---- 3. 提交：候选 + run 终态 + 审计（同一事务） ----
  try {
    const saved = await runWorkWrite(input.db, workId, async (tx) => {
      const current = await tx.chapterFactRun.findUniqueOrThrow({ where: { id: run.id } });
      if (current.status !== 'running') {
        throw new AuthError('CONTINUITY_EXTRACTION_IN_PROGRESS');
      }

      const created: (ChapterFact & { readonly id: string })[] = [];
      for (const fact of facts) {
        const row = await tx.chapterFactCandidate.create({
          data: {
            runId: run.id,
            workId,
            chapterId,
            sourceVersionId: run.sourceVersionId,
            factType: fact.factType,
            payload: toPayload(fact),
          },
          select: { id: true },
        });
        created.push({ ...fact, id: row.id });
      }

      await tx.chapterFactRun.update({
        where: { id: run.id },
        data: { status: 'succeeded', finishedAt: new Date() },
      });

      const factTypeCounts = countFactTypes(created);
      await writeAuditLog(tx, {
        action: AUDIT_ACTIONS.CONTINUITY_FACTS_EXTRACTED,
        actorId: input.authorId,
        targetType: 'chapter',
        targetId: chapterId,
        detail: {
          workId,
          chapterId,
          sourceVersionId: run.sourceVersionId,
          runId: run.id,
          agentName: CONTINUITY_EXTRACTOR_AGENT.name,
          agentVersion: CONTINUITY_EXTRACTOR_AGENT.promptVersion,
          provider: run.provider,
          model: run.model,
          factCount: created.length,
          factTypeCounts,
        },
      });

      return { facts: created, factTypeCounts };
    });

    return {
      runId: run.id,
      chapterId,
      sourceVersionId: run.sourceVersionId,
      sourceVersionNo,
      agentName: CONTINUITY_EXTRACTOR_AGENT.name,
      agentVersion: CONTINUITY_EXTRACTOR_AGENT.promptVersion,
      provider: run.provider,
      model: run.model,
      created: true,
      facts: saved.facts,
      factTypeCounts: saved.factTypeCounts,
    };
  } catch (error) {
    const code = mapExtractionError(error);
    await markRunFailed(input.db, run.id, code);
    throw error instanceof AuthError ? error : new AuthError(code);
  }
}

interface LoadFactContextInput {
  readonly work: { readonly id: string; readonly title: string };
  readonly chapter: { readonly id: string; readonly chapterNo: number; readonly title: string };
  readonly sourceVersion: { readonly versionId: string; readonly versionNo: number };
  readonly chapterText: string;
}

/** 读取当前设定摘要（人物 / 物品 / 境界 / 势力），过滤 secret 字段。 */
async function loadFactContext(
  db: Prisma.TransactionClient,
  workId: string,
  base: LoadFactContextInput,
): Promise<ChapterFactInput> {
  const entities = await db.entity.findMany({
    where: {
      workId,
      deletedAt: null,
      entityType: { in: ['character', 'item', 'realm_level', 'faction'] },
    },
    orderBy: [{ orderIndex: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    take: MAX_FACT_CONTEXT_ENTITIES * 4,
    select: { id: true, entityType: true, name: true, orderIndex: true },
  });

  const attributes =
    entities.length === 0
      ? []
      : await db.entityAttribute.findMany({
          where: { entityId: { in: entities.map((entity) => entity.id) } },
          orderBy: { createdAt: 'asc' },
          select: { entityId: true, attrKey: true, attrValue: true },
        });

  const attributesByEntity = new Map<string, string[]>();
  for (const row of attributes) {
    // 秘密类字段永不进入模型输入（docs/08 的硬约束）
    if (row.attrKey.startsWith('secret')) {
      continue;
    }
    const bucket = attributesByEntity.get(row.entityId) ?? [];
    const text = formatAttributeValue(row.attrValue);
    if (text !== '') {
      bucket.push(`${row.attrKey}：${text}`);
    }
    attributesByEntity.set(row.entityId, bucket);
  }

  const build = (entityType: string, limit: number): FactEntityRef[] =>
    entities
      .filter((entity) => entity.entityType === entityType)
      .slice(0, limit)
      .map((entity) => ({
        id: entity.id,
        name: entity.name,
        summary: truncate(
          (attributesByEntity.get(entity.id) ?? []).join('；'),
          MAX_ENTITY_SUMMARY_LENGTH,
        ),
      }));

  const realms: (FactEntityRef & { orderIndex: number | null })[] = entities
    .filter((entity) => entity.entityType === 'realm_level')
    .slice(0, MAX_FACT_CONTEXT_ENTITIES)
    .map((entity) => ({
      id: entity.id,
      name: entity.name,
      summary: truncate(
        (attributesByEntity.get(entity.id) ?? []).join('；'),
        MAX_ENTITY_SUMMARY_LENGTH,
      ),
      orderIndex: entity.orderIndex,
    }));

  return {
    work: { id: base.work.id, title: base.work.title },
    chapter: {
      id: base.chapter.id,
      chapterNo: base.chapter.chapterNo,
      title: base.chapter.title,
    },
    sourceVersion: base.sourceVersion,
    characters: build('character', MAX_FACT_CONTEXT_ENTITIES),
    items: build('item', MAX_FACT_CONTEXT_ENTITIES),
    realms,
    factions: build('faction', MAX_FACT_CONTEXT_ENTITIES),
    chapterText: base.chapterText,
  };
}

/** 属性值转成稳定的一句话摘要（数组用「、」连接，对象只取标量键）。 */
function formatAttributeValue(value: unknown): string {
  if (typeof value === 'string') {
    return truncate(value.trim(), 120);
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (Array.isArray(value)) {
    return truncate(
      value
        .map((item) =>
          typeof item === 'string' ? item : typeof item === 'number' ? String(item) : '',
        )
        .filter((item) => item !== '')
        .join('、'),
      120,
    );
  }
  if (value !== null && typeof value === 'object') {
    const parts: string[] = [];
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      if (key.startsWith('secret')) {
        continue;
      }
      if (typeof inner === 'string' || typeof inner === 'number' || typeof inner === 'boolean') {
        parts.push(`${key}=${String(inner)}`);
      }
    }
    return truncate(parts.join('，'), 120);
  }
  return '';
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/** 错误 → 稳定错误码（供 run.error_code 与上层映射）。 */
function mapExtractionError(error: unknown): AuthErrorCode {
  if (error instanceof AgentOutputInvalidError || error instanceof AgentInputInvalidError) {
    return 'CONTINUITY_FACTS_INVALID';
  }
  if (error instanceof ChapterFactsInvalidError) {
    return 'CONTINUITY_FACTS_INVALID';
  }
  if (error instanceof AuthError) {
    return error.code;
  }
  return 'CONTINUITY_EXTRACTION_FAILED';
}

/** 把 run 标记为失败（best-effort；失败不掩盖原始错误）。 */
async function markRunFailed(db: PrismaClient, runId: string, errorCode: string): Promise<void> {
  try {
    await db.chapterFactRun.updateMany({
      where: { id: runId, status: 'running' },
      data: { status: 'failed', errorCode, finishedAt: new Date() },
    });
  } catch {
    // 忽略：原始错误更重要；run 会停在 running，由后续重试覆盖
  }
}

function toFactView(candidate: {
  readonly id: string;
  readonly payload: unknown;
}): ChapterFact & { readonly id: string } {
  const payload = candidate.payload as ChapterFact;
  return {
    id: candidate.id,
    factType: payload.factType,
    summary: payload.summary,
    reason: payload.reason,
    ...(payload.subjectId === undefined ? {} : { subjectId: payload.subjectId }),
    ...(payload.objectId === undefined ? {} : { objectId: payload.objectId }),
    ...(payload.name === undefined ? {} : { name: payload.name }),
    ...(payload.threadStatus === undefined ? {} : { threadStatus: payload.threadStatus }),
  };
}

/** 候选 payload：显式构造纯 JSON 对象（字段固定，无法夹带正文）。 */
function toPayload(fact: ChapterFact): Prisma.InputJsonObject {
  return {
    factType: fact.factType,
    summary: fact.summary,
    reason: fact.reason,
    ...(fact.subjectId === undefined ? {} : { subjectId: fact.subjectId }),
    ...(fact.objectId === undefined ? {} : { objectId: fact.objectId }),
    ...(fact.name === undefined ? {} : { name: fact.name }),
    ...(fact.threadStatus === undefined ? {} : { threadStatus: fact.threadStatus }),
  };
}

function countFactTypes(facts: readonly { readonly factType: string }[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const fact of facts) {
    counts[fact.factType] = (counts[fact.factType] ?? 0) + 1;
  }
  return counts;
}
