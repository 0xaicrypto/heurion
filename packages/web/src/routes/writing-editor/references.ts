import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, ApiError } from '@/lib/api';
import { showToast } from '@/lib/plugin-dom-ui';

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

/** #1010: 引用材料池条目 — 选择器隐式排序（最近用过/用得最多/当前场景相关）。 */
export interface ReferencePoolItem {
  reference_id: string;
  kind: string;
  label: string;
  content: string;
  source_ref: string | null;
  created_at: string;
  usage: {
    session_count: number;
    last_used_at: string | null;
    last_session_id: string | null;
    last_session_title: string | null;
  };
  score: number;
}

export type ReferencePoolSort = 'recent' | 'frequent' | 'relevant';

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
  handleKbPickConfirm: (items: Array<{ id: string; title: string; summary: string; kind: 'summary' | 'file' }>) => Promise<void>;
  addFileLibraryRefs: (files: FileLibraryItem[]) => Promise<void>;
  deleteReference: (referenceId: string) => Promise<void>;
  /** #1010: 引用池（跨会话复用 + 隐式排序 + 使用痕迹）。 */
  poolOpen: boolean;
  setPoolOpen: React.Dispatch<React.SetStateAction<boolean>>;
  poolLoading: boolean;
  poolSort: ReferencePoolSort;
  setPoolSort: (sort: ReferencePoolSort) => void;
  poolList: ReferencePoolItem[];
  poolAdding: boolean;
  loadPool: (sort?: ReferencePoolSort) => Promise<void>;
  addPoolRefs: (items: ReferencePoolItem[]) => Promise<void>;
}

/** #1007: 引用面板后端适配器 — 写作编辑器(docId)/主 chat(sessionId)共用同一状态机与弹层。 */
export interface ReferenceAdapter {
  list: () => Promise<DocReferenceItem[]>;
  add: (data: { kind: string; content: string; label?: string; source_patient_hash?: string; reference_id?: string }) => Promise<{ imported?: boolean; imported_body?: string | null }>;
  remove: (referenceId: string) => Promise<void>;
}

/** #696/#711 — 参考材料管理状态机（表单对话框 + 列表 + KbPicker 登记 + 文件库勾选）。
 *  #1007: 后端访问抽成 ReferenceAdapter，doc/session 两条链路共用。 */
