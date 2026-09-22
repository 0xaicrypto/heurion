import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Check, Loader2, Presentation } from 'lucide-react';
import { PowerPointViewer } from 'pptx-react-viewer';
import type { ThemeCatalogEntry } from 'pptx-react-viewer';
// viewer 预构建样式（tailwind v4 产物,自带 --pptx-* 主题 token）。以 ?raw 注入
// <style> — 必须绕过本仓 postcss 管线（tailwind v3 会把 viewer 的 @layer base
// 判为缺少 @tailwind 指令而构建失败；?url 在 vite 6 仍走 css transform）。
// 仅富编辑 chunk 承载,不进主 bundle。
import pptxViewerCssRaw from 'pptx-react-viewer/styles.css?raw';
import { Button } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import i18n from '@/i18n';

/**
 * #1101 富编辑 — pptx 字节单一标准的人类编辑面（设计文档 §1/§6/§7）。
 * 字节真相源 = 服务端 deck-artifact 工件：挂载时 GET 元数据 → fetch tokenized
 * download_url 拉原始 pptx 字节 → <PowerPointViewer canEdit> 挂载（spike
 * #1102 GO 结论：React 18 直接挂载可用）；编辑回写 = PUT 原始字节 +
 * 'X-Deck-Base' 版本乐观锁，409 = 并发写冲突（提示重试，绝不静默覆盖）。
 * 自动保存与编辑器 autosave 同节奏（2.5s debounce）。
 * 卡片流（deck-view）v1 仍保留卡片编辑能力，待 AI edit_deck_bytes 验证后退役。
 */

/** 点分扁平词典 → 嵌套对象（i18next 默认 keySeparator '.' 查找形态）。 */
function flatToNested(flat: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(flat)) {
    const segs = key.split('.');
    let node = out;
    for (let i = 0; i < segs.length - 1; i++) {
      const seg = segs[i];
      if (typeof node[seg] !== 'object' || node[seg] === null) node[seg] = {};
      node = node[seg] as Record<string, unknown>;
    }
    node[segs[segs.length - 1]] = value;
  }
  return out;
}

// viewer 自带 chrome 的 pptx.* 词条随包分发（zh-CN/en 扁平词典）— 注册进宿主
// i18n 的 translation 命名空间（与 app 词条共存；幂等，只在首个富编辑会话注册）。
let viewerLocalesRegistered = false;
async function registerViewerLocales(): Promise<void> {
  if (viewerLocalesRegistered) return;
  viewerLocalesRegistered = true;
  try {
    const [{ translationsZhCN }, { translationsEn }] = await Promise.all([
      import('pptx-react-viewer/i18n/zh-CN'),
      import('pptx-react-viewer/i18n'),
    ]);
    i18n.addResourceBundle('zh-CN', 'translation', flatToNested(translationsZhCN), true, true);
    i18n.addResourceBundle('en', 'translation', flatToNested(translationsEn), true, true);
  } catch {
    // 词典缺席降级：viewer 标签回落 key 原文（spike 验证可正常渲染）。
  }
}

/* ── #theme-alignment: --pptx-* → DESIGN_SYSTEM_v2 token 映射 ─────────────────
 * viewer 的 chrome 由 shadcn 语义 token（--pptx-background/card/primary/…）
 * 驱动：其样式表在 :root 声明 `--color-*: var(--pptx-*, 库默认暗色)` 间接层。
 * 自定义属性在「声明元素」上求值 — 间接层落在 :root,因此映射必须声明在
 * html 作用域（而非编辑器容器）才能改写 :root 的解析结果。宿主样式表随
 * 组件挂载注入/卸载摘除（下方 effect）,生命周期即作用域；暗色沿用本仓
 * darkMode:'class' 的 html.dark（stores/theme.ts）。
 *
 * Light 直取 docs/DESIGN_SYSTEM_v2.md §2 调色板；Dark 文档未定义（v2 为
 * light-first,§13 open question）,按 v2 ink/warm 系推导:Surface/Ink
 * #1A1A1A 作主底,accent 沿 Apothecary Green 色相提亮（#2F4F47 L24%→#73A69A
 * L55%）保证暗底对比,Error 同法提亮（#9A3232→#C34646）。radius 取
 * --pptx-radius: 12px 使派生 md=10 命中 v2 Radius/Md（派生规则 ±4/±2）。
 * 幻灯片纸面不受影响 — 页内颜色由 pptx 自带主题渲染,这里只对齐 chrome。 */
