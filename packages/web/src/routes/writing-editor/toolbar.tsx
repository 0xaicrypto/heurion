import { useTranslation } from 'react-i18next';
import { Download, FilePlus, FileText, MessageSquare, ShieldAlert, Sparkles, X } from 'lucide-react';
import { Button, Input } from '@/components/ui';
import { ExportDonePanel, ReferenceListPopover } from './dialogs';
import type { DocChat } from './doc-chat';
import type { DocReferences } from './references';

/** #688: 第二行工具栏（PHI/上传/导出/方法/注入/参考/Chat + inject 弹层 +
 * 导出完成面板）— 从 writing-editor 路由机械拆出；全部状态与 handler
 * 仍归路由，经 props 传入。 */
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
  exportResult: { docx_path: string; size_bytes: number } | null;
  exportHistory: Array<{ format: 'docx' | 'pdf'; filename: string; size: number; at: number }>;
  exportPanelOpen: boolean;
  setExportPanelOpen: React.Dispatch<React.SetStateAction<boolean>>;
}) {
  const { t } = useTranslation();
  const { chat, references, phiScanning, onPhiScan, exporting, onExportDocx, onExportPdf, studyId, methodsLoading, methodsError, onGenerateMethods, injectOpen, setInjectOpen, injectLabel, setInjectLabel, injectResult, setInjectResult, injecting, onInjectResults, onOpenKbPicker, setChatOpen, exportResult, exportHistory, exportPanelOpen, setExportPanelOpen } = input;
  const { refListOpen, setRefListOpen, refList, refDeleting, loadReferences, deleteReference } = references;
  return (
    <div className="flex items-center gap-1 border-b border-border bg-surface px-6 py-1.5 shrink-0">
          <Button
            variant="ghost"
            size="sm"
            onClick={onPhiScan}
            disabled={phiScanning}
            isLoading={phiScanning}
            >
              <ShieldAlert size={14} className="mr-1" /> Scan PHI
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => chat.docUploadRef.current?.click()}
            >
              <FileText size={14} className="mr-1" /> Upload
            </Button>
            <input
              ref={chat.docUploadRef}
              type="file"
              accept=".pdf,.docx,.doc,.txt,.md"
              onChange={chat.handleDocUpload}
              className="hidden"
            />
          <Button
            variant="ghost"
            size="sm"
            onClick={onExportDocx}
            disabled={exporting}
            isLoading={exporting}
          >
            <Download size={14} className="mr-1" /> Export DOCX
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onExportPdf()}
            disabled={exporting}
          >
            <FileText size={14} className="mr-1" /> Export PDF
          </Button>
          {studyId && (
            <>
              <Button variant="ghost" size="sm" onClick={onGenerateMethods} isLoading={methodsLoading} disabled={!studyId}>
                <Sparkles size={14} className="mr-1" /> {t('writing.genMethods', '生成方法')}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setInjectOpen((v) => !v)}>
                <FileText size={14} className="mr-1" /> {t('writing.injectResults', '注入结果')}
              </Button>
            </>
          )}
          {methodsError && (
            <span className="text-xs text-error">{methodsError}</span>
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
            <Button
              variant="ghost"
              size="sm"
              onClick={() => { setRefListOpen((v) => !v); if (!refListOpen) void loadReferences(); }}
            >
              <FilePlus size={14} className="mr-1" /> Reference
              {refList.length > 0 && (
                <span className="ml-1 rounded-full bg-accent/10 px-1.5 py-0.5 text-[10px] text-accent">{refList.length}</span>
              )}
            </Button>
            {/* #757: 从知识库选择 — 同一文件不再重传,一次上传处处引用。 */}
            <Button
              variant="ghost"
              size="sm"
              onClick={onOpenKbPicker}
              title={t('writing.pickFromKb', '从知识库选择总结/文件作为参考')}
            >
              📚 {t('writing.fromKb', '知识库')}
            </Button>
            {refListOpen && (
              <ReferenceListPopover list={refList} deleting={refDeleting} onClose={() => setRefListOpen(false)} onDelete={(id) => void deleteReference(id)} />
            )}
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setChatOpen((v) => !v)}
          >
            <MessageSquare size={14} className="mr-1" /> Chat
          </Button>

          {/* #754: 导出完成态面板 — 取代路径字符串;api 层已触发下载,
              面板补齐确认感 + 历史入口。 */}
          {(exportResult || exportHistory.length > 0) && exportPanelOpen && (
            <ExportDonePanel exportResult={exportResult} exportHistory={exportHistory} onClose={() => setExportPanelOpen(false)} />
          )}
    </div>
  );
}
