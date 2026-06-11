# CodeGraphBench 设计文档

**目标：** 一键对任意代码库执行 CodeGraph vs 无 CodeGraph 的 Claude Code A/B 基准测试，输出含可视化图表的完整对比报告。

**背景：** CodeGraph 声称可减少 AI Agent 的 token 消耗和工具调用次数，需要一个可复现、可配置的测试工具来在自己的代码库上验证这一效果。

**方案选择：** Shell 编排 + Node.js 解析 + 自包含 HTML 报告（Chart.js 内嵌）。不引入 Python 依赖，保持零额外安装要求（仅需 node + claude CLI + codegraph 源码）。

---

## 架构

主入口 Shell 脚本编排整个流程：准备目标仓库 → 构建 codegraph → 交替执行 WITH/WITHOUT 两组 headless claude 运行 → Node.js 解析 jsonl 日志 → 生成 Markdown + HTML 报告。

```
codegraph-bench.sh <repo> [prompt] [--runs N]
  ├── lib/prepare.sh      # clone/验证 repo，build codegraph，init index
  ├── lib/run-one.sh      # 单次 claude -p headless 运行
  ├── lib/parse-results.mjs   # 解析所有 jsonl → summary.json
  └── lib/generate-report.mjs # summary.json → report.md + report.html
```

---

## 组件

### `codegraph-bench.sh`（主入口）
- 解析参数：`<repo>` 必填（URL 或本地路径），`[prompt]` 可选，`--runs N`（默认 3）
- 自动识别 repo 类型：`http(s)://` 或 `git@` → clone；本地路径 → 直接使用
- 创建 `data/bench-<timestamp>/` 作为本次运行的工作目录
- 按序调用 prepare → run WITH×N → run WITHOUT×N → parse → report

### `lib/prepare.sh`
- clone（如需）到 `data/bench-<ts>/repo/`
- 检查 codegraph 源码是否已构建（`dist/bin/codegraph.js`），未构建则 `npm run build`
- 对目标 repo 执行 `codegraph init -i`，建立索引

### `lib/run-one.sh`
- 参数：`<repo-path> <label> <prompt> <mcp-config-path> <out-dir>`
- 调用 `claude -p "$PROMPT" --output-format stream-json --verbose --permission-mode bypassPermissions --model claude-opus-4-5 --max-budget-usd 3 --strict-mcp-config --mcp-config "$MCP_CFG"`
- 输出到 `<out-dir>/<label>.jsonl`，stderr 到 `<label>.err`
- WITH 组：MCP config 指向 codegraph serve；WITHOUT 组：空 MCP config `{}`

### `lib/parse-results.mjs`
- 读取 `data/bench-<ts>/` 下所有 `with-*.jsonl` 和 `without-*.jsonl`
- 每个文件提取：
  - `cost_usd`、`total_tokens`、`input_tokens`、`output_tokens`、`duration_ms`
  - `tool_calls`：各工具调用次数 map
  - `file_reads`：Read 工具调用次数
  - `greps`：Grep + Bash 调用次数
- 计算每组的中位数
- 输出 `summary.json`

### `lib/generate-report.mjs`
- 读取 `summary.json`
- 生成 `report.md`：文字摘要表格 + 各 run 详情
- 生成 `report.html`：自包含 HTML，内嵌 Chart.js CDN，4 张柱状图：
  - Cost (USD) 对比
  - Total Tokens 对比
  - Wall-clock Time 对比
  - Tool Calls 总数对比

---

## 数据流

```
claude -p --output-format stream-json
  → data/bench-<ts>/with-1.jsonl … with-N.jsonl
  → data/bench-<ts>/without-1.jsonl … without-N.jsonl
  → parse-results.mjs → data/bench-<ts>/summary.json
  → generate-report.mjs
      → data/bench-<ts>/report.md
      → data/bench-<ts>/report.html   ← 浏览器直接打开
```

---

## 内置 Prompt

未传入 prompt 时，使用以下通用架构问题（适合大多数代码库）：

> "Explain the overall architecture of this codebase: what are the main components, how do they interact, and how does a typical request or operation flow through the system from entry point to completion?"

---

## 错误处理

| 场景 | 处理方式 |
|------|---------|
| repo URL clone 失败 | 报错退出，提示检查 URL 和网络/SSH 权限 |
| 本地路径不存在 | 报错退出 |
| codegraph build 失败 | 报错退出，提示 `npm run build` 错误信息 |
| codegraph init 失败 | 报错退出 |
| claude 单次运行失败（非零退出） | 记录错误，继续其他 runs，报告中标注该 run 为 FAILED |
| 某组有效 runs < 2 | 警告，仍输出报告但标注样本不足 |
| parse 某个 jsonl 失败 | 跳过该 run，用剩余数据计算中位数 |

---

## 目录结构

```
projects/CodeGraphBench/
├── codegraph-bench.sh          # 主入口
├── lib/
│   ├── prepare.sh
│   ├── run-one.sh
│   ├── parse-results.mjs
│   └── generate-report.mjs
├── data/
│   └── bench-<timestamp>/      # 每次运行独立目录（gitignore）
│       ├── repo/               # clone 的目标仓库
│       ├── with-1.jsonl … with-N.jsonl
│       ├── without-1.jsonl … without-N.jsonl
│       ├── summary.json
│       ├── report.md
│       └── report.html
├── docs/superpowers/
│   ├── specs/
│   └── plans/
├── .gitignore
└── README.md
```

---

## 测试策略

- `parse-results.mjs` 用 Node.js 内置 `assert` 写单元测试，覆盖：空文件、缺字段、多 run 中位数计算
- `generate-report.mjs` 测试：给定 summary.json，验证输出 HTML 包含预期的图表数据
- 集成测试：用 codegraph 自身仓库作为目标，跑 1 run/arm，验证报告文件生成

---

## 不在范围内

- 多问题批量跑（问题文件模式）
- 并行执行 WITH/WITHOUT（避免资源竞争影响计时）
- 云端存储或分享报告
- 支持除 claude 以外的其他 AI Agent
