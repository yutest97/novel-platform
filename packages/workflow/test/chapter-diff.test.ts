/**
 * 章节正式版本的行级 diff（A1-4B-C-A）。
 *
 * 只测纯函数：行切分、Myers 脚本、方向、统计与规模保护。
 * 服务层与 HTTP 权限在 `apps/web/test/chapter-diff-api.test.ts` 覆盖。
 */

import { describe, expect, it } from 'vitest';

import {
  MAX_DIFF_EDIT_DISTANCE,
  MAX_DIFF_LINES_PER_SIDE,
  diffTextLines,
  splitDiffLines,
  summarizeDiff,
  type ChapterDiffLine,
} from '../src/chapter/diff.js';

/** 把 diff 压缩成便于断言的 `符号:文本` 序列（e=equal / a=added / r=removed）。 */
function script(lines: readonly ChapterDiffLine[]): string[] {
  return lines.map((line) => {
    const mark = line.kind === 'equal' ? 'e' : line.kind === 'added' ? 'a' : 'r';
    return `${mark}:${line.text}`;
  });
}

describe('行切分与换行归一化', () => {
  it('CRLF / CR / LF 视为同一种换行', () => {
    expect(splitDiffLines('甲\r\n乙\r丙\n丁')).toEqual(['甲', '乙', '丙', '丁']);
  });

  it('末尾换行不产生额外空行', () => {
    expect(splitDiffLines('甲\n乙\n')).toEqual(['甲', '乙']);
    expect(splitDiffLines('甲\n乙')).toEqual(['甲', '乙']);
  });

  it('中间空行保留，空正文得到空数组', () => {
    expect(splitDiffLines('甲\n\n乙')).toEqual(['甲', '', '乙']);
    expect(splitDiffLines('')).toEqual([]);
    // 单个换行 = 一个空行（后面那个空行是"末尾换行"，不额外计数）
    expect(splitDiffLines('\n')).toEqual(['']);
  });

  it('末尾换行差异不产生 diff 行', () => {
    const lines = diffTextLines('甲\n乙\n', '甲\n乙');
    expect(lines.every((line) => line.kind === 'equal')).toBe(true);
    expect(summarizeDiff(lines)).toEqual({ added: 0, removed: 0, unchanged: 2 });
  });
});

describe('基本 diff', () => {
  it('完全相同的正文：全 equal，统计正确', () => {
    const lines = diffTextLines('甲\n乙\n丙', '甲\n乙\n丙');
    expect(script(lines)).toEqual(['e:甲', 'e:乙', 'e:丙']);
    expect(summarizeDiff(lines)).toEqual({ added: 0, removed: 0, unchanged: 3 });
    expect(lines.every((line) => line.oldLineNo === line.newLineNo)).toBe(true);
  });

  it('单行新增：只多一条 added，行号只在新版本递增', () => {
    const lines = diffTextLines('甲\n丙', '甲\n乙\n丙');
    expect(script(lines)).toEqual(['e:甲', 'a:乙', 'e:丙']);
    const added = lines[1];
    expect(added).toMatchObject({ kind: 'added', oldLineNo: null, newLineNo: 2 });
    expect(lines[2]).toMatchObject({ kind: 'equal', oldLineNo: 2, newLineNo: 3 });
  });

  it('单行删除：只多一条 removed', () => {
    const lines = diffTextLines('甲\n乙\n丙', '甲\n丙');
    expect(script(lines)).toEqual(['e:甲', 'r:乙', 'e:丙']);
    expect(lines[1]).toMatchObject({ kind: 'removed', oldLineNo: 2, newLineNo: null });
  });

  it('单行替换：一条 removed + 一条 added', () => {
    const lines = diffTextLines('甲\n乙\n丙', '甲\n丁\n丙');
    expect(script(lines)).toEqual(['e:甲', 'r:乙', 'a:丁', 'e:丙']);
    expect(summarizeDiff(lines)).toEqual({ added: 1, removed: 1, unchanged: 2 });
  });

  it('多段修改保留上下文行', () => {
    const from = ['一', '二', '三', '四', '五', '六', '七'];
    const to = ['一', '二改', '三', '四', '五改', '六', '七'];
    const lines = diffTextLines(from.join('\n'), to.join('\n'));
    expect(script(lines)).toEqual([
      'e:一',
      'r:二',
      'a:二改',
      'e:三',
      'e:四',
      'r:五',
      'a:五改',
      'e:六',
      'e:七',
    ]);
  });

  it('中文与 emoji 按整行比较（不拆分代理对）', () => {
    const lines = diffTextLines('他说：你好🙂\n第二行', '他说：你好🙂\n第二行改了');
    expect(script(lines)).toEqual(['e:他说：你好🙂', 'r:第二行', 'a:第二行改了']);
    expect(lines[0]?.text).toBe('他说：你好🙂');
  });

  it('空行参与比较', () => {
    const lines = diffTextLines('甲\n\n乙', '甲\n乙');
    expect(script(lines)).toEqual(['e:甲', 'r:', 'e:乙']);
  });
});

