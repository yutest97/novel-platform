/**
 * 确定性 ContextBuilder（A1-2）。
 *
 * 规则（硬约束）：
 * - 只读取任务所属的 work / chapter / 设定 / 人物，**不跨作品**；
 * - 装配顺序固定：章节合同输入 → 人物 → 境界 → 势力 → 作品方向；
 * - 不做 RAG、不调用模型决定上下文；
 * - 人物"秘密"类字段（secret / secretKnownBy）**不进入**模型输入与摘要；
 * - 每条来源写入 task_contexts（snippet ≤ 500、rank 稳定），
 *   便于回答"模型实际看到了什么"。
 */

import type { PrismaClient } from '@novel/db';
import { parseRuleFieldSchema, type FieldDefinition, type FieldGroup } from '@novel/works';

import { NonRetryableTaskError } from '../errors.js';
import { MAX_CONTEXT_SNIPPET_CHARS } from '../queue.js';
import {
  isChapterOpenForGeneration,
  MAX_CONTEXT_ENTITIES_PER_TYPE,
  MAX_CONTRACT_TARGET_WORDS,
  MIN_CONTRACT_TARGET_WORDS,
  type AssembledContext,
  type ChapterDraftContext,
  type ChapterStyle,
  type ContextEntity,
  type ContextSource,
} from './types.js';

type ContextDb = Pick<
  PrismaClient,
  'work' | 'chapter' | 'rulePackage' | 'workSetting' | 'entity' | 'entityAttribute'
>;

/** 参与上下文装配的实体类型（顺序固定）。 */
const CONTEXT_ENTITY_TYPES = ['character', 'realm_level', 'faction'] as const;

const RANK_CHAPTER = 1;
const RANK_CHARACTER_BASE = 100;
const RANK_REALM_BASE = 200;
const RANK_FACTION_BASE = 300;
const RANK_DIRECTION = 400;
const RANK_TRUNCATED = 500;

const ENTITY_TYPE_LABELS: Readonly<Record<string, string>> = {
  character: '人物',
  realm_level: '境界',
  faction: '势力',
};

const DEFAULT_STYLE: ChapterStyle = {
  tone: '克制',
  pointOfView: '第三人称限知',
  pacing: '中速',
};

export interface BuildContextInput {
  readonly workId: string;
  readonly chapterId: string;
  /** 已由任务输入解析；未提供时取作品默认值并收敛到合同区间。 */
  readonly targetWords?: number;
  readonly style?: Partial<ChapterStyle>;
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}

function notFound(detail: string): never {
  throw new NonRetryableTaskError('TASK_INPUT_INVALID', detail);
}

function resolveTargetWords(requested: number | undefined, workDefault: number): number {
  if (requested !== undefined) {
    if (
      !Number.isInteger(requested) ||
      requested < MIN_CONTRACT_TARGET_WORDS ||
      requested > MAX_CONTRACT_TARGET_WORDS
    ) {
      notFound(
        `targetWords 必须是 ${MIN_CONTRACT_TARGET_WORDS}..${MAX_CONTRACT_TARGET_WORDS} 的整数`,
      );
    }
    return requested;
  }
  return Math.min(MAX_CONTRACT_TARGET_WORDS, Math.max(MIN_CONTRACT_TARGET_WORDS, workDefault));
}

