# CodeGraphBench 实现计划

> **给 Agent 执行者：** 必须使用 superpowers:subagent-driven-development 逐任务执行本计划。
> 步骤使用 `- [ ]` 复选框语法追踪进度。

**目标：** 一键对任意代码库执行 CodeGraph vs 无 CodeGraph 的 Claude Code A/B 基准测试，输出含可视化图表的完整对比报告。

**架构：** Shell 主入口编排流程，lib/ 下各模块分工明确，Node.js 负责解析和报告生成，Chart.js 内嵌 HTML 实现可视化。

**技术栈：** Bash、Node.js (ESM)、Chart.js (CDN)、claude CLI、codegraph (本地源码构建)

---

### 任务 1：`lib/parse-results.mjs` — jsonl 解析器

**文件：**
- 创建：`lib/parse-results.mjs`
- 创建：`tests/parse-results.test.mjs`

- [ ] **步骤 1：写失败测试**

  ```js
  // tests/parse-results.test.mjs
  import assert from 'node:assert/strict';
  import { parseRun, median, summarize } from '../lib/parse-results.mjs';

  // 测试 parseRun：正常 jsonl
  const SAMPLE_JSONL = [
    JSON.stringify({ type: 'assistant', message: { content: [
      { type: 'tool_use', name: 'mcp__codegraph__codegraph_explore', input: { query: 'test' } },
      { type: 'tool_use', name: 'Read', input: { file_path: '/foo/bar.ts' } },
    ], usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 200, cache_creation_input_tokens: 10 } } }),
    JSON.stringify({ type: 'result', subtype: 'success', duration_ms: 5000, total_cost_usd: 0.042, num_turns: 3,
      usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 5000, cache_creation_input_tokens: 100 } }),
  ].join('\n');

  const run = parseRun(SAMPLE_JSONL, 'with-1');
  assert.equal(run.label, 'with-1');
  assert.equal(run.cost_usd, 0.042);
  assert.equal(run.duration_ms, 5000);
  assert.equal(run.tool_calls.mcp__codegraph__codegraph_explore, 1);
  assert.equal(run.tool_calls.Read, 1);
  assert.equal(run.file_reads, 1);
  assert.equal(run.failed, false);

  // 测试 median：奇数个
  assert.equal(median([3, 1, 2]), 2);
  // 测试 median：偶数个
  assert.equal(median([4, 1, 3, 2]), 2.5);
  // 测试 median：单个
  assert.equal(median([7]), 7);

  // 测试 summarize：两组各 3 runs
  const withRuns = [
    { cost_usd: 0.5, duration_ms: 60000, total_tokens: 500000, tool_calls: { Read: 2, Grep: 1 }, file_reads: 2, greps: 1, failed: false },
    { cost_usd: 0.6, duration_ms: 70000, total_tokens: 600000, tool_calls: { Read: 3 }, file_reads: 3, greps: 0, failed: false },
    { cost_usd: 0.4, duration_ms: 50000, total_tokens: 400000, tool_calls: { Read: 1 }, file_reads: 1, greps: 0, failed: false },
  ];
  const withoutRuns = [
    { cost_usd: 0.8, duration_ms: 90000, total_tokens: 900000, tool_calls: { Read: 8, Grep: 3 }, file_reads: 8, greps: 3, failed: false },
    { cost_usd: 0.9, duration_ms: 100000, total_tokens: 1000000, tool_calls: { Read: 9 }, file_reads: 9, greps: 0, failed: false },
    { cost_usd: 0.7, duration_ms: 80000, total_tokens: 800000, tool_calls: { Read: 7 }, file_reads: 7, greps: 0, failed: false },
  ];
  const summary = summarize(withRuns, withoutRuns);
  assert.equal(summary.with.median.cost_usd, 0.5);
  assert.equal(summary.without.median.cost_usd, 0.8);
  assert.ok(summary.delta.cost_pct < 0); // with 更便宜

  console.log('parse-results tests PASSED');
  ```

- [ ] **步骤 2：运行测试确认失败**
  ```bash
  cd /Users/yanqi/Documents/onlyspace/projects/CodeGraphBench
  node --test tests/parse-results.test.mjs 2>&1 | head -20
  ```
  预期：`Error: Cannot find module '../lib/parse-results.mjs'`