const pptxThemeCss = `
html {
  --pptx-background: #FAF7F2;          /* Surface/Paper */
  --pptx-foreground: #15130F;         /* Text/Primary */
  --pptx-card: #FFFFFF;               /* Surface/Card */
  --pptx-card-foreground: #15130F;    /* Text/Primary */
  --pptx-popover: #FFFFFF;            /* Surface/Card */
  --pptx-popover-foreground: #15130F; /* Text/Primary */
  --pptx-primary: #2F4F47;            /* Accent — Apothecary Green */
  --pptx-primary-foreground: #FAF7F2; /* Text/OnInk */
  --pptx-secondary: #F4EFE7;          /* Surface/Raised */
  --pptx-secondary-foreground: #15130F;
  --pptx-muted: #F4EFE7;              /* Surface/Raised */
  --pptx-muted-foreground: #5C564B;   /* Text/Secondary */
  --pptx-accent: #E3EAE6;             /* Accent/Tint — hover/选中面 */
  --pptx-accent-foreground: #2F4F47;  /* Accent */
  --pptx-destructive: #9A3232;        /* Error */
  --pptx-destructive-foreground: #FAF7F2;
  --pptx-border: #E5DDD0;             /* Border/Hairline */
  --pptx-input: #E5DDD0;              /* Border/Hairline */
  --pptx-ring: #2F4F47;               /* Accent */
  --pptx-radius: 12px;                /* 派生 md=10 = v2 Radius/Md */
}
html.dark {
  --pptx-background: #1A1A1A;         /* Surface/Ink（非纯黑） */
  --pptx-foreground: #FAF7F2;         /* Text/OnInk */
  --pptx-card: #232323;               /* Ink + 1 档 */
  --pptx-card-foreground: #FAF7F2;
  --pptx-popover: #232323;
  --pptx-popover-foreground: #FAF7F2;
  --pptx-primary: #73A69A;            /* Apothecary Green 提亮 */
  --pptx-primary-foreground: #1A1A1A; /* Surface/Ink */
  --pptx-secondary: #2E2E2E;          /* Ink + 2 档 */
  --pptx-secondary-foreground: #FAF7F2;
  --pptx-muted: #2E2E2E;
  --pptx-muted-foreground: #928975;   /* Text/Tertiary */
  --pptx-accent: rgba(115, 166, 154, 0.16);          /* primary 16% tint 面 */
  --pptx-accent-foreground: #9EC3B8; /* primary 再提亮一档作文字 */
  --pptx-destructive: #C34646;        /* Error 提亮 */
  --pptx-destructive-foreground: #FAF7F2;
  --pptx-border: #3A3A3A;             /* Ink 系 hairline */
  --pptx-input: #3A3A3A;
  --pptx-ring: #73A69A;
  --pptx-radius: 12px;
}
`;

/* viewer File > Options > Appearance 的主题选择收口为单选项（= 跟随宿主
 * CSS 变量）。库默认 catalog（default/light/vermilion…）会经内联 --pptx-*
 * 压过宿主映射并把偏好写进 localStorage 与 .dark 脱节 — 单选项化后选择器
 * 仍可见但任何选择都解析回 theme:undefined（无内联变量,宿主映射生效）,
 * 历史遗留的 localStorage 主题键在单条 catalog 里 resolve 不中,同样回落
 * 宿主主题。 */
const VIEWER_THEME_CHOICES: ThemeCatalogEntry[] = [
  { key: 'default', labelKey: 'pptx.settings.theme.default', theme: undefined },
];

type SavePhase = 'idle' | 'saving';

