# CodeGraphBench

一键测试 [CodeGraph](https://github.com/colbymchenry/codegraph) vs 无 CodeGraph 的 Claude Code 分析效率，输出含可视化图表的对比报告。

## 工作原理

对同一代码库和同一 prompt，分别运行 N 次：

- **WITH CodeGraph**：Claude 通过 MCP 协议使用 CodeGraph 的预索引知识图谱
- **WITHOUT CodeGraph**：Claude 只能使用 Read/Grep/Bash 等原始文件工具

取每组的中位数，对比 **成本、Token 消耗、耗时、工具调用次数**，生成 HTML 可视化报告。

## 前置要求

- Claude CLI 已安装：`claude`（官方）或任意支持相同参数约定的客户端
- Node.js 18+
- codegraph 源码位于 `../codegraph`（与本项目同级），或通过 `CODEGRAPH_SRC` 环境变量指定

## 快速开始

```bash
# 克隆本项目
git clone <this-repo> projects/CodeGraphBench
cd projects/CodeGraphBench

# 测试本地仓库（使用默认 prompt，跑 3 次/arm）
bash codegraph-bench.sh /path/to/your/repo

# 测试 GitHub 仓库
bash codegraph-bench.sh https://github.com/user/repo

# 自定义 prompt
bash codegraph-bench.sh /path/to/repo "How does authentication work?"

# 自定义运行次数（每组跑 5 次取中位数，结果更稳定）
bash codegraph-bench.sh /path/to/repo --runs 5

# 指定具体的 Claude 客户端命令
bash codegraph-bench.sh /path/to/repo --cli claude

# 指定模型
bash codegraph-bench.sh /path/to/repo --cli "claude --model claude-opus-4-5"

# 通过环境变量指定 CLI（适合长期使用）
export CLAUDE_CLI=claude
bash codegraph-bench.sh /path/to/repo --runs 3

# 组合使用
bash codegraph-bench.sh https://github.com/user/repo "Explain the request flow" --runs 3 --cli claude
```

## 输出

每次运行结果保存在 `data/bench-<timestamp>/`：

| 文件 | 说明 |
|------|------|
| `report.html` | 可视化对比图表（浏览器直接打开，自动弹出） |
| `report.md` | 文字摘要报告 |
| `summary.json` | 原始统计数据（中位数、delta、每次 run 详情） |
| `meta.json` | 测试元信息（repo、prompt、时间戳） |
| `with-N.jsonl` | WITH CodeGraph 的 claude stream-json 原始输出 |
| `without-N.jsonl` | WITHOUT CodeGraph 的 claude stream-json 原始输出 |

## 项目结构

```
CodeGraphBench/
├── codegraph-bench.sh        # 主入口：编排完整 A/B 测试流程
├── lib/
│   ├── prepare.sh            # repo 准备 + codegraph 构建/索引
│   ├── run-one.sh            # 单次 claude headless 运行
│   ├── parse-results.mjs     # jsonl → summary.json（指标提取）
│   └── generate-report.mjs  # summary.json → report.md + report.html
├── tests/
│   ├── parse-results.test.mjs   # parse-results 单元测试
│   ├── generate-report.test.mjs # generate-report 单元测试
│   └── integration.sh           # 端到端集成测试
├── data/                     # 测试输出（gitignored）
│   ├── repos/                # clone 的远程仓库缓存
│   └── bench-<timestamp>/    # 每次测试的输出目录
└── docs/
    └── superpowers/
        ├── specs/            # 设计文档
        └── plans/            # 实现计划
```

## 选项

| 选项 | 说明 |
|------|------|
| `--runs N` | 每组运行次数，默认 3 |
| `--cli <cmd>` | 指定 Claude CLI 命令，默认 `claude` |

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `CLAUDE_CLI` | `claude` | Claude CLI 命令，支持任意兼容客户端（需支持 `--print`、`--output-format`、`--mcp-config` 等参数） |
| `CODEGRAPH_SRC` | `../codegraph` | codegraph 源码目录 |
| `CODEGRAPH_REPO` | `../codegraph` | 集成测试使用的 repo |

> **`--cli` 参数优先级高于 `CLAUDE_CLI` 环境变量。**

## 运行测试

```bash
# 单元测试（无需 claude API）
node --test tests/parse-results.test.mjs
node --test tests/generate-report.test.mjs

# 端到端集成测试（需要 claude API，约 2-5 分钟）
bash tests/integration.sh
```

## 注意事项

- 每次运行会产生真实 API 费用，建议先用 `--runs 1` 验证流程
- 结果受网络延迟、API 负载等因素影响，建议 `--runs 3` 以上取中位数
- `data/` 目录已加入 `.gitignore`，测试数据不会提交到 git
- 使用自定义客户端时，请确保其支持 `--print`、`--output-format stream-json`、`--verbose`、`--mcp-config`、`--allowedTools`、`--dangerously-skip-permissions` 等参数
