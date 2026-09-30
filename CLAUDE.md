# Heurion 2.0 — 协作约定

- 通用智能体能力（对话循环、工具执行、LLM 调用、子代理、压缩、office 读写）一律交给 dsh，不在本仓库重复实现。只有 dsh 确实做不到的，才自己写，并在 docs/DESIGN.md 记录原因。
- dsh 依赖锁定精确版本；升级单独提交，并跑 `pnpm test` 和 `smoke`。
- `apps/server/src/harness/profile/heurion.cordis.yml` 是数据外发的边界：不得重新启用 `session-log-deepseek` 或 web 工具。
- 正式引用只能来自 `insert_citation`；改动引用流程必须同步更新 `literature/audit.ts` 的校验和对应测试。
- 注释和文档用中文，代码标识符用英文。
