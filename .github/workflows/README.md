# Workflows 目录说明

## 探针（一次性/诊断）工作流 — 归档候选（#924）

以下 5 个 workflow 均为 **dispatch-only**（仅 `workflow_dispatch` 手动触发，无 push/PR/cron 触发器），
不参与常规 CI/CD。保留成本为零（不跑就不耗 Actions 分钟数），但会长期堆积。**是否删除留给维护者决定**；
删除后如需恢复可从 git 历史找回。

| 文件 | 用途 | 触发方式 | 归档建议 |
|---|---|---|---|
| `llm-probe.yml` | LLM 供应商 tool-call 兼容性 sweep（复用 `scripts/probe-llm.mjs`，跑 `ai` SDK 对各模型做工具调用冒烟）。文件自述为 temp。 | 手动 | 换模型/换 SDK 版本时还有用，建议保留或改为按需重建 |
| `cf-agent-browser-probe.yml` | 验证 Cloudflare API token 权限范围 + Browser Rendering（Agent Browser）订阅可用性 | 手动 | CF 侧配置变更排障时用；平时可删 |
| `vps-disk-diagnose.yml` | SSH 到 VPS 查看磁盘占用（df/du/docker system df/journalctl --disk-usage），定位空间大户 | 手动 | 磁盘告警时用；建议保留（运维排障成本低） |
| `vps-volume-inspect.yml` | SSH 到 VPS 检查 compose 服务、Docker volume 与数据卷目录布局 | 手动 | 一次性数据布局勘察，基本可删 |
| `vps-disk-clean.yml` | SSH 到 VPS 深度清理磁盘（`docker system prune -a`、builder prune、journal vacuum）。**有损操作**：会删未使用镜像 | 手动 | 磁盘告急时的应急手段，建议保留 |

> 注意：GitHub Actions 只识别 `.github/workflows/` **顶层**的 yml；移入子目录（如 `probes/`）会失效，故以注释标记替代归档。

## 正式 CI/CD 工作流

| 文件 | 用途 | 触发 |
|---|---|---|
| `web-ci.yml` | web 包 typecheck + vitest + lint | push(main)/PR（路径过滤） |
| `server-ts-ci.yml` | server-ts 包 typecheck + 测试 | push(main)/PR（路径过滤） |
| `worker-ci.yml` | worker 包 typecheck + vitest | push(main)/PR/手动（路径过滤） |
| `e2e-tests.yml` | 端到端测试（target: 8002=staging / 8001=prod） | 手动 |
| `cf-browser-agent.yml` | cf-browser-agent 包 CI（Cloudflare Worker） | push(main)/PR（路径过滤） |
| `deploy-server.yml` | 部署 server-ts 到 VPS（含 Reactome 图库 provision） | push(main)/手动 |
| `deploy-worker.yml` | 部署 worker 到 VPS | push(main)/手动 |
