#!/usr/bin/env node
/**
 * #947 — i18n key 存在性校验（CI 门禁）。
 * 扫描 web src 中 t('...') / t("...") / i18n.t('...') 调用，比对两份
 * locale JSON，输出缺失 key（报告式：存在缺失以非零码退出，可接 CI）。
 * 排除动态 key（模板串/变量），仅检查字符串字面量。
 */
import fs from 'fs'
import path from 'path'
import url from 'url'

const webSrc = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '../packages/web/src')
const locales = {
  zh: JSON.parse(fs.readFileSync(path.join(webSrc, 'i18n/locales/zh-CN.json'), 'utf8')),
  en: JSON.parse(fs.readFileSync(path.join(webSrc, 'i18n/locales/en.json'), 'utf8')),
}

function hasKey(obj, key) {
  return key.split('.').every((seg) => {
    if (obj && typeof obj === 'object' && seg in obj) {
      obj = obj[seg]
      return true
    }
    return false
  })
}

const T_RE = /\b(?:i18n\.)?\bt\(\s*(['"])((?:(?!\1)[^\\]|\\.)*)\1/g
const USE = process.argv.includes('--report')
const missing = { zh: new Set(), en: new Set() }
let total = 0

function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) { walk(p); continue }
    if (!/\.(tsx?|ts)$/.test(e.name)) continue
    const src = fs.readFileSync(p, 'utf8')
    for (const m of src.matchAll(T_RE)) {
      total++
      const key = m[2]
      if (!hasKey(locales.zh, key)) missing.zh.add(key)
      if (!hasKey(locales.en, key)) missing.en.add(key)
    }
  }
}
walk(webSrc)

const zhMiss = [...missing.zh]
const enMiss = [...missing.en]
console.log(`t() 调用扫描：${total} 处；zh-CN 缺失 ${zhMiss.length}；en 缺失 ${enMiss.length}`)
if (USE && (zhMiss.length || enMiss.length)) {
  console.log('\n-- zh-CN 缺失 key --')
  for (const k of zhMiss) console.log('  ' + k)
  console.log('\n-- en 缺失 key --')
  for (const k of enMiss) console.log('  ' + k)
}
if (!USE) {
  // 校验模式：缺 key 即非零退出（CI 门禁）。
  if (zhMiss.length || enMiss.length) {
    console.log('FAIL: 存在缺失的 i18n key — 先补 locale JSON 再合入')
    process.exit(1)
  }
  console.log('OK: 全部 key 存在')
}
