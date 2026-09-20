import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { DeckWire } from '@/lib/types';

/**
 * #1074-3 — deck 冲突/撤销状态机从 writing-editor 路由下沉（仿 bubble.ts/
 * doc-chat.ts 先例：hook + 参数对象 + 返回值；路由只留接线）。
 *
 * 职责（纯机械迁移，行为不变为验收线）：
 * - #1043 deck/正文分叉冲突（deckConflict 未决 → autosave/手动保存暂停，
 *   二选一决策 + 二次确认态）；
 * - #1071-1 deck AI 写回可撤销窗口（落地前内存快照 + TTL 横幅 + force 回滚）；
 * - deck 写回消费 effect（doc_updated.deck → 分叉检测/静默换源）。
 */

export interface DeckConflictInput {
  docId: string | undefined;
  /** deck 资产控制器（useDeckAsset）— 画布状态/基线 refs。 */
  deckAsset: DeckWire | null;
  setDeckAsset: React.Dispatch<React.SetStateAction<DeckWire | null>>;
  lastSavedDeck: React.MutableRefObject<string>;
  appliedDocDeck: React.MutableRefObject<string>;
  deckJson: string;
  /** chat 会话快照中的 lastDocDeck（doc_updated 同帧 deck 写回）。 */
  lastDocDeck: DeckWire | null | undefined;
  /** 保存上下文 — undo/KeepMine 的 force 落盘共用 saveDoc 语义。 */
  title: string;
  body: string;
  saveDoc: (title: string, body: string, opts?: { deck?: unknown; force?: boolean }) => Promise<{ body?: string | null }>;
  serverBodyRef: React.MutableRefObject<string | null>;
  lastSavedBody: React.MutableRefObject<string | null>;
  /** 互斥守卫 — 正文审阅未决/写回待冲刷时不得连带落盘。 */
  diffReview: unknown;
  pendingWriteBackRef: React.MutableRefObject<{ base: string; body: string; timer: ReturnType<typeof setTimeout> | null } | null>;
  /** #986: 保存失败统一处置（回灌 dirty + 常驻警示）。 */
  markSaveFailed: (err: unknown) => void;
  /** #986: 常驻警示清理 — 冲突两出口成功收口时清（与原路由行为一致）。 */
  clearSaveFailure: () => void;
  /** #696: 统一轻提示通道。 */
  onNotice: (text: string, ttlMs?: number) => void;
}

export interface DeckConflict {
  /** #1043: 未决分叉冲突（服务端 AI deck + 其 key）。 */
  deckConflict: { serverDeck: DeckWire; serverDeckKey: string } | null;
  deckConflictConfirm: 'keep' | 'use-ai' | null;
  setDeckConflictConfirm: React.Dispatch<React.SetStateAction<'keep' | 'use-ai' | null>>;
  deckConflictResolving: boolean;
  /** #1071-1: 可撤销窗口（非 null = 横幅可见，TTL 内有效）。 */
  deckUndo: { prevDeck: DeckWire | null } | null;
  /** #1071-1: 撤销窗口出口 — 恢复快照并 force 落盘；返回值 = 落盘是否成功
   *  （#1088: 路由据它联动收口评论侧的待确认态）。 */
  undoDeckWriteBack: () => Promise<boolean>;
  /** #1088: 恢复指定 deck 快照并 force 落盘的共享内核 — 评论确认闭环的
   *  「撤销修改」出口复用（true = 已恢复并落盘成功）。 */
  restoreDeckSnapshot: (prevDeck: DeckWire | null) => Promise<boolean>;
  /** #1088: 收掉 8s 撤销窗口横幅（评论出口先行撤销时调用 — 同一写回不重复出口）。 */
  closeDeckUndoWindow: () => void;
  resolveDeckConflictKeepMine: () => Promise<void>;
  resolveDeckConflictUseAI: () => void;
  /** 切文档双保险 — 冲突/确认/撤销窗口一次清空。 */
  resetForDocSwitch: () => void;
}