export function DeckRichEditor(input: {
  docId: string;
  /** 返回卡片流（保存语义由本组件内聚：显式保存成功后才 close）。 */
  onClose: () => void;
  /** 路由统一轻提示通道（与 showNotice 同签名）。 */
  onNotice?: (text: string, ttlMs?: number) => void;
  /**
   * dirty 上报（父级 leave 保护数据源）：编辑检出 / 保存完成 / 冲突 /
   * 会话结束（卸载）每个状态转移都如实上报 — 页头返回键与 beforeunload
   * 的守护据此把画布内未保存编辑纳入确认门。
   */
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const { docId, onClose, onNotice, onDirtyChange } = input;
  const { t } = useTranslation();
  const [status, setStatus] = useState<'loading' | 'ready' | 'missing' | 'error'>('loading');
  const [content, setContent] = useState<Uint8Array | null>(null);
  const [dirty, setDirty] = useState(false);
  const [phase, setPhase] = useState<SavePhase>('idle');
  // 最新字节为非响应式 ref（viewer 回调高频；重渲染只驱动 dirty 徽标）。
  const bytesRef = useRef<Uint8Array | null>(null);
  const lastVersionRef = useRef<string | undefined>(undefined);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dirtyRef = useRef(false);
  // 保存代数（#review-fix debounce 竞态）：每次编辑 +1；保存发起时捕获代数,
  // 完成时代数不变才清 dirty — 飞行中的新编辑不会被迟到的清零吞掉。
  const generationRef = useRef(0);
  // 在飞保存互斥（防 debounce tick 与手动保存并发 PUT → 409 对撞）。
  const savingRef = useRef(false);
  // 回调走 latest-ref（repo 惯例,render 期赋值）— 父级传入的内联箭头
  // 不进 useCallback 依赖,报告路径零重渲染。
  const onDirtyChangeRef = useRef(onDirtyChange);
  onDirtyChangeRef.current = onDirtyChange;

  /** dirty 单点写入：ref + 徽标 state + 父级上报同步推进。 */
  const applyDirty = useCallback((next: boolean) => {
    dirtyRef.current = next;
    setDirty(next);
    onDirtyChangeRef.current?.(next);
  }, []);

  // 工件装载（懒加载承诺兑现：DeckRichEditor 仅在进入富编辑时挂载，
  // 文档常规加载不拉 60KB+ 字节）。404 = 尚无工件 — 由服务端迁移（§3.2）
  // 为存量 deck 补建，客户端不本地合成 pptx 字节。
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await registerViewerLocales();
      try {
        const artifact = await api.getDeckArtifact(docId);
        const r = await fetch(artifact.download_url);
        if (!r.ok) throw new ApiError(r.status, '', artifact.download_url);
        const bytes = new Uint8Array(await r.arrayBuffer());
        if (cancelled) return;
        lastVersionRef.current = artifact.version;
        bytesRef.current = bytes;
        setContent(bytes);
        setStatus('ready');
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 404) {
          onNotice?.(t('writing.deckRichEditNoArtifact', '该 deck 尚无 pptx 工件 — 让 AI 编排一次或手动导出后再进入富编辑'), 6000);
          setStatus('missing');
          return;
        }
        onNotice?.(t('writing.deckRichEditLoadFail', 'deck 工件加载失败，请返回卡片流后重试'), 6000);
        setStatus('error');
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- docId 装配期生命周期（t/onNotice 稳定）
  }, [docId]);

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    // 会话结束即撤守护 — 父级 leave 保护不再需要本组件的 dirty 信号
    // （丢弃路径 onClose 已同步复位,这里兜住路由级离开/切文档卸载）。
    onDirtyChangeRef.current?.(false);
  }, []);

  // viewer 样式 <style> 注入（?raw 预构建 css + 宿主 --pptx-* token 映射,
  // 同一样式表保证映射声明在 viewer 主题间接层之后；卸载即撤,反复进出
  // 富编辑幂等）。
  useEffect(() => {
    const style = document.createElement('style');
    style.dataset.pptxViewerStyles = 'true';
    style.textContent = `${pptxViewerCssRaw}\n${pptxThemeCss}`;
    document.head.appendChild(style);
    return () => style.remove();
  }, []);

  /** 保存当前字节（baseVersion 乐观锁）。成功且代数未前移 = 版本戳前移 +
   * dirty 清零；飞行中有新编辑则保持 dirty 并补一次延迟保存。 */
  const save = useCallback(async (): Promise<boolean> => {
    const bytes = bytesRef.current;
    if (!bytes) return false;
    // 字节快照在保存发起时捕获（非调度时）— debounce 到期后读 ref,拿到
    // 的必然是截至此刻的最新字节；飞行中的新编辑由代数守护交给下一拍。
    const generation = generationRef.current;
    savingRef.current = true;
    setPhase('saving');
    try {
      const res = await api.putDeckArtifact(docId, bytes, lastVersionRef.current);
      lastVersionRef.current = res.version;
      if (generationRef.current !== generation) {
        // 飞行中用户又编辑了 — dirty 保持（不迟到清零,UI 不谎报已同步）,
        // 无挂起 debounce 时补排一拍把最新字节送出。
        if (!timerRef.current) {
          timerRef.current = setTimeout(() => {
            timerRef.current = null;
            if (!dirtyRef.current || savingRef.current) return;
            void saveRef.current();
          }, 2500);
        }
        return false;
      }
      applyDirty(false);
      return true;
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        // 设计 §6: 工件版本戳已变（其他窗口/AI 已写）— 明示重试，不静默覆盖。
        applyDirty(true);
        onNotice?.(t('writing.deckRichEditConflict', 'deck 工件已被其他窗口修改，请重试'), 6000);
      } else {
        onNotice?.(t('writing.deckRichEditSaveFail', 'deck 保存失败，请重试'), 6000);
      }
      return false;
    } finally {
      savingRef.current = false;
      setPhase('idle');
    }
  }, [docId, onNotice, t, applyDirty]);
  // save 的自引用（竞态补拍）走 latest-ref,避免 useCallback 环形依赖。
  const saveRef = useRef(save);
  saveRef.current = save;

  const handleContentChange = useCallback((next: Uint8Array) => {
    bytesRef.current = next;
    generationRef.current += 1;
    applyDirty(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    // 与编辑器 autosave 同节奏（2.5s debounce，见 #705 先例）。
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      if (!dirtyRef.current || savingRef.current) return;
      void save();
    }, 2500);
  }, [save, applyDirty]);

  /** 「保存并返回卡片流」— 冲刷挂起的 debounce 编辑，保存成功才关闭。 */
  const handleSaveAndBack = useCallback(() => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    // 已有保存在飞（按钮禁用覆盖可见窗口,这里防 tick 间隙并发 PUT）。
    if (savingRef.current) return;
    if (!dirtyRef.current) { onClose(); return; }
    void (async () => {
      const ok = await save();
      // ok=false 含「飞行中有新编辑」— 编辑器保持打开,补拍已排程,
      // 用户可再次点击保存（届时发送最新代数字节）。
      if (ok) onClose();
    })();
  }, [save, onClose]);

  /** 「返回」— 有未保存编辑时确认放弃（对齐 leaveEditor 的 confirm 先例）。 */
  const handleBack = useCallback(() => {
    if (!dirtyRef.current) { onClose(); return; }
    const ok = window.confirm(t('writing.deckRichEditUnsaved', '有未保存的 deck 编辑，确定不保存直接返回吗？'));
    if (!ok) return;
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    onClose();
  }, [onClose, t]);

  return (
    <div data-testid="deck-rich-editor" className="flex h-full min-h-[70vh] w-full flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border bg-surface px-3 py-2">
        <Button size="sm" variant="ghost" data-testid="deck-rich-editor-close" onClick={handleBack}>
          <ArrowLeft size={14} className="mr-1" /> {t('writing.deckRichEditBack', '返回')}
        </Button>
        <Presentation size={15} className="text-accent" />
        <span className="text-sm font-medium text-text-primary">{t('writing.deckRichEditTitle', 'deck 富编辑（画布）')}</span>
        {dirty && <span className="text-xs text-warning">{t('writing.deckRichEditDirty', '● 未保存')}</span>}
        {phase === 'saving' && <span className="text-xs text-text-tertiary">{t('writing.deckRichEditSaving', '保存中…')}</span>}
        {!dirty && phase === 'idle' && status === 'ready' && (
          <span className="flex items-center gap-1 text-xs text-text-tertiary"><Check size={12} /> {t('writing.deckRichEditUpToDate', '已同步')}</span>
        )}
        <div className="ml-auto flex items-center gap-2">
          <Button
            size="sm"
            variant="secondary"
            data-testid="deck-rich-editor-save"
            disabled={phase === 'saving'}
            onClick={handleSaveAndBack}
          >
            {t('writing.deckRichEditSaveBack', '保存并返回卡片流')}
          </Button>
        </div>
      </div>
      <div className="min-h-0 flex-1 bg-surface-elevated">
        {status === 'ready' && content && (
          <PowerPointViewer
            content={content}
            canEdit
            onContentChange={handleContentChange}
            fileName="deck.pptx"
            // 主题收口：单选项 catalog + 显式 defaultThemeKey — 禁用 viewer
            // 自带主题切换对宿主主题的脱一致改写（见 VIEWER_THEME_CHOICES 注释）。
            defaultThemeKey="default"
            availableThemes={VIEWER_THEME_CHOICES}
          />
        )}
        {status === 'loading' && (
          <div className="flex h-full items-center justify-center">
            <Loader2 size={20} className="animate-spin text-text-tertiary" />
          </div>
        )}
        {status === 'missing' && (
          <div className="flex h-full items-center justify-center px-6">
            <p className="max-w-md text-center text-sm text-text-secondary">
              {t('writing.deckRichEditNoArtifact', '该 deck 尚无 pptx 工件 — 让 AI 编排一次或手动导出后再进入富编辑')}
            </p>
          </div>
        )}
        {status === 'error' && (
          <div className="flex h-full items-center justify-center px-6">
            <p className="max-w-md text-center text-sm text-text-secondary">
              {t('writing.deckRichEditLoadFail', 'deck 工件加载失败，请返回卡片流后重试')}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
