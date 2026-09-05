#!/usr/bin/env bash
# #854 — 部署后冒烟探针:在 nexus-server 容器内用部署的 dist 代码打真实
# 外部文献源。背景:external-fetch URL 拼接 bug(生产 PubMed 全量 404 多日
# 未被发现)——单测全 mock fetch,永远校验不到最终 URL;健康检查只探
# /healthz,外部源坏了照样全绿。本探针补上这一层,由 CI 在部署成功后执行,
# 失败即部署失败(阻塞回滚感知)。
#
# 用法:VPS 上执行(或 CI ssh 远程执行)。
#   bash scripts/smoke-probe-production.sh
#
# env:
#   CONTAINER  目标容器名(默认 nexus-server)
#   ATTEMPTS   探针尝试次数(默认 2,间隔 5s — 缓解 NCBI/Crossref 瞬断
#              造成的假阳性;真回归两次都炸)

set -euo pipefail

CONTAINER="${CONTAINER:-nexus-server}"
ATTEMPTS="${ATTEMPTS:-2}"

probe() {
  docker exec --workdir /app "$CONTAINER" node --no-warnings -e '
import("./dist/tools/external-fetch.js").then(async (m) => {
  const fail = (msg) => { console.error("SMOKE FAIL: " + msg); process.exit(1); };
  // 探针 1 — eutils:#854 回归本体。URL 拼接必须产生
  // /entrez/eutils/esearch.fcgi(bug 版本:.../eutilsesearch.fcgi → 404)。
  try {
    const t = await m.externalRequest("eutils", "esearch.fcgi", {
      db: "pubmed", term: "FLASH radiotherapy", retmode: "json", retmax: "1",
    });
    const ids = JSON.parse(t)?.esearchresult?.idlist;
    if (!Array.isArray(ids) || ids.length === 0) fail("eutils esearch unexpected payload: " + String(t).slice(0, 120));
    console.log("OK eutils esearch.fcgi (idlist[0]=" + ids[0] + ")");
  } catch (e) { fail("eutils esearch: " + e.message); }
  // 探针 2 — crossref:带头斜杠调用风格 + 兜底通道健康。
  try {
    const u = await m.externalRequest("crossref", "/works", { query: "FLASH radiotherapy", rows: "1" });
    if (JSON.parse(u)?.status !== "ok") fail("crossref /works unexpected payload: " + String(u).slice(0, 120));
    console.log("OK crossref /works");
  } catch (e) { fail("crossref /works: " + e.message); }
  console.log("SMOKE PASS");
})'
}

for i in $(seq 1 "$ATTEMPTS"); do
  if probe; then
    exit 0
  fi
  echo "  smoke probe attempt $i/$ATTEMPTS failed, retrying in 5s..."
  sleep 5
done

echo "❌ Smoke probe failed after $ATTEMPTS attempts — deployed dist external-source path is broken (or sources unreachable)"
exit 1