export function useDeckConflict(input: DeckConflictInput): DeckConflict {
  const { t } = useTranslation();
  const { docId, deckAsset, setDeckAsset, lastSavedDeck, appliedDocDeck, deckJson, lastDocDeck, title, body, saveDoc, serverBodyRef, lastSavedBody, diffReview, pendingWriteBackRef, markSaveFailed, clearSaveFailure, onNotice } = input;

  // #1043: deck 与正文分叉冲突 — 服务端 AI deck 写回到达而本地有未保存
  // deck 编辑时置位;常驻提示条 + 二选一(保留我的编辑/使用 AI 的版本),
  // 未决策前 autosave/手动保存暂停。此前仅 6 秒 toast 无操作出口,谁生效
  // 完全不确定(#910 遗留半成品)。
  const [deckConflict, setDeckConflict] = useState<{ serverDeck: DeckWire; serverDeckKey: string } | null>(null);
  const [deckConflictConfirm, setDeckConflictConfirm] = useState<'keep' | 'use-ai' | null>(null);
  const [deckConflictResolving, setDeckConflictResolving] = useState(false);
  // #1071-1: deck AI 写回可撤销窗口 — 落地前快照本地画布（内存），横幅给「撤销」。
  // 取舍：DocSnapshot 服务端 API 只收 body（createDocSnapshot(docId, body, label)），
  // 不含 deck、无法用它回滚画布；采用「等价最小实现」：内存快照 + 带「撤销」按钮的
  // 横幅（TTL 内有效，与 toast 同生命周期），撤销 = 恢复本地 deck 并 force 落盘
  // 覆盖服务端 AI 版本（语义同 #1043 KeepMine）。刷新/切文档丢撤销窗口。
  const [deckUndo, setDeckUndo] = useState<{ prevDeck: DeckWire | null } | null>(null);
  const deckUndoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const openDeckUndoWindow = useCallback((prevDeck: DeckWire | null) => {
    if (deckUndoTimer.current) clearTimeout(deckUndoTimer.current);
    setDeckUndo({ prevDeck });
    deckUndoTimer.current = setTimeout(() => setDeckUndo(null), 8000);
  }, []);
  const closeDeckUndoWindow = useCallback(() => {
    if (deckUndoTimer.current) clearTimeout(deckUndoTimer.current);
    deckUndoTimer.current = null;
    setDeckUndo(null);
  }, []);

  // #773: AI deck 写回（edit_deck / organize 落 deck）— 页级小改直接应用
  // + 服务端快照回滚（deck 页是天然结构化单元，整篇 markdown diff 反而难读）。
  // 并发守卫：本地有未保存 deck 编辑时不直接覆盖 — #1043: 常驻冲突提示条
  // (非 6 秒 toast),由用户在「保留我的编辑/使用 AI 的版本」中明示决策。
  // #1071-1: 无分叉的静默换源路径在落地前快照本地画布,开「撤销」窗口 —
  // AI 改错页时用户可在 TTL 内一键回滚（此前仅评论线程收到 AI 说明,无回滚出口）。
  // prevDeck 为 null（首次建 deck）不提供撤销 — 服务端回滚需 force 落盘空 deck,
  // 语义另需产品决策;评论场景 edit_deck 修改的总是已有 deck。
  /**
   * #1088: 恢复指定 deck 快照并 force 落盘 — #1071-1 undoDeckWriteBack 的
   * 共享内核（deck 评论确认闭环的「撤销修改」出口复用同一条快照+force 落盘
   * 语义，见 comments-ai 的 undoDeckWriteBackForComment）。prevDeck 为 null
   * 不动作（无可回滚对象，同 #1071-1 的取舍：评论场景 edit_deck 修改的总是
   * 已有 deck）。返回值 = 落盘是否成功；失败时本地画布已先恢复（#986 常驻
   * 警示 + dirty 回灌，重试保存即可）。
   */
  const restoreDeckSnapshot = useCallback(async (prevDeck: DeckWire | null): Promise<boolean> => {
    if (!docId || !prevDeck) return false;
    setDeckAsset(prevDeck);
    lastSavedDeck.current = JSON.stringify(prevDeck);
    try {
      // force 落盘覆盖服务端 AI 版本（撤销目标 = 落地前已保存状态,base 无并发意义）。
      const updated = await saveDoc(title, body, { deck: prevDeck, force: true });
      lastSavedBody.current = updated.body ?? body;
      serverBodyRef.current = updated.body ?? body;
      onNotice(t('writing.deckUndoDone', '已撤销 AI 的画布修改，恢复为之前版本'), 3000);
      return true;
    } catch (err) {
      // #986 同款:落盘失败 → 常驻警示 + dirty 回灌（本地画布已先恢复,重试保存即可）。
      markSaveFailed(err);
      return false;
    }
  }, [docId, setDeckAsset, lastSavedDeck, saveDoc, title, body, lastSavedBody, serverBodyRef, onNotice, t, markSaveFailed]);

  const undoDeckWriteBack = async (): Promise<boolean> => {
    if (!docId || !deckUndo) return false;
    const prevDeck = deckUndo.prevDeck;
    closeDeckUndoWindow();
    return restoreDeckSnapshot(prevDeck);
  };
  useEffect(() => {
    if (!docId || !lastDocDeck) return;
    const deckKey = JSON.stringify(lastDocDeck);
    if (appliedDocDeck.current === deckKey) return;
    appliedDocDeck.current = deckKey;
    // 本地有未保存编辑且与服务端 AI deck 分叉 → 挂起冲突,等用户决策。
    // #1071-1: 冲突决策 UI 置顶,撤销窗口让位关闭。
    if (deckJson && deckJson !== lastSavedDeck.current && deckJson !== deckKey) {
      closeDeckUndoWindow();
      setDeckConflict({ serverDeck: lastDocDeck, serverDeckKey: deckKey });
      return;
    }
    // 无分叉(本地无未保存编辑) — 静默换源并同步"已保存"基线。
    setDeckConflict(null);
    // #1071-1: 替换了已有画布且内容确实变化时开撤销窗口（deckJson 与 deckAsset
    // 同步派生,deps 已含 deckJson — 闭包取到的 deckAsset 与当前渲染一致）。
    if (deckAsset !== null && deckJson !== deckKey) openDeckUndoWindow(deckAsset);
    lastSavedDeck.current = deckKey;
    setDeckAsset(lastDocDeck);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- ref/稳定 setter(#696 hooks 下沉)
  }, [lastDocDeck, docId, deckJson]);

  // #1043: 「保留我的编辑」— 本地 deck 为权威:force 落盘一次(语义同
  // #882 saveConflict 的 KeepMine),覆盖服务端 AI deck;appliedDocDeck
  // 不动(仍指向已消费的服务端事件 key,幂等守卫不得被破坏)。
  const resolveDeckConflictKeepMine = async () => {
    if (!docId || !deckConflict || deckConflictResolving) return;
    // #895 同款守卫:正文审阅未决时 body 处于审阅前状态,连带 force 落盘
    // 会把审阅前的正文盖回服务端 — 先让用户处理审阅,横幅保留。
    if (diffReview !== null || pendingWriteBackRef.current !== null) {
      setDeckConflictConfirm(null);
      onNotice(t('writing.reviewFirstForDeckConflict', '请先处理当前的 AI 修改审阅，再解决画布冲突'));
      return;
    }
    setDeckConflictResolving(true);
    try {
      const updated = await saveDoc(title, body, { deck: deckAsset ?? undefined, force: true });
      lastSavedBody.current = updated.body ?? body;
      serverBodyRef.current = updated.body ?? body;
      lastSavedDeck.current = deckAsset ? JSON.stringify(deckAsset) : lastSavedDeck.current;
      setDeckConflict(null);
      setDeckConflictConfirm(null);
      clearSaveFailure();
      onNotice(t('writing.deckConflictKeptMine', '已保留本地画布编辑（已成为权威版本）'), 3000);
    } catch (err) {
      // #986 同款:落盘失败 → 常驻警示 + dirty 回灌,横幅保留可重试。
      markSaveFailed(err);
    } finally {
      setDeckConflictResolving(false);
    }
  };

  // #1043: 「使用 AI 的版本」— 丢弃本地未保存编辑,采用服务端 AI deck。
  // 服务端已是权威,无需再保存;dirty 随基线同步自动消除。
  const resolveDeckConflictUseAI = () => {
    if (!deckConflict) return;
    setDeckAsset(deckConflict.serverDeck);
    lastSavedDeck.current = deckConflict.serverDeckKey;
    setDeckConflict(null);
    setDeckConflictConfirm(null);
    clearSaveFailure();
    onNotice(t('writing.deckConflictUsedAI', '已采用 AI 的画布版本'), 3000);
  };

  /** 切文档双保险 — #1072-5: 旧文档未决的画布冲突/确认态/解决中标记/
   *  撤销窗口不得串染新文档（撤销目标 deck 属于旧文档）。 */
  const resetForDocSwitch = useCallback(() => {
    setDeckConflict(null);
    setDeckConflictConfirm(null);
    setDeckConflictResolving(false);
    closeDeckUndoWindow();
  }, [closeDeckUndoWindow]);

  return {
    deckConflict,
    deckConflictConfirm,
    setDeckConflictConfirm,
    deckConflictResolving,
    deckUndo,
    undoDeckWriteBack,
    restoreDeckSnapshot,
    closeDeckUndoWindow,
    resolveDeckConflictKeepMine,
    resolveDeckConflictUseAI,
    resetForDocSwitch,
  };
}
