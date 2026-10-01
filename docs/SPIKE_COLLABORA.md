# Spike：编辑面选型 — Collabora Online（#4）

**Status:** 结论：**采纳 Collabora CODE 作为 doc 与 deck 的统一编辑面（S4）**；TipTap + XML 补丁器降级为备选。
**验证日期:** 2026-10-01
**验证环境:** macOS arm64 + podman（libkrun VM）+ `collabora/code:latest`（CODE 26.04.4.2）

---

## 1. 许可结论（生产前必须知道的事）

| 项 | 结论 |
|---|---|
| 源码 | MPL-2.0（[官方许可页](https://www.collaboraonline.com/terms/collabora-online-mplv2/)） |
| 官方二进制（`collabora/code` 镜像） | **附专有条件分发**；商标与 CSS 主题归 Collabora 专有 |
| CODE 定位 | 官方明确「仅测试/家用/小团队，**不建议生产**」——本意是逼企业用户订阅或自建 |
| 生产路径 | ① 买 Collabora Online（COOL）订阅；② 从 MPLv2 源码自建、去 Collabora 商标、自行维护 |
| 本项目 POC | ✅ 本地开发/评测用 CODE 二进制完全合规（这正是它的定位） |
| 上线闸（M2 前） | 需拍板：自建构建（工程 + 长期维护）vs 订阅（成本）——不阻塞 S4/S5 |

## 2. 集成面：最小 WOPI host（已实现并验证）

协议面只实现 CODE 依赖的三个入口（`apps/server/src/routes/wopi.ts`，~150 行）：

| 入口 | 实现 | 验证 |
|---|---|---|
| CheckFileInfo `GET /wopi/files/:docId` | BaseFileName/Size/UserCanWrite/LastModifiedTime/OwnerId/UserId + `UserCanNotWriteRelative` | ✅ 宿主与 podman 网络内（alpine 侧车）双端 200 |
| GetFile `GET .../contents` | head 版本字节直出 | ✅ 4314 字节往返 |
| PutFile `POST .../contents` | **用户保存 = 落 `user` 版本**（与 AI 落版同一条投影/漂移审计管线） | ✅ 200 + 新时间戳回传 |

鉴权：`access_token` = 按文档签发的 HMAC 令牌（复用文献 MCP 的 signDocToken），token 内绑 docId、与路径参数双重校验。

iframe 嵌入：`GET /api/docs/:id/editor` 返回 `{urlsrc, access_token, wopisrc}`（discovery 按 MIME 匹配 docx/pptx 的 `name="edit"` action，缓存 1h）；前端 `EditorOverlay` 以 form POST 提交 access_token 进 iframe，监听 `close` 消息返回并刷新。

## 3. 版本守卫映射（本轮最有价值的发现）

CODE 原生的**外部变更检测**与我们 §4.3 的写后合并语义严丝合缝：

- CheckFileInfo 返回 `LastModifiedTime`（= head 版本时间）；
- PutFile 带 `X-COOL-WOPI-Timestamp`，与 head 不一致（编辑期间 AI 落了新版本/回滚）→ 返回 **409 `{COOLStatusCode: 1010}`**，CODE 会主动弹「覆盖我的版本 / 重新加载」询问 —— **用户优先**的冲突 UX 由编辑器原生承担；
- AI 回合进行中（busy）PutFile → 同样 409，回合窗口内天然互斥。

实测：旧时间戳 PutFile → 409 ✓；当前时间戳 → 200 ✓。

## 4. 为什么选 Collabora 而不是 TipTap + XML 补丁器

| 维度 | Collabora（CODE/COOL） | TipTap + XML 手术补丁器 |
|---|---|---|
| 保真 | LibreOffice 原生 OOXML 渲染/回写，最高 | 编辑器视图结构级保真；补丁器只保未触碰节点 |
| deck 编辑 | ✅ Impress 同一组件 | 需 pptx-react-viewer（license 待核）或 Konva 自研（多日） |
| 工程量 | WOPI host ~150 行 + 集成页 ~80 行，**已验证** | XML 补丁器 1–2k 行（表格最难），deck 另算 |
| 评论锚定 | 见 §5 开放项：文件内评论 → 同步进评论库 | 投影内选区直锚（S2 已建的面板可复用） |
| 基建重量 | CODE 容器 ~1GB 内存，多一个常驻组件 | 无 |
| 许可 | POC 免费；生产要决策（§1） | 无外部约束 |

结论：**保真 + doc/deck 双编辑 + 字级编辑三个硬需求，Collabora 以最小自研面全部满足**；XML 补丁器的 1–2k 行高风险自研被省掉。代价是运行时多一个容器与一个生产许可决策。

## 5. 开放项（S4/S5 范围）

1. **评论同步**：用户在 Collabora 里写的是文件内评论（docx `word/comments.xml`）。S4 需把文件内评论同步进评论表（锚点 = 所在段落的 `w14:paraId`），AI 回复写回线程即可（不回写 OOXML 评论，避免双源）。pptx 侧同理（Impress 评论）。
2. **frame_ancestors**：CODE 默认放行 `localhost:*`；生产（M2）需把集成域写进 coolwsd 配置。
3. **视觉验收**：iframe 内实际编辑/保存需浏览器手工确认（本 spike 以协议层验证为准）——浏览器打开 `http://localhost:8787` → 选中已有文档 → 「编辑器」按钮即可。
4. **容器同网部署**：`scripts/container.sh up` 已把两个容器放进同一网络（别名互连）；本地开发拓扑（宿主 server + 容器 CODE）用 `HEURION_PUBLIC_URL=http://host.containers.internal:8787`。

## 6. 复现步骤

```sh
./scripts/container.sh collabora            # 起 CODE（:9980）
pnpm --filter @heurion2/server dev          # 宿主起 server（:8787）
# 浏览器 http://localhost:5173 → 选文档 → 「编辑器」
# 协议级冒烟：
curl -s http://127.0.0.1:8787/api/docs/<docId>/editor -H 'Authorization: Bearer dev'
curl -s "http://127.0.0.1:8787/wopi/files/<docId>?access_token=<token>"
```
