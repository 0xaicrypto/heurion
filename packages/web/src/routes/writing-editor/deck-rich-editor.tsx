import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Check, Loader2, Presentation } from 'lucide-react';
import { PowerPointViewer } from 'pptx-react-viewer';
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

type SavePhase = 'idle' | 'saving';

export function DeckRichEditor(input: {
  docId: string;
  /** 返回卡片流（保存语义由本组件内聚：显式保存成功后才 close）。 */
  onClose: () => void;
  /** 路由统一轻提示通道（与 showNotice 同签名）。 */
  onNotice?: (text: string, ttlMs?: number) => void;
}) {
  const { docId, onClose, onNotice } = input;
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
  }, []);

  // viewer 样式 <style> 注入（?raw 预构建 css；卸载即撤，反复进出富编辑幂等）。
  useEffect(() => {
    const style = document.createElement('style');
    style.dataset.pptxViewerStyles = 'true';
    style.textContent = pptxViewerCssRaw;
    document.head.appendChild(style);
    return () => style.remove();
  }, []);

  /** 保存当前字节（baseVersion 乐观锁）。成功 = 版本戳前移 + dirty 清零。 */
  const save = useCallback(async (): Promise<boolean> => {
    const bytes = bytesRef.current;
    if (!bytes) return false;
    setPhase('saving');
    try {
      const res = await api.putDeckArtifact(docId, bytes, lastVersionRef.current);
      lastVersionRef.current = res.version;
      dirtyRef.current = false;
      setDirty(false);
      return true;
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        // 设计 §6: 工件版本戳已变（其他窗口/AI 已写）— 明示重试，不静默覆盖。
        onNotice?.(t('writing.deckRichEditConflict', 'deck 工件已被其他窗口修改，请重试'), 6000);
      } else {
        onNotice?.(t('writing.deckRichEditSaveFail', 'deck 保存失败，请重试'), 6000);
      }
      return false;
    } finally {
      setPhase('idle');
    }
  }, [docId, onNotice, t]);

  const handleContentChange = useCallback((next: Uint8Array) => {
    bytesRef.current = next;
    dirtyRef.current = true;
    setDirty(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    // 与编辑器 autosave 同节奏（2.5s debounce，见 #705 先例）。
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      if (!dirtyRef.current) return;
      void save();
    }, 2500);
  }, [save]);

  /** 「保存并返回卡片流」— 冲刷挂起的 debounce 编辑，保存成功才关闭。 */
  const handleSaveAndBack = useCallback(() => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    if (!dirtyRef.current) { onClose(); return; }
    void (async () => {
      const ok = await save();
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
