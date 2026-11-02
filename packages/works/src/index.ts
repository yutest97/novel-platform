/**
 * @novel/works —— 小说作品核心（M2-A）。
 *
 * 只包含"作品 / 题材规则包 / 作品设定"三类对象；
 * 章节、人物、境界、大纲生成与模型调用**不在**本阶段范围内。
 */

export {
  ALLOWED_RULE_PACKAGE_CODE,
  DEFAULT_TARGET_CHAPTERS,
  DEFAULT_TARGET_WORDS_PER_CHAPTER,
  MAX_SUMMARY_LENGTH,
  MAX_TARGET_CHAPTERS,
  MAX_TARGET_WORDS_PER_CHAPTER,
  MAX_TITLE_LENGTH,
  MIN_TARGET_CHAPTERS,
  MIN_TARGET_WORDS_PER_CHAPTER,
  assertTargetChapters,
  assertTargetWordsPerChapter,
  assertUsableRulePackage,
  createWork,
  getWork,
  listActiveRulePackages,
  listWorks,
  normalizeSummary,
  normalizeTitle,
  updateWork,
} from './works.js';

export {
  DEFAULT_ENTITY_TYPE,
  MAX_ENTITY_NAME_LENGTH,
  MAX_REFERENCE_SUMMARY_ITEMS,
  SUPPORTED_ENTITY_TYPES,
  createEntity,
  deleteEntity,
  getSettingsCenter,
  isSupportedEntityType,
  listEntities,
  normalizeEntityName,
  reorderEntities,
  updateDirection,
  updateEntity,
} from './entities.js';

export type {
  CreateEntityInput,
  DeleteEntityInput,
  EntityGroupView,
  EntityReferenceSummaryItem,
  EntityView,
  ReorderEntitiesInput,
  SettingsCenterView,
  SupportedEntityType,
  UpdateDirectionInput,
  UpdateEntityInput,
} from './entities.js';

export { assertUuid, isUuid } from './ids.js';

export { WORK_LOCK_NAMESPACE, lockWork, runWorkWrite } from './work-lock.js';

export { requireOwnedWork } from './work-access.js';
export type { WorkContext } from './work-access.js';

export {
  DEFAULT_ITEM_EVENT_PAGE_SIZE,
  MAX_IDEMPOTENCY_KEY_LENGTH,
  MAX_ITEM_EVENT_NOTE_LENGTH,
  MAX_ITEM_EVENT_PAGE_SIZE,
  MIN_IDEMPOTENCY_KEY_LENGTH,
  appendItemEvent,
  getItemState,
  listItemEvents,
  reverseItemEvent,
} from './item-events.js';

export type {
  AppendItemEventInput,
  GetItemStateInput,
  ItemEventMutationResult,
  ItemEventPage,
  ItemEventView,
  ItemHolderRef,
  ItemStateView,
  ListItemEventsInput,
  ReverseItemEventInput,
} from './item-events.js';

export {
  ITEM_EVENT_TYPES,
  findItemsHeldBy,
  isItemEventType,
  loadItemEventRows,
  replayItemState,
} from './item-state.js';

export type { ItemEventRow, ItemEventType, ItemStateSnapshot, ItemStatus } from './item-state.js';

export {
  MAX_ENTITY_REFS,
  assertFieldSchemaContract,
  buildSchemaSummary,
  entityTypeGroup,
  isReferenceFieldType,
  parseRuleFieldSchema,
  validateFields,
  workDirectionGroup,
} from './schema.js';

export type {
  EnumOption,
  FieldDefinition,
  FieldGroup,
  FieldType,
  RuleFieldSchema,
  SchemaSummary,
} from './schema.js';

export type {
  CreateWorkInput,
  RulePackageView,
  UpdateWorkInput,
  WorkDetailView,
  WorkSettingView,
  WorkView,
} from './works.js';
