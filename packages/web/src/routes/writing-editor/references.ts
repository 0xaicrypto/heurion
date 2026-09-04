import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';

export interface DocReferences {
  refDialogOpen: boolean;
  setRefDialogOpen: React.Dispatch<React.SetStateAction<boolean>>;
  refForm: { kind: string; content: string; label: string; source_patient_hash: string };
  setRefForm: React.Dispatch<React.SetStateAction<{ kind: string; content: string; label: string; source_patient_hash: string }>>;
  refSubmitting: boolean;
  refList: Array<{ reference_id: string; kind: string; label: string; content: string; created_at: string }>;
  refListOpen: boolean;
  setRefListOpen: React.Dispatch<React.SetStateAction<boolean>>;
  refDeleting: string | null;
  loadReferences: () => Promise<void>;
  handleAddReference: () => Promise<void>;
  handleKbPickConfirm: (items: Array<{ id: string; title: string; kind: 'summary' | 'document' }>) => Promise<void>;
  deleteReference: (referenceId: string) => Promise<void>;
}

/** #696/#711 — 参考材料管理（表单对话框 + 列表 + KbPicker 登记）下沉。 */
export function useDocReferences(input: {
  docId: string | undefined;
  setError: (e: string) => void;
}): DocReferences {
  const { docId, setError } = input;

  const [refDialogOpen, setRefDialogOpen] = useState(false);
  const [refForm, setRefForm] = useState({ kind: 'guideline', content: '', label: '', source_patient_hash: '' });
  const [refSubmitting, setRefSubmitting] = useState(false);
  // #711: 参考材料列表(可查看/删除) — 此前只能添加,AI 上下文对用户不可见。
  const [refList, setRefList] = useState<Array<{ reference_id: string; kind: string; label: string; content: string; created_at: string }>>([]);
  const [refListOpen, setRefListOpen] = useState(false);
  const [refDeleting, setRefDeleting] = useState<string | null>(null);

  const loadReferences = useCallback(async () => {
    if (!docId) return;
    try {
      const r = await api.getDocReferences(docId);
      setRefList(r.references);
    } catch { /* 列表加载失败不阻断编辑 */ }
  }, [docId]);

  const handleAddReference = async () => {
    if (!docId || !refForm.content.trim() || !refForm.kind.trim()) return;
    setRefSubmitting(true);
    try {
      await api.addDocReference(docId, {
        kind: refForm.kind,
        content: refForm.content,
        label: refForm.label || undefined,
        source_patient_hash: refForm.source_patient_hash || undefined,
      });
      setRefDialogOpen(false);
      setRefForm({ kind: 'guideline', content: '', label: '', source_patient_hash: '' });
    } catch (err) {
      setError(err instanceof ApiError ? err.messageText : String(err));
    } finally {
      setRefSubmitting(false);
    }
  };

  // #757: 共享 KbPicker — 从知识库选文章/文件直接登记为参考(kind=summary/file)。
  const handleKbPickConfirm = async (items: Array<{ id: string; title: string; kind: 'summary' | 'document' }>) => {
    if (!docId || items.length === 0) return;
    for (const it of items) {
      try {
        await api.addDocReference(docId, {
          kind: it.kind === 'document' ? 'file' : 'guideline',
          content: it.title,
          label: it.title,
        });
      } catch (err) {
        setError(err instanceof ApiError ? err.messageText : String(err));
      }
    }
    void loadReferences();
  };

  const deleteReference = async (referenceId: string) => {
    if (!docId) return;
    setRefDeleting(referenceId);
    try {
      await api.deleteDocReference(docId, referenceId);
      setRefList((prev) => prev.filter((x) => x.reference_id !== referenceId));
    } catch (err) {
      setError(err instanceof ApiError ? err.messageText : String(err));
    } finally {
      setRefDeleting(null);
    }
  };

  useEffect(() => {
    void loadReferences();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId]);

  return {
    refDialogOpen,
    setRefDialogOpen,
    refForm,
    setRefForm,
    refSubmitting,
    refList,
    refListOpen,
    setRefListOpen,
    refDeleting,
    loadReferences,
    handleAddReference,
    handleKbPickConfirm,
    deleteReference,
  };
}