describe('方向与确定性', () => {
  it('交换两侧后 added / removed 互换，行号各自从 1 开始', () => {
    const forward = diffTextLines('甲\n乙\n丙', '甲\n丁\n丙');
    const backward = diffTextLines('甲\n丁\n丙', '甲\n乙\n丙');
    expect(summarizeDiff(forward)).toEqual({ added: 1, removed: 1, unchanged: 2 });
    expect(summarizeDiff(backward)).toEqual({ added: 1, removed: 1, unchanged: 2 });
    expect(script(forward)).toEqual(['e:甲', 'r:乙', 'a:丁', 'e:丙']);
    expect(script(backward)).toEqual(['e:甲', 'r:丁', 'a:乙', 'e:丙']);
  });

  it('同样输入重复执行结果完全一致', () => {
    const from = '甲\n乙\n丙\n丁\n戊';
    const to = '甲\n丙\n丁改\n戊\n己';
    expect(diffTextLines(from, to)).toEqual(diffTextLines(from, to));
  });

  it('纯新增 / 纯删除的边界', () => {
    expect(script(diffTextLines('', '甲\n乙'))).toEqual(['a:甲', 'a:乙']);
    expect(script(diffTextLines('甲\n乙', ''))).toEqual(['r:甲', 'r:乙']);
  });
});

describe('规模保护', () => {
  it('中间段编辑距离超过上限时退化为整段替换，仍是确定结果', () => {
    // 构造完全不相交的两段：编辑距离 = 行数之和，必然超过 500
    const size = MAX_DIFF_EDIT_DISTANCE + 50;
    const from = Array.from({ length: size }, (_, index) => `旧-${String(index)}`).join('\n');
    const to = Array.from({ length: size }, (_, index) => `新-${String(index)}`).join('\n');

    const lines = diffTextLines(from, to);
    expect(summarizeDiff(lines)).toEqual({ added: size, removed: size, unchanged: 0 });
    // 先删除旧段，再新增新段，顺序确定
    expect(lines[0]).toMatchObject({ kind: 'removed', text: '旧-0' });
    expect(lines[size]).toMatchObject({ kind: 'added', text: '新-0' });
    expect(diffTextLines(from, to)).toEqual(lines);
  });

  it('单侧行数超过上限 → CHAPTER_DIFF_TOO_LARGE', () => {
    const tooMany = '一\n'.repeat(MAX_DIFF_LINES_PER_SIDE + 1);
    let caught: unknown;
    try {
      diffTextLines(tooMany, '一');
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: 'CHAPTER_DIFF_TOO_LARGE' });
  });

  it('字符数超过 200000 → CHAPTER_DIFF_TOO_LARGE', () => {
    const tooLong = '甲'.repeat(200_001);
    let caught: unknown;
    try {
      diffTextLines(tooLong, '甲');
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: 'CHAPTER_DIFF_TOO_LARGE' });
  });
});
