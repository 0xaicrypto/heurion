// #1055 locale 完整性防回归：扫描 src 下全部 t() 调用的 key，断言 zh-CN/en 词条均已录入；
// 另补一条 en 环境渲染断言（冲突横幅显示英文而非回落中文默认值）。
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

// 匹配 t( 后的第一个字符串字面量（容忍换行与模板串）
const T_CALL_RE = /\bt\(\s*(['"`])((?:(?!\1)[\s\S])*?)\1/g;

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

// 动态 key 豁免清单：运行时拼接的 key（对应的字面量 key 已全部录入 locales）。
// 新增动态 key 时需在此登记，防止清单腐化（见下方新鲜度断言）。
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

describe('#1055 locale 完整性扫描', () => {
  const rawKeys = extractRawKeys();
  const staticKeys = rawKeys.filter((k) => !isDynamicKey(k));
  const dynamicKeys = rawKeys.filter(isDynamicKey);

  it('zh-CN 覆盖源码全部静态 t() key', () => {
    const missing = staticKeys.filter((k) => !zhKeys.has(k));
    expect(missing).toEqual([]);
  });

  it('en 覆盖源码全部静态 t() key', () => {
    const missing = staticKeys.filter((k) => !enKeys.has(k));
    expect(missing).toEqual([]);
  });

  it('动态 key 全部命中豁免清单，且豁免清单无过期条目', () => {
    const unmatched = dynamicKeys.filter((k) => !DYNAMIC_KEY_EXEMPTIONS.some((re) => re.test(k)));
    expect(unmatched).toEqual([]);
    // 新鲜度：每条豁免都必须仍能命中源码里的动态 key，否则应移除
    for (const re of DYNAMIC_KEY_EXEMPTIONS) {
      expect(dynamicKeys.some((k) => re.test(k)), `豁免规则 ${re} 已过期`).toBe(true);
    }
  });

  it('zh-CN 与 en 词条 key 完全对齐', () => {
    const zhOnly = [...zhKeys].filter((k) => !enKeys.has(k));
    const enOnly = [...enKeys].filter((k) => !zhKeys.has(k));
    expect({ zhOnly, enOnly }).toEqual({ zhOnly: [], enOnly: [] });
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
