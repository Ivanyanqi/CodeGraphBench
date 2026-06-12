#!/usr/bin/env bash
# lib/prepare.sh
# 准备目标 repo（clone 或本地路径）并构建/索引 codegraph。
#
# 用法（source 方式，以便导出变量到调用方）:
#   source lib/prepare.sh <repo_path_or_url> <bench_dir>
#
# 导出变量:
#   REPO_PATH          — 目标 repo 的本地绝对路径
#   CODEGRAPH_CLI      — codegraph bin 的绝对路径
#   CODEGRAPH_INDEX_DIR — .codegraph 索引目录路径
set -euo pipefail

REPO_INPUT="${1:?repo path or URL required}"
BENCH_DIR="${2:?bench dir required}"
WORKSPACE_DIR="${3:-$(cd "$BENCH_DIR/../.." && pwd)}"

# codegraph 源码目录（可通过环境变量覆盖）
# BENCH_DIR 的父目录即 workspace root，codegraph 与 CodeGraphBench 同级
CODEGRAPH_SRC="${CODEGRAPH_SRC:-$(cd "$BENCH_DIR/../.." && pwd)/projects/codegraph}"

# ── 1. 解析 repo 路径 ─────────────────────────────────────────────────────────
if [[ "$REPO_INPUT" == https://* ]] || [[ "$REPO_INPUT" == git@* ]]; then
  REPO_NAME=$(basename "$REPO_INPUT" .git)
  REPO_PATH="$WORKSPACE_DIR/data/codegraph-bench/repos/$REPO_NAME"
  mkdir -p "$(dirname "$REPO_PATH")"
  if [ ! -d "$REPO_PATH/.git" ]; then
    echo "[prepare] Cloning $REPO_INPUT → $REPO_PATH"
    git clone --depth=1 "$REPO_INPUT" "$REPO_PATH"
  else
    echo "[prepare] Repo already cloned at $REPO_PATH"
  fi
else
  REPO_PATH="$(cd "$REPO_INPUT" && pwd)"
  echo "[prepare] Using local repo: $REPO_PATH"
fi

# ── 2. 构建 codegraph（若 dist/bin/codegraph.js 不存在）────────────────────────
CODEGRAPH_CLI="$CODEGRAPH_SRC/dist/bin/codegraph.js"
if [ ! -f "$CODEGRAPH_CLI" ]; then
  echo "[prepare] Building codegraph at $CODEGRAPH_SRC ..."
  (
    cd "$CODEGRAPH_SRC"
    # 检查 node_modules 是否存在
    if [ ! -d "node_modules" ]; then
      echo "[prepare]   npm install ..."
      npm install --silent
    fi
    echo "[prepare]   npm run build ..."
    npm run build
  )
  echo "[prepare] Build complete: $CODEGRAPH_CLI"
else
  echo "[prepare] codegraph already built: $CODEGRAPH_CLI"
fi

# ── 3. 初始化/索引目标 repo ───────────────────────────────────────────────────
CODEGRAPH_INDEX_DIR="$REPO_PATH/.codegraph"
if [ ! -d "$CODEGRAPH_INDEX_DIR" ]; then
  echo "[prepare] Initializing + indexing $REPO_PATH ..."
  # init 会同时完成初始化和首次索引
  node "$CODEGRAPH_CLI" init "$REPO_PATH"
  echo "[prepare] Init complete: $CODEGRAPH_INDEX_DIR"
else
  echo "[prepare] Index already exists, syncing: $CODEGRAPH_INDEX_DIR"
  node "$CODEGRAPH_CLI" sync "$REPO_PATH" || true  # sync 失败不中断流程
fi

export REPO_PATH
export CODEGRAPH_CLI
export CODEGRAPH_INDEX_DIR
