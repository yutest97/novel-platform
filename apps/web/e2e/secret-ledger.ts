import { appendFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * E2E 运行期的**口令清单**（M1-B3-REV-01 / REV-02）。
 *
 * 为什么需要：Playwright 在用例失败时会生成 `error-context.md`
 * （位于 test-results 目录下），其可访问性快照会原样包含密码输入框的值与页面
 * 文本，可能带出**可用**口令。
 * E2E 把本次运行用到的所有口令记到这里，CI 在上传 artifact 之前用
 * `scripts/verify-no-plaintext-secrets.sh` 扫描并删除含明文口令的产物。
 *
 * 该文件**不入仓库**（.gitignore）也**不进镜像上下文**（.dockerignore）。
 */

/** 口令清单的默认位置（相对 Playwright 的工作目录 apps/web）。 */
export const SECRET_LEDGER_PATH = resolve(process.cwd(), '.e2e-secrets.txt');

/** 少于这个长度的值不记录（避免把空串或噪声写进清单）。 */
const MIN_RECORDED_LENGTH = 4;

/**
 * 记录一个口令。
 *
 * **写入失败必须直接抛错**：口令清单是"失败产物不含明文口令"这条保证的
 * 唯一依据；一旦静默失败，CI 就可能在上传的 artifact 里留下可用口令。
 * 因此这里不做任何 catch —— 失败即让整个 E2E 套件失败。
 *
 * @param value 口令明文
 * @param ledgerPath 清单文件路径（默认 `SECRET_LEDGER_PATH`）
 */
export function recordSecret(value: string, ledgerPath: string = SECRET_LEDGER_PATH): void {
  if (value.length < MIN_RECORDED_LENGTH) {
    return;
  }
  appendFileSync(ledgerPath, `${value}\n`, { encoding: 'utf8' });
}

/** 清空上一次运行遗留的清单。 */
export function resetSecretLedger(ledgerPath: string = SECRET_LEDGER_PATH): void {
  rmSync(ledgerPath, { force: true });
}
