#!/usr/bin/env bash
# codegraph-bench.sh — CodeGraph A/B 基准测试主入口
#
# 用法:
#   bash codegraph-bench.sh <repo_path_or_url> [prompt] [--runs N] [--cli <cmd>]
#
# 示例:
#   bash codegraph-bench.sh /path/to/repo
#   bash codegraph-bench.sh /path/to/repo --cli "mc --code"
#   bash codegraph-bench.sh https://github.com/user/repo "How does auth work?" --runs 3
#   CLAUDE_CLI="mc --code" bash codegraph-bench.sh /path/to/repo --runs 1
set -euo pipefail

BENCH_DIR="$(cd "$(dirname "$0")" && pwd)"

# ── 参数解析 ──────────────────────────────────────────────────────────────────
if [ $# -eq 0 ]; then
  echo "Usage: bash codegraph-bench.sh <repo_path_or_url> [prompt] [--runs N] [--cli <cmd>]"
  echo ""
  echo "Options:"
  echo "  --runs N      Runs per arm (default: 3)"
  echo "  --cli <cmd>   Claude CLI command (default: claude)"
  echo "                Can also be set via CLAUDE_CLI env var"
  echo ""
  echo "Examples:"
  echo "  bash codegraph-bench.sh /path/to/repo"
  echo "  bash codegraph-bench.sh /path/to/repo --cli 'mc --code'"
  echo "  CLAUDE_CLI='mc --code' bash codegraph-bench.sh /path/to/repo --runs 3"
  exit 1
fi

REPO_INPUT="$1"
shift

DEFAULT_PROMPT="Explain the overall architecture of this codebase. Describe the main modules, their responsibilities, and how they interact. Be concise."
PROMPT="$DEFAULT_PROMPT"
RUNS=3
# CLI 优先级：--cli 参数 > CLAUDE_CLI 环境变量 > 默认 claude
CLAUDE_CLI="${CLAUDE_CLI:-claude}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --runs)
      RUNS="${2:?--runs requires a number}"
      shift 2
      ;;
    --cli)
      CLAUDE_CLI="${2:?--cli requires a command}"
      shift 2
      ;;
    --*)
      echo "Unknown option: $1"
      exit 1
      ;;
    *)
      PROMPT="$1"
      shift
      ;;
  esac
done

# 导出供 run-one.sh 使用
export CLAUDE_CLI

# ── 创建本次 bench 输出目录 ───────────────────────────────────────────────────
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
OUT_DIR="$BENCH_DIR/data/bench-$TIMESTAMP"
mkdir -p "$OUT_DIR"

echo "╔══════════════════════════════════════════════════════════╗"
echo "║          CodeGraphBench — A/B Test Runner                ║"
echo "╠══════════════════════════════════════════════════════════╣"
printf "║  Repo:  %-50s ║\n" "$REPO_INPUT"
printf "║  Runs:  %-3s per arm (total: %-3s)                       ║\n" "$RUNS" "$((RUNS * 2))"
printf "║  CLI:   %-50s ║\n" "$CLAUDE_CLI"
printf "║  Out:   %-50s ║\n" "$(basename "$OUT_DIR")"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""

# ── 1. 准备 repo + codegraph 索引 ─────────────────────────────────────────────
echo "▶ [1/5] Preparing repo and CodeGraph index..."
# shellcheck source=lib/prepare.sh
source "$BENCH_DIR/lib/prepare.sh" "$REPO_INPUT" "$BENCH_DIR"
echo ""

# ── 2. 写入 meta.json ─────────────────────────────────────────────────────────
REPO_NAME="$(basename "$REPO_PATH")"
node --input-type=module <<EOF > "$OUT_DIR/meta.json"
const meta = {
  repo: ${JSON.stringify(REPO_NAME)},
  repo_path: ${JSON.stringify(REPO_PATH)},
  prompt: ${JSON.stringify(PROMPT)},
  runs_per_arm: $RUNS,
  claude_cli: ${JSON.stringify(CLAUDE_CLI)},
  timestamp: new Date().toISOString(),
};
process.stdout.write(JSON.stringify(meta, null, 2));
EOF

# ── 3. 运行 WITH CodeGraph ────────────────────────────────────────────────────
echo "▶ [2/5] Running WITH CodeGraph ($RUNS runs)..."
for i in $(seq 1 "$RUNS"); do
  bash "$BENCH_DIR/lib/run-one.sh" "with-$i" "$PROMPT" "$REPO_PATH" "$OUT_DIR" --with-codegraph
done
echo ""

# ── 4. 运行 WITHOUT CodeGraph ─────────────────────────────────────────────────
echo "▶ [3/5] Running WITHOUT CodeGraph ($RUNS runs)..."
for i in $(seq 1 "$RUNS"); do
  bash "$BENCH_DIR/lib/run-one.sh" "without-$i" "$PROMPT" "$REPO_PATH" "$OUT_DIR"
done
echo ""

# ── 5. 解析结果 ───────────────────────────────────────────────────────────────
echo "▶ [4/5] Parsing results..."
node "$BENCH_DIR/lib/parse-results.mjs" "$OUT_DIR"

# 将 meta 合并到 summary.json
node --input-type=module <<EOF
import { readFileSync, writeFileSync } from 'node:fs';
const meta = JSON.parse(readFileSync('$OUT_DIR/meta.json', 'utf8'));
const summary = JSON.parse(readFileSync('$OUT_DIR/summary.json', 'utf8'));
writeFileSync('$OUT_DIR/summary.json', JSON.stringify({ ...meta, ...summary }, null, 2));
EOF
echo ""

# ── 6. 生成报告 ───────────────────────────────────────────────────────────────
echo "▶ [5/5] Generating report..."
node "$BENCH_DIR/lib/generate-report.mjs" "$OUT_DIR"
echo ""

# ── 7. 输出摘要 ───────────────────────────────────────────────────────────────
echo "════════════════════════════════════════════════════════════"
echo "✅ Benchmark complete!"
echo "   HTML report: $OUT_DIR/report.html"
echo "   MD report:   $OUT_DIR/report.md"
echo "   Raw data:    $OUT_DIR/"
echo "════════════════════════════════════════════════════════════"

# ── 8. 自动打开报告（macOS）──────────────────────────────────────────────────
if command -v open &>/dev/null; then
  open "$OUT_DIR/report.html"
fi