- [ ] **步骤 3：实现 `lib/parse-results.mjs`**

  ```js
  // lib/parse-results.mjs
  import { readFileSync, readdirSync } from 'node:fs';
  import { join } from 'node:path';

  /** 从单个 jsonl 文件提取指标 */
  export function parseRun(content, label) {
    const lines = content.split('\n').filter(Boolean);
    const toolCalls = {};
    let result = null;

    for (const line of lines) {
      let ev;
      try { ev = JSON.parse(line); } catch { continue; }

      // 累计工具调用
      for (const b of (ev.message?.content || [])) {
        if (b.type !== 'tool_use') continue;
        toolCalls[b.name] = (toolCalls[b.name] || 0) + 1;
      }
      if (ev.type === 'result') result = ev;
    }

    const u = result?.usage || {};
    const totalTokens = (u.input_tokens || 0) + (u.output_tokens || 0)
      + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);

    const cgTools = Object.entries(toolCalls)
      .filter(([k]) => k.startsWith('mcp__codegraph__'))
      .reduce((s, [, v]) => s + v, 0);

    const totalToolCalls = Object.values(toolCalls).reduce((s, v) => s + v, 0);

    return {
      label,
      failed: !result || result.subtype !== 'success',
      cost_usd: result?.total_cost_usd || 0,
      duration_ms: result?.duration_ms || 0,
      num_turns: result?.num_turns || 0,
      total_tokens: totalTokens,
      input_tokens: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0),
      output_tokens: u.output_tokens || 0,
      cached_tokens: u.cache_read_input_tokens || 0,
      total_tool_calls: totalToolCalls,
      cg_tool_calls: cgTools,
      file_reads: toolCalls['Read'] || 0,
      greps: (toolCalls['Grep'] || 0) + (toolCalls['Bash'] || 0),
      tool_calls: toolCalls,
    };
  }

  /** 中位数（升序排列后取中间值） */
  export function median(arr) {
    if (arr.length === 0) return 0;
    const s = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
  }

  /** 从两组 runs 计算摘要 */
  export function summarize(withRuns, withoutRuns) {
    const valid = (runs) => runs.filter(r => !r.failed);
    const vWith = valid(withRuns);
    const vWithout = valid(withoutRuns);

    const med = (runs, key) => median(runs.map(r => r[key]));
    const pct = (a, b) => b === 0 ? null : Math.round((a - b) / b * 100);

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

  /** CLI 入口：扫描 outDir 下所有 jsonl，输出 summary.json */
  export async function main(outDir) {
    const files = readdirSync(outDir).filter(f => f.endsWith('.jsonl'));
    const withRuns = [], withoutRuns = [];

    for (const f of files) {
      const content = readFileSync(join(outDir, f), 'utf8');
      const run = parseRun(content, f.replace('.jsonl', ''));
      if (f.startsWith('with-')) withRuns.push(run);
      else if (f.startsWith('without-')) withoutRuns.push(run);
    }

    const summary = summarize(withRuns, withoutRuns);
    const outPath = join(outDir, 'summary.json');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(outPath, JSON.stringify(summary, null, 2));
    console.log(`summary written to ${outPath}`);
    return summary;
  }

  // 直接执行时作为 CLI
  if (process.argv[1] === new URL(import.meta.url).pathname) {
    const outDir = process.argv[2];
    if (!outDir) { console.error('usage: parse-results.mjs <out-dir>'); process.exit(1); }
    main(outDir).catch(e => { console.error(e); process.exit(1); });
  }
  ```

- [ ] **步骤 4：运行测试确认通过**
  ```bash
  cd /Users/yanqi/Documents/onlyspace/projects/CodeGraphBench
  node --test tests/parse-results.test.mjs
  ```
  预期：`parse-results tests PASSED`

- [ ] **步骤 5：提交**
  ```bash
  cd /Users/yanqi/Documents/onlyspace/projects/CodeGraphBench
  git add lib/parse-results.mjs tests/parse-results.test.mjs
  git commit -m "feat: add parse-results.mjs with unit tests"
  ```

---

### 任务 2：`lib/generate-report.mjs` — 报告生成器

**文件：**
- 创建：`lib/generate-report.mjs`
- 创建：`tests/generate-report.test.mjs`

