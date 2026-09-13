import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, Download, Eye, FilePlus, FileText, History, MessageSquare, Presentation, ShieldAlert, Sparkles, X } from 'lucide-react';
import { Button, Input } from '@/components/ui';
import { OverflowMenu } from '@/components/ui/OverflowMenu';
import { ExportDonePanel, ReferenceListPopover } from './dialogs';
import type { DocChat } from './doc-chat';
import type { DocReferences } from './references';
import { cn } from '@/lib/utils';

/** #996/#1000/#1001: 工具栏收敛 — 原第二行（PHI/上传/导出×2/方法/注入/
 * 参考/Chat 六七个并列按钮）+ 页头 DOCX 常驻按钮，统一收成
 * 「Export ▾ + ··· 更多菜单」两个入口（设计稿桌面工作台口径）；
 * inject 弹层/参考弹层/导出完成面板逻辑保留。本组件渲染进页头（不再
 * 占独立一行）。 */
export function Toolbar(input: {
  chat: DocChat;
  references: DocReferences;
  phiScanning: boolean;
  onPhiScan: () => void;
  exporting: boolean;
  onExportDocx: () => void;
  onExportPdf: () => void;
  studyId: string;
  methodsLoading: boolean;
  methodsError: string | null;
  onGenerateMethods: () => void;
  injectOpen: boolean;
  setInjectOpen: React.Dispatch<React.SetStateAction<boolean>>;
  injectLabel: string;
  setInjectLabel: React.Dispatch<React.SetStateAction<string>>;
  injectResult: string;
  setInjectResult: React.Dispatch<React.SetStateAction<string>>;
  injecting: boolean;
  onInjectResults: () => void;
  onOpenKbPicker: () => void;
  setChatOpen: React.Dispatch<React.SetStateAction<boolean>>;
  chatOpen: boolean;
  /** #1000: 页头原 History/Preview 按钮收进 ··· 菜单。 */
  onToggleHistory: () => void;
  previewing: boolean;
  onTogglePreview: () => void;
  /** #1001: 移动端隐藏的 viewMode 控件经 ··· 可达。 */
  viewMode: 'document' | 'deck';
  onToggleViewMode: () => void;
  deckSlideCount: number;
  exportResult: { docx_path: string; size_bytes: number } | null;
  exportHistory: Array<{ format: 'docx' | 'pdf'; filename: string; size: number; at: number }>;
  exportPanelOpen: boolean;
  setExportPanelOpen: React.Dispatch<React.SetStateAction<boolean>>;
}) {
  const { t } = useTranslation();
  const { chat, references, phiScanning, onPhiScan, exporting, onExportDocx, onExportPdf, studyId, methodsLoading, methodsError, onGenerateMethods, injectOpen, setInjectOpen, injectLabel, setInjectLabel, injectResult, setInjectResult, injecting, onInjectResults, onOpenKbPicker, setChatOpen, chatOpen, onToggleHistory, previewing, onTogglePreview, viewMode, onToggleViewMode, deckSlideCount, exportResult, exportHistory, exportPanelOpen, setExportPanelOpen } = input;
  const { refListOpen, setRefListOpen, refList, refDeleting, loadReferences, deleteReference, setRefDialogOpen, filesLibOpen, setFilesLibOpen, filesLibLoading, filesLibAdding, filesLibList, loadFilesLibrary, addFileLibraryRefs } = references;

  // Export ▾ 下拉（DOCX/PDF）。
  const [exportOpen, setExportOpen] = useState(false);
  const exportRootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!exportOpen) return;
    const onDown = (e: MouseEvent) => {
      if (exportRootRef.current && !exportRootRef.current.contains(e.target as Node)) setExportOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setExportOpen(false); } };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [exportOpen]);

  return (
    <>
      <div ref={exportRootRef} className="relative">
        <Button
          variant="secondary"
          size="sm"
          aria-expanded={exportOpen}
          onClick={() => setExportOpen((v) => !v)}
        >
          <Download size={14} className="mr-1" /> {t('writing.export', 'Export')}
          <ChevronDown size={12} className={cn('ml-0.5 transition-transform', exportOpen && 'rotate-180')} />
        </Button>
        {exportOpen && (
          <div role="menu" className="absolute right-0 top-full z-40 mt-1 w-44 rounded-xl border border-border bg-surface-elevated p-1 shadow-lg">
            <button
              type="button"
              disabled={exporting}
              onClick={() => { setExportOpen(false); onExportDocx(); }}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] text-text-primary hover:bg-surface disabled:opacity-40"
            >
              <FileText size={14} /> {t('writing.exportDocx', 'Export DOCX')}
            </button>
            <button
              type="button"
              disabled={exporting}
              onClick={() => { setExportOpen(false); onExportPdf(); }}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] text-text-primary hover:bg-surface disabled:opacity-40"
            >
              <Download size={14} /> {t('writing.exportPdf', 'Export PDF')}
            </button>
          </div>
        )}
      </div>

      <OverflowMenu
        ariaLabel={t('writing.moreActions', '更多操作')}
        items={[
          {
            label: previewing ? t('writing.editToggle', 'Edit') : t('writing.previewToggle', 'Preview'),
            icon: <Eye size={14} />,
            onClick: onTogglePreview,
          },
          {
            // #1001: viewMode 控件在窄屏隐藏 — 经 ··· 可达。
            label: viewMode === 'deck'
              ? `${t('writing.docView', '文档')}`
              : `${t('writing.deckView', '幻灯片')} · ${deckSlideCount}`,
            icon: viewMode === 'deck' ? <FileText size={14} /> : <Presentation size={14} />,
            onClick: onToggleViewMode,
            className: 'sm:hidden',
            hidden: previewing,
          },
          { label: t('writing.history', '历史版本'), icon: <History size={14} />, onClick: onToggleHistory },
          { label: t('writing.scanPhi', 'Scan PHI'), icon: <ShieldAlert size={14} />, onClick: onPhiScan, disabled: phiScanning },
          { label: t('writing.uploadDoc', '上传文件'), icon: <FileText size={14} />, onClick: () => chat.docUploadRef.current?.click() },
          {
            label: t('writing.genMethods', '生成方法'),
            icon: <Sparkles size={14} />,
            onClick: onGenerateMethods,
            disabled: methodsLoading,
            hidden: !studyId,
          },
          {
            label: t('writing.injectResults', '注入结果'),
            icon: <FileText size={14} />,
            onClick: () => setInjectOpen((v) => !v),
            hidden: !studyId,
          },
          {
            label: refList.length > 0
              ? `${t('writing.references', '参考材料')} (${refList.length})`
              : t('writing.references', '参考材料'),
            icon: <FilePlus size={14} />,
            onClick: () => { setRefListOpen((v) => !v); if (!refListOpen) void loadReferences(); },
          },
          {
            label: chatOpen ? t('writing.closeChat', '收起 Chat') : t('writing.openChat', 'Chat'),
            icon: <MessageSquare size={14} />,
            onClick: () => setChatOpen((v) => !v),
          },
        ]}
      />

      <input
        ref={chat.docUploadRef}
        type="file"
        accept=".pdf,.docx,.doc,.txt,.md"
        onChange={chat.handleDocUpload}
        className="hidden"
      />

      {methodsError && (
        <span className="hidden text-xs text-error sm:inline" title={methodsError}>
          {methodsError.length > 24 ? `${methodsError.slice(0, 24)}…` : methodsError}
        </span>
      )}

      {injectOpen && (
        <div className="absolute right-2 top-14 z-30 w-[min(92vw,420px)] rounded-xl border border-border bg-surface-elevated p-4 shadow-lg">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-sm font-medium text-text-secondary">{t('writing.injectResultsTitle', '注入统计结果')}</span>
            <button onClick={() => setInjectOpen(false)} className="text-text-tertiary hover:text-text-primary"><X size={14} /></button>
          </div>
          <Input
            value={injectLabel}
            onChange={(e) => setInjectLabel(e.target.value)}
            placeholder={t('writing.injectLabel', '小节标题，如 Overall survival')}
            className="mb-2"
          />
          <textarea
            value={injectResult}
            onChange={(e) => setInjectResult(e.target.value)}
            rows={6}
            placeholder={t('writing.injectHint', '粘贴 #361 统计输出（JSON），如 {"method":"kaplan_meier_logrank","p_value":0.012}')}
            className="w-full rounded-lg border border-border bg-surface px-3 py-2 font-mono text-xs text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <div className="mt-2 flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setInjectOpen(false)}>Cancel</Button>
            <Button size="sm" onClick={onInjectResults} isLoading={injecting} disabled={!injectLabel.trim() || !injectResult.trim()}>
              {t('writing.injectNow', '注入')}
            </Button>
          </div>
        </div>
      )}

      <div className="relative">
        {refListOpen && (
          <ReferenceListPopover
            list={refList}
            deleting={refDeleting}
            onClose={() => setRefListOpen(false)}
            onDelete={(id) => void deleteReference(id)}
            // #930: 粘贴文本(复活 AddReferenceDialog)/文件库勾选登记。
            onOpenPaste={() => { setRefDialogOpen(true); setRefListOpen(false); }}
            // #932: 知识库入口 — 打开共享 KbPicker(总结/文件按类型分组)。
            onOpenKbPicker={onOpenKbPicker}
            filesLibOpen={filesLibOpen}
            onToggleFilesLib={() => {
              const next = !filesLibOpen;
              setFilesLibOpen(next);
              if (next) void loadFilesLibrary();
            }}
            filesLibLoading={filesLibLoading}
            filesLibAdding={filesLibAdding}
            filesLibList={filesLibList}
            onAddFiles={(files) => void addFileLibraryRefs(files)}
          />
        )}
      </div>

      {/* #754: 导出完成态面板 — 取代路径字符串;api 层已触发下载,
          面板补齐确认感 + 历史入口。 */}
      {(exportResult || exportHistory.length > 0) && exportPanelOpen && (
        <ExportDonePanel exportResult={exportResult} exportHistory={exportHistory} onClose={() => setExportPanelOpen(false)} />
      )}
    </>
  );
}
