import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PlusCircle, Check, AlertTriangle } from 'lucide-react';
import { api } from '@/lib/api';
import { Button, Input } from '@/components/ui';

const CATEGORIES = [
  { value: 'fact', label: '一般事实' },
  { value: 'preference', label: '偏好' },
  { value: 'constraint', label: '约束' },
  { value: 'goal', label: '目标' },
  { value: 'context', label: '背景' },
  { value: 'diagnosis', label: '诊断' },
  { value: 'symptom', label: '症状' },
  { value: 'exam', label: '检查' },
  { value: 'medication', label: '用药' },
  { value: 'allergy', label: '过敏' },
  { value: 'plan', label: '计划' },
];

/**
 * #200: manually add a memory — the fact enters the pending review queue
 * (never a direct graph write).
 */
export function ManualMemoryAdd({ onAdded }: { onAdded?: () => void }) {
  const { t } = useTranslation();
  const [content, setContent] = useState('');
  const [category, setCategory] = useState('fact');
  const [importance, setImportance] = useState('3');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  const handleSubmit = async () => {
    if (!content.trim() || busy) return;
    setBusy(true);
    setResult(null);
    try {
      const r = await api.proposeMemory({
        content: content.trim(),
        category,
        importance: parseInt(importance, 10) || 3,
      });
      setResult(
        r.status === 'pending'
          ? { ok: true, message: t('brain.memoryProposed', '已进入待审核队列') }
          : { ok: false, message: r.reason || t('brain.memoryDeduped', '与已有记忆重复，已自动拒绝') },
      );
      if (r.status === 'pending') {
        setContent('');
        onAdded?.();
      }
    } catch (err) {
      setResult({ ok: false, message: String(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-xl border border-border bg-surface p-4">
      <div className="mb-3 flex items-center gap-2">
        <PlusCircle size={16} className="text-accent" />
        <h3 className="text-sm font-semibold text-text-primary">{t('brain.manualAdd', '手动添加记忆')}</h3>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={content}
          onChange={(e) => setContent(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') handleSubmit(); }}
          placeholder={t('brain.manualAddHint', '如：患者对阿司匹林不耐受…')}
          className="min-w-[240px] flex-1"
          aria-label={t('brain.manualAddHint', '如：患者对阿司匹林不耐受…')}
        />
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          className="h-9 w-32 rounded-lg border border-border bg-surface-elevated px-2 text-sm text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label="category"
        >
          {CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
        </select>
        <select
          value={importance}
          onChange={(e) => setImportance(e.target.value)}
          className="h-9 w-24 rounded-lg border border-border bg-surface-elevated px-2 text-sm text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label="importance"
        >
          {[1, 2, 3, 4, 5].map((n) => <option key={n} value={String(n)}>{t('brain.importance', '重要度')} {n}</option>)}
        </select>
        <Button onClick={handleSubmit} isLoading={busy} disabled={!content.trim()}>
          {t('common.submit', '提交')}
        </Button>
      </div>
      {result && (
        <p className={`mt-2 flex items-center gap-1.5 text-xs ${result.ok ? 'text-success' : 'text-error'}`}>
          {result.ok ? <Check size={12} /> : <AlertTriangle size={12} />}
          {result.message}
        </p>
      )}
    </div>
  );
}
