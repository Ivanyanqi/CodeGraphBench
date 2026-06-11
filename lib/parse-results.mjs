/**
 * parse-results.mjs
 * 解析 claude --output-format stream-json 产生的 jsonl 文件，提取基准测试指标。
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 从单个 jsonl 字符串提取运行指标。
 * @param {string} content  jsonl 文件内容
 * @param {string} label    运行标签（如 "with-1"、"without-2"）
 * @returns {object}        指标对象
 */
export function parseRun(content, label) {
  const lines = content.split('\n').filter(Boolean);
  const toolCalls = {};
  let result = null;

  for (const line of lines) {
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }

    // 累计工具调用次数（来自 assistant message 的 content blocks）
    for (const block of (ev.message?.content ?? [])) {
      if (block.type !== 'tool_use') continue;
      toolCalls[block.name] = (toolCalls[block.name] ?? 0) + 1;
    }

    // 记录 result 行
    if (ev.type === 'result') result = ev;
  }

  const u = result?.usage ?? {};
  const totalTokens =
    (u.input_tokens ?? 0) +
    (u.output_tokens ?? 0) +
    (u.cache_read_input_tokens ?? 0) +
    (u.cache_creation_input_tokens ?? 0);

  // CodeGraph MCP 工具调用总数
  const cgToolCalls = Object.entries(toolCalls)
    .filter(([k]) => k.startsWith('mcp__codegraph__'))
    .reduce((sum, [, v]) => sum + v, 0);

  const totalToolCalls = Object.values(toolCalls).reduce((sum, v) => sum + v, 0);

  return {
    label,
    failed: !result || result.subtype !== 'success',
    cost_usd: result?.total_cost_usd ?? 0,
    duration_ms: result?.duration_ms ?? 0,
    num_turns: result?.num_turns ?? 0,
    total_tokens: totalTokens,
    input_tokens: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
    output_tokens: u.output_tokens ?? 0,
    cached_tokens: u.cache_read_input_tokens ?? 0,
    total_tool_calls: totalToolCalls,
    cg_tool_calls: cgToolCalls,
    file_reads: toolCalls['Read'] ?? 0,
    greps: (toolCalls['Grep'] ?? 0) + (toolCalls['Bash'] ?? 0),
    tool_calls: toolCalls,
  };
}

/**
 * 计算数组的中位数（升序排列后取中间值）。
 * @param {number[]} arr
 * @returns {number}
 */
export function median(arr) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/**
 * 从两组 runs 计算汇总统计（中位数 + delta）。
 * @param {object[]} withRuns     WITH CodeGraph 的 runs
 * @param {object[]} withoutRuns  WITHOUT CodeGraph 的 runs
 * @returns {object}              summary 对象
 */
export function summarize(withRuns, withoutRuns) {
  const valid = (runs) => runs.filter((r) => !r.failed);
  const vWith = valid(withRuns);
  const vWithout = valid(withoutRuns);

  const med = (runs, key) => median(runs.map((r) => r[key]));
  const pct = (a, b) => (b === 0 ? null : Math.round(((a - b) / b) * 100));

  const mWith = {
    cost_usd: med(vWith, 'cost_usd'),
    duration_ms: med(vWith, 'duration_ms'),
    total_tokens: med(vWith, 'total_tokens'),
    total_tool_calls: med(vWith, 'total_tool_calls'),
    file_reads: med(vWith, 'file_reads'),
    greps: med(vWith, 'greps'),
    cg_tool_calls: med(vWith, 'cg_tool_calls'),
  };
  const mWithout = {
    cost_usd: med(vWithout, 'cost_usd'),
    duration_ms: med(vWithout, 'duration_ms'),
    total_tokens: med(vWithout, 'total_tokens'),
    total_tool_calls: med(vWithout, 'total_tool_calls'),
    file_reads: med(vWithout, 'file_reads'),
    greps: med(vWithout, 'greps'),
    cg_tool_calls: 0,
  };

  return {
    with: { runs: withRuns, valid_count: vWith.length, median: mWith },
    without: { runs: withoutRuns, valid_count: vWithout.length, median: mWithout },
    delta: {
      cost_pct: pct(mWith.cost_usd, mWithout.cost_usd),
      duration_pct: pct(mWith.duration_ms, mWithout.duration_ms),
      tokens_pct: pct(mWith.total_tokens, mWithout.total_tokens),
      tool_calls_pct: pct(mWith.total_tool_calls, mWithout.total_tool_calls),
    },
  };
}

/**
 * CLI 入口：扫描 outDir 下所有 jsonl，输出 summary.json。
 * @param {string} outDir  bench 输出目录
 */
export async function main(outDir) {
  const files = readdirSync(outDir).filter((f) => f.endsWith('.jsonl'));
  const withRuns = [];
  const withoutRuns = [];

  for (const f of files) {
    const content = readFileSync(join(outDir, f), 'utf8');
    const run = parseRun(content, f.replace('.jsonl', ''));
    if (f.startsWith('with-')) withRuns.push(run);
    else if (f.startsWith('without-')) withoutRuns.push(run);
  }

  const summary = summarize(withRuns, withoutRuns);
  const outPath = join(outDir, 'summary.json');
  writeFileSync(outPath, JSON.stringify(summary, null, 2));
  console.log(`summary written to ${outPath}`);
  return summary;
}

// 直接执行时作为 CLI
if (process.argv[1] === new URL(import.meta.url).pathname) {
  const outDir = process.argv[2];
  if (!outDir) {
    console.error('usage: parse-results.mjs <out-dir>');
    process.exit(1);
  }
  main(outDir).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
