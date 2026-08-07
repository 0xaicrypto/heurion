import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Sparkles, Check, X, RefreshCw } from 'lucide-react';
import { api } from '@/lib/api';
import { Button, Input } from '@/components/ui';

interface SkillDraft {
  name: string;
  description: string;
  steps: string[];
  prompt: string;
}

/**
 * #298: skill capture — the doctor clicks 保存 once, optionally refines in
 * natural language, then confirms. Zero form-filling.
 */
export function SkillCapturePrompt({ conversation, sessionId, onDone }: {
  conversation: string;
  sessionId?: string;
  onDone?: () => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<SkillDraft | null>(null);
  const [draftId, setDraftId] = useState('');
  const [refineInput, setRefineInput] = useState('');
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleCapture = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.captureSkill(conversation, sessionId);
      setDraftId(res.draft_id);
      setDraft({ name: res.name, description: res.description, steps: res.steps, prompt: res.prompt });
      setOpen(true);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleRefine = async () => {
    if (!refineInput.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.refineSkill(draftId, refineInput.trim());
      setDraft({ name: res.name, description: res.description, steps: res.steps, prompt: res.prompt });
      setRefineInput('');
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleConfirm = async () => {
    setBusy(true);
    try {
      await api.confirmSkill(draftId);
      setSaved(true);
      onDone?.();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  if (saved) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-success/30 bg-success/10 px-3 py-2 text-xs text-success">
        <Check size={14} />
        {t('skills.captureSaved', '技能已保存，下次对话可直接调用')}
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        onClick={handleCapture}
        disabled={busy}
        className="flex items-center gap-1.5 rounded-lg border border-accent/40 bg-accent/10 px-2.5 py-1 text-xs text-accent transition-colors hover:bg-accent/20 disabled:opacity-50"
      >
        <Sparkles size={13} />
        {busy ? t('common.loading') : t('skills.captureHint', '这个流程可以保存为技能，要保存吗？')}
      </button>
      {error && <span className="text-xs text-error">{error}</span>}

      {open && draft && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-lg rounded-lg border border-border bg-surface p-5 shadow-lg">
            <div className="mb-1 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-text-primary">{t('skills.captureTitle', '保存为技能')}</h2>
              <button onClick={() => setOpen(false)} aria-label="Close" className="text-text-tertiary hover:text-text-primary">
                <X size={16} />
              </button>
            </div>

            <p className="mb-3 text-xs text-text-tertiary">{t('skills.captureSubtitle', 'AI 已把你的操作整理成可复用流程，下次可直接调用。')}</p>

            <div className="mb-3 rounded-lg border border-border bg-surface-elevated p-3">
              <p className="text-sm font-medium text-text-primary">{draft.name}</p>
              <p className="mt-0.5 text-xs text-text-secondary">{draft.description}</p>
              {draft.steps.length > 0 && (
                <ol className="mt-2 list-decimal space-y-1 pl-4 text-xs text-text-secondary">
                  {draft.steps.map((s, i) => <li key={i}>{s}</li>)}
                </ol>
              )}
            </div>

            <div className="mb-3 flex gap-2">
              <Input
                value={refineInput}
                onChange={(e) => setRefineInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleRefine(); }}
                placeholder={t('skills.refineHint', '用一句话修改，如"下次别忘了加上复发风险"')}
                className="flex-1"
              />
              <Button size="sm" variant="secondary" onClick={handleRefine} disabled={busy || !refineInput.trim()}>
                <RefreshCw size={13} className="mr-1" />
                {t('skills.refine', '调整')}
              </Button>
            </div>

            <div className="flex justify-end gap-2">
              <Button size="sm" variant="secondary" onClick={() => setOpen(false)}>
                {t('common.cancel', '取消')}
              </Button>
              <Button size="sm" onClick={handleConfirm} disabled={busy}>
                <Check size={14} className="mr-1" />
                {t('skills.save', '保存')}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
