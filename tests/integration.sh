#!/usr/bin/env bash
# tests/integration.sh
# 端到端集成测试：用 codegraph 自身仓库跑 1 run/arm，验证报告文件生成。
# 注意：此测试会真实调用 claude CLI，需要有效的 API key 且耗时较长（约 2-5 分钟）。
set -euo pipefail

BENCH_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CODEGRAPH_REPO="${CODEGRAPH_REPO:-/Users/yanqi/Documents/onlyspace/projects/codegraph}"

echo "╔══════════════════════════════════════════════════════════╗"
echo "║          CodeGraphBench — Integration Test               ║"
echo "╚══════════════════════════════════════════════════════════╝"

# 前置检查
if [ ! -d "$CODEGRAPH_REPO" ]; then
  echo "❌ SKIP: codegraph repo not found at $CODEGRAPH_REPO"
  echo "   Set CODEGRAPH_REPO env var to override."
  exit 0
fi

if ! command -v claude &>/dev/null; then
  echo "❌ SKIP: claude CLI not found"
  exit 0
fi

echo "Running 1 run/arm on: $CODEGRAPH_REPO"
echo ""

# 运行基准测试（1 run/arm，使用简短 prompt 加快速度）
bash "$BENCH_DIR/codegraph-bench.sh" \
  "$CODEGRAPH_REPO" \
  "List the top-level directories in this project and briefly describe each one." \
  --runs 1

# 找最新的 bench 目录
LATEST=$(ls -td "$BENCH_DIR/data/bench-"* 2>/dev/null | head -1)

if [ -z "$LATEST" ]; then
  echo "❌ FAIL: no bench output directory found"
  exit 1
fi

echo ""
echo "Verifying output files in: $LATEST"

FAILED=0
for f in report.html report.md summary.json meta.json with-1.jsonl without-1.jsonl; do
  if [ -f "$LATEST/$f" ]; then
    SIZE=$(wc -c < "$LATEST/$f" | tr -d ' ')
    echo "  ✅ $f (${SIZE} bytes)"
  else
    echo "  ❌ MISSING: $f"
    FAILED=1
  fi
done

if [ $FAILED -ne 0 ]; then
  echo ""
  echo "❌ Integration test FAILED"
  exit 1
fi

# 验证 summary.json 结构
node --input-type=module <<'EOF'
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';

const latest = readdirSync('/Users/yanqi/Documents/onlyspace/projects/CodeGraphBench/data')
  .filter(d => d.startsWith('bench-'))
  .sort()
  .at(-1);

const summaryPath = `/Users/yanqi/Documents/onlyspace/projects/CodeGraphBench/data/${latest}/summary.json`;
const summary = JSON.parse(readFileSync(summaryPath, 'utf8'));

assert.ok(summary.repo, 'summary should have repo');
assert.ok(summary.prompt, 'summary should have prompt');
assert.ok(summary.with, 'summary should have with arm');
assert.ok(summary.without, 'summary should have without arm');
assert.ok(summary.delta, 'summary should have delta');
assert.ok(typeof summary.with.median.cost_usd === 'number', 'with.median.cost_usd should be number');
assert.ok(typeof summary.without.median.cost_usd === 'number', 'without.median.cost_usd should be number');

console.log('  ✅ summary.json structure valid');
EOF

echo ""
echo "════════════════════════════════════════════════════════════"
echo "✅ Integration test PASSED"
echo "   Reports at: $LATEST"
echo "════════════════════════════════════════════════════════════"
