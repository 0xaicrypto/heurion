// #1055 locale 完整性防回归：扫描 src 下全部 t() 调用的 key，断言 zh-CN/en 词条均已录入；
// 另补一条 en 环境渲染断言（冲突横幅显示英文而非回落中文默认值）。
// #1065 缺陷修复：#1055 的 T_CALL_RE 要求 t() 首参为引号字面量，对 t(变量) 形态
// （t(item.labelKey) / t(PHASE_KEY[phase]) 等）完全失明 — 从双 locale 删除这类 key 照样全绿。
// 本次增强：识别标识符型 t() 调用点，同文件静态可分析的（局部常量对象/labelKey 映射）
// 提取其 key 并纳入 zh/en 覆盖断言；跨文件传参的登记到显式"标识符型动态源清单"，
// 断言其定义处 key 与 locale 对齐，且清单本身带新鲜度检查（与模板串型豁免清单分开断言）。
// 实现方式：import.meta.glob(?raw) 读源码 + 正则提取（支持多行调用），
// 不 import 任何业务组件，不依赖 node 内置模块（web 包未装 @types/node）。
import { beforeAll, describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { useTranslation } from 'react-i18next';
import { render } from '@/test/render';
import i18n from '@/i18n';
import en from './locales/en.json';
import zh from './locales/zh-CN.json';

// ---------- 源码扫描 ----------

// 以 raw 字符串形式内联 src 下全部 ts/tsx 源码（排除测试文件自身），避免 fs 依赖
const sources = import.meta.glob<{ default: string }>('../**/*.{ts,tsx}', { query: '?raw', eager: true });
const sourceFiles: Array<[string, string]> = Object.entries(sources)
  .filter(([path]) => !/\.test\.(ts|tsx)$/.test(path))
  .map(([path, mod]): [string, string] => [path, mod.default])
  .sort(([a], [b]) => a.localeCompare(b));

const sourceTexts = new Map(sourceFiles);

// 匹配 t( 后的第一个字符串字面量（容忍换行与模板串）
const T_CALL_RE = /\bt\(\s*(['"`])((?:(?!\1)[\s\S])*?)\1/g;

// #1065 匹配 t( 标识符形态首参：t(labelKey)、t(item.labelKey)、t(PHASE_KEY[sa.phase])，容忍后续参数
const T_IDENT_CALL_RE = /\bt\(\s*(?!['"`])([A-Za-z_$][\w$.[\]]*)\s*[,)]/g;

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** 源码中出现的全部 t() 首参原文（含动态模板串，去重） */
function extractRawKeys(): string[] {
  const keys = new Set<string>();
  for (const [, text] of sourceFiles) {
    const clean = stripComments(text);
    let m: RegExpExecArray | null;
    while ((m = T_CALL_RE.exec(clean))) {
      const key = m[2].trim();
      if (key) keys.add(key);
    }
  }
  return [...keys].sort();
}

/** 动态 key：模板串（含 ${...}），运行时才可解析 */
function isDynamicKey(key: string): boolean {
  return key.includes('${');
}

// ---------- 标识符型 t() 调用扫描（#1065） ----------

type IdentifierSite = { file: string; arg: string };

/** 全部标识符形态 t() 调用点（按 文件+首参原文 去重） */
function extractIdentifierSites(): IdentifierSite[] {
  const sites = new Map<string, IdentifierSite>();
  for (const [path, text] of sourceFiles) {
    const clean = stripComments(text);
    let m: RegExpExecArray | null;
    while ((m = T_IDENT_CALL_RE.exec(clean))) {
      const arg = m[1].trim();
      if (!arg) continue;
      const k = `${path} :: ${arg}`;
      if (!sites.has(k)) sites.set(k, { file: path, arg });
    }
  }
  return [...sites.values()].sort((a, b) => `${a.file}::${a.arg}`.localeCompare(`${b.file}::${b.arg}`));
}

/** i18n key 形态：至少含一个点（排除 key: 'summaries'、'__global__' 等非词条字段值） */
const I18N_KEY_SHAPE = /^[A-Za-z_$][\w$]*(?:\.[\w$-]+)+$/;

/** 同文件里字段名为 token 的字符串字面量值中，形如 i18n key 的（labelKey: 'nav.today'） */
function fieldStringValues(text: string, token: string): string[] {
  const out = new Set<string>();
  const re = new RegExp(`\\b${token}\\s*:\\s*(['"])([^'"\n]+)\\1`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const v = m[2].trim();
    if (I18N_KEY_SHAPE.test(v)) out.add(v);
  }
  return [...out];
}

/** 同文件里 `const NAME ... = { ... }` 对象体内，形如 i18n key 的字符串字面量值（PHASE_KEY[X] 形态） */
function constObjectStringValues(text: string, name: string): string[] {
  // 要求 `= {` 直连（`[^;{]*` 不越过 ; 或 {）：排除 const key = X[kind]; 等非对象声明，
  // 也排除 Array<{...}> 标注（数组形态由 fieldStringValues 按字段名覆盖）
  const decl = new RegExp(`\\bconst\\s+${name}\\b[^;{]*=\\s*\\{`).exec(text);
  if (!decl) return [];
  const open = decl.index + decl[0].length - 1;
  const literals: string[] = [];
  for (let i = open, depth = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "'" || ch === '"') {
      // 跳过字符串字面量（其内部的 {} 不参与配对），记录对象体内的值
      let lit = ch;
      for (i++; i < text.length && text[i] !== ch; i++) lit += text[i];
      lit += ch;
      if (depth > 0 && I18N_KEY_SHAPE.test(lit.slice(1, -1).trim())) literals.push(lit.slice(1, -1).trim());
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) break;
    }
  }
  return [...new Set(literals)];
}

/** 局部别名：const key = KIND_LABEL_KEYS[kind] → 调用点 t(key) 实际走 KIND_LABEL_KEYS */
function localAliasTargets(text: string, token: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`\\bconst\\s+${token}\\s*=\\s*([A-Za-z_$][\\w$]*)\\[`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push(m[1]);
  return out;
}

/** t() 首参里的标识符集合（PHASE_KEY[sa.phase] → PHASE_KEY/sa/phase） */
function argTokens(arg: string): string[] {
  return [...new Set(arg.replace(/[[\]]/g, '.').split('.').filter((t) => /^[A-Za-z_$][\w$]*$/.test(t)))];
}

/** 单个调用点的同文件静态解析结果：解析不出任何 key → 跨文件传参，需登记动态源清单 */
function resolveSiteKeys(file: string, arg: string): string[] {
  const text = sourceTexts.get(file);
  if (!text) return [];
  const tokens = argTokens(arg);
  const keys = new Set<string>();
  const constNames = new Set([...tokens, ...tokens.flatMap((t) => localAliasTargets(text, t))]);
  for (const c of constNames) for (const k of constObjectStringValues(text, c)) keys.add(k);
  for (const t of tokens) for (const k of fieldStringValues(text, t)) keys.add(k);
  return [...keys].sort();
}

// 标识符型动态源清单：t(标识符) 调用点的 key 定义在别的文件（跨文件传参），
// 同文件静态分析不可达，在此登记。断言保证 (a) 清单无过期条目 (b) 定义处 key 与 locale 对齐。
const IDENTIFIER_DYNAMIC_SOURCES: Array<{
  file: RegExp;
  arg: string;
  defFile: RegExp;
  defProp: string;
  reason: string;
}> = [
  {
    // research-detail.tsx:275 t(labelKey) — TABS 定义于 ./research-detail/types.ts 跨文件传入
    file: /routes\/research-detail\.tsx$/,
    arg: 'labelKey',
    defFile: /routes\/research-detail\/types\.ts$/,
    defProp: 'labelKey',
    reason: 'research-detail 页签 labelKey 在 routes/research-detail/types.ts 的 TABS 定义',
  },
];

function manifestEntryKeys(defFile: RegExp, defProp: string): string[] {
  const defText = sourceFiles.find(([p]) => defFile.test(p))?.[1];
  return defText ? fieldStringValues(defText, defProp) : [];
}

// 动态 key 豁免清单（模板串型）：运行时拼接的 key（对应的字面量 key 已全部录入 locales）。
// 新增动态 key 时需在此登记，防止清单腐化（见下方新鲜度断言）。
// 注意：标识符型动态面不走这里，走 IDENTIFIER_DYNAMIC_SOURCES（两类分开断言，见 #1065）。
const DYNAMIC_KEY_EXEMPTIONS: RegExp[] = [
  /^chat\.tool\.\$\{/, // ActivityTimeline：工具名动态映射（chat.tool.* 字面量均已录入）
  /^writing\.\$\{/, // selection-bubble：气泡按钮 labelKey 动态映射（writing.bubble* 字面量均已录入）
  /^chat\.deepTopic_\$\{/, // chat：深度分析主题动态后缀（chat.deepTopic_* 字面量均已录入）
];

// ---------- locale 工具 ----------

type LocaleTree = Record<string, unknown>;

function flattenLocale(tree: LocaleTree, prefix = '', out: Set<string> = new Set()): Set<string> {
  for (const [key, value] of Object.entries(tree)) {
    const full = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object') flattenLocale(value as LocaleTree, full, out);
    else out.add(full);
  }
  return out;
}

const zhKeys = flattenLocale(zh as LocaleTree);
const enKeys = flattenLocale(en as LocaleTree);

// ---------- 测试 ----------

// #1065：标识符型 t() 调用的静态可分析 key（同文件映射 + 跨文件清单定义处）
const identifierSites = extractIdentifierSites();
const siteResolutions = identifierSites.map((s) => ({ ...s, keys: resolveSiteKeys(s.file, s.arg) }));
const unresolvedSites = siteResolutions.filter((s) => s.keys.length === 0);
const identifierKeys = [
  ...new Set([
    ...siteResolutions.flatMap((s) => s.keys),
    ...IDENTIFIER_DYNAMIC_SOURCES.flatMap((e) => manifestEntryKeys(e.defFile, e.defProp)),
  ]),
].sort();

describe('#1055 locale 完整性扫描', () => {
  const rawKeys = extractRawKeys();
  const staticKeys = rawKeys.filter((k) => !isDynamicKey(k));
  const dynamicKeys = rawKeys.filter(isDynamicKey);

  it('zh-CN 覆盖源码全部静态 t() key（含标识符映射型）', () => {
    const missing = [...new Set([...staticKeys, ...identifierKeys])].filter((k) => !zhKeys.has(k));
    expect(missing).toEqual([]);
  });

  it('en 覆盖源码全部静态 t() key（含标识符映射型）', () => {
    const missing = [...new Set([...staticKeys, ...identifierKeys])].filter((k) => !enKeys.has(k));
    expect(missing).toEqual([]);
  });

  it('模板串型动态 key 全部命中豁免清单，且豁免清单无过期条目', () => {
    const unmatched = dynamicKeys.filter((k) => !DYNAMIC_KEY_EXEMPTIONS.some((re) => re.test(k)));
    expect(unmatched).toEqual([]);
    // 新鲜度：每条豁免都必须仍能命中源码里的模板串型动态 key，否则应移除
    for (const re of DYNAMIC_KEY_EXEMPTIONS) {
      expect(dynamicKeys.some((k) => re.test(k)), `豁免规则 ${re} 已过期`).toBe(true);
    }
  });

  it('标识符型动态源：未解析调用点全部登记，且清单无过期条目、定义处 key 仍存在', () => {
    // 无盲区：每个同文件解析不出 key 的标识符调用点都必须登记在清单里
    const unregistered = unresolvedSites.filter(
      (s) => !IDENTIFIER_DYNAMIC_SOURCES.some((e) => e.file.test(s.file) && e.arg === s.arg),
    );
    expect(unregistered).toEqual([]);
    // 新鲜度：每条登记都必须仍命中至少一个未解析调用点，否则应移除
    for (const entry of IDENTIFIER_DYNAMIC_SOURCES) {
      const live = unresolvedSites.some((s) => entry.file.test(s.file) && s.arg === entry.arg);
      expect(live, `标识符型动态源登记已过期: ${entry.reason}`).toBe(true);
      // 定义处 key 与 locale 对齐的前提：定义文件里仍能提取到该字段名的 key
      expect(
        manifestEntryKeys(entry.defFile, entry.defProp).length,
        `动态源定义处提取不到 key: ${entry.reason}`,
      ).toBeGreaterThan(0);
    }
  });

  it('zh-CN 与 en 词条 key 完全对齐', () => {
    const zhOnly = [...zhKeys].filter((k) => !enKeys.has(k));
    const enOnly = [...enKeys].filter((k) => !zhKeys.has(k));
    expect({ zhOnly, enOnly }).toEqual({ zhOnly: [], enOnly: [] });
  });
});

// ---------- #1065 t(标识符) 动态面（缺陷锚定） ----------

// #1055 扫描对 t(变量) 失明的实证：下面这批 key 全部经 t(item.labelKey) /
// t(PHASE_KEY[phase]) 等标识符形态调用，旧 T_CALL_RE 首参必须为引号字面量 → 全部漏检，
// 从 zh-CN 与 en 同时删除任意一个时测试照样全绿（虚假信心，issue 用例 1）。
describe('#1065 t(标识符) 动态面扫描', () => {
  it('标识符形态调用点被全部识别', () => {
    expect(identifierSites.length).toBeGreaterThanOrEqual(10);
    const has = (file: string, arg: string) =>
      identifierSites.some((s) => s.file.endsWith(file) && s.arg === arg);
    // issue 点名的失明现场
    expect(has('components/layout/AppShell.tsx', 'item.labelKey')).toBe(true);
    expect(has('components/layout/AppShell.tsx', 'section.labelKey')).toBe(true);
    expect(has('routes/knowledge.tsx', 'labelKey')).toBe(true);
    expect(has('routes/research-detail.tsx', 'labelKey')).toBe(true);
    expect(has('components/marketing/MarketingShell.tsx', 'item.labelKey')).toBe(true);
    // 同形态的其他调用点（issue 未点名，一并纳入）
    expect(has('routes/knowledge.tsx', 'badge.key')).toBe(true);
    expect(has('components/ProposalCard.tsx', 'meta.titleKey')).toBe(true);
    expect(has('components/chat/ActivityTimeline.tsx', 'PHASE_KEY[sa.phase]')).toBe(true);
    expect(has('components/brain/IngestionInbox.tsx', 'KIND_LABEL_KEYS[type]')).toBe(true);
    expect(has('components/brain/IngestionInbox.tsx', 'key')).toBe(true);
  });

  it('同文件映射型 key 被提取并纳入断言（删除即红）', () => {
    for (const k of [
      'nav.today', // AppShell NAV_ITEMS
      'nav.sectionTools', // AppShell NAV_SECTIONS
      'knowledge.tabFiles', // knowledge TABS
      'kb.pipelineFailed', // knowledge PIPELINE_BADGE
      'marketing.navDocs', // MarketingShell docLinks
      'writing.proposal.methodsTitle', // ProposalCard SOURCE_META
      'chat.subagentPhaseSummarizing', // ActivityTimeline PHASE_KEY
      'brain.kindCompaction', // IngestionInbox KIND_LABEL_KEYS（经局部别名 t(key)）
    ]) {
      expect(identifierKeys).toContain(k);
    }
  });

  it('跨文件动态源定义处 key 被提取并纳入断言（research-detail TABS）', () => {
    for (const k of ['research.tabOverview', 'research.tabProtocol']) {
      expect(identifierKeys).toContain(k);
    }
  });
});

// ---------- en 环境渲染断言 ----------

// 与 routes/writing-editor.tsx 冲突横幅同一调用形态（key + 中文 defaultValue）
const CONFLICT_BANNER_KEY = 'writing.deckConflictBanner';
const CONFLICT_BANNER_DEFAULT = '画布冲突 — AI 已更新服务端画布，本地有未保存的画布编辑，请选择保留哪个版本';

function ConflictBannerProbe() {
  const { t } = useTranslation();
  return <div>{t(CONFLICT_BANNER_KEY, CONFLICT_BANNER_DEFAULT)}</div>;
}

describe('#1055 en 环境渲染新 UI 文案', () => {
  beforeAll(async () => {
    await i18n.changeLanguage('en');
  });

  it('冲突横幅渲染英文词条而非回落中文默认值', () => {
    render(<ConflictBannerProbe />);
    const banner = screen.getByText(/Canvas conflict/);
    expect(banner).toBeInTheDocument();
    expect(banner.textContent).not.toContain('画布冲突');
  });
});