- [ ] **步骤 1：写失败测试**

  ```js
  // tests/generate-report.test.mjs
  import assert from 'node:assert/strict';
  import { generateMarkdown, generateHtml } from '../lib/generate-report.mjs';

  const SAMPLE_SUMMARY = {
    prompt: 'Explain the overall architecture',
    repo: 'test-repo',
    runs_per_arm: 3,
    timestamp: '2026-05-29T10:00:00Z',
    with: {
      valid_count: 3,
      median: { cost_usd: 0.5, duration_ms: 60000, total_tokens: 500000, total_tool_calls: 5, file_reads: 0, greps: 0, cg_tool_calls: 3 },
      runs: [
        { label: 'with-1', failed: false, cost_usd: 0.5, duration_ms: 60000, total_tokens: 500000, total_tool_calls: 5, file_reads: 0, greps: 0, cg_tool_calls: 3, tool_calls: { mcp__codegraph__codegraph_explore: 3 } },
      ],
    },
    without: {
      valid_count: 3,
      median: { cost_usd: 0.8, duration_ms: 90000, total_tokens: 900000, total_tool_calls: 15, file_reads: 8, greps: 3, cg_tool_calls: 0 },
      runs: [
        { label: 'without-1', failed: false, cost_usd: 0.8, duration_ms: 90000, total_tokens: 900000, total_tool_calls: 15, file_reads: 8, greps: 3, cg_tool_calls: 0, tool_calls: { Read: 8, Grep: 3 } },
      ],
    },
    delta: { cost_pct: -38, duration_pct: -33, tokens_pct: -44, tool_calls_pct: -67 },
  };

  // Markdown 包含关键内容
  const md = generateMarkdown(SAMPLE_SUMMARY);
  assert.ok(md.includes('CodeGraphBench'), 'md should have title');
  assert.ok(md.includes('$0.500'), 'md should have with cost');
  assert.ok(md.includes('$0.800'), 'md should have without cost');
  assert.ok(md.includes('-38%'), 'md should have cost delta');
  assert.ok(md.includes('test-repo'), 'md should have repo name');

  // HTML 包含 Chart.js 和图表数据
  const html = generateHtml(SAMPLE_SUMMARY);
  assert.ok(html.includes('chart.js'), 'html should include Chart.js');
  assert.ok(html.includes('0.5'), 'html should include with cost data');
  assert.ok(html.includes('0.8'), 'html should include without cost data');
  assert.ok(html.includes('<canvas'), 'html should have canvas elements');

  console.log('generate-report tests PASSED');
  ```

- [ ] **步骤 2：运行测试确认失败**
  ```bash
  cd /Users/yanqi/Documents/onlyspace/projects/CodeGraphBench
  node --test tests/generate-report.test.mjs 2>&1 | head -5
  ```
  预期：`Error: Cannot find module '../lib/generate-report.mjs'`

