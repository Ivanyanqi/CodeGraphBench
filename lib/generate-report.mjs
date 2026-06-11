/**
 * generate-report.mjs
 * 将 summary.json 转换为 report.md（文字摘要）和 report.html（含 Chart.js 可视化）。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// ── 格式化工具 ────────────────────────────────────────────────────────────────

const fmt = {
  cost: (v) => `$${v.toFixed(3)}`,
  ms: (v) => (v >= 60000 ? `${(v / 60000).toFixed(1)}m` : `${(v / 1000).toFixed(0)}s`),
  tokens: (v) =>
    v >= 1_000_000 ? `${(v / 1_000_000).toFixed(2)}M` : `${(v / 1000).toFixed(0)}k`,
  pct: (v) => (v === null ? 'N/A' : `${v > 0 ? '+' : ''}${v}%`),
};

// ── Markdown 报告 ─────────────────────────────────────────────────────────────

/**
 * 生成 Markdown 格式的报告。
 * @param {object} summary  summary.json 内容
 * @returns {string}
 */
export function generateMarkdown(summary) {
  const { with: w, without: wo, delta, prompt, repo, runs_per_arm, timestamp } = summary;
  const mw = w.median;
  const mwo = wo.median;

  const toolDetail = (runs) =>
    runs
      .map((r) => {
        const status = r.failed ? '❌ FAILED' : '✅';
        const tools = Object.entries(r.tool_calls ?? {})
          .sort((a, b) => b[1] - a[1])
          .map(([k, v]) => `${k.replace('mcp__codegraph__', 'cg:')}×${v}`)
          .join(', ');
        return `  - ${r.label} ${status}: cost=${fmt.cost(r.cost_usd)} time=${fmt.ms(r.duration_ms)} tokens=${fmt.tokens(r.total_tokens)} | ${tools || '(no tools)'}`;
      })
      .join('\n');

  const isImproved = delta.cost_pct !== null && delta.cost_pct < 0;
  const verdict = isImproved
    ? `✅ CodeGraph is **${Math.abs(delta.cost_pct)}% cheaper**, uses **${Math.abs(delta.tokens_pct ?? 0)}% fewer tokens** and **${Math.abs(delta.tool_calls_pct ?? 0)}% fewer tool calls**.`
    : `⚠️ CodeGraph did not show clear improvement on this repo/prompt.`;

  return `# CodeGraphBench Report

**Repo:** ${repo}
**Prompt:** ${prompt}
**Runs per arm:** ${runs_per_arm} (WITH valid: ${w.valid_count}, WITHOUT valid: ${wo.valid_count})
**Timestamp:** ${timestamp ?? new Date().toISOString()}

## Summary (median of ${runs_per_arm} runs)

| Metric | WITH CodeGraph | WITHOUT CodeGraph | Delta |
|--------|---------------|-------------------|-------|
| Cost | ${fmt.cost(mw.cost_usd)} | ${fmt.cost(mwo.cost_usd)} | **${fmt.pct(delta.cost_pct)}** |
| Total Tokens | ${fmt.tokens(mw.total_tokens)} | ${fmt.tokens(mwo.total_tokens)} | **${fmt.pct(delta.tokens_pct)}** |
| Wall-clock Time | ${fmt.ms(mw.duration_ms)} | ${fmt.ms(mwo.duration_ms)} | **${fmt.pct(delta.duration_pct)}** |
| Total Tool Calls | ${mw.total_tool_calls} | ${mwo.total_tool_calls} | **${fmt.pct(delta.tool_calls_pct)}** |
| File Reads | ${mw.file_reads} | ${mwo.file_reads} | — |
| Grep/Bash | ${mw.greps} | ${mwo.greps} | — |
| CodeGraph Calls | ${mw.cg_tool_calls} | ${mwo.cg_tool_calls} | — |

## Verdict

${verdict}

## Per-run Details

### WITH CodeGraph
${toolDetail(w.runs)}

### WITHOUT CodeGraph
${toolDetail(wo.runs)}
`;
}

// ── HTML 报告 ─────────────────────────────────────────────────────────────────

/**
 * 生成含 Chart.js 可视化的 HTML 报告。
 * @param {object} summary  summary.json 内容
 * @returns {string}
 */
