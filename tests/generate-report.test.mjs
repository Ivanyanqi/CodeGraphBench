import assert from 'node:assert/strict';
import { generateMarkdown, generateHtml } from '../lib/generate-report.mjs';

const SAMPLE_SUMMARY = {
  prompt: 'Explain the overall architecture of this codebase.',
  repo: 'test-repo',
  runs_per_arm: 3,
  timestamp: '2026-05-29T10:00:00Z',
  with: {
    valid_count: 3,
    median: {
      cost_usd: 0.5,
      duration_ms: 60000,
      total_tokens: 500000,
      total_tool_calls: 5,
      file_reads: 0,
      greps: 0,
      cg_tool_calls: 3,
    },
    runs: [
      {
        label: 'with-1',
        failed: false,
        cost_usd: 0.5,
        duration_ms: 60000,
        total_tokens: 500000,
        total_tool_calls: 5,
        file_reads: 0,
        greps: 0,
        cg_tool_calls: 3,
        tool_calls: { mcp__codegraph__codegraph_explore: 3, mcp__codegraph__codegraph_search: 2 },
      },
    ],
  },
  without: {
    valid_count: 3,
    median: {
      cost_usd: 0.8,
      duration_ms: 90000,
      total_tokens: 900000,
      total_tool_calls: 15,
      file_reads: 8,
      greps: 3,
      cg_tool_calls: 0,
    },
    runs: [
      {
        label: 'without-1',
        failed: false,
        cost_usd: 0.8,
        duration_ms: 90000,
        total_tokens: 900000,
        total_tool_calls: 15,
        file_reads: 8,
        greps: 3,
        cg_tool_calls: 0,
        tool_calls: { Read: 8, Grep: 3, Bash: 4 },
      },
    ],
  },
  delta: { cost_pct: -38, duration_pct: -33, tokens_pct: -44, tool_calls_pct: -67 },
};

// ── generateMarkdown ──────────────────────────────────────────────────────────
const md = generateMarkdown(SAMPLE_SUMMARY);

assert.ok(typeof md === 'string', 'should return string');
assert.ok(md.includes('CodeGraphBench'), 'should have title');
assert.ok(md.includes('test-repo'), 'should include repo name');
assert.ok(md.includes('$0.500'), 'should include with cost');
assert.ok(md.includes('$0.800'), 'should include without cost');
assert.ok(md.includes('-38%'), 'should include cost delta');
assert.ok(md.includes('-67%'), 'should include tool calls delta');
assert.ok(md.includes('with-1'), 'should include run label');
assert.ok(md.includes('without-1'), 'should include run label');
assert.ok(md.includes('✅'), 'should include verdict emoji when cheaper');

// ── generateMarkdown：with 更贵时显示 ⚠️ ─────────────────────────────────────
const expensiveSummary = {
  ...SAMPLE_SUMMARY,
  delta: { cost_pct: 10, duration_pct: 5, tokens_pct: 8, tool_calls_pct: -10 },
};
const mdExpensive = generateMarkdown(expensiveSummary);
assert.ok(mdExpensive.includes('⚠️'), 'should show warning when with is more expensive');

// ── generateHtml ──────────────────────────────────────────────────────────────
const html = generateHtml(SAMPLE_SUMMARY);

assert.ok(typeof html === 'string', 'should return string');
assert.ok(html.includes('<!DOCTYPE html>'), 'should be valid HTML');
assert.ok(html.includes('chart.js'), 'should include Chart.js CDN');
assert.ok(html.includes('<canvas'), 'should have canvas elements for charts');
assert.ok(html.includes('test-repo'), 'should include repo name');
assert.ok(html.includes('0.5'), 'should include with cost data');
assert.ok(html.includes('0.8'), 'should include without cost data');
// 应有 4 个图表（cost, tokens, time, tools）
const canvasCount = (html.match(/<canvas/g) || []).length;
assert.equal(canvasCount, 4, 'should have 4 chart canvases');
// 应有 Chart.js 初始化代码
assert.ok(html.includes('new Chart('), 'should initialize Chart.js charts');

// ── 格式化辅助：时间格式 ──────────────────────────────────────────────────────
// 60s → "1.0m"，30s → "30s"
assert.ok(html.includes('1.0m') || html.includes('60s'), 'should format duration');

console.log('✅ generate-report tests PASSED');
