# Desktop-v2 UI/UX Review（2026-07）

已修复项见 commit `6a51506`；其余为待办建议，按影响/成本排序。

## 已修复

1. **聊天复制功能**：此前四个聊天界面（Today 跨患者、问诊 Encounter、研究对话、跨研究对话）和代码块均无复制入口。现统一为共享 `CopyButton`：hover 浮现、复制原始 markdown、流式中隐藏、复制后 ✓ 反馈 1.5s、带 aria-label，base/rw 两种配色随界面自适应。
2. **`surface-1/2` token 未定义**：约 15 处下拉/浮层/诊断面板背景透明（身份切换下拉、会话下拉、boot 诊断卡等）。已在 tailwind config 补 alias。
3. **聊天自动滚动**：三个消息列表此前不跟随流式输出。新增 `useAutoScroll`（仅当用户已在底部附近时跟随）。

## 待办建议（Top 8）

| # | 建议 | 影响 | 成本 | 位置 |
|---|---|---|---|---|
| 1 | Composer 草稿与附件持久化：切换患者/模式即丢失正在输入的文字和已上传附件，临床场景高风险 | 高 | 中 | `modes.tsx:819,859,168` 本地 useState → 按 session 入 zustand |
| 2 | 统一浅色主题：`rw-*` 色板不随明暗切换，切浅色后侧边栏/Tab/研究台仍是深色，视觉割裂 | 高 | 中 | `index.css:46-73`、`layout.tsx:154,441` |
| 3 | 统一四个聊天界面的消息范式：Encounter 是"标签+时间戳无气泡"，Research 是"气泡无标签无时间戳"；输入框有单行 input / textarea、发送按钮 `↑`/`Send`/`发送` 三种、📎 按钮有的有有的没有；错误展示四种写法。建议抽 MessageBubble + ChatComposer 共享组件 | 高 | 高 | `modes.tsx` / `research-workspace.tsx` |
| 4 | Toast 改队列 + 语义化图标 + `aria-live`：现为单例互相覆盖，错误图标是 Plus 旋转 45° | 中 | 低 | `store.ts:659`、`overlays.tsx:538-571` |
| 5 | 研究台手写模态统一化：4 个裸 div 模态无 Esc/focus trap/`aria-modal`，另有 `alert()`/`window.prompt()` 与设计语言脱节 | 中 | 中 | `research-workspace.tsx:126,942,70,1076` |
| 6 | 长列表虚拟化：患者列表、聊天历史（一次 200 条）、roster 表全量渲染，规模化后卡顿 | 中 | 中 | `layout.tsx:180`、`modes.tsx:1352` |
| 7 | i18n 补齐：研究台 243 处硬编码中文（useT=0），患者外壳偏英文，切任一语言都是中英拼图 | 中 | 高 | `research-workspace.tsx`、`identity-picker.tsx` |
| 8 | 弱文字对比度：`--text-tertiary`(3.5:1)、`--rw-t4`(2.5:1) 低于 WCAG AA，且常叠加 10-11px 字号 | 中 | 低 | `index.css:32,58` |

## 做得好的（不要改）

设计 token 单点声明 + `ui.tsx` 8 原语（患者侧复用度高）；boot-gate sidecar 死机恢复与 401 回退路径完善；流式聊天状态跨 tab 持久化；破坏性操作（删患者/归档研究）确认弹窗文案解释后果到位；异步按钮防重复提交普遍做对。
