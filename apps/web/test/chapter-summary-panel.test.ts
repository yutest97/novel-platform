/**
 * 版本摘要卡片纯展示逻辑（A2-D-E）。
 *
 * 覆盖：
 * - loading / ready / notfound / error / idle 的文案与色调；
 * - 摘要正文保留换行与中文，只统一 CRLF；
 * - 未知状态安全回退；
 * - 请求序号边界（只有最新序号可以落地）。
 */

import { describe, expect, it } from 'vitest';

import {
  isCurrentSummaryRequest,
  summaryBodyText,
  summaryMetaLabel,
  summaryPanelView,
  type SummaryLoadState,
} from '../src/lib/chapter-summary-panel';

describe('摘要卡片状态', () => {
  it('loading：正在读取版本摘要…，info，无重试', () => {
    expect(summaryPanelView({ state: 'loading', errorText: '' })).toEqual({
      text: '正在读取版本摘要…',
      detail: '',
      tone: 'info',
      canRetry: false,
    });
  });

  it('ready：标题为"版本摘要"，ok，无重试', () => {
    expect(summaryPanelView({ state: 'ready', errorText: '' })).toEqual({
      text: '版本摘要',
      detail: '',
      tone: 'ok',
      canRetry: false,
    });
  });

  it('notfound：信息态文案 + 三种可能说明，不是红色错误', () => {
    const view = summaryPanelView({ state: 'notfound', errorText: '' });
    expect(view.text).toBe('该版本暂无摘要');
    expect(view.detail).toBe('摘要可能仍在生成、生成失败，或定稿时模型未配置。');
    expect(view.tone).toBe('muted');
    expect(view.canRetry).toBe(false);
  });

  it('error：红色错误 + 局部重试；没有错误文案时给兜底说明', () => {
    expect(summaryPanelView({ state: 'error', errorText: '网络异常，请稍后重试' })).toEqual({
      text: '版本摘要读取失败',
      detail: '网络异常，请稍后重试',
      tone: 'danger',
      canRetry: true,
    });
    expect(summaryPanelView({ state: 'error', errorText: '' }).detail).toBe('请稍后重新读取。');
  });

  it('idle：尚未读取；未知状态回退到安全文案，不抛错', () => {
    expect(summaryPanelView({ state: 'idle', errorText: '' })).toEqual({
      text: '尚未读取版本摘要',
      detail: '',
      tone: 'muted',
      canRetry: false,
    });
    expect(summaryPanelView({ state: 'paused' as SummaryLoadState, errorText: '' })).toEqual({
      text: '版本摘要状态未知',
      detail: '',
      tone: 'muted',
      canRetry: false,
    });
  });
});

describe('摘要正文展示', () => {
  it('保留中文与内部换行，不做转义或截断', () => {
    const text = '第一段：主角入门。\n第二段：初次比试。\n\n第三段：留下悬念。';
    expect(summaryBodyText(text)).toBe(text);
  });

  it('CRLF / CR 统一为 \\n（pre-wrap 依赖 \\n，混入 \\r 会多出空行）', () => {
    expect(summaryBodyText('甲\r\n乙\r丙\n丁')).toBe('甲\n乙\n丙\n丁');
  });

  it('HTML 片段原样返回（渲染层负责纯文本）', () => {
    const text = '<script>alert(1)</script>\n<img src=x onerror=1>';
    expect(summaryBodyText(text)).toBe(text);
  });

  it('空串与纯空白不被"美化"成别的文案', () => {
    expect(summaryBodyText('')).toBe('');
    expect(summaryBodyText('   ')).toBe('   ');
  });
});

describe('元信息与请求序号', () => {
  it('元信息包含版本号与生成时间', () => {
    expect(summaryMetaLabel(3, '2026-11-06 10:00')).toBe('版本 v3 · 生成于 2026-11-06 10:00');
  });

  it('只有最新序号的响应可以落地', () => {
    expect(isCurrentSummaryRequest(2, 2)).toBe(true);
    // 旧请求（v2 → v1 → v2 的中间响应）必须静默
    expect(isCurrentSummaryRequest(1, 2)).toBe(false);
    expect(isCurrentSummaryRequest(0, 1)).toBe(false);
    // 未来序号不应出现；出现也视为过期，避免覆盖当前状态
    expect(isCurrentSummaryRequest(3, 2)).toBe(false);
  });
});
