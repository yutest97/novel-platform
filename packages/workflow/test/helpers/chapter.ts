/**
 * 单章流水线测试辅助（A1-2）。
 *
 * 每个用例独立作品，实体名带随机 tag，避免跨用例/跨作品串数据。
 */

import { randomUUID } from 'node:crypto';

import type { PrismaClient } from '@novel/db';
import { parseRuleFieldSchema } from '@novel/works';

import type { ModelJsonInput } from '../../src/model-types.js';
import { MockProvider, type MockJsonValue } from '../../src/providers/mock.js';
import { createTestUser, createTestWork } from './db.js';

export interface FixtureEntity {
  readonly id: string;
  readonly name: string;
}

export interface ChapterFixture {
  readonly tag: string;
  readonly authorId: string;
  readonly email: string;
  readonly workId: string;
  readonly workTitle: string;
  readonly chapterId: string;
  readonly chapterNo: number;
  readonly chapterTitle: string;
  readonly realms: readonly FixtureEntity[];
  readonly factions: readonly FixtureEntity[];
  readonly characters: readonly FixtureEntity[];
}

async function loadSchema(db: PrismaClient) {
  const rule = await db.rulePackage.findUnique({
    where: { code: 'xuanhuan' },
    select: { fieldSchema: true },
  });
  if (rule === null) {
    throw new Error('测试库缺少 xuanhuan 规则包');
  }
  return parseRuleFieldSchema(rule.fieldSchema);
}

async function schemaRefFor(db: PrismaClient, kind: string): Promise<string> {
  const schema = await loadSchema(db);
  const group = kind === 'workDirection' ? schema.workDirection : schema.entityTypes?.[kind];
  if (group === undefined) {
    throw new Error(`规则包缺少字段组 ${kind}`);
  }
  return group.schemaRef;
}

async function createEntity(
  db: PrismaClient,
  input: {
    workId: string;
    entityType: string;
    name: string;
    orderIndex: number;
    attributes: Record<string, unknown>;
  },
): Promise<FixtureEntity> {
  const schemaRef = await schemaRefFor(db, input.entityType);
  const entity = await db.entity.create({
    data: {
      workId: input.workId,
      entityType: input.entityType,
      name: input.name,
      orderIndex: input.orderIndex,
    },
    select: { id: true, name: true },
  });
  const entries = Object.entries(input.attributes);
  if (entries.length > 0) {
    await db.entityAttribute.createMany({
      data: entries.map(([attrKey, attrValue]) => ({
        entityId: entity.id,
        attrKey,
        attrValue: attrValue as never,
        schemaRef,
      })),
    });
  }
  return entity;
}

/**
 * 建一个最小但完整的玄幻作品：
 * 作品方向 + 2 境界 + 1 势力 + 2 人物（含秘密字段，用来验证不进上下文）。
 */
export async function createChapterFixture(
  db: PrismaClient,
  options: { tag?: string } = {},
): Promise<ChapterFixture> {
  const tag = options.tag ?? randomUUID().slice(0, 6);
  const author = await createTestUser(db, 'author');
  const work = await createTestWork(db, author.id, `A1-2 作品-${tag}`);

  const directionRef = await schemaRefFor(db, 'workDirection');
  await db.workSetting.createMany({
    data: [
      {
        workId: work.id,
        settingKey: 'subGenre',
        settingValue: '东方玄幻',
        schemaRef: directionRef,
      },
      {
        workId: work.id,
        settingKey: 'goldenFinger',
        settingValue: `吞星古卷-${tag}`,
        schemaRef: directionRef,
      },
      {
        workId: work.id,
        settingKey: 'toneStyle',
        settingValue: '冷峻克制',
        schemaRef: directionRef,
      },
    ],
  });

  const qi = await createEntity(db, {
    workId: work.id,
    entityType: 'realm_level',
    name: `炼气-${tag}`,
    orderIndex: 1,
    attributes: { powerBaseline: '凡人十倍', description: '引气入体' },
  });
  const foundation = await createEntity(db, {
    workId: work.id,
    entityType: 'realm_level',
    name: `筑基-${tag}`,
    orderIndex: 2,
    attributes: { powerBaseline: '凡人百倍', description: '筑就道基' },
  });
  const sect = await createEntity(db, {
    workId: work.id,
    entityType: 'faction',
    name: `青云宗-${tag}`,
    orderIndex: 1,
    attributes: { type: 'sect', tier: '一流', description: '东域第一宗' },
  });
  const hero = await createEntity(db, {
    workId: work.id,
    entityType: 'character',
    name: `李青-${tag}`,
    orderIndex: 1,
    attributes: {
      identity: '外门弟子',
      personality: '克制隐忍',
      goal: '查明灭门真相',
      secret: `他其实是${tag}界的转世`,
      initialRealm: qi.id,
      faction: sect.id,
    },
  });
  const rival = await createEntity(db, {
    workId: work.id,
    entityType: 'character',
    name: `赵四-${tag}`,
    orderIndex: 2,
    attributes: {
      identity: '内门弟子',
      personality: '骄横',
      goal: '保住内门第一',
      initialRealm: foundation.id,
      faction: sect.id,
    },
  });

  const chapterTitle = `初入青云-${tag}`;
  const chapter = await db.chapter.create({
    data: { workId: work.id, chapterNo: 1, title: chapterTitle },
    select: { id: true, chapterNo: true },
  });

  return {
    tag,
    authorId: author.id,
    email: author.email,
    workId: work.id,
    workTitle: work.title,
    chapterId: chapter.id,
    chapterNo: chapter.chapterNo,
    chapterTitle,
    realms: [qi, foundation],
    factions: [sect],
    characters: [hero, rival],
  };
}

