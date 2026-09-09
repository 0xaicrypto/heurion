import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Upload } from 'lucide-react';
import { Alert, Badge, Button, Skeleton } from '@/components/ui';
import { api, ApiError } from '@/lib/api';

export function ProtocolTab({ studyId }: { studyId: string }) {
  const { t } = useTranslation();
  const [rules, setRules] = useState<Array<{ id: string; category: string; rule: string; confirmed: boolean }>>([]);
  const [status, setStatus] = useState({ total: 0, confirmed: 0, pending: 0 });
  const [loading, setLoading] = useState(true);
  const [importText, setImportText] = useState('');
  const [importing, setImporting] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastFile, setLastFile] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const loadRules = useCallback(() => {
    setLoading(true);
    api.getProtocolRules(studyId)
      .then((data) => { setRules(data.rules); setStatus(data.status); })
      .catch((err) => setError(err instanceof ApiError ? err.messageText : String(err)))
      .finally(() => setLoading(false));
  }, [studyId]);

  useEffect(() => { loadRules(); }, [loadRules]);

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (fileRef.current) fileRef.current.value = '';
    setUploading(true);
    setError(null);
    try {
      const res = await api.importProtocolFile(studyId, file);
      setRules(res.rules);
      setStatus(res.status);
      setLastFile(res.file_name);
    } catch (err) {
      setError(err instanceof ApiError ? err.messageText : String(err));
    } finally {
      setUploading(false);
    }
  };

  const handleImport = async () => {
    if (!importText.trim()) return;
    setImporting(true);
    setError(null);
    try {
      await api.importProtocol(studyId, importText);
      await api.extractRules(studyId, importText);
      setImportText('');
      loadRules();
    } catch (err) {
      setError(err instanceof ApiError ? err.messageText : String(err));
    } finally {
      setImporting(false);
    }
  };

  const handleConfirm = async (ruleId: string) => {
    try {
      await api.confirmRule(studyId, ruleId);
      loadRules();
    } catch (err) {
      setError(err instanceof ApiError ? err.messageText : String(err));
    }
  };
  const handleReject = async (ruleId: string) => {
    try {
      // #462: auth handled centrally by the api layer (was raw fetch + manual Bearer).
      await api.deleteProtocolRule(studyId, ruleId);
      loadRules();
    } catch {
      setError(t('research.rejectRuleFailed', '拒绝规则失败'));
    }
  };

  return (
    <div className="max-w-2xl space-y-4">
      <div className="rounded-xl border border-border bg-surface-elevated p-4">
        <h3 className="mb-2 text-sm font-semibold text-text-primary">{t('research.importProtocol', '导入方案')}</h3>
        <textarea value={importText} onChange={e => setImportText(e.target.value)}
          placeholder={t('research.protocolPlaceholder', '在此粘贴方案文本，或在下方上传文件（.txt、.md、.csv、.pdf、.docx）')}
          className="mb-2 min-h-[120px] w-full rounded-lg border border-border bg-surface p-2 text-xs text-text-primary"
          rows={5} />
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={handleImport} isLoading={importing} disabled={!importText.trim()}>
            {t('research.importExtract', '导入并提取规则')}
          </Button>
          <Button size="sm" variant="secondary" onClick={() => fileRef.current?.click()} isLoading={uploading} disabled={uploading}>
            <Upload size={14} className="mr-1" /> {t('research.uploadProtocolFile', '上传方案文件')}
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept=".txt,.md,.csv,.pdf,.docx"
            onChange={handleFileUpload}
            className="hidden"
          />
        </div>
        {lastFile && (
          <p className="mt-2 text-xs text-text-tertiary">{t('research.lastUploaded', '最近上传：{{name}}', { name: lastFile })}</p>
        )}
        {error && (
          <div className="mt-2">
            <Alert variant="error">{error}</Alert>
          </div>
        )}
      </div>

      {loading ? <Skeleton className="h-32 w-full rounded-xl" /> : (
        <div className="rounded-xl border border-border bg-surface-elevated p-4">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-text-primary">{t('research.extractedRules', '已提取规则')}</h3>
            <span className="text-xs text-text-tertiary">{t('research.rulesProgress', '已确认 {{confirmed}}/{{total}} · 待确认 {{pending}}', { confirmed: status.confirmed, total: status.total, pending: status.pending })}</span>
          </div>
          {rules.length === 0 ? (
            <p className="text-sm text-text-tertiary">{t('research.noRulesHint', '先导入方案文本，再提取规则')}</p>
          ) : (
            <div className="space-y-2">
              {rules.map(r => (
                <div key={r.id} className={`flex items-start gap-3 rounded-lg p-2 ${r.confirmed ? 'bg-green-50/10' : 'bg-surface'}`}>
                  <Badge variant={r.category === 'inclusion' ? 'success' : r.category === 'exclusion' ? 'error' : r.category === 'safety' ? 'warning' : 'default'}>
                    {r.category}
                  </Badge>
                  <span className="flex-1 text-xs text-text-primary">{r.rule}</span>
                  {r.confirmed ? (
                    <span className="text-xs text-green-500">✓</span>
                  ) : (
                    <div className="flex gap-1">
                      <button onClick={() => handleConfirm(r.id)} className="rounded px-2 py-0.5 text-xs text-green-500 hover:bg-green-50/10">✓</button>
                      <button onClick={() => handleReject(r.id)} className="rounded px-2 py-0.5 text-xs text-red-400 hover:bg-red-50/10">✗</button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
