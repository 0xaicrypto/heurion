# Heurion 2.0

用 AI 编辑医学文档，内置医学文献检索与引用规范。平台持有带稳定 id 的结构化文档模型，经 MCP 向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）暴露结构化编辑操作，所有 AI 写入在操作层经写前守卫（用户优先、引用规范、评论锚点保护）。

架构：[docs/PLATFORM.md](docs/PLATFORM.md)

## 快速开始

需要 Node ≥ 24、pnpm。

```sh
cp .env.example .env        # 填 DEEPSEEK_API_KEY
pnpm install
pnpm --filter @heurion2/platform build   # 构建编辑器页面（dist-web/）
pnpm --filter @heurion2/platform dev     # http://127.0.0.1:8787（页面 + REST + /collab + /mcp）
```

改前端时用 `pnpm --filter @heurion2/platform dev:web`（http://127.0.0.1:5173，热更新，代理到 8787）。

容器：`scripts/container.sh build && scripts/container.sh up`。

## 结构

```
apps/platform/src
  model/     schema、块 id、markdown 方言、评论锚点、Documents（Yjs）
  ops/       操作层：校验 → 写前守卫 → 原子应用
  mcp/       MCP 工具面（dsh 调用）
  views/     读视图与渲染
  convert/   docx 导入 / 修补式导出
  turns/     AI 回合
  harness/   dsh 进程池与 profile
  collab/    协同网关（WebSocket + y-protocols）与人类编辑的事后检查
  http/      REST + SSE
apps/platform/web   编辑器页面（ProseMirror + y-prosemirror，schema 与服务端共用）
docs/        架构与决策记录
```

## 检查

```sh
pnpm --filter @heurion2/platform typecheck
pnpm --filter @heurion2/platform test
pnpm --filter @heurion2/platform e2e   # 需要 server 在运行与 DEEPSEEK_API_KEY；真实 dsh 回合
pnpm --filter @heurion2/platform ui    # 编辑器浏览器测试（首次：npx playwright install chromium）
```
