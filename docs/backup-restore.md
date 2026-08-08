# Heurion 备份与恢复手册

> 对应架构优化文档 §12.7.4（#345）。备份由 `scripts/backup-to-s3.sh` 每日/每周自动执行（cron 02:10 daily、03:10 weekly），状态写入 `/opt/heurion/backup-status.json`（#346）。

## 备份内容与保留

| 频率 | 内容 | S3 路径 | 保留 |
|---|---|---|---|
| 每日 | SQLite DB（一致性快照 + 完整性校验 + gzip） | `s3://BUCKET/db/nexus_server.db.gz` | 14 天 |
| 每日 | 用户记忆文件（event log / memory graph / facts / skills） | `s3://BUCKET/memory/files-<stamp>.tar.gz` | 14 天 |
| 每周 | 上传文件/缓存 | `s3://BUCKET/files/uploads-<stamp>.tar.gz` | 8 周 |

备份状态检查：

```bash
cat /opt/heurion/backup-status.json
# 期望 {"last_run":"...","status":"ok","message":"Backup complete (daily)"}
# status=skipped → S3 未配置；status=failed → 上次失败（见日志）
```

---

## 场景 A：DB 损坏 / 误删（RTO ~30 分钟）

1. 停止服务，避免写入：

```bash
ssh root@174.138.31.245
cd /opt/heurion
docker compose stop nexus-server
```

2. 拉取最新备份并校验：

```bash
LATEST=$(rclone lsf heurion-s3:BUCKET/db/ --format t 2>/dev/null | sort -r | head -1)
rclone copy "heurion-s3:BUCKET/db/$LATEST" /tmp/restore/
gunzip -f /tmp/restore/nexus_server.db.gz
sqlite3 /tmp/restore/nexus_server.db "PRAGMA integrity_check;"   # 必须返回 ok
```

> rclone 远程配置在 `~/.config/rclone/rclone.conf`（backup 脚本自动生成，含 S3 端点/密钥）。

3. 备份当前损坏库，挂载新库：

```bash
docker run --rm -v heurion_nexus-db-data:/db alpine sh -c 'cp /db/nexus_server.db /db/nexus_server.db.corrupt-$(date +%Y%m%d)'
docker cp /tmp/restore/nexus_server.db $(docker create --name tmp-restore -v heurion_nexus-db-data:/db alpine true):/db/nexus_server.db
docker rm tmp-restore
```

4. 重启并验证：

```bash
docker compose up -d nexus-server
curl -fsS https://heurion.org/healthz   # 期望 ok
```

---

## 场景 B：全盘丢失 / VPS 重建（RTO ~2 小时）

1. 重建 VPS（DigitalOcean 同规格），安全组放行 80/443/22。
2. 恢复代码与部署环境（从 GitHub）：

```bash
git clone https://github.com/0xaicrypto/heurion.git /opt/heurion
cd /opt/heurion
# 复制上次部署的 .env.production / docker-compose.yml / Caddyfile（如有保留）
```

> 完整重建路径：参考 `.github/workflows/deploy-server.yml` 的生产步骤（scp env → compose up）。
> 若 env 也丢失：从 GitHub Actions secrets 重建 `.env.production`（SERVER_SECRET 必须与旧值一致，否则登录态失效）。

3. 恢复数据卷（先建卷再灌数据）：

```bash
docker volume create heurion_nexus-db-data
docker volume create heurion_nexus-files-data
docker volume create heurion_nexus-data

# DB（最新每日备份）
rclone copy "heurion-s3:BUCKET/db/$(rclone lsf heurion-s3:BUCKET/db/ | sort -r | head -1)" /tmp/restore/
gunzip -f /tmp/restore/nexus_server.db.gz
docker run --rm -v heurion_nexus-db-data:/db alpine sh -c 'cat > /db/nexus_server.db' < /tmp/restore/nexus_server.db

# 记忆文件（最新每日）
rclone copy "heurion-s3:BUCKET/memory/$(rclone lsf heurion-s3:BUCKET/memory/ | sort -r | head -1)" /tmp/restore/
docker run --rm -v heurion_nexus-files-data:/data alpine sh -c 'tar xzf - -C /data' < /tmp/restore/files-*.tar.gz

# 上传文件（最新每周）
rclone copy "heurion-s3:BUCKET/files/$(rclone lsf heurion-s3:BUCKET/files/ | sort -r | head -1)" /tmp/restore/
docker run --rm -v heurion_nexus-data:/data alpine sh -c 'tar xzf - -C /data' < /tmp/restore/uploads-*.tar.gz
```

4. 启动并验证：

```bash
docker compose up -d
curl -fsS https://heurion.org/healthz && curl -fsS https://heurion.org/api/v1/memory/export -H "Authorization: Bearer <token>"
```

---

## 场景 C：用户文件误删（RTO ~15 分钟）

```bash
# 找对应周的 files 备份（每周 tar 内含 uploads/ 与 cache/）
rclone lsf heurion-s3:BUCKET/files/ | sort -r
rclone copy "heurion-s3:BUCKET/files/uploads-<stamp>.tar.gz" /tmp/restore/
docker run --rm -v heurion_nexus-data:/data alpine sh -c 'tar xzf - -C /data' < /tmp/restore/uploads-<stamp>.tar.gz
```

---

## 月度恢复演练

每月第一个周五执行（约 30 分钟），验证备份可用性：

1. **清单准备**：记录当前 `backup-status.json` 状态；确认 rclone 配置存在。
2. **临时环境恢复**（在 VPS 上新建临时卷，不触碰生产）：

```bash
docker volume create heurion_drill-db-data
docker run --rm -v heurion_drill-db-data:/db alpine sh -c 'cat > /db/nexus_server.db' < /tmp/restore/nexus_server.db
docker run --rm -v heurion_drill-db-data:/db alpine sqlite3 /db/nexus_server.db "PRAGMA integrity_check;"
```

3. **冒烟**：临时卷挂载 `docker run --rm -v heurion_drill-db-data:/db alpine ls -la /db` 确认非空；用 `docker compose -f docker-compose.drill.yml`（可选）启动只读实例验证 `/healthz` 与一条查询。
4. **清理**：`docker volume rm heurion_drill-db-data`。
5. **记录**：在 `backup-status.json` 旁写 `drill-<date>.log`（备份时间、校验结果、恢复耗时），异常时升级处理。

演练失败处理：立即停止，按场景 A/B 从**最新两份备份**中择一恢复（避免恢复坏备份）。
