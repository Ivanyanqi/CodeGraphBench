import assert from 'node:assert/strict';
import { parseRun, median, summarize } from '../lib/parse-results.mjs';

// ── parseRun：正常 jsonl ──────────────────────────────────────────────────────
const SAMPLE_JSONL = [
  JSON.stringify({
    type: 'assistant',
    message: {
      content: [
        { type: 'tool_use', name: 'mcp__codegraph__codegraph_explore', input: { query: 'test' } },
        { type: 'tool_use', name: 'Read', input: { file_path: '/foo/bar.ts' } },
      ],
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 200,
        cache_creation_input_tokens: 10,
      },
    },
  }),
  JSON.stringify({
    type: 'result',
    subtype: 'success',
    duration_ms: 5000,
    total_cost_usd: 0.042,
    num_turns: 3,
    usage: {
      input_tokens: 1000,
      output_tokens: 200,
      cache_read_input_tokens: 5000,
      cache_creation_input_tokens: 100,
    },
  }),
].join('\n');

const run = parseRun(SAMPLE_JSONL, 'with-1');
assert.equal(run.label, 'with-1');
assert.equal(run.cost_usd, 0.042);
assert.equal(run.duration_ms, 5000);
assert.equal(run.num_turns, 3);
assert.equal(run.tool_calls['mcp__codegraph__codegraph_explore'], 1);
assert.equal(run.tool_calls['Read'], 1);
assert.equal(run.file_reads, 1);
assert.equal(run.cg_tool_calls, 1);
assert.equal(run.failed, false);

// ── parseRun：失败的 run（无 result 行）────────────────────────────────────────
const FAILED_JSONL = JSON.stringify({ type: 'assistant', message: { content: [] } });
const failedRun = parseRun(FAILED_JSONL, 'with-2');
assert.equal(failedRun.failed, true);
assert.equal(failedRun.cost_usd, 0);

// ── parseRun：result subtype 非 success ───────────────────────────────────────
const ERROR_JSONL = JSON.stringify({ type: 'result', subtype: 'error', duration_ms: 1000, total_cost_usd: 0.001, num_turns: 1, usage: {} });
const errorRun = parseRun(ERROR_JSONL, 'with-3');
assert.equal(errorRun.failed, true);

// ── median ────────────────────────────────────────────────────────────────────
assert.equal(median([3, 1, 2]), 2);           // 奇数个
assert.equal(median([4, 1, 3, 2]), 2.5);      // 偶数个
assert.equal(median([7]), 7);                  // 单个
assert.equal(median([]), 0);                   // 空数组

// ── summarize ─────────────────────────────────────────────────────────────────
const withRuns = [
  { cost_usd: 0.5, duration_ms: 60000, total_tokens: 500000, total_tool_calls: 5, file_reads: 2, greps: 1, cg_tool_calls: 3, failed: false },
  { cost_usd: 0.6, duration_ms: 70000, total_tokens: 600000, total_tool_calls: 6, file_reads: 3, greps: 0, cg_tool_calls: 4, failed: false },
  { cost_usd: 0.4, duration_ms: 50000, total_tokens: 400000, total_tool_calls: 4, file_reads: 1, greps: 0, cg_tool_calls: 2, failed: false },
];
const withoutRuns = [
  { cost_usd: 0.8, duration_ms: 90000, total_tokens: 900000, total_tool_calls: 15, file_reads: 8, greps: 3, cg_tool_calls: 0, failed: false },
  { cost_usd: 0.9, duration_ms: 100000, total_tokens: 1000000, total_tool_calls: 18, file_reads: 9, greps: 0, cg_tool_calls: 0, failed: false },
  { cost_usd: 0.7, duration_ms: 80000, total_tokens: 800000, total_tool_calls: 12, file_reads: 7, greps: 0, cg_tool_calls: 0, failed: false },
];

const summary = summarize(withRuns, withoutRuns);
assert.equal(summary.with.valid_count, 3);
assert.equal(summary.without.valid_count, 3);
assert.equal(summary.with.median.cost_usd, 0.5);
assert.equal(summary.without.median.cost_usd, 0.8);
assert.ok(summary.delta.cost_pct < 0, 'with should be cheaper');
assert.ok(summary.delta.tokens_pct < 0, 'with should use fewer tokens');
assert.ok(summary.delta.tool_calls_pct < 0, 'with should use fewer tool calls');

// summarize 应过滤掉 failed runs
const withFailed = [...withRuns, { cost_usd: 99, duration_ms: 999999, total_tokens: 9999999, total_tool_calls: 999, file_reads: 0, greps: 0, cg_tool_calls: 0, failed: true }];
const summaryWithFailed = summarize(withFailed, withoutRuns);
assert.equal(summaryWithFailed.with.valid_count, 3, 'failed runs should be excluded');
assert.equal(summaryWithFailed.with.median.cost_usd, 0.5, 'failed run should not affect median');

console.log('✅ parse-results tests PASSED');
