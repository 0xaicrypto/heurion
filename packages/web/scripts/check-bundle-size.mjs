#!/usr/bin/env node
/**
 * #1145 — 入口包体积预算。静态 import 回潮会把 cytoscape/katex/tiptap 重新
 * 带进入口（审计时入口 3.1MB）；这里以 index.html 的 module script +
 * modulepreload 图（即首屏实际下载的静态图）为口径设预算，超限退出码 1。
 *
 * 用法: node scripts/check-bundle-size.mjs [distDir]
 * 预算: WEB_ENTRY_BUDGET_KB（默认 700，原始字节）。
 */
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';

const distDir = process.argv[2] ?? 'dist';
const budgetKb = Number(process.env.WEB_ENTRY_BUDGET_KB ?? 700);

let html;
try {
  html = readFileSync(join(distDir, 'index.html'), 'utf8');
} catch {
  console.error(`[bundle] ${distDir}/index.html not found — run \`pnpm build\` first`);
  process.exit(1);
}
const urls = [...html.matchAll(/<(?:script[^>]*src|link[^>]*href)="(\/assets\/[^"]+\.js)"/g)].map((m) => m[1]);
if (urls.length === 0) {
  console.error('[bundle] no entry JS in index.html — unexpected build output');
  process.exit(1);
}

let raw = 0;
let gzip = 0;
for (const url of urls) {
  const buf = readFileSync(join(distDir, url.replace(/^\//, '')));
  raw += buf.length;
  gzip += gzipSync(buf).length;
}
const rawKb = raw / 1024;
const gzipKb = gzip / 1024;
console.log(
  `[bundle] entry graph (${urls.length} chunk(s)): ${rawKb.toFixed(0)}KB raw / ${gzipKb.toFixed(0)}KB gzip — budget ${budgetKb}KB raw`,
);
if (rawKb > budgetKb) {
  console.error(`[bundle] entry graph exceeds budget: ${rawKb.toFixed(0)}KB > ${budgetKb}KB`);
  process.exit(1);
}
