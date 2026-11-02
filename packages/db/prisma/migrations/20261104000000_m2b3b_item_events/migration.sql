-- M2-B3-B1：物品事件流水（item_events）。
--
-- 设计要点（与契约一致，改动前请先读）：
--
-- 1. 物品持有人**只有**一个真相：本表的完整流水回放。
--    `item` 规则包里没有 holder 字段，`entity_attributes` 也不存持有人，
--    因此不存在"属性与流水双写不一致"的可能。
--
-- 2. 只追加，不修改：数据库层用触发器禁止 UPDATE / DELETE。
--    录错了不是改历史，而是**追加一条冲正事件**（reversal_of 指向被冲正事件）。
--
-- 3. 回放口径（服务层实现）：冲正行与其目标行**同时**从有效流里剔除，
--    所以回放结果等价于"该冲正从未发生过"。冲正行的 from/to 只用于展示。
--    这也是为什么下面的形态 CHECK 对**冲正行同样成立**而无需开例外：
--      obtained   : from = NULL, to NOT NULL   （冲正 consumed/lost 时也是这个形状）
--      transferred: from/to 均非空且不同        （冲正 transferred 时是反向，仍不同）
--      consumed/lost: from NOT NULL, to = NULL  （冲正 obtained 时也是这个形状）
--
-- 4. seq_no 由服务层在**作品级 advisory lock 内**取 max+1，
--    本表的 (item_entity_id, seq_no) 唯一索引是并发兜底。
--
-- 5. 幂等：客户端提供 idempotency_key，(item_entity_id, idempotency_key) 唯一。
--    同键同内容返回既有事件；同键不同内容 409。
--
-- 6. **不建 chapter_id**：chapters 表尚不存在。等 chapters 迁移落地时，
--    在同一次迁移里补列 + FK，避免先建一个永远为 NULL 的悬空列。
--
-- 7. 外键一律 ON DELETE RESTRICT：entities / works 只有软删除，
--    项目也没有硬删除入口，因此 RESTRICT 不会挡住任何现有流程；
--    反过来它保证"事件永不因父行消失而丢失"。

-- CreateTable
CREATE TABLE "item_events" (
    "id" UUID NOT NULL,
    "work_id" UUID NOT NULL,
    "item_entity_id" UUID NOT NULL,
    "event_type" TEXT NOT NULL,
    -- from_holder 只由服务端按当前状态推导，接口层不接受客户端提交。
    "from_holder" UUID,
    "to_holder" UUID,
    "seq_no" INTEGER NOT NULL,
    "reversal_of" UUID,
    "idempotency_key" TEXT NOT NULL,
    "note" TEXT,
    "created_by" UUID,
    -- 与 entity_versions / entities.deleted_at 同口径：取数据库时钟的**实际落库时刻**，
    -- 而不是事务开始时刻（事务会先等作品级锁，开始时刻可能远早于写入时刻）。
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT "item_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex：同一物品内序号唯一、单调（回放靠它严格排序）
CREATE UNIQUE INDEX "item_events_item_entity_id_seq_no_key"
    ON "item_events"("item_entity_id", "seq_no");

-- CreateIndex：幂等键按物品维度唯一
CREATE UNIQUE INDEX "item_events_item_entity_id_idempotency_key_key"
    ON "item_events"("item_entity_id", "idempotency_key");

-- CreateIndex：一个原事件只能被冲正一次（部分唯一索引，NULL 不参与）
CREATE UNIQUE INDEX "item_events_reversal_of_key"
    ON "item_events"("reversal_of")
    WHERE "reversal_of" IS NOT NULL;

-- CreateIndex：按作品回放（删除人物时判定"仍是某些物品的当前持有人"）
CREATE INDEX "item_events_work_id_item_entity_id_seq_no_idx"
    ON "item_events"("work_id", "item_entity_id", "seq_no");

-- 事件类型白名单
ALTER TABLE "item_events" ADD CONSTRAINT "item_events_event_type_check"
    CHECK ("event_type" IN ('obtained', 'transferred', 'consumed', 'lost'));

-- 每种事件类型的持有人形态（对普通行与冲正行都成立，见文件头第 3 条）
ALTER TABLE "item_events" ADD CONSTRAINT "item_events_holder_shape_check"
    CHECK (
        ("event_type" = 'obtained'
            AND "from_holder" IS NULL
            AND "to_holder" IS NOT NULL)
        OR ("event_type" = 'transferred'
            AND "from_holder" IS NOT NULL
            AND "to_holder" IS NOT NULL
            AND "from_holder" <> "to_holder")
        OR ("event_type" IN ('consumed', 'lost')
            AND "from_holder" IS NOT NULL
            AND "to_holder" IS NULL)
    );

-- 序号从 1 开始
ALTER TABLE "item_events" ADD CONSTRAINT "item_events_seq_no_check"
    CHECK ("seq_no" >= 1);

-- 不能冲正自己
ALTER TABLE "item_events" ADD CONSTRAINT "item_events_reversal_not_self_check"
    CHECK ("reversal_of" IS NULL OR "reversal_of" <> "id");

-- 幂等键长度（接口层同样校验，这里是兜底）
ALTER TABLE "item_events" ADD CONSTRAINT "item_events_idempotency_key_length_check"
    CHECK (char_length("idempotency_key") BETWEEN 8 AND 128);

-- 备注长度上限；note 属剧情内容，只落库，不进审计/日志
ALTER TABLE "item_events" ADD CONSTRAINT "item_events_note_length_check"
    CHECK ("note" IS NULL OR char_length("note") <= 500);

-- AddForeignKey
ALTER TABLE "item_events" ADD CONSTRAINT "item_events_work_id_fkey"
    FOREIGN KEY ("work_id") REFERENCES "works"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "item_events" ADD CONSTRAINT "item_events_item_entity_id_fkey"
    FOREIGN KEY ("item_entity_id") REFERENCES "entities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "item_events" ADD CONSTRAINT "item_events_from_holder_fkey"
    FOREIGN KEY ("from_holder") REFERENCES "entities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "item_events" ADD CONSTRAINT "item_events_to_holder_fkey"
    FOREIGN KEY ("to_holder") REFERENCES "entities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "item_events" ADD CONSTRAINT "item_events_reversal_of_fkey"
    FOREIGN KEY ("reversal_of") REFERENCES "item_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "item_events" ADD CONSTRAINT "item_events_created_by_fkey"
    FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- append-only：数据库层禁止 UPDATE / DELETE。
-- 与 audit_logs 同一套做法：任何修改尝试都抛错（restrict_violation），
-- 而不是静默成功。应用只提供 INSERT 与 SELECT。
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "item_events_reject_mutation"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'item_events 为 append-only，禁止 % 操作', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "item_events_no_update"
  BEFORE UPDATE ON "item_events"
  FOR EACH ROW EXECUTE FUNCTION "item_events_reject_mutation"();

CREATE TRIGGER "item_events_no_delete"
  BEFORE DELETE ON "item_events"
  FOR EACH ROW EXECUTE FUNCTION "item_events_reject_mutation"();
