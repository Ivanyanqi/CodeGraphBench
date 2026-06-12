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
WORKSPACE_DIR="$(cd "$BENCH_DIR/../.." && pwd)"

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
OUT_DIR="$WORKSPACE_DIR/data/codegraph-bench/bench-$TIMESTAMP"
mkdir -p "$OUT_DIR"

echo "╔══════════════════════════════════════════════════════════╗"
echo "║          CodeGraphBench — A/B Test Runner                ║"
echo "╠══════════════════════════════════════════════════════════╣"
printf "║  Repo:  %-50s ║\n" "$REPO_INPUT"
printf "║  Runs:  %-3s per arm (total: %-3s)                       ║\n" "$RUNS" "$((RUNS * 2))"
printf "║  CLI:   %-50s ║\n" "$CLAUDE_CLI"
printf "║  Out:   %-50s ║\n" "data/codegraph-bench/$(basename "$OUT_DIR")"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""

# ── 1. 准备 repo + codegraph 索引 ─────────────────────────────────────────────
echo "▶ [1/5] Preparing repo and CodeGraph index..."
# shellcheck source=lib/prepare.sh
source "$BENCH_DIR/lib/prepare.sh" "$REPO_INPUT" "$BENCH_DIR" "$WORKSPACE_DIR"
echo ""

# ── 2. 写入 meta.json ─────────────────────────────────────────────────────────
REPO_NAME="$(basename "$REPO_PATH")"
# 通过环境变量传参，避免 heredoc 中 bash 对 ${JSON.stringify()} 的 bad substitution
_REPO_NAME="$REPO_NAME" _REPO_PATH="$REPO_PATH" _PROMPT="$PROMPT" \
  _RUNS="$RUNS" _CLAUDE_CLI="$CLAUDE_CLI" \
  node -e '
    const meta = {
      repo:        process.env._REPO_NAME,
      repo_path:   process.env._REPO_PATH,
      prompt:      process.env._PROMPT,
      runs_per_arm: Number(process.env._RUNS),
      claude_cli:  process.env._CLAUDE_CLI,
      timestamp:   new Date().toISOString(),
    };
    process.stdout.write(JSON.stringify(meta, null, 2));
  ' > "$OUT_DIR/meta.json"

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
_OUT_DIR="$OUT_DIR" node -e '
  const fs = require("fs");
  const dir = process.env._OUT_DIR;
  const meta = JSON.parse(fs.readFileSync(dir + "/meta.json", "utf8"));
  const summary = JSON.parse(fs.readFileSync(dir + "/summary.json", "utf8"));
  fs.writeFileSync(dir + "/summary.json", JSON.stringify({ ...meta, ...summary }, null, 2));
'
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