- [ ] **步骤 3：实现 `lib/generate-report.mjs`**

  ```js
  // lib/generate-report.mjs
  import { readFileSync, writeFileSync } from 'node:fs';
  import { join } from 'node:path';

  const fmt = {
    cost: (v) => `$${v.toFixed(3)}`,
    ms: (v) => v >= 60000 ? `${(v/60000).toFixed(1)}m` : `${(v/1000).toFixed(0)}s`,
    tokens: (v) => v >= 1000000 ? `${(v/1000000).toFixed(2)}M` : `${(v/1000).toFixed(0)}k`,
    pct: (v) => v === null ? 'N/A' : `${v > 0 ? '+' : ''}${v}%`,
    pctLabel: (v) => v === null ? '' : v < 0 ? `${Math.abs(v)}% cheaper` : `${v}% more expensive`,
  };

  export function generateMarkdown(summary) {
    const { with: w, without: wo, delta, prompt, repo, runs_per_arm, timestamp } = summary;
    const mw = w.median, mwo = wo.median;

    const deltaRow = (label, key, fmtFn) =>
      `| ${label} | ${fmtFn(mw[key])} | ${fmtFn(mwo[key])} | ${fmt.pct(delta[key + '_pct'])} |`;

    const toolDetail = (runs) => runs.map(r => {
      const status = r.failed ? '❌ FAILED' : '✅';
      const tools = Object.entries(r.tool_calls || {})
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${k.replace('mcp__codegraph__', 'cg:')}×${v}`)
        .join(', ');
      return `  - ${r.label} ${status}: cost=${fmt.cost(r.cost_usd)} time=${fmt.ms(r.duration_ms)} tokens=${fmt.tokens(r.total_tokens)} | ${tools}`;
    }).join('\n');

    return `# CodeGraphBench Report

**Repo:** ${repo}
**Prompt:** ${prompt}
**Runs per arm:** ${runs_per_arm} (WITH valid: ${w.valid_count}, WITHOUT valid: ${wo.valid_count})
**Timestamp:** ${timestamp}

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

${delta.cost_pct !== null && delta.cost_pct < 0 ? `✅ CodeGraph is **${fmt.pctLabel(delta.cost_pct)}** and uses **${Math.abs(delta.tool_calls_pct)}% fewer tool calls**.` : `⚠️ CodeGraph did not show clear improvement on this repo/prompt.`}

## Per-run Details

### WITH CodeGraph
${toolDetail(w.runs)}

### WITHOUT CodeGraph
${toolDetail(wo.runs)}
`;
  }

  export function generateHtml(summary) {
    const { with: w, without: wo, delta, prompt, repo } = summary;
    const mw = w.median, mwo = wo.median;

    const chartData = {
      cost: [mw.cost_usd, mwo.cost_usd],
      tokens: [Math.round(mw.total_tokens / 1000), Math.round(mwo.total_tokens / 1000)],
      time: [Math.round(mw.duration_ms / 1000), Math.round(mwo.duration_ms / 1000)],
      tools: [mw.total_tool_calls, mwo.total_tool_calls],
    };

    const chartConfig = (label, data, unit) => JSON.stringify({
      type: 'bar',
      data: {
        labels: ['WITH CodeGraph', 'WITHOUT CodeGraph'],
        datasets: [{
          label,
          data,
          backgroundColor: ['rgba(59,130,246,0.8)', 'rgba(239,68,68,0.8)'],
          borderColor: ['rgb(59,130,246)', 'rgb(239,68,68)'],
          borderWidth: 2,
        }],
      },
      options: {
        responsive: true,
        plugins: { legend: { display: false }, title: { display: true, text: `${label} (${unit})`, font: { size: 14 } } },
        scales: { y: { beginAtZero: true } },
      },
    });

    const deltaHtml = (pct) => pct === null ? '' :
      `<span style="color:${pct < 0 ? '#16a34a' : '#dc2626'};font-weight:bold">${pct > 0 ? '+' : ''}${pct}%</span>`;

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>CodeGraphBench — ${repo}</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"></script>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 960px; margin: 0 auto; padding: 2rem; background: #f9fafb; color: #111; }
  h1 { font-size: 1.6rem; margin-bottom: 0.25rem; }
  .meta { color: #6b7280; font-size: 0.9rem; margin-bottom: 2rem; }
  .charts { display: grid; grid-template-columns: 1fr 1fr; gap: 1.5rem; margin: 2rem 0; }
  .chart-box { background: white; border-radius: 12px; padding: 1.25rem; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
  table { width: 100%; border-collapse: collapse; background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
  th { background: #f3f4f6; padding: 0.75rem 1rem; text-align: left; font-size: 0.85rem; color: #374151; }
  td { padding: 0.75rem 1rem; border-top: 1px solid #e5e7eb; font-size: 0.9rem; }
  .with { color: #2563eb; font-weight: 600; }
  .without { color: #dc2626; font-weight: 600; }
  .verdict { background: white; border-radius: 12px; padding: 1.25rem 1.5rem; margin: 1.5rem 0; box-shadow: 0 1px 3px rgba(0,0,0,0.1); font-size: 1rem; }
</style>
</head>
<body>
<h1>CodeGraphBench Report</h1>
<div class="meta">
  <strong>Repo:</strong> ${repo} &nbsp;|&nbsp;
  <strong>Prompt:</strong> ${prompt.slice(0, 80)}${prompt.length > 80 ? '…' : ''} &nbsp;|&nbsp;
  <strong>Runs/arm:</strong> ${summary.runs_per_arm}
</div>

<div class="verdict">
  ${delta.cost_pct !== null && delta.cost_pct < 0
    ? `✅ CodeGraph is <strong>${Math.abs(delta.cost_pct)}% cheaper</strong>, uses <strong>${Math.abs(delta.tokens_pct)}% fewer tokens</strong> and <strong>${Math.abs(delta.tool_calls_pct)}% fewer tool calls</strong>.`
    : `⚠️ CodeGraph did not show clear improvement on this repo/prompt.`}
</div>

<div class="charts">
  <div class="chart-box"><canvas id="costChart"></canvas></div>
  <div class="chart-box"><canvas id="tokensChart"></canvas></div>
  <div class="chart-box"><canvas id="timeChart"></canvas></div>
  <div class="chart-box"><canvas id="toolsChart"></canvas></div>
</div>

<h2>Summary Table (median)</h2>
<table>
  <tr><th>Metric</th><th class="with">WITH CodeGraph</th><th class="without">WITHOUT CodeGraph</th><th>Delta</th></tr>
  <tr><td>Cost (USD)</td><td class="with">$${mw.cost_usd.toFixed(3)}</td><td class="without">$${mwo.cost_usd.toFixed(3)}</td><td>${deltaHtml(delta.cost_pct)}</td></tr>
  <tr><td>Total Tokens</td><td class="with">${Math.round(mw.total_tokens/1000)}k</td><td class="without">${Math.round(mwo.total_tokens/1000)}k</td><td>${deltaHtml(delta.tokens_pct)}</td></tr>
  <tr><td>Wall-clock Time</td><td class="with">${Math.round(mw.duration_ms/1000)}s</td><td class="without">${Math.round(mwo.duration_ms/1000)}s</td><td>${deltaHtml(delta.duration_pct)}</td></tr>
  <tr><td>Total Tool Calls</td><td class="with">${mw.total_tool_calls}</td><td class="without">${mwo.total_tool_calls}</td><td>${deltaHtml(delta.tool_calls_pct)}</td></tr>
  <tr><td>File Reads</td><td class="with">${mw.file_reads}</td><td class="without">${mwo.file_reads}</td><td>—</td></tr>
  <tr><td>Grep/Bash</td><td class="with">${mw.greps}</td><td class="without">${mwo.greps}</td><td>—</td></tr>
  <tr><td>CodeGraph Calls</td><td class="with">${mw.cg_tool_calls}</td><td class="without">0</td><td>—</td></tr>
</table>

<script>
new Chart(document.getElementById('costChart'), ${chartConfig('Cost', chartData.cost, 'USD')});
new Chart(document.getElementById('tokensChart'), ${chartConfig('Total Tokens', chartData.tokens, 'k tokens')});
new Chart(document.getElementById('timeChart'), ${chartConfig('Wall-clock Time', chartData.time, 'seconds')});
new Chart(document.getElementById('toolsChart'), ${chartConfig('Total Tool Calls', chartData.tools, 'calls')});
</script>
</body>
</html>`;
  }

  /** CLI 入口 */
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
    if (!outDir) { console.error('usage: generate-report.mjs <out-dir>'); process.exit(1); }
    main(outDir).catch(e => { console.error(e); process.exit(1); });
  }
  ```

- [ ] **步骤 4：运行测试确认通过**
  ```bash
  cd /Users/yanqi/Documents/onlyspace/projects/CodeGraphBench
  node --test tests/generate-report.test.mjs
  ```
  预期：`generate-report tests PASSED`

- [ ] **步骤 5：提交**
  ```bash
  cd /Users/yanqi/Documents/onlyspace/projects/CodeGraphBench
  git add lib/generate-report.mjs tests/generate-report.test.mjs
  git commit -m "feat: add generate-report.mjs + generate HTML report"
  ```

---

### 任务 3：`lib/prepare.sh` — 仓库准备 + codegraph 构建/索引

**文件：**
- 创建：`lib/prepare.sh`

**职责：**
1. 若传入 GitHub URL，则 `git clone` 到 `data/repos/<name>`
2. 若传入本地路径，直接使用
3. 构建 codegraph（`npm run build` in `$CODEGRAPH_SRC`，若 dist 已存在则跳过）
4. 对目标 repo 运行 `node dist/cli.js index <repo_path>`，生成 `.codegraph/` 索引

- [ ] **步骤 1：实现 `lib/prepare.sh`**

  ```bash
  #!/usr/bin/env bash
  # lib/prepare.sh
  # 用法: source lib/prepare.sh <repo_path_or_url> <bench_dir>
  # 输出: REPO_PATH（本地绝对路径）, CODEGRAPH_INDEX_DIR（.codegraph 所在目录）
  set -euo pipefail

  REPO_INPUT="${1:?repo path or URL required}"
  BENCH_DIR="${2:?bench dir required}"
  CODEGRAPH_SRC="${CODEGRAPH_SRC:-$(cd "$(dirname "$0")/../.." && pwd)/codegraph}"

  # 1. 解析 repo 路径
  if [[ "$REPO_INPUT" == https://* ]] || [[ "$REPO_INPUT" == git@* ]]; then
    REPO_NAME=$(basename "$REPO_INPUT" .git)
    REPO_PATH="$BENCH_DIR/data/repos/$REPO_NAME"
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

  # 2. 构建 codegraph（若 dist/cli.js 不存在）
  CODEGRAPH_CLI="$CODEGRAPH_SRC/dist/cli.js"
  if [ ! -f "$CODEGRAPH_CLI" ]; then
    echo "[prepare] Building codegraph at $CODEGRAPH_SRC ..."
    (cd "$CODEGRAPH_SRC" && npm install --silent && npm run build --silent)
  fi

  # 3. 索引目标 repo
  CODEGRAPH_INDEX_DIR="$REPO_PATH/.codegraph"
  if [ ! -d "$CODEGRAPH_INDEX_DIR" ]; then
    echo "[prepare] Indexing $REPO_PATH ..."
    node "$CODEGRAPH_CLI" index "$REPO_PATH"
  else
    echo "[prepare] Index already exists at $CODEGRAPH_INDEX_DIR"
  fi

  export REPO_PATH
  export CODEGRAPH_INDEX_DIR
  export CODEGRAPH_CLI
  ```

- [ ] **步骤 2：手动验证（用 codegraph 自身仓库）**
  ```bash
  cd /Users/yanqi/Documents/onlyspace/projects/CodeGraphBench
  source lib/prepare.sh /Users/yanqi/Documents/onlyspace/projects/codegraph .
  echo "REPO_PATH=$REPO_PATH"
  echo "CODEGRAPH_CLI=$CODEGRAPH_CLI"
  ```
  预期：输出正确路径，无报错

- [ ] **步骤 3：提交**
  ```bash
  cd /Users/yanqi/Documents/onlyspace/projects/CodeGraphBench
  git add lib/prepare.sh
  git commit -m "feat: add prepare.sh for repo clone + codegraph build/index"
  ```

---

### 任务 4：`lib/run-one.sh` + `codegraph-bench.sh` 主入口

**文件：**
- 创建：`lib/run-one.sh`
- 创建：`codegraph-bench.sh`

**`run-one.sh` 职责：** 执行单次 claude headless 运行，将 stream-json 输出写入 `<out_dir>/<label>.jsonl`

**`codegraph-bench.sh` 职责：** 编排完整流程（prepare → N×with → N×without → parse → report → open）

- [ ] **步骤 1：实现 `lib/run-one.sh`**

  ```bash
  #!/usr/bin/env bash
  # lib/run-one.sh
  # 用法: bash lib/run-one.sh <label> <prompt> <repo_path> <out_dir> [--with-codegraph]
  set -euo pipefail

  LABEL="${1:?label required}"
  PROMPT="${2:?prompt required}"
  REPO_PATH="${3:?repo path required}"
  OUT_DIR="${4:?out dir required}"
  WITH_CG="${5:-}"

  mkdir -p "$OUT_DIR"
  OUT_FILE="$OUT_DIR/${LABEL}.jsonl"

  # 构建 MCP 配置（仅 with-codegraph 时注入）
  if [[ "$WITH_CG" == "--with-codegraph" ]]; then
    CODEGRAPH_CLI="${CODEGRAPH_CLI:-$(cd "$(dirname "$0")/../.." && pwd)/codegraph/dist/cli.js}"
    MCP_FLAGS="--mcp-config <(node -e \"
      const cfg = {
        mcpServers: {
          codegraph: {
            command: 'node',
            args: ['$CODEGRAPH_CLI', 'mcp', '$REPO_PATH']
          }
        }
      };
      process.stdout.write(JSON.stringify(cfg));
    \")"
  else
    MCP_FLAGS=""
  fi

  echo "[run-one] Starting $LABEL ($([ -n "$WITH_CG" ] && echo 'WITH' || echo 'WITHOUT') CodeGraph) ..."
  START_MS=$(date +%s%3N)

  # 执行 claude headless
  eval claude \
    --output-format stream-json \
    --no-interactive \
    -p "$PROMPT" \
    --allowedTools "Read,Write,Bash,Grep,Glob,LS,mcp__codegraph__*" \
    --cwd "$REPO_PATH" \
    $MCP_FLAGS \
    > "$OUT_FILE" 2>&1

  END_MS=$(date +%s%3N)
  ELAPSED=$((END_MS - START_MS))
  echo "[run-one] $LABEL done in ${ELAPSED}ms → $OUT_FILE"
  ```

- [ ] **步骤 2：实现 `codegraph-bench.sh` 主入口**

  ```bash
  #!/usr/bin/env bash
  # codegraph-bench.sh — CodeGraph A/B 基准测试主入口
  # 用法: bash codegraph-bench.sh <repo_path_or_url> [prompt] [--runs N]
  set -euo pipefail

  BENCH_DIR="$(cd "$(dirname "$0")" && pwd)"
  REPO_INPUT="${1:?Usage: codegraph-bench.sh <repo_path_or_url> [prompt] [--runs N]}"
  shift

  # 解析可选参数
  PROMPT="Explain the overall architecture of this codebase. Describe the main modules, their responsibilities, and how they interact."
  RUNS=3

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --runs) RUNS="$2"; shift 2 ;;
      *) PROMPT="$1"; shift ;;
    esac
  done

  # 创建本次 bench 输出目录
  TIMESTAMP=$(date +%Y%m%d-%H%M%S)
  OUT_DIR="$BENCH_DIR/data/bench-$TIMESTAMP"
  mkdir -p "$OUT_DIR"

  echo "╔══════════════════════════════════════════════════════╗"
  echo "║           CodeGraphBench — A/B Test Runner           ║"
  echo "╠══════════════════════════════════════════════════════╣"
  echo "║ Repo:  $REPO_INPUT"
  echo "║ Runs:  $RUNS per arm (total: $((RUNS * 2)))"
  echo "║ Out:   $OUT_DIR"
  echo "╚══════════════════════════════════════════════════════╝"

  # 1. 准备 repo + codegraph 索引
  source "$BENCH_DIR/lib/prepare.sh" "$REPO_INPUT" "$BENCH_DIR"

  # 2. 写入 meta.json
  cat > "$OUT_DIR/meta.json" <<EOF
  {
    "repo": "$(basename "$REPO_PATH")",
    "repo_path": "$REPO_PATH",
    "prompt": $(node -e "process.stdout.write(JSON.stringify(process.argv[1]))" "$PROMPT"),
    "runs_per_arm": $RUNS,
    "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  }
  EOF

  # 3. 运行 WITH CodeGraph
  echo ""
  echo "▶ Running WITH CodeGraph ($RUNS runs)..."
  for i in $(seq 1 "$RUNS"); do
    bash "$BENCH_DIR/lib/run-one.sh" "with-$i" "$PROMPT" "$REPO_PATH" "$OUT_DIR" --with-codegraph
  done

  # 4. 运行 WITHOUT CodeGraph
  echo ""
  echo "▶ Running WITHOUT CodeGraph ($RUNS runs)..."
  for i in $(seq 1 "$RUNS"); do
    bash "$BENCH_DIR/lib/run-one.sh" "without-$i" "$PROMPT" "$REPO_PATH" "$OUT_DIR"
  done

  # 5. 解析结果
  echo ""
  echo "▶ Parsing results..."
  node "$BENCH_DIR/lib/parse-results.mjs" "$OUT_DIR"

  # 注入 meta 到 summary.json
  node -e "
    const fs = require('fs');
    const meta = JSON.parse(fs.readFileSync('$OUT_DIR/meta.json', 'utf8'));
    const summary = JSON.parse(fs.readFileSync('$OUT_DIR/summary.json', 'utf8'));
    fs.writeFileSync('$OUT_DIR/summary.json', JSON.stringify({...meta, ...summary}, null, 2));
  "

  # 6. 生成报告
  echo "▶ Generating report..."
  node "$BENCH_DIR/lib/generate-report.mjs" "$OUT_DIR"

  # 7. 输出摘要
  echo ""
  echo "════════════════════════════════════════════════════════"
  echo "✅ Benchmark complete!"
  echo "   HTML report: $OUT_DIR/report.html"
  echo "   MD report:   $OUT_DIR/report.md"
  echo "════════════════════════════════════════════════════════"

  # 8. 自动打开报告（macOS）
  if command -v open &>/dev/null; then
    open "$OUT_DIR/report.html"
  fi
  ```

- [ ] **步骤 3：赋予执行权限**
  ```bash
  chmod +x /Users/yanqi/Documents/onlyspace/projects/CodeGraphBench/codegraph-bench.sh
  chmod +x /Users/yanqi/Documents/onlyspace/projects/CodeGraphBench/lib/run-one.sh
  chmod +x /Users/yanqi/Documents/onlyspace/projects/CodeGraphBench/lib/prepare.sh
  ```

- [ ] **步骤 4：提交**
  ```bash
  cd /Users/yanqi/Documents/onlyspace/projects/CodeGraphBench
  git add codegraph-bench.sh lib/run-one.sh
  git commit -m "feat: add run-one.sh and main codegraph-bench.sh orchestrator"
  ```

---

### 任务 5：集成测试 + README

**文件：**
- 创建：`tests/integration.sh`
- 创建：`README.md`

- [ ] **步骤 1：写集成测试脚本**
  ```bash
  #!/usr/bin/env bash
  # 用 codegraph 自身仓库跑 1 run/arm，验证报告文件生成
  set -euo pipefail
  BENCH_DIR="$(cd "$(dirname "$0")/.." && pwd)"
  CODEGRAPH_REPO="/Users/yanqi/Documents/onlyspace/projects/codegraph"
  [ -d "$CODEGRAPH_REPO" ] || { echo "codegraph repo not found at $CODEGRAPH_REPO"; exit 1; }
  bash "$BENCH_DIR/codegraph-bench.sh" "$CODEGRAPH_REPO" --runs 1
  # 找最新的 bench 目录
  LATEST=$(ls -td "$BENCH_DIR/data/bench-"* | head -1)
  [ -f "$LATEST/report.html" ] || { echo "FAIL: report.html not generated"; exit 1; }
  [ -f "$LATEST/report.md" ]   || { echo "FAIL: report.md not generated"; exit 1; }
  [ -f "$LATEST/summary.json" ] || { echo "FAIL: summary.json not generated"; exit 1; }
  echo "Integration test PASSED — reports at $LATEST"
  ```

- [ ] **步骤 2：运行集成测试确认通过**
  ```bash
  bash tests/integration.sh
  ```
  预期：`Integration test PASSED`

- [ ] **步骤 3：写 README.md**
  ```markdown
  # CodeGraphBench

  一键测试 CodeGraph vs 无 CodeGraph 的 Claude Code 分析效率，输出含可视化图表的对比报告。

  ## 前置要求

  - `claude` CLI 已安装（`claude --version`）
  - Node.js 22.5+
  - codegraph 源码位于 `../codegraph`（或通过 `CODEGRAPH_SRC` 环境变量指定）

  ## 使用方法

  ```bash
  # 测试本地仓库（使用内置 prompt）
  bash codegraph-bench.sh /path/to/your/repo

  # 测试 GitHub 仓库
  bash codegraph-bench.sh https://github.com/user/repo

  # 自定义 prompt
  bash codegraph-bench.sh /path/to/repo "How does authentication work?"

  # 自定义运行次数（每组跑 5 次取中位数）
  bash codegraph-bench.sh /path/to/repo --runs 5

  # 组合使用
  bash codegraph-bench.sh https://github.com/user/repo "Explain the request flow" --runs 3
  ```

  ## 报告

  每次运行结果保存在 `data/bench-<timestamp>/`：
  - `report.html` — 可视化对比图表（浏览器直接打开）
  - `report.md` — 文字摘要
  - `summary.json` — 原始数据
  ```

- [ ] **步骤 4：提交**
  ```bash
  cd /Users/yanqi/Documents/onlyspace/projects/CodeGraphBench
  git add tests/integration.sh README.md
  git commit -m "feat: add integration test and README"
  ```
