#!/usr/bin/env bash
# 检查（并清理）测试产物中的明文口令。
#
# 背景（M1-B3-REV-01）：
# - Playwright 在用例失败时会生成 `test-results/**/error-context.md`，
#   其中的可访问性快照会原样包含 `<input type="password">` 的**值**；
# - 页面截图我们已对一次性口令区域做模糊处理，但失败产物无法逐张人工确认。
#
# 因此在上传 artifact 之前统一扫描一遍：
# - 命中明文口令 → 删除该文件并打印警告（保证上传的产物里没有可用口令）；
# - 未命中       → 原样保留，便于排查失败原因。
#
# 用法：
#   SECRET_VALUES="pass1 pass2" bash scripts/verify-no-plaintext-secrets.sh [目录...]
#
# 环境变量：
#   SECRET_VALUES  空格分隔的明文口令（可选；若同时提供 SECRET_LEDGER，
#                  则清单文件里的每一行也会作为待扫描口令）
#   SECRET_LEDGER  口令清单文件（E2E 运行期生成，扫描后删除；默认
#                  apps/web/.e2e-secrets.txt，存在即读取）
#   SCAN_DIRS      扫描目录（空格分隔，默认 test-results / playwright-report / 截图目录）
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

SECRET_VALUES="${SECRET_VALUES:-}"
SECRET_LEDGER="${SECRET_LEDGER:-apps/web/.e2e-secrets.txt}"

# 合并口令清单：清单文件里每行一个口令
ledger_values=""
if [ -f "$SECRET_LEDGER" ]; then
  ledger_values="$(tr '\n' ' ' < "$SECRET_LEDGER")"
  rm -f "$SECRET_LEDGER"
  echo "[secrets] 已读取并清除口令清单：$SECRET_LEDGER"
fi

ALL_SECRETS="${SECRET_VALUES} ${ledger_values}"
if [ -z "${ALL_SECRETS// }" ]; then
  echo "[secrets] 未提供任何口令，跳过扫描。"
  exit 0
fi

if [ "$#" -gt 0 ]; then
  SCAN_DIRS="$*"
else
  SCAN_DIRS="apps/web/test-results apps/web/playwright-report docs/screenshots"
fi

removed=0
scanned=0

for dir in $SCAN_DIRS; do
  [ -e "$dir" ] || continue

  # 只处理普通文件；二进制（png 等）按字节匹配同样适用
  while IFS= read -r -d '' file; do
    scanned=$((scanned + 1))
    hit=0
    for secret in $ALL_SECRETS; do
      [ -n "$secret" ] || continue
      if grep -aFq -- "$secret" "$file"; then
        hit=1
        break
      fi
    done

    if [ "$hit" = "1" ]; then
      rm -f "$file"
      removed=$((removed + 1))
      echo "[secrets] ⚠ 已删除含明文口令的产物：$file"
    fi
  done < <(find "$dir" -type f -print0 2>/dev/null)
done

echo "[secrets] 扫描 ${scanned} 个文件，删除 ${removed} 个含明文口令的文件。"
if [ "$removed" -gt 0 ]; then
  echo "[secrets] 上传的产物已不含任何明文口令。"
fi
