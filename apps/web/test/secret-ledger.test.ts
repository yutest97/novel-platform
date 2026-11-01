import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { recordSecret, resetSecretLedger } from '../e2e/secret-ledger.js';

/** 仓库根目录（vitest 的工作目录是 apps/web）。 */
const repoRoot = resolve(process.cwd(), '../..');

/** 失败产物扫描脚本。 */
const scanScript = join(repoRoot, 'scripts', 'verify-no-plaintext-secrets.sh');

/** 运行扫描脚本，返回标准输出。 */
function runScan(
  env: Record<string, string>,
  scanDirs: string[],
): { stdout: string; status: number | null } {
  const result = spawnSync('bash', [scanScript, ...scanDirs], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
  return { stdout: result.stdout ?? '', status: result.status };
}

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

  it('清单中的口令能被扫描脚本识别，并删除含明文口令的失败产物', () => {
    const dir = mkdtempSync(join(tmpdir(), 'secret-scan-'));
    const ledger = join(dir, 'secrets.txt');
    const artifacts = join(dir, 'artifacts');
    mkdirSync(artifacts);

    const secret = 'Dynamic-Runtime-Password-Value';
    const dirty = join(artifacts, 'error-context.md');
    const clean = join(artifacts, 'notes.md');
    writeFileSync(dirty, `- textbox "密码": ${secret}\n`, { encoding: 'utf8' });
    writeFileSync(clean, '没有任何口令\n', { encoding: 'utf8' });

    // 模拟 E2E 运行期写入口令清单
    recordSecret(secret, ledger);
    expect(readFileSync(ledger, 'utf8')).toContain(secret);

    const { stdout, status } = runScan({ SECRET_LEDGER: ledger }, [artifacts]);
    expect(status).toBe(0);
    expect(stdout).toContain('已删除含明文口令的产物');

    // 含口令的产物被删除，干净文件保留，清单文件本身也被清理
    expect(existsSync(dirty)).toBe(false);
    expect(existsSync(clean)).toBe(true);
    expect(existsSync(ledger)).toBe(false);

    rmSync(dir, { recursive: true, force: true });
  });

  it('共享管理员口令文件参与扫描并在扫描后被删除', () => {
    const dir = mkdtempSync(join(tmpdir(), 'secret-admin-'));
    const adminFile = join(dir, '.e2e-admin-password');
    const artifacts = join(dir, 'artifacts');
    mkdirSync(artifacts);

    const adminPassword = 'Shared-Admin-Password-Value';
    writeFileSync(adminFile, `${adminPassword}\n`, { encoding: 'utf8' });
    const dirty = join(artifacts, 'error-context.md');
    writeFileSync(dirty, `- textbox "密码": ${adminPassword}\n`, { encoding: 'utf8' });

    const { stdout, status } = runScan({ ADMIN_PASSWORD_FILE: adminFile }, [artifacts]);
    expect(status).toBe(0);
    expect(stdout).toContain('已读取并清除共享管理员口令');

    expect(existsSync(dirty)).toBe(false);
    // 共享口令文件本身不会留在工作区
    expect(existsSync(adminFile)).toBe(false);

    rmSync(dir, { recursive: true, force: true });
  });
});