export function generateHtml(summary) {
  const { with: w, without: wo, delta, prompt, repo, runs_per_arm } = summary;
  const mw = w.median;
  const mwo = wo.median;

  const isImproved = delta.cost_pct !== null && delta.cost_pct < 0;

  const deltaHtml = (pct) =>
    pct === null
      ? '<span style="color:#6b7280">N/A</span>'
      : `<span style="color:${pct < 0 ? '#16a34a' : '#dc2626'};font-weight:600">${pct > 0 ? '+' : ''}${pct}%</span>`;

  const barChartConfig = (label, withVal, withoutVal, unit) =>
    JSON.stringify({
      type: 'bar',
      data: {
        labels: ['WITH CodeGraph', 'WITHOUT CodeGraph'],
        datasets: [
          {
            label,
            data: [withVal, withoutVal],
            backgroundColor: ['rgba(59,130,246,0.8)', 'rgba(239,68,68,0.8)'],
            borderColor: ['rgb(59,130,246)', 'rgb(239,68,68)'],
            borderWidth: 2,
            borderRadius: 6,
          },
        ],
      },
      options: {
        responsive: true,
        plugins: {
          legend: { display: false },
          title: {
            display: true,
            text: `${label} (${unit})`,
            font: { size: 13, weight: '600' },
            color: '#374151',
          },
        },
        scales: { y: { beginAtZero: true, grid: { color: '#f3f4f6' } } },
      },
    });

  const runRows = (runs) =>
    runs
      .map((r) => {
        const status = r.failed
          ? '<span style="color:#dc2626">❌ FAILED</span>'
          : '<span style="color:#16a34a">✅</span>';
        const tools = Object.entries(r.tool_calls ?? {})
          .sort((a, b) => b[1] - a[1])
          .map(([k, v]) => `<code>${k.replace('mcp__codegraph__', 'cg:')}×${v}</code>`)
          .join(' ');
        return `<tr>
          <td>${r.label}</td>
          <td>${status}</td>
          <td>${fmt.cost(r.cost_usd)}</td>
          <td>${fmt.ms(r.duration_ms)}</td>
          <td>${fmt.tokens(r.total_tokens)}</td>
          <td style="font-size:0.8rem;color:#6b7280">${tools || '—'}</td>
        </tr>`;
      })
      .join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>CodeGraphBench — ${repo}</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"></script>
<style>
  *, *::before, *::after { box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    max-width: 1000px; margin: 0 auto; padding: 2rem 1.5rem;
    background: #f9fafb; color: #111827; line-height: 1.6;
  }
  h1 { font-size: 1.75rem; font-weight: 700; margin-bottom: 0.25rem; }
  h2 { font-size: 1.1rem; font-weight: 600; margin: 2rem 0 0.75rem; color: #374151; }
  .meta { color: #6b7280; font-size: 0.875rem; margin-bottom: 2rem; }
  .meta strong { color: #374151; }
  .verdict {
    background: white; border-radius: 12px; padding: 1rem 1.5rem;
    margin: 1.5rem 0; box-shadow: 0 1px 3px rgba(0,0,0,0.08);
    font-size: 1rem; border-left: 4px solid ${isImproved ? '#16a34a' : '#f59e0b'};
  }
  .charts {
    display: grid; grid-template-columns: 1fr 1fr; gap: 1.25rem; margin: 1.5rem 0;
  }
  .chart-box {
    background: white; border-radius: 12px; padding: 1.25rem;
    box-shadow: 0 1px 3px rgba(0,0,0,0.08);
  }
  table {
    width: 100%; border-collapse: collapse; background: white;
    border-radius: 12px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.08);
    margin-bottom: 1.5rem;
  }
  th {
    background: #f3f4f6; padding: 0.65rem 1rem; text-align: left;
    font-size: 0.8rem; font-weight: 600; color: #374151; text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  td { padding: 0.65rem 1rem; border-top: 1px solid #e5e7eb; font-size: 0.9rem; }
  .with { color: #2563eb; font-weight: 600; }
  .without { color: #dc2626; font-weight: 600; }
  code { background: #f3f4f6; padding: 0.1em 0.35em; border-radius: 4px; font-size: 0.8em; }
  @media (max-width: 640px) { .charts { grid-template-columns: 1fr; } }
</style>
</head>
<body>

<h1>CodeGraphBench Report</h1>
<div class="meta">
  <strong>Repo:</strong> ${repo} &nbsp;·&nbsp;
  <strong>Runs/arm:</strong> ${runs_per_arm ?? '?'} (WITH valid: ${w.valid_count}, WITHOUT valid: ${wo.valid_count}) &nbsp;·&nbsp;
  <strong>Prompt:</strong> ${(prompt ?? '').slice(0, 100)}${(prompt ?? '').length > 100 ? '…' : ''}
</div>

<div class="verdict">
  ${
    isImproved
      ? `✅ CodeGraph is <strong>${Math.abs(delta.cost_pct)}% cheaper</strong>, uses <strong>${Math.abs(delta.tokens_pct ?? 0)}% fewer tokens</strong> and <strong>${Math.abs(delta.tool_calls_pct ?? 0)}% fewer tool calls</strong>.`
      : `⚠️ CodeGraph did not show clear improvement on this repo/prompt.`
  }
</div>

<div class="charts">
  <div class="chart-box"><canvas id="costChart"></canvas></div>
  <div class="chart-box"><canvas id="tokensChart"></canvas></div>
  <div class="chart-box"><canvas id="timeChart"></canvas></div>
  <div class="chart-box"><canvas id="toolsChart"></canvas></div>
</div>

<h2>Summary Table (median)</h2>
<table>
  <tr>
    <th>Metric</th>
    <th class="with">WITH CodeGraph</th>
    <th class="without">WITHOUT CodeGraph</th>
    <th>Delta</th>
  </tr>
  <tr>
    <td>Cost (USD)</td>
    <td class="with">${fmt.cost(mw.cost_usd)}</td>
    <td class="without">${fmt.cost(mwo.cost_usd)}</td>
    <td>${deltaHtml(delta.cost_pct)}</td>
  </tr>
  <tr>
    <td>Total Tokens</td>
    <td class="with">${fmt.tokens(mw.total_tokens)}</td>
    <td class="without">${fmt.tokens(mwo.total_tokens)}</td>
    <td>${deltaHtml(delta.tokens_pct)}</td>
  </tr>
  <tr>
    <td>Wall-clock Time</td>
    <td class="with">${fmt.ms(mw.duration_ms)}</td>
    <td class="without">${fmt.ms(mwo.duration_ms)}</td>
    <td>${deltaHtml(delta.duration_pct)}</td>
  </tr>
  <tr>
    <td>Total Tool Calls</td>
    <td class="with">${mw.total_tool_calls}</td>
    <td class="without">${mwo.total_tool_calls}</td>
    <td>${deltaHtml(delta.tool_calls_pct)}</td>
  </tr>
  <tr>
    <td>File Reads</td>
    <td class="with">${mw.file_reads}</td>
    <td class="without">${mwo.file_reads}</td>
    <td>—</td>
  </tr>
  <tr>
    <td>Grep / Bash</td>
    <td class="with">${mw.greps}</td>
    <td class="without">${mwo.greps}</td>
    <td>—</td>
  </tr>
  <tr>
    <td>CodeGraph Calls</td>
    <td class="with">${mw.cg_tool_calls}</td>
    <td class="without">0</td>
    <td>—</td>
  </tr>
</table>

<h2>Per-run Details — WITH CodeGraph</h2>
<table>
  <tr><th>Run</th><th>Status</th><th>Cost</th><th>Time</th><th>Tokens</th><th>Tool Calls</th></tr>
  ${runRows(w.runs)}
</table>

<h2>Per-run Details — WITHOUT CodeGraph</h2>
<table>
  <tr><th>Run</th><th>Status</th><th>Cost</th><th>Time</th><th>Tokens</th><th>Tool Calls</th></tr>
  ${runRows(wo.runs)}
</table>

<script>
new Chart(document.getElementById('costChart'),
  ${barChartConfig('Cost', mw.cost_usd, mwo.cost_usd, 'USD')});
new Chart(document.getElementById('tokensChart'),
  ${barChartConfig('Total Tokens', Math.round(mw.total_tokens / 1000), Math.round(mwo.total_tokens / 1000), 'k tokens')});
new Chart(document.getElementById('timeChart'),
  ${barChartConfig('Wall-clock Time', Math.round(mw.duration_ms / 1000), Math.round(mwo.duration_ms / 1000), 'seconds')});
new Chart(document.getElementById('toolsChart'),
  ${barChartConfig('Total Tool Calls', mw.total_tool_calls, mwo.total_tool_calls, 'calls')});
</script>

</body>
</html>`;
}

// ── CLI 入口 ──────────────────────────────────────────────────────────────────

/**
 * CLI 入口：读取 summary.json，写出 report.md 和 report.html。
 * @param {string} outDir  bench 输出目录
 */
export async function main(outDir) {
  const summaryPath = join(outDir, 'summary.json');
  const summary = JSON.parse(readFileSync(summaryPath, 'utf8'));
  const md = generateMarkdown(summary);
  const html = generateHtml(summary);
  writeFileSync(join(outDir, 'report.md'), md);
  writeFileSync(join(outDir, 'report.html'), html);
  console.log(`report.md and report.html written to ${outDir}`);
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const outDir = process.argv[2];
  if (!outDir) {
    console.error('usage: generate-report.mjs <out-dir>');
    process.exit(1);
  }
  main(outDir).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