function displayValue(
  field: FieldDefinition,
  value: unknown,
  names: ReadonlyMap<string, string>,
): string | null {
  if (typeof value === 'string') {
    if (field.type === 'enum') {
      return field.options?.find((option) => option.value === value)?.label ?? value;
    }
    if (field.type === 'entityRef') {
      return names.get(value) ?? '（已删除）';
    }
    return value === '' ? null : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (Array.isArray(value)) {
    const items = value
      .filter((item): item is string => typeof item === 'string')
      .map((item) => (field.type === 'entityRefs' ? (names.get(item) ?? '（已删除）') : item))
      .filter((item) => item !== '');
    return items.length === 0 ? null : items.join('、');
  }
  return null;
}

/** 把一组属性格式化为"标签：值；标签：值"，秘密字段直接跳过。 */
function formatAttributes(
  group: FieldGroup,
  attributes: ReadonlyMap<string, unknown>,
  names: ReadonlyMap<string, string>,
): string {
  const parts: string[] = [];
  for (const field of group.fields) {
    // 秘密类字段只留在设定中心，不进入模型输入 / 上下文摘要 / 审计。
    if (field.key.startsWith('secret')) {
      continue;
    }
    const value = attributes.get(field.key);
    if (value === undefined || value === null) {
      continue;
    }
    const display = displayValue(field, value, names);
    if (display === null) {
      continue;
    }
    parts.push(`${field.label}：${display}`);
  }
  return parts.join('；');
}

/**
 * 装配上下文。
 *
 * 只返回"任务所属作品"的数据；任何跨作品的读取都不会发生。
 */
export async function buildChapterDraftContext(
  db: ContextDb,
  input: BuildContextInput,
): Promise<AssembledContext> {
  const work = await db.work.findUnique({
    where: { id: input.workId },
    select: {
      id: true,
      title: true,
      summary: true,
      authorId: true,
      genreRulePackage: true,
      targetWordsPerChapter: true,
    },
  });
  if (work === null) {
    notFound('作品不存在');
  }

  const chapter = await db.chapter.findFirst({
    where: { id: input.chapterId, workId: work.id },
    select: { id: true, chapterNo: true, title: true, status: true },
  });
  if (chapter === null) {
    notFound('章节不存在');
  }
  // 章节可能在任务排队期间被定稿 / 废弃：这是不可重试的输入问题，
  // 直接失败，不写合同、不写候选（不为已关闭章节自动重开）。
  if (!isChapterOpenForGeneration(chapter.status)) {
    throw new NonRetryableTaskError('TASK_INPUT_INVALID', '章节已定稿或已废弃，不能继续生成');
  }

  const rulePackage = await db.rulePackage.findUnique({
    where: { code: work.genreRulePackage },
    select: { fieldSchema: true },
  });
  if (rulePackage === null) {
    throw new NonRetryableTaskError('WORKFLOW_INTERNAL_ERROR', '作品的规则包不存在');
  }
  const schema = parseRuleFieldSchema(rulePackage.fieldSchema);
  const directionGroup = schema.workDirection ?? null;
  const groups = new Map<string, FieldGroup>();
  for (const entityType of CONTEXT_ENTITY_TYPES) {
    const group = schema.entityTypes?.[entityType];
    if (group !== undefined) {
      groups.set(entityType, group);
    }
  }

  const directionRows =
    directionGroup === null
      ? []
      : await db.workSetting.findMany({
          where: { workId: work.id, schemaRef: directionGroup.schemaRef },
          orderBy: { settingKey: 'asc' },
          select: { settingKey: true, settingValue: true },
        });
  const directionValues = new Map<string, unknown>();
  for (const row of directionRows) {
    directionValues.set(row.settingKey, row.settingValue);
  }

  // 每类最多取 50 条（多取 1 条只用于判断是否发生截断）。
  // 顺序固定：order_index asc → createdAt asc → id asc，保证分页/重试稳定。
  const entityRows: { id: string; entityType: string; name: string }[] = [];
  const truncatedTypes: string[] = [];
  for (const entityType of CONTEXT_ENTITY_TYPES) {
    const rows = await db.entity.findMany({
      where: { workId: work.id, entityType, deletedAt: null },
      orderBy: [{ orderIndex: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      take: MAX_CONTEXT_ENTITIES_PER_TYPE + 1,
      select: { id: true, entityType: true, name: true },
    });
    if (rows.length > MAX_CONTEXT_ENTITIES_PER_TYPE) {
      truncatedTypes.push(entityType);
    }
    entityRows.push(...rows.slice(0, MAX_CONTEXT_ENTITIES_PER_TYPE));
  }

  const names = new Map<string, string>();
  for (const entity of entityRows) {
    names.set(entity.id, entity.name);
  }

  const attributeRows =
    entityRows.length === 0
      ? []
      : await db.entityAttribute.findMany({
          where: { entityId: { in: entityRows.map((entity) => entity.id) } },
          select: { entityId: true, attrKey: true, attrValue: true, schemaRef: true },
        });
  // entityId -> schemaRef -> attrKey -> value
  const attributesByEntity = new Map<string, Map<string, Map<string, unknown>>>();
  for (const row of attributeRows) {
    const bySchema =
      attributesByEntity.get(row.entityId) ?? new Map<string, Map<string, unknown>>();
    const bucket = bySchema.get(row.schemaRef) ?? new Map<string, unknown>();
    bucket.set(row.attrKey, row.attrValue);
    bySchema.set(row.schemaRef, bucket);
    attributesByEntity.set(row.entityId, bySchema);
  }

  const buildEntities = (entityType: string): ContextEntity[] => {
    const group = groups.get(entityType);
    return entityRows
      .filter((entity) => entity.entityType === entityType)
      .map((entity) => {
        // 只读当前 schemaRef 的属性：旧契约写入的值不得混入。
        const attributes =
          group === undefined
            ? new Map<string, unknown>()
            : (attributesByEntity.get(entity.id)?.get(group.schemaRef) ??
              new Map<string, unknown>());
        const summary = group === undefined ? '' : formatAttributes(group, attributes, names);
        return { id: entity.id, name: entity.name, summary } satisfies ContextEntity;
      });
  };

  const characters = buildEntities('character');
  const realms = buildEntities('realm_level');
  const factions = buildEntities('faction');

  const direction: Record<string, string> = {};
  if (directionGroup !== null) {
    for (const field of directionGroup.fields) {
      const value = directionValues.get(field.key);
      if (value === undefined || value === null) {
        continue;
      }
      const display = displayValue(field, value, names);
      if (display !== null) {
        direction[field.label] = display;
      }
    }
  }

  const targetWords = resolveTargetWords(input.targetWords, work.targetWordsPerChapter);
  const directionTone =
    typeof directionValues.get('toneStyle') === 'string'
      ? (directionValues.get('toneStyle') as string)
      : '';
  const style: ChapterStyle = {
    tone: input.style?.tone ?? (directionTone === '' ? DEFAULT_STYLE.tone : directionTone),
    pointOfView: input.style?.pointOfView ?? DEFAULT_STYLE.pointOfView,
    pacing: input.style?.pacing ?? DEFAULT_STYLE.pacing,
  };

  const context: ChapterDraftContext = {
    work: {
      id: work.id,
      title: work.title,
      summary: work.summary,
      authorId: work.authorId,
    },
    chapter: {
      id: chapter.id,
      chapterNo: chapter.chapterNo,
      title: chapter.title,
      status: chapter.status,
    },
    style,
    targetWords,
    direction,
    characters,
    realms,
    factions,
  };

  const directionSnippet =
    Object.keys(direction).length === 0
      ? '作品方向：未填写'
      : `作品方向：${Object.entries(direction)
          .map(([label, value]) => `${label}：${value}`)
          .join('；')}`;

  const sources: ContextSource[] = [
    {
      contextType: 'chapter',
      refId: chapter.id,
      snippet: truncate(
        `第${chapter.chapterNo}章《${chapter.title}》｜目标 ${targetWords} 字｜视角：${style.pointOfView}｜节奏：${style.pacing}`,
        MAX_CONTEXT_SNIPPET_CHARS,
      ),
      rank: RANK_CHAPTER,
    },
    ...characters.map((entity, index) => ({
      contextType: 'character',
      refId: entity.id,
      snippet: truncate(
        `${entity.name}（人物）：${entity.summary === '' ? '未填写' : entity.summary}`,
        MAX_CONTEXT_SNIPPET_CHARS,
      ),
      rank: RANK_CHARACTER_BASE + index,
    })),
    ...realms.map((entity, index) => ({
      contextType: 'realm_level',
      refId: entity.id,
      snippet: truncate(
        `${entity.name}（境界）：${entity.summary === '' ? '未填写' : entity.summary}`,
        MAX_CONTEXT_SNIPPET_CHARS,
      ),
      rank: RANK_REALM_BASE + index,
    })),
    ...factions.map((entity, index) => ({
      contextType: 'faction',
      refId: entity.id,
      snippet: truncate(
        `${entity.name}（势力）：${entity.summary === '' ? '未填写' : entity.summary}`,
        MAX_CONTEXT_SNIPPET_CHARS,
      ),
      rank: RANK_FACTION_BASE + index,
    })),
    {
      contextType: 'work_direction',
      refId: work.id,
      snippet: truncate(directionSnippet, MAX_CONTEXT_SNIPPET_CHARS),
      rank: RANK_DIRECTION,
    },
  ];

  if (truncatedTypes.length > 0) {
    const labels = truncatedTypes.map((type) => ENTITY_TYPE_LABELS[type] ?? type).join('/');
    sources.push({
      contextType: 'context.truncated',
      refId: null,
      snippet: `上下文截断：${labels}超过 ${MAX_CONTEXT_ENTITIES_PER_TYPE} 条，仅保留前 ${MAX_CONTEXT_ENTITIES_PER_TYPE} 条`,
      rank: RANK_TRUNCATED,
    });
  }

  return { context, sources };
}
