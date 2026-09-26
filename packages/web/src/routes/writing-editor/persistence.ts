/**
 * #705/#882/#986 拆分: 文档持久化状态机 hook — 自动保存(debounce)/手动保存
 * (Cmd+S)/并发冲突横幅/失败常驻警示/未保存离开守护。从 writing-editor.tsx
 * 抽出（拆分记录: persistence / write-back / comments 三块中的 persistence）。
 *
 * 行为与抽出前逐行等价，含两个 P0/P1 修复:
 *  - Cmd+S 经 latest-ref 转发（不再捕获文档加载前的空 title/body 闭包）;
 *  - 保存响应只回灌用户未再改动的维度（在飞期间的输入不被旧快照覆盖）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import type { BlockProjection, SectionMetaMap } from '@heurion/contracts';
import { normalizeFileDownloadTokens } from '@heurion/contracts';
import type { DiffReviewState } from '@/components/DocEditor';
import { api, ApiError } from '@/lib/api';
import { sha1Hex } from '@/lib/hash';
import type { DeckWire } from '@/lib/types';
import type { DocDetail } from './types';

/** api.updateDoc 响应（含 unchanged 短路标记与节级元数据）。 */
export interface SaveDocResult {
  id: string;
  title: string;
  body: string;
  deck?: unknown;
  block_projection?: BlockProjection | null;
  section_meta?: SectionMetaMap;
  updated_at: string;
  unchanged?: boolean;
}

/** #882/#996: 409 冲突横幅数据 — 待保存的本地态 + 服务端当前完整态。 */
export interface SaveConflictState {
  title: string;
  body: string;
  deck?: unknown;
  current?: { title: string; body: string; deck?: unknown; block_projection?: BlockProjection | null; updated_at: string };
}

export interface ServerDocState {
  title: string;
  body: string;
  deck?: unknown;
  block_projection?: BlockProjection | null;
  updated_at: string;
}

export interface UseDocPersistenceInput {
  docId?: string;
  doc: DocDetail | null;
  body: string;
  title: string;
  bodyRef: MutableRefObject<string>;
  titleRef: MutableRefObject<string>;
  /** 服务端视角正文（并发保护指纹 / 预保存基线）— 由路由持有。 */
  serverBodyRef: MutableRefObject<string | null>;
  lastSavedBody: MutableRefObject<string | null>;
  lastSavedDeck: MutableRefObject<string>;
  deckAsset: DeckWire | null;
  /** useDeckAsset 派生的 deck 指纹（dirty 判定）。 */
  deckJson: string;
  deckRichDirtyRef: MutableRefObject<boolean>;
  dirtyRef: MutableRefObject<boolean>;
  /** 当前 dirty（父级状态）— autosave 触发条件。 */
  dirty: boolean;
  setDirty: Dispatch<SetStateAction<boolean>>;
  diffReview: DiffReviewState | null;
  pendingWriteBackRef: MutableRefObject<unknown>;
  conflictLoadRef: MutableRefObject<DocDetail | null>;
  applyServerDoc: (fresh: ServerDocState) => void;
  setDoc: Dispatch<SetStateAction<DocDetail | null>>;
  setBody: Dispatch<SetStateAction<string>>;
  setTitle: Dispatch<SetStateAction<string>>;
  setDiffReview: Dispatch<SetStateAction<DiffReviewState | null>>;
  setError: (e: string | null) => void;
  setViewMode: Dispatch<SetStateAction<'document' | 'deck'>>;
  showNotice: (text: string, ttlMs?: number) => void;
}

