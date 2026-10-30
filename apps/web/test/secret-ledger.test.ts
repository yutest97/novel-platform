import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { recordSecret, resetSecretLedger } from '../e2e/secret-ledger.js';

/**
 * E2E 口令清单（M1-B3-REV-02）。
 *
 * 关键保证：**写入失败必须抛错**，否则 CI 可能在上传的失败产物里
 * 留下真实可用的测试口令。因此这里必须有一条用例锁死"失败即中止"。
 */
describe('E2E 口令清单', () => {
  it('把口令逐行写入清单文件', () => {
    const dir = mkdtempSync(join(tmpdir(), 'secret-ledger-'));
    const ledger = join(dir, 'secrets.txt');

    try {
      recordSecret('First-Secret-1', ledger);
      recordSecret('Second-Secret-2', ledger);

      const content = readFileSync(ledger, 'utf8');
      expect(content).toBe('First-Secret-1\nSecond-Secret-2\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('过短的值不写入清单', () => {
    const dir = mkdtempSync(join(tmpdir(), 'secret-ledger-'));
    const ledger = join(dir, 'secrets.txt');

    try {
      recordSecret('ab', ledger);
      expect(() => readFileSync(ledger, 'utf8')).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('写入失败时直接抛错（不得静默吞掉）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'secret-ledger-'));
    // 目标是一个真实存在的目录，appendFileSync 必然失败
    const ledger = join(dir, 'not-a-file');
    mkdirSync(ledger);

    try {
      expect(() => recordSecret('Must-Not-Be-Silently-Dropped', ledger)).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('写入失败时抛出的错误不是被吞掉的空操作', () => {
    const dir = mkdtempSync(join(tmpdir(), 'secret-ledger-'));
    const ledger = join(dir, 'missing-dir', 'secrets.txt');

    try {
      let caught: unknown = null;
      try {
        recordSecret('Another-Secret-Value', ledger);
      } catch (error) {
        caught = error;
      }
      expect(caught).not.toBeNull();
      expect(caught).toBeInstanceOf(Error);
      // 文件确实没有被创建（失败发生在写入之前）
      expect(() => readFileSync(ledger, 'utf8')).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resetSecretLedger 清空既有清单', () => {
    const dir = mkdtempSync(join(tmpdir(), 'secret-ledger-'));
    const ledger = join(dir, 'secrets.txt');
    writeFileSync(ledger, 'Old-Secret-Value\n', { encoding: 'utf8' });

    try {
      resetSecretLedger(ledger);
      expect(() => readFileSync(ledger, 'utf8')).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