function useReferenceManager(input: {
  adapter: ReferenceAdapter | null;
  setError: (e: string) => void;
  /** #930: 文件类参考登记触发空文档自动导入时,把导入正文回填编辑器。 */
  onImportedBody?: (body: string) => void;
  /** #1010: 当前场景上下文（会话标题/近期消息/文档标题）— "当前场景相关"排序用。 */
  poolContext?: () => string;
}): DocReferences {
  const { adapter, setError } = input;
  const poolContext = input.poolContext;
  const { t } = useTranslation();

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
  // #1010: 引用池 — 跨会话复用已登记材料；排序数据来自 MemoryUsageBus 聚合。
  const [poolOpen, setPoolOpen] = useState(false);
  const [poolLoading, setPoolLoading] = useState(false);
  const [poolSort, setPoolSortState] = useState<ReferencePoolSort>('recent');
  const [poolList, setPoolList] = useState<ReferencePoolItem[]>([]);
  const [poolAdding, setPoolAdding] = useState(false);

  const loadReferences = useCallback(async () => {
    if (!adapter) return;
    try {
      setRefList(await adapter.list());
    } catch { /* 列表加载失败不阻断编辑 */ }
  }, [adapter]);

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
    if (!adapter || !refForm.content.trim() || !refForm.kind.trim()) return;
    setRefSubmitting(true);
    try {
      const r = await adapter.add({
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
      void loadReferences();
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
  const handleKbPickConfirm = async (items: Array<{ id: string; title: string; summary: string; kind: 'summary' | 'file' }>) => {
    if (!adapter || items.length === 0) return;
    for (const it of items) {
      try {
        const kind = it.kind === 'file' ? 'file' : 'guideline';
        let content = it.title;
        if (it.kind === 'summary') {
          try {
            const full = await api.getKnowledgeSummary(it.id);
            content = full.content || it.summary || it.title;
          } catch { /* 取全文失败回退摘要预览 */ content = it.summary || it.title; }
        }
        const r = await adapter.add({ kind, content, label: it.title });
        if (r.imported && r.imported_body) input.onImportedBody?.(r.imported_body);
      } catch (err) {
        setError(err instanceof ApiError ? err.messageText : String(err));
      }
    }
    await loadReferences();
  };

  // #930: 文件库勾选登记 — 走 POST /references(空文档自动导入 ensureDraftBody
  // 复用现有语义;服务端幂等去重防重复点选)。
  const addFileLibraryRefs = async (files: FileLibraryItem[]) => {
    if (!adapter || files.length === 0) return;
    setFilesLibAdding(true);
    try {
      for (const f of filterNewFileRefs(files, refList)) {
        try {
          const r = await adapter.add({ kind: fileRefKindFromName(f.name), content: f.name, label: f.name, source_patient_hash: f.file_id });
          if (r.imported && r.imported_body) input.onImportedBody?.(r.imported_body);
        } catch (err) {
          setError(err instanceof ApiError ? err.messageText : String(err));
        }
      }
      await loadReferences();
      // #1036: 固定/登记成功反馈。
      showToast(t('chat.refAdded', '已添加为引用'), 'success');
    } finally {
      setFilesLibAdding(false);
    }
  };

  const deleteReference = async (referenceId: string) => {
    if (!adapter) return;
    setRefDeleting(referenceId);
    try {
      await adapter.remove(referenceId);
      setRefList((prev) => prev.filter((x) => x.reference_id !== referenceId));
    } catch (err) {
      setError(err instanceof ApiError ? err.messageText : String(err));
    } finally {
      setRefDeleting(null);
    }
  };

  // #1010: 拉取引用池（按隐式排序）；"当前场景相关"由上下文关键词重叠决胜。
  const loadPool = useCallback(async (sort?: ReferencePoolSort) => {
    const useSort = sort ?? poolSort;
    setPoolLoading(true);
    try {
      const r = await api.getReferencePool({ sort: useSort, context: poolContext?.() || '', limit: 30 });
      setPoolList(r.items || []);
    } catch (err) {
      setError(err instanceof ApiError ? err.messageText : String(err));
    } finally {
      setPoolLoading(false);
    }
  }, [poolSort, setError, poolContext]);

  const setPoolSort = (sort: ReferencePoolSort) => {
    setPoolSortState(sort);
    void loadPool(sort);
  };

  // #1010: 从池子复用 — 按 item id 精确挂载（不重算 identity，正文完整）。
  const addPoolRefs = async (items: ReferencePoolItem[]) => {
    if (!adapter || items.length === 0) return;
    setPoolAdding(true);
    try {
      for (const it of items) {
        try {
          const r = await adapter.add({
            kind: it.kind === 'kb_summary' ? 'guideline' : it.kind,
            content: it.content || it.label,
            label: it.label,
            reference_id: it.reference_id,
          });
          if (r.imported && r.imported_body) input.onImportedBody?.(r.imported_body);
        } catch (err) {
          setError(err instanceof ApiError ? err.messageText : String(err));
        }
      }
      await loadReferences();
      showToast(t('chat.refAdded', '已添加为引用'), 'success');
    } finally {
      setPoolAdding(false);
    }
  };

  useEffect(() => {
    void loadReferences();
  }, [loadReferences]);

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
    poolOpen,
    setPoolOpen,
    poolLoading,
    poolSort,
    setPoolSort,
    poolList,
    poolAdding,
    loadPool,
    addPoolRefs,
  };
}

/** #696/#711 — 写作编辑器文档级参考材料管理（docId 链路）。 */
export function useDocReferences(input: {
  docId: string | undefined;
  setError: (e: string) => void;
  /** #930: 文件类参考登记触发空文档自动导入时,把导入正文回填编辑器。 */
  onImportedBody?: (body: string) => void;
  /** #1010: 当前场景上下文（文档标题等）。 */
  poolContext?: () => string;
}): DocReferences {
  const { docId, setError } = input;
  // #1034: 写作引用迁移到统一会话链路（doc-<docId>）；自动导入/pptx 由
  // 服务端 doc-reference-effects 在同一端点保留，响应形状与旧端点对齐。
  const sessionId = docId ? `doc-${docId}` : undefined;
  const adapter = useMemo<ReferenceAdapter | null>(() => (sessionId ? {
    list: async () => (await api.getSessionReferences(sessionId)).references,
    add: (data) => api.addSessionReference(sessionId, data),
    remove: async (referenceId) => { await api.deleteSessionReference(sessionId, referenceId); },
  } : null), [sessionId]);
  return useReferenceManager({ adapter, setError, onImportedBody: input.onImportedBody, poolContext: input.poolContext });
}

/** #1007 — 主 chat 会话级引用管理（sessionId 链路，与写作编辑器共用弹层/状态机）。 */
export function useSessionReferences(input: {
  sessionId: string | undefined;
  setError: (e: string) => void;
  /** #1010: 当前场景上下文（会话标题 + 近期消息）。 */
  poolContext?: () => string;
}): DocReferences {
  const { sessionId, setError } = input;
  const adapter = useMemo<ReferenceAdapter | null>(() => (sessionId ? {
    list: async () => (await api.getSessionReferences(sessionId)).references,
    add: (data) => api.addSessionReference(sessionId, data),
    remove: async (referenceId) => { await api.deleteSessionReference(sessionId, referenceId); },
  } : null), [sessionId]);
  return useReferenceManager({ adapter, setError, poolContext: input.poolContext });
}
