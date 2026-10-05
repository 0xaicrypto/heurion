# 知家「分享给医生」

家人在知家（个人空间）里把一位成员的档案分享给**某家医院的某个科室**，可再指定一位医生。医生在工作台「患者 → 家庭分享」里看到只读实时视图；家人允许时，医生可以一键「纳入本院」。实现：`src/tenancy/shares.ts`（ShareService）、`src/tenancy/patients.ts`（sharedView / sharedFile / sharedLog / importShared）、`src/auth/tenants.ts`（科室）。

## 1. 决定

| 问题 | 决定 |
| --- | --- |
| 分享给谁 | 选医院 → 科室（必选，科室里的医生都能看）→ 可选指定医生（指定后只有这位医生能看） |
| 医生看到什么 | 只读实时视图：数据不复制，每次按分享去读家人个人空间的库；撤销立即生效、到期自动失效 |
| 纳入病历 | 家人勾选「允许纳入」时，医生可一键复制成本院患者；纳入后归医院，家人撤销不影响已纳入部分 |
| 医生的 AI | 与医生本人一致（MCP share_*），只受本院「患者数据不发外部模型」约束；不给 AI「给医生看的姓名」 |

## 2. 数据（平台库）

```
tenant_departments (id, tenant_id, name, created_at)
department_members (department_id, user_id, added_at)        -- 一人可在多个科室
phr_shares (
  id, owner,                       -- 家人账号
  source_tenant_id, patient_id,    -- 家人的个人空间、成员（数据仍在个人空间的加密库里）
  tenant_id, department_id,        -- 目标医院、科室（必填）
  doctor_id,                       -- 可选指定医生
  scope,                           -- JSON {categories: labs|reports|docs, since: YYYY-MM-DD|null}
  allow_import,                    -- 是否允许纳入医院病历
  display_name_enc,                -- 给医生看的姓名（个人空间密钥加密；只给医生本人的界面）
  expires_at,                      -- 7 / 30 / 90 天，默认 30
  status, created_at, revoked_at,  -- active / revoked（过期、科室删除在读取时判断）
  imported_at, imported_by, imported_patient_id
)
```

机构设置新增 `accept_patient_shares`（默认 true）：关掉后知家目录里不再出现本院，已有分享也不再可见。纳入本院时 `records.origin` / `labs.origin` 记 `share:<分享 id>`；有报告原件的化验标来源 `share`，家人手工录入（没有原件）的仍标 `manual`、不进研究数据集。

## 3. 权限矩阵

| 谁 \ 做什么 | 看目录 | 新建 / 撤销分享 | 看分享（概况、化验、原件、简报） | 纳入本院 |
| --- | --- | --- | --- | --- |
| 家人（成员的诊疗组，个人空间） | ✓ | ✓（只自己的成员；撤销只自己的分享） | ✗（家人看自己的成员页） | ✗ |
| 别的家庭账号 | ✓ | ✗（404） | ✗ | ✗ |
| 目标科室的医生（未指定医生时） | — | — | ✓ | ✓（允许纳入时） |
| 被指定的医生 | — | — | ✓ | ✓（允许纳入时） |
| 同科室的其他医生（指定了医生时） | — | — | ✗（404） | ✗ |
| 同院别的科室、机构管理员（不在科室里） | — | — | ✗（404） | ✗ |
| 别的医院、平台运营 | — | — | ✗（404） | ✗ |
| 撤销后 / 过期后 / 科室删除后 | — | — | ✗（404） | ✗ |
| 医生的 AI | — | — | 与医生相同；本院不允许外部模型时拒绝；不含姓名 | 本院「AI 写入需确认」时拒绝（由医生点） |
| 家人的 AI | ✓ | 列出、撤销直接做；**新建分享 = 对外披露，生成确认卡** | — | — |

科室：机构管理员建 / 改名 / 删除、设置成员（只能是本机构的人）；成员只能看。经 AI 时删除科室与调整成员需用户确认（权限变更）。个人空间没有科室。

## 4. 访问记录

医生（或医生的 AI）每次查看概况、化验、报告原件、简报 / 档案、纳入本院，都写进**家人那边该成员的访问日志**：谁、`医院 · 科室`、做了什么、是不是 AI。知家成员页「分享」页签里列出「医生的查看记录」。

## 5. 接口与 MCP

| 接口 | MCP |
| --- | --- |
| `GET /api/phr/directory` | `phr_share.directory` |
| `GET /api/phr/:ptid/shares`、`POST /api/phr/:ptid/shares`、`DELETE /api/phr/shares/:shid` | `phr_share.list` / `create`（需确认）/ `revoke` |
| `GET /api/shares` | `share_list` |
| `GET /api/shares/:shid`、`GET /api/shares/:shid/docs/:id` | `share_read`（给 doc_id 时返回 Markdown） |
| `GET /api/shares/:shid/labs` | `share_labs` |
| `GET /api/shares/:shid/files/:pfid` | `share_file`（AI 读打码后的文字） |
| `POST /api/shares/:shid/import` | `share_import` |
| `GET/POST /api/tenant/departments`、`PATCH/DELETE /api/tenant/departments/:dpid`、`PUT …/members` | `tenant_admin.departments` / `create_department` / `rename_department` / `delete_department`（需确认）/ `set_department_members`（需确认） |

测试：`tests/phr-share.test.ts`（权限矩阵、范围、撤销 / 过期 / 科室删除、访问日志、纳入与来源、AI 约束），越权测试登记 `:shid` `:dpid` 与 `share_id` `department_id` `doctor_id` `user_ids`，对等测试映射全部新接口；`scripts/ui-accounts.ts` 走一遍完整流程。

## 6. 进展与以后

- **简报 / 档案里的图片（已实现 ✅ 2026-10-05）**：`GET /api/shares/:shid/assets/:aid`（`ShareService.asset`）。医生按分享授权安全读取简报与健康档案中引用的图片资产；严格校验仅能访问当前分享文档显式引用的资产（防水平越权泄露家人其他未分享图片）；访问记录自动沉淀至家人端审计日志。
- 医生给家人回话（就诊后的医嘱回传知家）、分享续期、分享给不在平台上的医生（一次性链接 + 验证码）。
- 纳入后的数据与知家的后续更新不同步（纳入是一次性的快照）；需要时可以再纳入一次（新分享）。
