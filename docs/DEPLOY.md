# Heurion 2.0 部署

2.0 用容器部署在 1.0 所在的同一台 VPS 上，替换 1.0（2026-10-02 定）。代码推到 `0xaicrypto/heurion` 的 `v2` 分支，GitHub Actions 构建镜像（GHCR）、通过 SSH 部署，复用 1.0 仓库的 secrets 与 `production` environment。

## 组成

| 容器 | 镜像 | 说明 |
|---|---|---|
| `heurion2` | `ghcr.io/0xaicrypto/heurion2:<sha>`（根目录 `Dockerfile`） | 平台：页面、REST / SSE、协同 WebSocket、MCP、每用户 dsh 子进程、LibreOffice 渲染、OCR。数据卷 `heurion2_data` → `/app/data` |
| `heurion2-embedder` | `ghcr.io/0xaicrypto/heurion2-embedder:<sha>`（`apps/embedder/Dockerfile`） | 本地 bge-m3 嵌入服务，模型构建时打进镜像；只在内部网络可达 |
| `heurion2-caddy` | `caddy:2.8-alpine` | 反向代理 + 自动 HTTPS，唯一暴露 80/443；`/mcp` 不对外 |

**AI 代码隔离**：平台容器以 root 启动，入口（`deploy/entrypoint.sh`）整理数据目录权限后降到 `node` 运行平台。每个平台用户的 dsh 进程及其执行的代码经 `sudo` + `deploy/sandbox/heurion-sandbox-exec` 降到该用户专属的 uid（20000 起，见 `sandbox_uids` 表）：只能进自己的工作区，读不到数据库、其他用户的工作区和平台进程的环境；环境只有白名单变量；进程数与文件大小受限。模型调用经平台代理（`/llm/v1`），真实 DeepSeek key 不进 dsh。部署后 `deploy/sandbox/probe.sh` 自检。出站网络尚未限制（M2）。

VPS 上的目录 `/opt/heurion2`：`docker-compose.yml`、`Caddyfile`、`.env.production`（0600）、`scripts/`、`backups/`（0700）、`.cutover-done`。

## 流程

1. push `v2` 分支 → `deploy-v2.yml`：类型检查与测试 → 构建两个镜像推 GHCR → 生成 `.env.production`、拷部署文件 → `scripts/deploy.sh` → 冒烟（`/healthz`、首页、`/mcp` 404）→ 清 Cloudflare 缓存。
2. `deploy.sh`：拉镜像 →（第一次）切换 → `compose up` → 等 `https://heurion.org/healthz` → 装 S3 备份定时任务。失败自动回滚：切换那次恢复 1.0，之后回滚到上一个 2.0 镜像。
3. **切换**（`cutover-v1.sh`，第一次部署自动执行，可重复）：**2026-10-03 决定放弃 1.0 的全部数据（含账户），2.0 从零开始**。切换只记下 1.0 在用的镜像，停掉 1.0 整套 compose 与监控栈、去掉 1.0 的备份定时任务。**1.0 的卷与 `/opt/heurion` 保留**：切换、启动 2.0、健康检查任一步失败都自动按原镜像恢复 1.0。
4. **清理 1.0**（`cleanup-v1.yml`，手动，输入 `DELETE-V1`）：确认已切换且 2.0 健康后，删除 1.0 的容器、卷、镜像、`/opt/heurion` 与之前留下的备份，停掉执行面 worker VPS。**不可恢复**。

> 2026-10-03 第一次切换失败（生产 1.0 的 users 表是旧结构，导入账户报错，切换中断后没有恢复 1.0，站点 502）：之后改为不导入、任何失败都恢复 1.0。

## Secrets（`0xaicrypto/heurion` 仓库）

| Secret | 用途 | 现状 |
|---|---|---|
| `VPS_HOST` / `VPS_USER` / `VPS_SSH_KEY` | SSH 部署 | 1.0 已有 |
| `HEURION2_SECRET` | 2.0 令牌签名（`openssl rand -hex 32`）；没设时用 `SERVER_SECRET` | 建议新建 |
| `DEEPSEEK_API_KEY` | dsh 模型 | 1.0 已有（之前在对话里出现过的 key 需要先轮换） |
| `RESEND_API_KEY` | 验证码邮件 | 1.0 已有 |
| `NCBI_API_KEY` | PubMed 限流提升 | 1.0 已有 |
| `S3_ENDPOINT` / `S3_REGION` / `S3_BUCKET` / `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | 每日备份、切换前全量备份上传 | 1.0 worker 已有 |
| `CF_API_TOKEN` / `CF_ZONE_ID` | 部署后清 Cloudflare 缓存 | 1.0 已有 |
| `WORKER_VPS_HOST` / `WORKER_VPS_USER` / `WORKER_VPS_SSH_KEY` | 清理时停掉执行面 worker VPS | 1.0 已有 |

## 切换当天的检查单

- [ ] 轮换 DeepSeek key，更新 `DEEPSEEK_API_KEY`；新建 `HEURION2_SECRET`。
- [ ] 在 GitHub 上禁用 1.0 的 `Deploy Server` 与 `Deploy Worker`（它们在 push `main` 时自动部署，会把 1.0 拉起来抢 80/443、重启 worker VPS）：`gh workflow disable deploy-server.yml -R 0xaicrypto/heurion`、`gh workflow disable deploy-worker.yml -R 0xaicrypto/heurion`。
- [ ] VPS 资源：平台 4G + 嵌入 3G + Caddy 0.5G 内存上限；磁盘留出两个镜像（约 2.5G + 1.5G）与 1.0 全量备份的空间（`vps-disk-diagnose` 先看一眼）。
- [ ] push `v2`，看 Actions 日志里的切换输出（备份大小、导入账户数）。
- [ ] 上线验证：注册新账户、新建文档、对话、导出、资料库上传、找回密码邮件。
- [ ] 观察一段时间后运行 `cleanup-v1`。

## 运维

- **告警**：平台内部——模型服务认证失败 / 余额不足立即、15 分钟内 5 个回合失败时，发邮件给绑定了邮箱的管理员（同类一小时一封，`src/ops-alert/alerts.ts`）。外部——`deploy/github-main/uptime.yml` 每 10 分钟探测 heurion.org，连续失败开 issue、恢复后关闭；它必须放在仓库默认分支 main 的 `.github/workflows/` 下才会定时运行。

- 日志：`docker logs -f heurion2`（json-file 轮转，单容器最多约 250MB）。
- 手动部署 / 回滚到某个版本：`cd /opt/heurion2 && HEURION2_IMAGE=ghcr.io/0xaicrypto/heurion2:<sha> EMBEDDER_IMAGE=ghcr.io/0xaicrypto/heurion2-embedder:<sha> bash scripts/deploy.sh`。
- 备份：每天 02:20 数据库在线快照（`node:sqlite` backup，`heurion2/db/` 保留 30 份），每周日 03:20 用户工作区（`heurion2/workspaces/` 保留 8 份）；状态在 `/opt/heurion2/backup-status.json`。
- 本地验证容器：`scripts/container.sh build && scripts/container.sh up`（单容器、开发用）。
