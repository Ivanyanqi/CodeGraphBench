/**
 * generate-report.mjs
 * 将 summary.json 转换为 report.md（中文摘要）和 report.html（中文可视化报告）。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// ── 格式化工具 ────────────────────────────────────────────────────────────────

const fmt = {
  cost: (v) => `$${v.toFixed(4)}`,
  ms: (v) => (v >= 60000 ? `${(v / 60000).toFixed(1)}分钟` : `${(v / 1000).toFixed(1)}秒`),
  tokens: (v) =>
    v >= 1_000_000 ? `${(v / 1_000_000).toFixed(2)}M` : `${(v / 1000).toFixed(1)}k`,
  pct: (v) => (v === null ? 'N/A' : `${v > 0 ? '+' : ''}${v}%`),
};

// ── Markdown 报告 ─────────────────────────────────────────────────────────────

export function generateMarkdown(summary) {
  const { with: w, without: wo, delta, prompt, repo, runs_per_arm, timestamp, diagnostics } = summary;
  const mw = w.median;
  const mwo = wo.median;
  const diag = diagnostics ?? {};

  const toolDetail = (runs) =>
    runs
      .map((r) => {
        const status = r.failed ? '❌ 失败' : '✅ 成功';
        const tools = Object.entries(r.tool_calls ?? {})
          .sort((a, b) => b[1] - a[1])
          .map(([k, v]) => `${k.replace('mcp__codegraph__', 'cg:')}×${v}`)
          .join(', ');
        const mcpStatus = r.mcp_servers?.length
          ? r.mcp_servers.map((s) => `${s.name}:${s.status}`).join(', ')
          : '无 MCP';
        const warns = (r.warnings ?? []).map((w) => `    ⚠️ ${w}`).join('\n');
        return [
          `  - **${r.label}** ${status}`,
          `    费用=${fmt.cost(r.cost_usd)} 耗时=${fmt.ms(r.duration_ms)} tokens=${fmt.tokens(r.total_tokens)} 缓存命中=${r.cache_hit_rate ?? 0}%`,
          `    MCP状态: ${mcpStatus} | CG调用: ${r.cg_tool_calls ?? 0}次`,
          `    工具: ${tools || '(无)'}`,
          warns,
        ].filter(Boolean).join('\n');
      })
      .join('\n');

  const verdictLines = [];
  if (diag.warnings?.length) {
    verdictLines.push('### ⚠️ 诊断警告');
    diag.warnings.forEach((w) => verdictLines.push(`- ${w}`));
    verdictLines.push('');
  }

  const isValid = diag.result_valid !== false;
  if (!isValid) {
    verdictLines.push('### 结论：本次对比结果**无效**');
    verdictLines.push('WITH 组 MCP 未正常工作，两组实际运行条件相同，数据不具参考价值。');
  } else {
    const isImproved = delta.cost_pct !== null && delta.cost_pct < 0;
    if (isImproved) {
      verdictLines.push(`### 结论：CodeGraph 有效降低成本 ${Math.abs(delta.cost_pct)}%`);
      verdictLines.push(`Token 减少 ${Math.abs(delta.tokens_pct ?? 0)}%，工具调用减少 ${Math.abs(delta.tool_calls_pct ?? 0)}%。`);
    } else {
      verdictLines.push('### 结论：本次测试未观察到明显收益');
    }
  }

  return `# CodeGraphBench 测试报告

**仓库：** ${repo}
**提示词：** ${prompt}
**每组运行次数：** ${runs_per_arm}（WITH 有效: ${w.valid_count}，WITHOUT 有效: ${wo.valid_count}）
**时间：** ${timestamp ?? new Date().toISOString()}

## 汇总（中位数）

| 指标 | WITH CodeGraph | WITHOUT CodeGraph | 变化 |
|------|---------------|-------------------|------|
| 费用 | ${fmt.cost(mw.cost_usd)} | ${fmt.cost(mwo.cost_usd)} | **${fmt.pct(delta.cost_pct)}** |
| 新增 Token（input+output）| ${fmt.tokens(mw.total_tokens)} | ${fmt.tokens(mwo.total_tokens)} | **${fmt.pct(delta.tokens_pct)}** |
| 缓存 Token（不计入对比）| ${fmt.tokens(mw.cached_tokens)} | ${fmt.tokens(mwo.cached_tokens)} | — |
| 缓存命中率 | ${mw.cache_hit_rate ?? 0}% | ${mwo.cache_hit_rate ?? 0}% | — |
| 耗时 | ${fmt.ms(mw.duration_ms)} | ${fmt.ms(mwo.duration_ms)} | **${fmt.pct(delta.duration_pct)}** |
| 工具调用总数 | ${mw.total_tool_calls} | ${mwo.total_tool_calls} | **${fmt.pct(delta.tool_calls_pct)}** |
| 文件读取 | ${mw.file_reads} | ${mwo.file_reads} | — |
| Grep/Bash | ${mw.greps} | ${mwo.greps} | — |
| CodeGraph 调用 | ${mw.cg_tool_calls} | 0 | — |

## 诊断与结论

${verdictLines.join('\n')}

## 逐次详情

### WITH CodeGraph
${toolDetail(w.runs)}

### WITHOUT CodeGraph
${toolDetail(wo.runs)}
`;
}

// ── HTML 报告 ─────────────────────────────────────────────────────────────────

export function generateHtml(summary) {
  const { with: w, without: wo, delta, prompt, repo, runs_per_arm, timestamp, diagnostics } = summary;
  const mw = w.median;
  const mwo = wo.median;
  const diag = diagnostics ?? {};
  const isValid = diag.result_valid !== false;
  const isImproved = isValid && delta.cost_pct !== null && delta.cost_pct < 0;

  // ── Token 统计说明横幅（固定展示）────────────────────────────────────────
  const tokenNoteBanner = `<div class="banner banner-neutral" style="margin-top:1rem">
    <span class="banner-icon">ℹ️</span>
    <span><strong>Token 统计说明：</strong>「新增 Token」= input + output，<strong>不含</strong> cached_tokens。cached 是历史轮次 context 的重复计入，WITH 组 turns 更多时会线性累加导致虚高，需单独参考「缓存 Token」行。</span>
  </div>`;

  // ── 诊断横幅 ──────────────────────────────────────────────────────────────
  const diagBanners = (diag.warnings ?? []).map((msg) => `
    <div class="banner banner-warn">
      <span class="banner-icon">⚠️</span>
      <span>${msg}</span>
    </div>`).join('');

  // ── 结论横幅 ──────────────────────────────────────────────────────────────
  let verdictBanner;
  if (!isValid) {
    verdictBanner = `<div class="banner banner-error">
      <span class="banner-icon">❌</span>
      <strong>本次对比结果无效</strong> — WITH 组 MCP 未正常工作，两组实际运行条件相同，数据不具参考价值。请修复 MCP 配置后重新运行。
    </div>`;
  } else if (isImproved) {
    verdictBanner = `<div class="banner banner-success">
      <span class="banner-icon">✅</span>
      <strong>CodeGraph 有效</strong> — 费用降低 <strong>${Math.abs(delta.cost_pct)}%</strong>，Token 减少 <strong>${Math.abs(delta.tokens_pct ?? 0)}%</strong>，工具调用减少 <strong>${Math.abs(delta.tool_calls_pct ?? 0)}%</strong>。
    </div>`;
  } else {
    verdictBanner = `<div class="banner banner-neutral">
      <span class="banner-icon">📊</span>
      <strong>未观察到明显收益</strong> — 本次测试中 CodeGraph 未带来显著改善，可尝试换用更复杂的提示词或更大的仓库。
    </div>`;
  }

  // ── 图表配置 ──────────────────────────────────────────────────────────────
  const chartCfg = (title, withVal, withoutVal, unit, lowerIsBetter = true) => {
    const wColor = lowerIsBetter
      ? (withVal <= withoutVal ? 'rgba(34,197,94,0.85)' : 'rgba(239,68,68,0.85)')
      : (withVal >= withoutVal ? 'rgba(34,197,94,0.85)' : 'rgba(239,68,68,0.85)');
    return JSON.stringify({
      type: 'bar',
      data: {
        labels: ['WITH CodeGraph', 'WITHOUT'],
        datasets: [{
          data: [withVal, withoutVal],
          backgroundColor: [wColor, 'rgba(148,163,184,0.7)'],
          borderColor: [wColor.replace('0.85', '1'), 'rgba(148,163,184,1)'],
          borderWidth: 2,
          borderRadius: 8,
        }],
      },
      options: {
        responsive: true,
        plugins: {
          legend: { display: false },
          title: { display: true, text: `${title}（${unit}）`, font: { size: 13, weight: '600' }, color: '#1e293b' },
          tooltip: { callbacks: { label: (ctx) => ` ${ctx.raw} ${unit}` } },
        },
        scales: { y: { beginAtZero: true, grid: { color: '#f1f5f9' }, ticks: { color: '#64748b' } }, x: { ticks: { color: '#64748b' } } },
      },
    });
  };

  // ── 折线图：每次 run 的费用趋势 ──────────────────────────────────────────
  const trendCfg = () => {
    const labels = Array.from({ length: Math.max(w.runs.length, wo.runs.length) }, (_, i) => `第${i + 1}次`);
    return JSON.stringify({
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: 'WITH CodeGraph',
            data: w.runs.map((r) => r.failed ? null : parseFloat(r.cost_usd.toFixed(4))),
            borderColor: 'rgba(59,130,246,1)',
            backgroundColor: 'rgba(59,130,246,0.1)',
            tension: 0.3,
            pointRadius: 5,
            fill: true,
          },
          {
            label: 'WITHOUT CodeGraph',
            data: wo.runs.map((r) => r.failed ? null : parseFloat(r.cost_usd.toFixed(4))),
            borderColor: 'rgba(249,115,22,1)',
            backgroundColor: 'rgba(249,115,22,0.1)',
            tension: 0.3,
            pointRadius: 5,
            fill: true,
          },
        ],
      },
      options: {
        responsive: true,
        plugins: {
          title: { display: true, text: '每次运行费用趋势（USD）', font: { size: 13, weight: '600' }, color: '#1e293b' },
          legend: { position: 'bottom', labels: { color: '#475569' } },
        },
        scales: { y: { beginAtZero: false, grid: { color: '#f1f5f9' }, ticks: { color: '#64748b' } }, x: { ticks: { color: '#64748b' } } },
      },
    });
  };

  // ── 工具调用分布雷达图 ────────────────────────────────────────────────────
  const radarCfg = () => {
    const allKeys = new Set([
      ...w.runs.flatMap((r) => Object.keys(r.tool_calls ?? {})),
      ...wo.runs.flatMap((r) => Object.keys(r.tool_calls ?? {})),
    ]);
    // 只保留常见工具，过滤掉 mcp__ 前缀的（单独统计）
    const keys = [...allKeys]
      .filter((k) => !k.startsWith('mcp__') && !['Agent', 'Task'].includes(k))
      .slice(0, 8);
    const avg = (runs, key) => {
      const vals = runs.filter((r) => !r.failed).map((r) => r.tool_calls?.[key] ?? 0);
      return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
    };
    return JSON.stringify({
      type: 'radar',
      data: {
        labels: keys,
        datasets: [
          {
            label: 'WITH CodeGraph',
            data: keys.map((k) => avg(w.runs, k)),
            borderColor: 'rgba(59,130,246,0.9)',
            backgroundColor: 'rgba(59,130,246,0.15)',
            pointBackgroundColor: 'rgba(59,130,246,1)',
          },
          {
            label: 'WITHOUT CodeGraph',
            data: keys.map((k) => avg(wo.runs, k)),
            borderColor: 'rgba(249,115,22,0.9)',
            backgroundColor: 'rgba(249,115,22,0.15)',
            pointBackgroundColor: 'rgba(249,115,22,1)',
          },
        ],
      },
      options: {
        responsive: true,
        plugins: {
          title: { display: true, text: '工具调用分布（平均次数）', font: { size: 13, weight: '600' }, color: '#1e293b' },
          legend: { position: 'bottom', labels: { color: '#475569' } },
        },
        scales: { r: { beginAtZero: true, grid: { color: '#e2e8f0' }, ticks: { color: '#94a3b8', backdropColor: 'transparent' }, pointLabels: { color: '#475569' } } },
      },
    });
  };

  // ── 逐次详情行 ────────────────────────────────────────────────────────────
  const runRows = (runs) =>
    runs.map((r) => {
      const statusBadge = r.failed
        ? '<span class="badge badge-error">失败</span>'
        : '<span class="badge badge-success">成功</span>';

      const mcpBadges = (r.mcp_servers ?? []).map((s) => {
        const cls = s.status === 'connected' ? 'badge-success' : 'badge-error';
        return `<span class="badge ${cls}" title="${s.name}">${s.name}: ${s.status}</span>`;
      }).join(' ') || '<span class="badge badge-neutral">无 MCP</span>';

      const cgBadge = r.cg_tool_calls > 0
        ? `<span class="badge badge-cg">CG ×${r.cg_tool_calls}</span>`
        : (r.label.startsWith('with-')
          ? '<span class="badge badge-error">CG ×0 ⚠️</span>'
          : '<span class="badge badge-neutral">—</span>');

      const tools = Object.entries(r.tool_calls ?? {})
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => {
          const display = k.startsWith('mcp__codegraph__') ? `<span style="color:#7c3aed">cg:${k.replace('mcp__codegraph__', '')}×${v}</span>` : `${k}×${v}`;
          return `<code>${display}</code>`;
        }).join(' ');

      const warnHtml = (r.warnings ?? []).map((w) =>
        `<div class="run-warn">⚠️ ${w}</div>`
      ).join('');

      return `<tr>
        <td><strong>${r.label}</strong></td>
        <td>${statusBadge}</td>
        <td class="num">${fmt.cost(r.cost_usd)}</td>
        <td class="num">${fmt.ms(r.duration_ms)}</td>
        <td class="num">${fmt.tokens(r.total_tokens)}</td>
        <td class="num">${r.cache_hit_rate ?? 0}%</td>
        <td>${mcpBadges}</td>
        <td>${cgBadge}</td>
        <td class="tools-cell">${tools || '—'}${warnHtml}</td>
      </tr>`;
    }).join('\n');

  // ── 指标卡片 ──────────────────────────────────────────────────────────────
  const metricCard = (label, withVal, withoutVal, pctVal, unit = '') => {
    const arrow = pctVal === null ? '' : pctVal < 0 ? '↓' : pctVal > 0 ? '↑' : '→';
    const color = pctVal === null ? '#64748b' : pctVal < 0 ? '#16a34a' : pctVal > 0 ? '#dc2626' : '#64748b';
    return `<div class="metric-card">
      <div class="metric-label">${label}</div>
      <div class="metric-row">
        <div class="metric-val with-val">${withVal}${unit}</div>
        <div class="metric-val without-val">${withoutVal}${unit}</div>
      </div>
      <div class="metric-delta" style="color:${color}">${arrow} ${fmt.pct(pctVal)}</div>
    </div>`;
  };

  const ts = timestamp ? new Date(timestamp).toLocaleString('zh-CN') : '—';

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>CodeGraphBench 报告 — ${repo}</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"></script>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif;
    background: #f8fafc; color: #1e293b; line-height: 1.6;
    padding: 0 0 4rem;
  }

  /* ── 顶部 header ── */
  .header {
    background: linear-gradient(135deg, #1e293b 0%, #334155 100%);
    color: white; padding: 2rem 2.5rem 1.5rem;
  }
  .header h1 { font-size: 1.6rem; font-weight: 700; margin-bottom: 0.5rem; }
  .header-meta { display: flex; flex-wrap: wrap; gap: 1.5rem; font-size: 0.82rem; color: #94a3b8; margin-top: 0.75rem; }
  .header-meta span strong { color: #e2e8f0; }
  .prompt-box {
    background: rgba(255,255,255,0.07); border-radius: 8px;
    padding: 0.6rem 1rem; margin-top: 0.75rem;
    font-size: 0.85rem; color: #cbd5e1; font-style: italic;
    border-left: 3px solid #3b82f6;
  }

  /* ── 主体容器 ── */
  .container { max-width: 1100px; margin: 0 auto; padding: 0 1.5rem; }

  /* ── 横幅 ── */
  .banner {
    display: flex; align-items: flex-start; gap: 0.75rem;
    padding: 1rem 1.25rem; border-radius: 10px; margin: 1.25rem 0;
    font-size: 0.92rem; line-height: 1.5;
  }
  .banner-icon { font-size: 1.2rem; flex-shrink: 0; margin-top: 0.05rem; }
  .banner-error   { background: #fef2f2; border: 1px solid #fca5a5; color: #991b1b; }
  .banner-warn    { background: #fffbeb; border: 1px solid #fcd34d; color: #92400e; }
  .banner-success { background: #f0fdf4; border: 1px solid #86efac; color: #166534; }
  .banner-neutral { background: #f0f9ff; border: 1px solid #7dd3fc; color: #075985; }

  /* ── 区块标题 ── */
  .section { margin-top: 2rem; }
  .section-title {
    font-size: 1rem; font-weight: 700; color: #475569;
    text-transform: uppercase; letter-spacing: 0.06em;
    padding-bottom: 0.5rem; border-bottom: 2px solid #e2e8f0;
    margin-bottom: 1rem;
  }

  /* ── 指标卡片 ── */
  .metrics-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 1rem; }
  .metric-card {
    background: white; border-radius: 12px; padding: 1rem 1.25rem;
    box-shadow: 0 1px 4px rgba(0,0,0,0.07); border: 1px solid #e2e8f0;
  }
  .metric-label { font-size: 0.75rem; color: #64748b; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 0.5rem; }
  .metric-row { display: flex; gap: 0.5rem; align-items: baseline; margin-bottom: 0.25rem; }
  .metric-val { font-size: 1.05rem; font-weight: 700; }
  .with-val { color: #2563eb; }
  .without-val { color: #94a3b8; font-size: 0.9rem; font-weight: 500; }
  .metric-delta { font-size: 0.8rem; font-weight: 600; }

  /* ── 图表网格 ── */
  .charts-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1.25rem; }
  .charts-grid-3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 1.25rem; }
  .chart-box {
    background: white; border-radius: 12px; padding: 1.25rem;
    box-shadow: 0 1px 4px rgba(0,0,0,0.07); border: 1px solid #e2e8f0;
  }
  .chart-box.span2 { grid-column: span 2; }

  /* ── 汇总表格 ── */
  .summary-table-wrap { background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 1px 4px rgba(0,0,0,0.07); border: 1px solid #e2e8f0; }
  table { width: 100%; border-collapse: collapse; }
  th {
    background: #f8fafc; padding: 0.65rem 1rem; text-align: left;
    font-size: 0.75rem; font-weight: 700; color: #475569;
    text-transform: uppercase; letter-spacing: 0.05em;
    border-bottom: 2px solid #e2e8f0;
  }
  td { padding: 0.6rem 1rem; border-top: 1px solid #f1f5f9; font-size: 0.875rem; vertical-align: top; }
  tr:hover td { background: #f8fafc; }
  .num { font-variant-numeric: tabular-nums; font-family: 'SF Mono', 'Fira Code', monospace; }
  .with-col { color: #2563eb; font-weight: 600; }
  .without-col { color: #64748b; }

  /* ── 徽章 ── */
  .badge {
    display: inline-block; padding: 0.15em 0.55em; border-radius: 999px;
    font-size: 0.72rem; font-weight: 600; white-space: nowrap;
  }
  .badge-success { background: #dcfce7; color: #166534; }
  .badge-error   { background: #fee2e2; color: #991b1b; }
  .badge-neutral { background: #f1f5f9; color: #64748b; }
  .badge-cg      { background: #ede9fe; color: #6d28d9; }

  /* ── 工具列 ── */
  .tools-cell { font-size: 0.78rem; max-width: 320px; }
  .tools-cell code { background: #f1f5f9; padding: 0.1em 0.4em; border-radius: 4px; margin: 0.1em; display: inline-block; }
  .run-warn { color: #b45309; font-size: 0.75rem; margin-top: 0.3rem; background: #fffbeb; padding: 0.2em 0.5em; border-radius: 4px; }

  /* ── 图例说明 ── */
  .legend { display: flex; gap: 1.5rem; font-size: 0.8rem; color: #64748b; margin-bottom: 0.75rem; }
  .legend-dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; margin-right: 0.3rem; }

  /* ── 提示词展示 ── */
  .prompt-full {
    background: white; border-radius: 10px; padding: 1rem 1.25rem;
    border: 1px solid #e2e8f0; box-shadow: 0 1px 4px rgba(0,0,0,0.05);
    font-size: 0.9rem; color: #334155; line-height: 1.7;
    white-space: pre-wrap; word-break: break-word;
    border-left: 4px solid #3b82f6;
  }

  @media (max-width: 700px) {
    .charts-grid, .charts-grid-3 { grid-template-columns: 1fr; }
    .chart-box.span2 { grid-column: span 1; }
    .metrics-grid { grid-template-columns: 1fr 1fr; }
  }
</style>
</head>
<body>

<div class="header">
  <h1>📊 CodeGraphBench 测试报告</h1>
  <div class="header-meta">
    <span><strong>仓库：</strong>${repo}</span>
    <span><strong>每组次数：</strong>${runs_per_arm} 次（WITH 有效 ${w.valid_count}，WITHOUT 有效 ${wo.valid_count}）</span>
    <span><strong>时间：</strong>${ts}</span>
    <span><strong>模型：</strong>${w.runs[0]?.model ?? '—'}</span>
  </div>
  <div class="prompt-box">💬 ${(prompt ?? '').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</div>
</div>

<div class="container">

  ${tokenNoteBanner}
  ${diagBanners}
  ${verdictBanner}

  <!-- ── 提示词 ── -->
  <div class="section">
    <div class="section-title">测试提示词</div>
    <div class="prompt-full">${(prompt ?? '').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</div>
  </div>

  <!-- ── 指标卡片 ── -->
  <div class="section">
    <div class="section-title">核心指标对比（中位数）</div>
    <div class="legend">
      <span><span class="legend-dot" style="background:#2563eb"></span>WITH CodeGraph</span>
      <span><span class="legend-dot" style="background:#94a3b8"></span>WITHOUT CodeGraph</span>
    </div>
    <div class="metrics-grid">
      ${metricCard('费用 (USD)', fmt.cost(mw.cost_usd), fmt.cost(mwo.cost_usd), delta.cost_pct)}
      ${metricCard('新增 Token', fmt.tokens(mw.total_tokens), fmt.tokens(mwo.total_tokens), delta.tokens_pct)}
      ${metricCard('缓存 Token', fmt.tokens(mw.cached_tokens), fmt.tokens(mwo.cached_tokens), null)}
      ${metricCard('缓存命中率', mw.cache_hit_rate ?? 0, mwo.cache_hit_rate ?? 0, null, '%')}
      ${metricCard('耗时', fmt.ms(mw.duration_ms), fmt.ms(mwo.duration_ms), delta.duration_pct)}
      ${metricCard('工具调用', mw.total_tool_calls, mwo.total_tool_calls, delta.tool_calls_pct, ' 次')}
      ${metricCard('CG 调用', mw.cg_tool_calls, '0', null, ' 次')}
      ${metricCard('文件读取', mw.file_reads, mwo.file_reads, null, ' 次')}
      ${metricCard('Grep/Bash', mw.greps, mwo.greps, null, ' 次')}
    </div>
  </div>

  <!-- ── 图表 ── -->
  <div class="section">
    <div class="section-title">可视化分析</div>
    <div class="charts-grid" style="margin-bottom:1.25rem">
      <div class="chart-box"><canvas id="costChart"></canvas></div>
      <div class="chart-box"><canvas id="tokensChart"></canvas></div>
      <div class="chart-box"><canvas id="timeChart"></canvas></div>
      <div class="chart-box"><canvas id="toolsChart"></canvas></div>
    </div>
    <div class="charts-grid">
      <div class="chart-box span2"><canvas id="trendChart"></canvas></div>
      <div class="chart-box"><canvas id="radarChart"></canvas></div>
    </div>
  </div>

  <!-- ── 汇总表格 ── -->
  <div class="section">
    <div class="section-title">汇总数据表（中位数）</div>
    <div class="summary-table-wrap">
      <table>
        <tr>
          <th>指标</th>
          <th class="with-col">WITH CodeGraph</th>
          <th class="without-col">WITHOUT CodeGraph</th>
          <th>变化</th>
        </tr>
        <tr><td>费用</td><td class="with-col num">${fmt.cost(mw.cost_usd)}</td><td class="without-col num">${fmt.cost(mwo.cost_usd)}</td><td>${deltaCell(delta.cost_pct)}</td></tr>
        <tr><td>新增 Token <small style="color:#94a3b8">(input+output)</small></td><td class="with-col num">${fmt.tokens(mw.total_tokens)}</td><td class="without-col num">${fmt.tokens(mwo.total_tokens)}</td><td>${deltaCell(delta.tokens_pct)}</td></tr>
        <tr><td>缓存 Token <small style="color:#94a3b8">(不计入对比)</small></td><td class="with-col num">${fmt.tokens(mw.cached_tokens)}</td><td class="without-col num">${fmt.tokens(mwo.cached_tokens)}</td><td>—</td></tr>
        <tr><td>缓存命中率</td><td class="with-col num">${mw.cache_hit_rate ?? 0}%</td><td class="without-col num">${mwo.cache_hit_rate ?? 0}%</td><td>—</td></tr>
        <tr><td>耗时</td><td class="with-col num">${fmt.ms(mw.duration_ms)}</td><td class="without-col num">${fmt.ms(mwo.duration_ms)}</td><td>${deltaCell(delta.duration_pct)}</td></tr>
        <tr><td>工具调用总数</td><td class="with-col num">${mw.total_tool_calls}</td><td class="without-col num">${mwo.total_tool_calls}</td><td>${deltaCell(delta.tool_calls_pct)}</td></tr>
        <tr><td>文件读取</td><td class="with-col num">${mw.file_reads}</td><td class="without-col num">${mwo.file_reads}</td><td>—</td></tr>
        <tr><td>Grep / Bash</td><td class="with-col num">${mw.greps}</td><td class="without-col num">${mwo.greps}</td><td>—</td></tr>
        <tr><td>CodeGraph 调用</td><td class="with-col num">${mw.cg_tool_calls}</td><td class="without-col num">0</td><td>—</td></tr>
      </table>
    </div>
  </div>

  <!-- ── 逐次详情 ── -->
  <div class="section">
    <div class="section-title">逐次运行详情</div>
    <div class="summary-table-wrap" style="margin-bottom:1.25rem">
      <table>
        <tr><th>编号</th><th>状态</th><th>费用</th><th>耗时</th><th>Token</th><th>缓存命中</th><th>MCP 状态</th><th>CG 调用</th><th>工具明细</th></tr>
        ${runRows(w.runs)}
      </table>
    </div>
    <div class="summary-table-wrap">
      <table>
        <tr><th>编号</th><th>状态</th><th>费用</th><th>耗时</th><th>Token</th><th>缓存命中</th><th>MCP 状态</th><th>CG 调用</th><th>工具明细</th></tr>
        ${runRows(wo.runs)}
      </table>
    </div>
  </div>

</div>

<script>
new Chart(document.getElementById('costChart'),
  ${chartCfg('费用', parseFloat(mw.cost_usd.toFixed(4)), parseFloat(mwo.cost_usd.toFixed(4)), 'USD')});
new Chart(document.getElementById('tokensChart'),
  ${chartCfg('总 Token', Math.round(mw.total_tokens / 1000), Math.round(mwo.total_tokens / 1000), 'k tokens')});
new Chart(document.getElementById('timeChart'),
  ${chartCfg('耗时', Math.round(mw.duration_ms / 1000), Math.round(mwo.duration_ms / 1000), '秒')});
new Chart(document.getElementById('toolsChart'),
  ${chartCfg('工具调用', mw.total_tool_calls, mwo.total_tool_calls, '次')});
new Chart(document.getElementById('trendChart'), ${trendCfg()});
new Chart(document.getElementById('radarChart'), ${radarCfg()});
</script>

</body>
</html>`;
}

// ── 辅助：delta 单元格 ────────────────────────────────────────────────────────
function deltaCell(pct) {
  if (pct === null) return '<span style="color:#94a3b8">N/A</span>';
  const color = pct < 0 ? '#16a34a' : pct > 0 ? '#dc2626' : '#64748b';
  const arrow = pct < 0 ? '↓' : pct > 0 ? '↑' : '→';
  return `<span style="color:${color};font-weight:700">${arrow} ${pct > 0 ? '+' : ''}${pct}%</span>`;
}

// ── CLI 入口 ──────────────────────────────────────────────────────────────────

export async function main(outDir) {
  const summaryPath = join(outDir, 'summary.json');
  const summary = JSON.parse(readFileSync(summaryPath, 'utf8'));
  const md = generateMarkdown(summary);
  const html = generateHtml(summary);
  writeFileSync(join(outDir, 'report.md'), md);
  writeFileSync(join(outDir, 'report.html'), html);
  console.log(`report.md 和 report.html 已写入 ${outDir}`);
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const outDir = process.argv[2];
  if (!outDir) {
    console.error('用法: generate-report.mjs <out-dir>');
    process.exit(1);
  }
  main(outDir).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
