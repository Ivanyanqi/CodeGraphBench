#!/usr/bin/env bash
# lib/run-one.sh
# 执行单次 claude headless 运行，将 stream-json 输出写入 <out_dir>/<label>.jsonl
#
# 用法:
#   bash lib/run-one.sh <label> <prompt> <repo_path> <out_dir> [--with-codegraph]
#
# 环境变量:
#   CODEGRAPH_CLI  — codegraph bin 路径（with-codegraph 模式必须）
set -euo pipefail

LABEL="${1:?label required}"
PROMPT="${2:?prompt required}"
REPO_PATH="${3:?repo path required}"
OUT_DIR="${4:?out dir required}"
WITH_CG="${5:-}"

mkdir -p "$OUT_DIR"
OUT_FILE="$OUT_DIR/${LABEL}.jsonl"

echo "[run-one] Starting $LABEL ($([ -n "$WITH_CG" ] && echo 'WITH' || echo 'WITHOUT') CodeGraph) ..."

# ── 构建 MCP 配置（仅 with-codegraph 时注入）──────────────────────────────────
MCP_CONFIG_FILE=""
if [[ "$WITH_CG" == "--with-codegraph" ]]; then
  # CODEGRAPH_CLI 必须由调用方（prepare.sh）导出
  CG_CLI="${CODEGRAPH_CLI:?CODEGRAPH_CLI not set; run prepare.sh first}"

  # 写入临时 MCP 配置文件（避免 shell 转义问题）
  MCP_CONFIG_FILE="$(mktemp /tmp/codegraph-mcp-XXXXXX.json)"
  cat > "$MCP_CONFIG_FILE" <<EOF
{
  "mcpServers": {
    "codegraph": {
      "command": "node",
      "args": ["$CG_CLI", "serve", "$REPO_PATH"]
    }
  }
}
EOF
fi

# ── 执行 claude headless ──────────────────────────────────────────────────────
START_MS=$(date +%s%3N)

(
  cd "$REPO_PATH"
  if [ -n "$MCP_CONFIG_FILE" ]; then
    claude \
      --print \
      --output-format stream-json \
      --mcp-config "$MCP_CONFIG_FILE" \
      --allowedTools "Read,Write,Bash,Grep,Glob,LS,mcp__codegraph__*" \
      --dangerously-skip-permissions \
      "$PROMPT" \
      > "$OUT_FILE" 2>&1
  else
    claude \
      --print \
      --output-format stream-json \
      --allowedTools "Read,Write,Bash,Grep,Glob,LS" \
      --dangerously-skip-permissions \
      "$PROMPT" \
      > "$OUT_FILE" 2>&1
  fi
)

EXIT_CODE=$?

END_MS=$(date +%s%3N)
ELAPSED=$((END_MS - START_MS))

# 清理临时文件
[ -n "$MCP_CONFIG_FILE" ] && rm -f "$MCP_CONFIG_FILE"

if [ $EXIT_CODE -ne 0 ]; then
  echo "[run-one] ⚠️  $LABEL exited with code $EXIT_CODE (output saved to $OUT_FILE)"
else
  echo "[run-one] ✅ $LABEL done in ${ELAPSED}ms → $OUT_FILE"
fi

# 即使 claude 非零退出也不中断整体流程（结果文件中会有错误信息）
exit 0
