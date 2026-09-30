# Heurion 2.0

用 AI 编辑 Word/PPT 医学文档，内置医学文献检索与引用规范。AI 执行层基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) TypeScript SDK。

设计与决策：[docs/DESIGN.md](docs/DESIGN.md)

## 快速开始

需要 Node ≥ 24、pnpm。

```sh
cp .env.example .env        # 填 DEEPSEEK_API_KEY
pnpm install
pnpm --filter @heurion2/server dev   # http://127.0.0.1:8787
pnpm --filter @heurion2/web dev      # http://127.0.0.1:5173
```

## 结构

```
apps/server   Hono API + dsh 进程池 + 医疗文献 MCP（/mcp）+ SQLite
apps/web      React 前端：文档列表 / 对话 / 版本与回滚 / 引用
docs/         设计文档
```

## 检查

```sh
pnpm typecheck
pnpm test
pnpm --filter @heurion2/server smoke <docId>   # 需要 server 在运行；dsh 握手 +（有 key 时）一轮真实对话
```
