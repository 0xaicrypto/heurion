/**
 * #1142 — deck 保存 409 冲突的用户决策流（从 deck-rich-editor.tsx 拆出，
 * P2 大文件棘轮）。
 *
 * 旧行为：409 后只把 `lastVersionRef` 换成最新版本号，2.5s 后把本地整包
 * 原样重新 PUT — 静默覆盖 AI 回合/其他标签页刚写入的幻灯片，无痕迹丢失，
 * 文案却称「已基于最新版本继续保存」。
 *
 * 现行为：拉取服务端最新字节存快照，交用户显式选择：
 *  - 保留我的：显式覆盖（覆盖前自动把服务端版本另存为快照文件）；
 *  - 载入最新：画布替换为服务端字节，丢弃本地未保存修改；
 *  - 另存快照：只下载服务端版本，不解决冲突。
 * 绝不自动重试覆盖。
 */
import { useCallback, useEffect, useState } from 'react';
import type { MutableRefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { api, ApiError } from '@/lib/api';
import { downloadBlob } from '@/lib/download';

export interface DeckConflictSnapshot {
  serverBytes: Uint8Array;
  serverVersion: string;
}

const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

/** Uint8Array → pptx Blob（slice 出独立 ArrayBuffer，规避 SharedArrayBuffer 泛型）。 */
export function deckBytesBlob(bytes: Uint8Array): Blob {
  return new Blob([bytes.slice().buffer as ArrayBuffer], { type: PPTX_MIME });
}

export function deckConflictFileName(version: string): string {
  return `deck-conflict-${version.replace(/[\\/:*?"<>|]/g, '_')}.pptx`;
}

export interface UseDeckConflictInput {
  docId: string;
  bytesRef: MutableRefObject<Uint8Array | null>;
  lastVersionRef: MutableRefObject<string | undefined>;
  generationRef: MutableRefObject<number>;
  savingRef: MutableRefObject<boolean>;
  turnUndoRef: MutableRefObject<{ aiVersion: string } | null>;
  onSlideCountChangeRef: MutableRefObject<((n: number | null) => void) | undefined>;
  mountedRef: MutableRefObject<boolean>;
  setContent: (bytes: Uint8Array) => void;
  setTurnUndo: (v: boolean) => void;
  applyDirty: (dirty: boolean) => void;
  onNotice?: (text: string, ttlMs?: number) => void;
}

export function useDeckConflict(input: UseDeckConflictInput) {
  const { t } = useTranslation();
  const { docId } = input;
  const [conflict, setConflict] = useState<DeckConflictSnapshot | null>(null);

  // 切文档：冲突快照作废（旧文档的服务端字节不得串染新画布）。
  useEffect(() => { setConflict(null); }, [docId]);

  /** 409 捕获：拉服务端新字节存快照 + 保持 dirty，等用户选择（无自动重试）。 */
  const captureConflict = useCallback(async () => {
    const { mountedRef, applyDirty, onNotice } = input;
    applyDirty(true);
    try {
      const latest = await api.getDeckArtifact(docId);
      const r = await fetch(latest.download_url);
      if (!r.ok) throw new ApiError(r.status, '', latest.download_url);
      const serverBytes = new Uint8Array(await r.arrayBuffer());
      if (!mountedRef.current) return;
      setConflict({ serverBytes, serverVersion: latest.version });
      onNotice?.(
        t('writing.deckConflictChoose', 'deck 已被其他窗口/AI 修改 — 已保留服务端新版本为快照，请选择「保留我的 / 载入最新 / 另存快照」'),
        8000,
      );
    } catch {
      if (!mountedRef.current) return;
      onNotice?.(t('writing.deckRichEditConflict', 'deck 工件已被其他窗口修改，请重试'), 6000);
    }
  }, [input, docId, t]);

  /** 保留我的：显式覆盖；覆盖前把服务端版本另存快照（不静默丢数据）。 */
  const keepMine = useCallback(async () => {
    const {
      bytesRef, lastVersionRef, savingRef, turnUndoRef,
      onSlideCountChangeRef, setTurnUndo, applyDirty, onNotice,
    } = input;
    const bytes = bytesRef.current;
    if (!conflict || !bytes || savingRef.current) return;
    savingRef.current = true;
    try {
      try {
        downloadBlob(deckBytesBlob(conflict.serverBytes), deckConflictFileName(conflict.serverVersion));
      } catch { /* 下载不可用（无 DOM/object URL）不阻塞覆盖 */ }
      const res = await api.putDeckArtifact(docId, bytes, conflict.serverVersion);
      lastVersionRef.current = res.version;
      onSlideCountChangeRef.current?.(res.slide_count ?? null);
      if (turnUndoRef.current && res.version !== turnUndoRef.current.aiVersion) {
        turnUndoRef.current = null;
        setTurnUndo(false);
      }
      setConflict(null);
      applyDirty(false);
      onNotice?.(t('writing.deckConflictKeptMine', '已用你的版本覆盖 — 服务端旧版本已另存为快照文件'), 6000);
    } catch (err) {
      // #1150-followup: 冲突快照之后服务端又有更新 → 覆盖基线的乐观锁再次
      // 失败。刷新冲突快照(新版本/新字节)并提示用户,不做自动循环覆盖。
      if (err instanceof ApiError && err.status === 409) {
        await captureConflict();
        onNotice?.(t('writing.deckConflictKeepStale', '服务端又有更新 — 已刷新冲突快照，请重试或载入最新'), 6000);
      } else {
        onNotice?.(t('writing.deckConflictKeepFail', '覆盖失败，请重试'), 6000);
      }
    } finally {
      savingRef.current = false;
    }
  }, [input, conflict, docId, t, captureConflict]);

  /** 载入最新：画布替换为服务端字节，本地未保存修改丢弃（用户显式选择）。 */
  const loadLatest = useCallback(() => {
    const { bytesRef, lastVersionRef, generationRef, setContent, applyDirty, onNotice } = input;
    if (!conflict) return;
    bytesRef.current = conflict.serverBytes;
    lastVersionRef.current = conflict.serverVersion;
    // 代数前移：任何在飞保存的迟到守护不得把状态误清为「已同步」。
    generationRef.current += 1;
    setContent(conflict.serverBytes);
    setConflict(null);
    applyDirty(false);
    onNotice?.(t('writing.deckConflictLoadedLatest', '已载入服务端最新版本；你未保存的修改已丢弃'), 5000);
  }, [input, conflict, t]);

  /** 另存快照：只下载服务端版本，冲突保持未决（用户可继续选择）。 */
  const saveSnapshot = useCallback(() => {
    if (!conflict) return;
    downloadBlob(deckBytesBlob(conflict.serverBytes), deckConflictFileName(conflict.serverVersion));
    input.onNotice?.(t('writing.deckConflictSnapshotSaved', '已另存服务端版本快照（冲突仍未解决，可继续选择覆盖或载入）'), 5000);
  }, [input, conflict, t]);

  return { conflict, captureConflict, keepMine, loadLatest, saveSnapshot };
}