/** 追加若干人物（用于验证 50 条上限）。 */
export async function addCharacters(
  db: PrismaClient,
  fixture: ChapterFixture,
  count: number,
): Promise<FixtureEntity[]> {
  const created: FixtureEntity[] = [];
  for (let index = 0; index < count; index += 1) {
    created.push(
      await createEntity(db, {
        workId: fixture.workId,
        entityType: 'character',
        name: `群演-${fixture.tag}-${String(index).padStart(2, '0')}`,
        orderIndex: 100 + index,
        attributes: { identity: '外门弟子' },
      }),
    );
  }
  return created;
}

/** 合法的 Planner 输出（人物名取自 fixture）。 */
export function defaultPlannerOutput(
  fixture: ChapterFixture,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const [hero, rival] = fixture.characters;
  const sect = fixture.factions[0];
  return {
    goal: `${hero?.name ?? '主角'}在${sect?.name ?? '宗门'}外门大比中暴露真实实力。`,
    mustInclude: ['外门大比', `${hero?.name ?? '主角'}的隐藏修为`],
    mustNotInclude: [`${hero?.name ?? '主角'}的身世`],
    characters: [hero?.name ?? '主角', rival?.name ?? '对手'],
    scenes: [
      {
        purpose: '把主角逼上台',
        location: '演武场',
        conflict: '赵四当众挑衅',
        outcome: '主角被迫应战',
      },
      {
        purpose: '第一次反转',
        location: '擂台',
        conflict: '境界压制失效',
        outcome: '主角露出炼气九层',
      },
    ],
    targetWords: 3000,
    ...overrides,
  };
}

/** 一篇明显超过 1200 字、带空行与段落的正文。 */
export function longDraft(tag = ''): string {
  const sentence = `风从演武场尽头吹来，李青握紧手中的木剑${tag === '' ? '' : `，${tag}`}。`;
  const paragraphs = Array.from(
    { length: 20 },
    (_, index) => `第${index + 1}段：${sentence.repeat(4)}`,
  );
  return paragraphs.join('\n\n');
}

export interface ChapterProviderHandlers {
  readonly planner?: (input: ModelJsonInput) => unknown;
  readonly writer?: (input: ModelJsonInput) => unknown;
}

export interface ChapterProvider {
  readonly provider: MockProvider;
  readonly calls: {
    readonly planner: ModelJsonInput[];
    readonly writer: ModelJsonInput[];
  };
}

/**
 * 用 MockProvider 按 system prompt 分派 Planner / Writer，并记录实际模型输入。
 *
 * 记录只用于测试断言"模型看到了什么"，不写日志、不落库。
 */
export function createChapterProvider(
  handlers: ChapterProviderHandlers,
  defaults: { plan: Record<string, unknown>; text: string },
): ChapterProvider {
  const planner: ModelJsonInput[] = [];
  const writer: ModelJsonInput[] = [];
  const provider = new MockProvider({
    json: (input) => {
      const system = input.messages[0]?.content ?? '';
      if (system.includes('planner.chapter')) {
        planner.push(input);
        return handlers.planner === undefined
          ? (defaults.plan as MockJsonValue)
          : (handlers.planner(input) as MockJsonValue);
      }
      writer.push(input);
      return handlers.writer === undefined
        ? { text: defaults.text }
        : (handlers.writer(input) as MockJsonValue);
    },
  });
  return { provider, calls: { planner, writer } };
}

/** 从模型输入里取出 user 消息（结构化 JSON）。 */
export function lastUserContent(input: ModelJsonInput): string {
  return input.messages
    .filter((message) => message.role === 'user')
    .map((message) => message.content)
    .join('\n');
}
