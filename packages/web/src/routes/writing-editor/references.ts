import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';

export interface DocReferenceItem {
  reference_id: string;
  kind: string;
  label: string;
  content: string;
  created_at: string;
}

export interface FileLibraryItem {
  file_id: string;
  name: string;
  mime: string;
  size_bytes: number;
  created_at: string;
}

/** #930: 文件名 → 参考材料 kind(与聊天上传挂参考的映射保持一致)。 */
export function fileRefKindFromName(name: string): 'pdf' | 'docx' | 'file' {
  const n = name.toLowerCase();
  if (n.endsWith('.pdf')) return 'pdf';
  if (n.endsWith('.docx') || n.endsWith('.doc')) return 'docx';
  return 'file';
}

/** #930: 过滤已登记的文件(按文件名 = label/content 匹配,大小写不敏感)。 */
export function filterNewFileRefs(files: FileLibraryItem[], refList: DocReferenceItem[]): FileLibraryItem[] {
  const taken = new Set(refList.map((r) => (r.label || r.content).toLowerCase()));
  return files.filter((f) => !taken.has(f.name.toLowerCase()));
}

export interface DocReferences {
  refDialogOpen: boolean;
  setRefDialogOpen: React.Dispatch<React.SetStateAction<boolean>>;
  refForm: { kind: string; content: string; label: string; source_patient_hash: string };
  setRefForm: React.Dispatch<React.SetStateAction<{ kind: string; content: string; label: string; source_patient_hash: string }>>;
  refSubmitting: boolean;
  refList: DocReferenceItem[];
  refListOpen: boolean;
  setRefListOpen: React.Dispatch<React.SetStateAction<boolean>>;
  refDeleting: string | null;
  /** #930: 文件库选择器 — 已上传文件勾选登记为参考。 */
  filesLibOpen: boolean;
  setFilesLibOpen: React.Dispatch<React.SetStateAction<boolean>>;
  filesLibLoading: boolean;
  filesLibList: FileLibraryItem[];
  filesLibAdding: boolean;
  loadReferences: () => Promise<void>;
  loadFilesLibrary: () => Promise<void>;
  handleAddReference: () => Promise<void>;
  handleKbPickConfirm: (items: Array<{ id: string; title: string; summary: string; kind: 'summary' | 'document' }>) => Promise<void>;
  addFileLibraryRefs: (files: FileLibraryItem[]) => Promise<void>;
  deleteReference: (referenceId: string) => Promise<void>;
}

/** #696/#711 — 参考材料管理（表单对话框 + 列表 + KbPicker 登记）下沉。 */
export function useDocReferences(input: {
  docId: string | undefined;
  setError: (e: string) => void;
  /** #930: 文件类参考登记触发空文档自动导入时,把导入正文回填编辑器。 */
  onImportedBody?: (body: string) => void;
}): DocReferences {
  const { docId, setError } = input;

  const [refDialogOpen, setRefDialogOpen] = useState(false);
  const [refForm, setRefForm] = useState({ kind: 'guideline', content: '', label: '', source_patient_hash: '' });
  const [refSubmitting, setRefSubmitting] = useState(false);
  // #711: 参考材料列表(可查看/删除) — 此前只能添加,AI 上下文对用户不可见。
  const [refList, setRefList] = useState<DocReferenceItem[]>([]);
  const [refListOpen, setRefListOpen] = useState(false);
  const [refDeleting, setRefDeleting] = useState<string | null>(null);
  // #930: 文件库选择器状态 — 已上传文件不再需要重传即可挂为参考。
  const [filesLibOpen, setFilesLibOpen] = useState(false);
  const [filesLibLoading, setFilesLibLoading] = useState(false);
  const [filesLibList, setFilesLibList] = useState<FileLibraryItem[]>([]);
  const [filesLibAdding, setFilesLibAdding] = useState(false);

  const loadReferences = useCallback(async () => {
    if (!docId) return;
    try {
      const r = await api.getDocReferences(docId);
      setRefList(r.references);
    } catch { /* 列表加载失败不阻断编辑 */ }
  }, [docId]);

  const loadFilesLibrary = useCallback(async () => {
    setFilesLibLoading(true);
    try {
      const r = await api.listFiles(200, 0);
      setFilesLibList(r.files || []);
    } catch (err) {
      setError(err instanceof ApiError ? err.messageText : String(err));
    } finally {
      setFilesLibLoading(false);
    }
  }, [setError]);

  const handleAddReference = async () => {
    if (!docId || !refForm.content.trim() || !refForm.kind.trim()) return;
    setRefSubmitting(true);
    try {
      const r = await api.addDocReference(docId, {
        kind: refForm.kind,
        content: refForm.content,
        label: refForm.label || undefined,
        source_patient_hash: refForm.source_patient_hash || undefined,
      });
      // #930: 空文档自动导入的正文回填编辑器(粘贴文本是纯文本不会触发,
      // 保持完整回调链以覆盖 kind 传成 file 类的路径)。
      if (r.imported && r.imported_body) input.onImportedBody?.(r.imported_body);
      setRefDialogOpen(false);
      setRefForm({ kind: 'guideline', content: '', label: '', source_patient_hash: '' });
    } catch (err) {
      setError(err instanceof ApiError ? err.messageText : String(err));
    } finally {
      setRefSubmitting(false);
    }
  };

  // #757: 共享 KbPicker — 从知识库选总结/文件直接登记为参考。
  // #930: summary 类此前只登记标题(picker 仅回传 120 字预览,AI 读不到
  // 实质内容) — 确认时经 getKnowledgeSummary 取全文登记;document 类保持
  // 文件名契约(content=文件名,注入侧按名定位上传文件解析正文)。
  const handleKbPickConfirm = async (items: Array<{ id: string; title: string; summary: string; kind: 'summary' | 'document' }>) => {
    if (!docId || items.length === 0) return;
    for (const it of items) {
      try {
        const kind = it.kind === 'document' ? 'file' : 'guideline';
        let content = it.title;
        if (it.kind === 'summary') {
          try {
            const full = await api.getKnowledgeSummary(it.id);
            content = full.content || it.summary || it.title;
          } catch { /* 取全文失败回退摘要预览 */ content = it.summary || it.title; }
        }
        const r = await api.addDocReference(docId, { kind, content, label: it.title });
        if (r.imported && r.imported_body) input.onImportedBody?.(r.imported_body);
      } catch (err) {
        setError(err instanceof ApiError ? err.messageText : String(err));
      }
    }
    void loadReferences();
  };

  // #930: 文件库勾选登记 — 走 POST /references(空文档自动导入 ensureDraftBody
  // 复用现有语义;服务端幂等去重防重复点选)。
  const addFileLibraryRefs = async (files: FileLibraryItem[]) => {
    if (!docId || files.length === 0) return;
    setFilesLibAdding(true);
    try {
      for (const f of filterNewFileRefs(files, refList)) {
        try {
          const r = await api.addDocReference(docId, { kind: fileRefKindFromName(f.name), content: f.name, label: f.name });
          if (r.imported && r.imported_body) input.onImportedBody?.(r.imported_body);
        } catch (err) {
          setError(err instanceof ApiError ? err.messageText : String(err));
        }
      }
      await loadReferences();
    } finally {
      setFilesLibAdding(false);
    }
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
    filesLibOpen,
    setFilesLibOpen,
    filesLibLoading,
    filesLibList,
    filesLibAdding,
    loadReferences,
    loadFilesLibrary,
    handleAddReference,
    handleKbPickConfirm,
    addFileLibraryRefs,
    deleteReference,
  };
}