export interface DocPersistenceController {
  saving: boolean;
  saveConflict: SaveConflictState | null;
  saveFailure: { count: number; message: string } | null;
  setSaveConflict: Dispatch<SetStateAction<SaveConflictState | null>>;
  setSaveFailure: Dispatch<SetStateAction<{ count: number; message: string } | null>>;
  markDirty: (nextBody: string, nextTitle: string) => void;
  markSaveFailed: (err: unknown) => void;
  saveDoc: (title: string, body: string, opts?: { deck?: unknown; force?: boolean }) => Promise<SaveDocResult>;
  presaveForChat: () => Promise<SaveDocResult>;
  extractConflictCurrent: (err: unknown) => ServerDocState | undefined;
  handleSave: () => Promise<void>;
  leaveEditor: () => void;
  resolveConflictKeepMine: () => Promise<void>;
  resolveConflictUseSaved: () => void;
  resolveConflictLoadLatest: () => Promise<void>;
}

const AUTOSAVE_DEBOUNCE_MS = 2500;

export function useDocPersistence(input: UseDocPersistenceInput): DocPersistenceController {
  const {
    docId, doc, body, title, bodyRef, titleRef, serverBodyRef, lastSavedBody, lastSavedDeck,
    deckAsset, deckJson, deckRichDirtyRef, dirtyRef, dirty, setDirty, diffReview, pendingWriteBackRef,
    conflictLoadRef, applyServerDoc, setDoc, setBody, setTitle, setDiffReview, setError, setViewMode, showNotice,
  } = input;
  const { t } = useTranslation();
  const navigate = useNavigate();

  const [saving, setSaving] = useState(false);
  const [saveConflict, setSaveConflict] = useState<SaveConflictState | null>(null);
  const [saveFailure, setSaveFailure] = useState<{ count: number; message: string } | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const leaveConfirmed = useRef(false);

  const markSaveFailed = useCallback((err: unknown) => {
    const message = err instanceof ApiError ? err.messageText : String(err);
    dirtyRef.current = true;
    setDirty(true);
    setSaveFailure((prev) => ({ count: (prev?.count ?? 0) + 1, message }));
  }, [dirtyRef, setDirty]);

  const markDirty = useCallback((nextBody: string, nextTitle: string) => {
    if (!docId) return;
    // #773: deck 变更同样计入 dirty（deckJson 由 useMemo 派生，与 lastSavedDeck 比较）。
    const nextDirty = nextBody !== (lastSavedBody.current ?? '')
      || nextTitle !== (doc?.title ?? '')
      || deckJson !== lastSavedDeck.current;
    dirtyRef.current = nextDirty;
    setDirty(nextDirty);
  }, [docId, doc?.title, deckJson, lastSavedBody, lastSavedDeck, dirtyRef, setDirty]);

  useEffect(() => {
    if (!docId || doc === null) return;
    markDirty(bodyRef.current, title);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [body, title, deckJson, docId]);

  // #882: 带 base_sha 的保存(服务端并发保护)— 指纹取服务端视角正文
  // (serverBodyRef),409 → 冲突横幅。force 跳过(「保留我的版本」)。
  // #896: 前移到 useDocChat 之前 — doc-chat 发送前预保存复用同一语义。
  const saveDoc = useCallback(async (
    nextTitle: string,
    nextBody: string,
    opts: { deck?: unknown; force?: boolean } = {},
  ): Promise<SaveDocResult> => {
    const base = serverBodyRef.current;
    // #1128: base_sha 按去 token 归一化的正文计算 — 读取期重签 token 只改
    // 展示文本,不应让并发指纹失配(否则每次保存 409 死循环)。与服务端
    // documents.router 同口径(shared contracts 单源)。
    const base_sha = !opts.force && base !== null ? await sha1Hex(normalizeFileDownloadTokens(base)) : undefined;
    const updated = await api.updateDoc(docId!, {
      title: nextTitle, body: nextBody,
      ...(opts.deck !== undefined ? { deck: opts.deck } : {}),
      ...(base_sha ? { base_sha } : {}),
      ...(opts.force ? { force: true } : {}),
    });
    // review 复核#8a: 手动保存后同步服务端最新块投影 — 此前 doc.block_projection
    // 停留在文档加载时的值,「AI 正在编辑哪个节」的批次基线(line 409 fallback)
    // 在"保存后才发起 AI 轮次"的顺序下取到过期投影,指示器可能标错节。
    // 仅在服务端返回有效投影时覆盖(存量文档首次保存前为 null,不冲掉本地值)。
    if (updated.block_projection) {
      setDoc((prev) => (prev ? { ...prev, block_projection: updated.block_projection! } : prev));
    }
    // #996/#999: 保存响应携带节级元数据 — 作者轴(human)/可信度轴即时同步。
    if (updated.section_meta) {
      setDoc((prev) => (prev ? { ...prev, section_meta: updated.section_meta } : prev));
    }
    return updated;
  }, [docId, serverBodyRef, setDoc]);

  // #996/#997: 从 409 响应体提取服务端当前完整态(current) — 双栏对照
  // 数据源;旧后端无 payload 时返回 undefined(前端 getDoc 兜底)。
  const extractConflictCurrent = useCallback((err: unknown) => {
    if (!(err instanceof ApiError) || err.status !== 409) return undefined;
    try {
      const parsed = JSON.parse(err.body) as { current?: ServerDocState };
      if (parsed.current && typeof parsed.current.body === 'string') return parsed.current;
    } catch { /* 非 JSON body — 无 current,走兜底 */ }
    return undefined;
  }, []);

  // #896: doc-chat 发送前预保存 — 复用 saveDoc 完整语义(带 base_sha 并发
  // 保护),成功后同步服务端基线(serverBodyRef/lastSavedBody);此前裸 PUT
  // 不带 base_sha,多窗口/审阅场景下必然假 409。失败由 hook 侧吞掉(不阻断发送)。
  const presaveForChat = useCallback(async (): Promise<SaveDocResult> => {
    const updated = await saveDoc(title, bodyRef.current);
    lastSavedBody.current = updated.body ?? bodyRef.current;
    serverBodyRef.current = updated.body ?? bodyRef.current;
    return updated;
  }, [saveDoc, title, bodyRef, lastSavedBody, serverBodyRef]);

  const handleSave = useCallback(async () => {
    if (!docId) return;
    // P0 #fix: 文档未加载完成时 Cmd+S 不得落盘 — 此刻 title/body 仍是初始
    // 空串,保存会创建"空正文"新版本。autosave 早已有同样的 doc===null 守卫。
    if (doc === null) return;
    // #895: 审阅未决或写回批次待冲刷时禁止保存 — 防止把审阅前的正文盖回
    // 服务端(覆盖 AI 写回)。接受/放弃落地路径(handleDiffResolve)直连
    // saveDoc,不经过本守卫,落地不受影响。
    // #1043: deck 冲突未决时同样禁止 — 手动保存会以本地 deck 静默覆盖
    // 服务端 AI deck,决策必须经冲突提示条明示。
    // #1066-3: 冲突未决时保存此前静默 return 无反馈 — 明确提示走横幅决策。
    // 此态下 markSaveFailed 回灌的 dirty 无 autosave 消费(autosave 暂停),
    // 兜底路径即横幅按钮本身:「保留我的编辑」force 落盘不依赖 autosave,
    // 失败再回灌 dirty 且横幅保留可重试,无死路。
    if (diffReview !== null || pendingWriteBackRef.current !== null) return;
    // P1 竞态: 快照本次提交的请求体 — 响应回来时只回灌用户没再改过的维度。
    const sentTitle = title;
    const sentBody = body;
    setSaving(true);
    setError(null);
    try {
      // #review-2（红线）: 正文保存绝不携带本地 deck 镜像 — 画布是 deck 唯一
      // 写入方（工件 PUT），本地 deckAsset 在画布保存后必然过期；一并 PUT 会
      // 用旧投影静默覆盖画布刚保存的修改。文档保存只写 title/body。
      const updated = await saveDoc(sentTitle, sentBody);
      const bodyStillCurrent = bodyRef.current === sentBody;
      const titleStillCurrent = titleRef.current === sentTitle;
      lastSavedBody.current = updated.body ?? sentBody;
      serverBodyRef.current = updated.body ?? sentBody;
      lastSavedDeck.current = deckAsset ? JSON.stringify(deckAsset) : lastSavedDeck.current;
      // 仅当本地没有比这次请求更新的输入时才清 dirty — 否则交给 markDirty
      // 保持"未保存"并让 autosave 补一拍把新内容送出。
      if (bodyStillCurrent && titleStillCurrent) {
        dirtyRef.current = false;
        setDirty(false);
      }
      setSaveFailure(null); // #986: 保存成功清常驻警示。
      if (updated.unchanged) {
        // #598: 内容未变化 — 提示且不刷新时间戳.
        showNotice(t('writing.unchanged', '内容未变化，未创建新版本'), 3000);
        setDoc((prev) => prev ? { ...prev, title: updated.title, body: updated.body } : prev);
      } else {
        setDoc((prev) => prev ? { ...prev, title: updated.title, body: updated.body, updated_at: updated.updated_at } : prev);
        // 保存期间用户又编辑 → 保留本地输入（不回灌旧快照）。
        if (titleStillCurrent) setTitle(updated.title);
        if (bodyStillCurrent) setBody(updated.body);
        showNotice(t('writing.savedVersion', '已保存并创建版本'), 3000);
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && err.code === 'stale_base') {
        // #882: 视图过期(僵尸 tab) — 弹冲突横幅由用户决策。
        // #996/#997: 409 payload 的 current 随行 — 双栏对照零额外请求。
        setSaveConflict({ title: sentTitle, body: sentBody, deck: deckAsset ?? undefined, current: extractConflictCurrent(err) });
        showNotice(t('writing.conflictDetected', '文档已在其他窗口被修改，当前窗口内容未保存'), 6000);
      } else {
        // #986: 非冲突失败 → 回灌 dirty + 常驻警示条(autosave 自动重试)。
        markSaveFailed(err);
      }
    } finally {
      setSaving(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- setDirty 为稳定 setter；其余逐项列明
  }, [
    docId, doc, body, title, bodyRef, titleRef, serverBodyRef, lastSavedBody, lastSavedDeck, deckAsset,
    diffReview, pendingWriteBackRef, saveDoc, extractConflictCurrent, markSaveFailed, showNotice, t,
    setDoc, setBody, setTitle, setError, setDirty,
  ]);

  const handleSaveRef = useRef(handleSave);
  handleSaveRef.current = handleSave;

  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      // #review-fix: 富编辑 dirty 一并纳入卸载守护。
      if ((!dirtyRef.current && !deckRichDirtyRef.current) || leaveConfirmed.current) return;
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void handleSaveRef.current();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      window.removeEventListener('keydown', onKeyDown);
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [dirtyRef, deckRichDirtyRef]);

  // #705: autosave（debounce 2.5s）。审阅未决/AI 写回待冲刷/冲突横幅/失败
  // 重试的守卫与抽出前一致。
  useEffect(() => {
    if (!docId || doc === null || !dirty) return;
    if (diffReview !== null || pendingWriteBackRef.current !== null || saveConflict !== null) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      void handleSaveRef.current();
    }, AUTOSAVE_DEBOUNCE_MS);
    return () => { if (saveTimer.current) clearTimeout(saveTimer.current); };
    // #986: saveFailure 计数入依赖 — 保存失败后自动重试(重试仍失败则继续,
    // 直至成功清警示)。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [body, title, docId, dirty, diffReview, saveConflict, saveFailure]);

  /** #705: 有未保存修改时拦截返回，确认后再离开。#review-fix: 富编辑器
   * dirty（画布未保存字节）同入确认门 — 组件侧 onClose 已先走自带保存,
   * 这里是页头返回箭头路径的安全网。 */
  const leaveEditor = useCallback(() => {
    if (!dirtyRef.current && !deckRichDirtyRef.current) { navigate('/app/writing'); return; }
    const ok = window.confirm(t('writing.unsavedLeave', '文档有未保存的修改，确定离开吗？'));
    if (ok) {
      leaveConfirmed.current = true;
      dirtyRef.current = false;
      deckRichDirtyRef.current = false;
      navigate('/app/writing');
    }
  }, [navigate, t, dirtyRef, deckRichDirtyRef]);

  // #882: 冲突横幅动作 — 保留我的版本(force)。
  const resolveConflictKeepMine = useCallback(async () => {
    if (!docId || !saveConflict) return;
    try {
      // #review-2: 冲突保留同样不携带 deck（投影由画布工件路径维护）。
      const updated = await saveDoc(saveConflict.title, saveConflict.body, { force: true });
      lastSavedBody.current = updated.body ?? saveConflict.body;
      serverBodyRef.current = updated.body ?? saveConflict.body;
      setDoc((prev) => prev ? { ...prev, body: updated.body } : prev);
      setSaveConflict(null);
      setSaveFailure(null); // #986: 保存成功清常驻警示。
      showNotice(t('writing.conflictKeptMine', '已保留当前窗口的版本'), 3000);
    } catch (err) {
      // #986: KeepMine 保存失败 → 常驻警示 + dirty 回灌(横幅保留可重试)。
      markSaveFailed(err);
    }
  }, [docId, saveConflict, saveDoc, lastSavedBody, serverBodyRef, setDoc, showNotice, t, markSaveFailed]);

  // #996/#997: 「Use AI's version」— 直接采用 409 payload 携带的服务端当前
  // 态(语义同旧「载入最新」确认审阅的接受分支:服务端已是该版本,无需再保存)。
  const resolveConflictUseSaved = useCallback(() => {
    const fresh = saveConflict?.current;
    if (!fresh) return;
    applyServerDoc(fresh);
    setSaveConflict(null);
    setSaveFailure(null);
    showNotice(t('writing.conflictLoadedLatest', '已载入服务端最新内容'), 3000);
  }, [saveConflict, applyServerDoc, showNotice, t]);

  // #927: 「载入最新」改为 diff 审阅确认 — 本地未保存内容(old)与服务端
  // 最新(new)进 diffReview,用户看到将被丢弃的修改并逐条确认;不再直接
  // setBody 静默丢弃本地编辑。取消则保留本地,冲突横幅仍在。
  // #996/#997: 有 409 payload 时双栏卡的「Use AI's version」已覆盖此场景;
  // 本路径保留为旧后端(无 payload)的兜底。
  const resolveConflictLoadLatest = useCallback(async () => {
    if (!docId || !saveConflict) return;
    try {
      const fresh = await api.getDoc(docId);
      if (fresh.body === bodyRef.current) {
        // 本地与服务端已一致 — 直接收口,无需审阅(完整态一并应用)。
        applyServerDoc(fresh);
        setSaveConflict(null);
        showNotice(t('writing.conflictLoadedLatest', '已载入服务端最新内容'), 3000);
        return;
      }
      conflictLoadRef.current = fresh;
      setDiffReview({ key: `conflict_${Date.now()}`, old: bodyRef.current, next: fresh.body, source: 'conflict', subject: fresh.title });
      // 审阅模式下 markdown diff 不可见 — deck 视图先切回文档视图(同写回路径)。
      setViewMode((m) => (m === 'deck' ? 'document' : m));
    } catch (err) {
      setError(err instanceof ApiError ? err.messageText : String(err));
    }
  }, [docId, saveConflict, bodyRef, conflictLoadRef, applyServerDoc, setDiffReview, setViewMode, setError, showNotice, t]);

  return {
    saving,
    saveConflict,
    saveFailure,
    setSaveConflict,
    setSaveFailure,
    markDirty,
    markSaveFailed,
    saveDoc,
    presaveForChat,
    extractConflictCurrent,
    handleSave,
    leaveEditor,
    resolveConflictKeepMine,
    resolveConflictUseSaved,
    resolveConflictLoadLatest,
  };
}
