/**
 * 章节工作台纯展示逻辑（A1-4A）。
 */

import { describe, expect, it } from 'vitest';

import type { ChapterListItem } from '../src/lib/api';
import {
  canGenerateChapter,
  chapterBadge,
  chapterStatusLabel,
  displayPlan,
  isTerminalTaskStatus,
  nextPollDelay,
  shouldPollTask,
  taskProgressLabel,
  taskStatusLabel,
  taskStepLabel,
  versionSourceLabel,
} from '../src/lib/chapter-workbench';

function item(overrides: Partial<ChapterListItem> = {}): ChapterListItem {
  return {
    id: 'chapter-1',
    workId: 'work-1',
    chapterNo: 1,
    title: '第一章',
    status: 'planned',
    latestTaskStatus: null,
    latestTaskStep: null,
    updatedAt: '2026-11-04T00:00:00.000Z',
    ...overrides,
  };
}

describe('章节状态', () => {
  it('只有开放状态允许生成', () => {
    for (const status of ['planned', 'outlined', 'drafting', 'in_review']) {
      expect(canGenerateChapter(status), status).toBe(true);
    }
    for (const status of ['finalized', 'abandoned', 'unknown']) {
      expect(canGenerateChapter(status), status).toBe(false);
    }
  });

  it('徽标：生成中的任务优先，其次失败，再按章节状态', () => {
    expect(chapterBadge(item({ latestTaskStatus: 'queued' }))).toEqual({
      label: '生成中',
      tone: 'warn',
    });
    expect(chapterBadge(item({ latestTaskStatus: 'processing', status: 'finalized' }))).toEqual({
      label: '生成中',
      tone: 'warn',
    });
    expect(chapterBadge(item({ latestTaskStatus: 'failed' }))).toEqual({
      label: '生成失败',
      tone: 'danger',
    });
    expect(chapterBadge(item({ status: 'finalized' }))).toEqual({ label: '已完成', tone: 'ok' });
    expect(chapterBadge(item({ status: 'abandoned' }))).toEqual({
      label: '已废弃',
      tone: 'danger',
    });
    expect(chapterBadge(item({ status: 'in_review' }))).toEqual({ label: '待定稿', tone: 'warn' });
    expect(chapterBadge(item())).toEqual({ label: '待生成', tone: 'muted' });
  });

  it('章节 / 任务状态中文稳定', () => {
    expect(chapterStatusLabel('finalized')).toBe('已完成');
    expect(chapterStatusLabel('nope')).toBe('未知状态');
    expect(taskStatusLabel('succeeded')).toBe('已完成');
    expect(taskStatusLabel('nope')).toBe('未知状态');
  });
});

describe('任务步骤与轮询', () => {
  it('六个固定步骤都有中文文案', () => {
    expect(taskStepLabel('assemble_context')).toBe('正在装配设定');
    expect(taskStepLabel('plan_chapter')).toBe('正在规划章节');
    expect(taskStepLabel('validate_and_freeze_contract')).toBe('正在冻结合同');
    expect(taskStepLabel('write_draft')).toBe('正在写正文');
    expect(taskStepLabel('validate_draft')).toBe('正在校验正文');
    expect(taskStepLabel('persist_candidate')).toBe('正在保存候选');
    expect(taskStepLabel(null)).toBeNull();
    expect(taskStepLabel('future_step')).toBe('future_step');
  });

  it('只轮询 queued / processing；终态立即停止', () => {
    expect(shouldPollTask('queued')).toBe(true);
    expect(shouldPollTask('processing')).toBe(true);
    for (const status of ['succeeded', 'failed', 'cancelled', null]) {
      expect(shouldPollTask(status), String(status)).toBe(false);
    }
    expect(isTerminalTaskStatus('succeeded')).toBe(true);
    expect(isTerminalTaskStatus('failed')).toBe(true);
    expect(isTerminalTaskStatus('cancelled')).toBe(true);
    expect(isTerminalTaskStatus('processing')).toBe(false);
  });

  it('轮询间隔 1s 起、每次 +1s、最大 5s', () => {
    expect(nextPollDelay(0)).toBe(1000);
    expect(nextPollDelay(1000)).toBe(2000);
    expect(nextPollDelay(2000)).toBe(3000);
    expect(nextPollDelay(3000)).toBe(4000);
    expect(nextPollDelay(4000)).toBe(5000);
    expect(nextPollDelay(5000)).toBe(5000);
    expect(nextPollDelay(Number.NaN)).toBe(1000);
  });

  it('进度文案优先 currentStep', () => {
    expect(
      taskProgressLabel({
        id: 't',
        chapterId: 'c',
        status: 'processing',
        currentStep: 'write_draft',
        attemptCount: 1,
        maxAttempts: 3,
        cancelRequestedAt: null,
        errorCode: null,
        errorMessage: null,
        createdAt: '',
        updatedAt: '',
      }),
    ).toBe('正在写正文');
    expect(taskProgressLabel(null)).toBe('尚未提交生成任务');
  });
});

describe('结构化计划', () => {
  it('提取 goal / scenes / mustInclude，忽略未知字段', () => {
    const plan = displayPlan({
      goal: '完成章节目标',
      mustInclude: ['演武场', 42, '正面交锋'],
      mustNotInclude: ['现代科技'],
      scenes: [
        { purpose: '冲突', location: '演武场', conflict: '挑衅', outcome: '化解', extra: true },
        'bad',
      ],
      targetWords: 3000,
    });
    expect(plan).toEqual({
      goal: '完成章节目标',
      mustInclude: ['演武场', '正面交锋'],
      scenes: [{ purpose: '冲突', location: '演武场', conflict: '挑衅', outcome: '化解' }],
    });
  });

  it('缺失 goal 或非对象 → null', () => {
    expect(displayPlan(null)).toBeNull();
    expect(displayPlan('x')).toBeNull();
    expect(displayPlan({ scenes: [] })).toBeNull();
    expect(displayPlan({ goal: '   ' })).toBeNull();
  });

  it('版本来源中文', () => {
    expect(versionSourceLabel('ai')).toBe('AI');
    expect(versionSourceLabel('human')).toBe('人工');
  });
});
