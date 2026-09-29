/**
 * #983/#1128/#1134 — 结果注入写回编排（从 writing-editor.tsx 拆出，P2 大文件
 * 棘轮）。服务端已落库 + 返回重签 token 的新正文；本地可能持有旧 token 与
 * 未保存编辑：
 *  - 仅 token 轮换（内容等价）→ 不弹审阅，服务端基线推进；
 *  - 真实变化 → 进统一提议卡审阅，next 复用本地同 fileId 的 token（diff
 *    不把 token 轮换显示成改动）；
 *  - 旧后端无 body → getDoc + 三路合并应用增量（冲突进审阅确认）。
 */
import { useCallback } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';
import { normalizeFileDownloadTokens } from '@heurion/contracts';
import { api, ApiError } from '@/lib/api';
import { mergeThreeWay } from '@/lib/doc-merge';
import { reuseLocalFileTokens } from '@/lib/file-url-tokens';
import type { DiffReviewState } from '@/components/DocEditor';
import type { DocDetail } from './types';

export interface UseInjectResultsInput {
  docId?: string;
  injectLabel: string;
  injectResult: string;
  diffReview: DiffReviewState | null;
  pendingWriteBackRef: MutableRefObject<unknown>;
  bodyRef: MutableRefObject<string>;
  serverBodyRef: MutableRefObject<string | null>;
  appliedDocBodyRef: MutableRefObject<string | null>;
  conflictLoadRef: MutableRefObject<DocDetail | null>;
  setInjecting: (v: boolean) => void;
  setInjectOpen: (v: boolean) => void;
  setInjectLabel: (v: string) => void;
  setInjectResult: (v: string) => void;
  setMethodsError: (v: string | null) => void;
  setDiffReview: Dispatch<SetStateAction<DiffReviewState | null>>;
  setViewMode: Dispatch<SetStateAction<'document' | 'deck'>>;
  setChatSelection: Dispatch<SetStateAction<string>>;
  setBody: Dispatch<SetStateAction<string>>;
  setDoc: Dispatch<SetStateAction<DocDetail | null>>;
  showNotice: (text: string, ttlMs?: number) => void;
}

export function useInjectResults(input: UseInjectResultsInput): { handleInjectResults: () => Promise<void> } {
  const { t } = useTranslation();

  const handleInjectResults = useCallback(async () => {
    const { docId, injectLabel, injectResult, diffReview, pendingWriteBackRef, bodyRef,
      serverBodyRef, appliedDocBodyRef, conflictLoadRef } = input;
    if (!docId || !injectLabel.trim() || !injectResult.trim()) return;
    // #983: 审阅未决时注入会与 diffReview 驱动的编辑器内容互相踩踏 — 明示
    // 先完成当前审阅。
    if (diffReview !== null || pendingWriteBackRef.current !== null) {
      input.showNotice(t('writing.reviewFirstForMethods', '请先完成当前 AI 修改的审阅，再生成内容'));
      return;
    }
    input.setInjecting(true);
    try {
      const res = await api.injectResults(docId, injectLabel.trim(), injectResult.trim());
      const subject = injectLabel.trim();
      // #996/#997: 服务端返回写回后的新正文 + 同帧投影 — 注入结果直接路由进
      // 统一提议卡(#998: results 表头),与 AI 写回同语义(先落库后审阅,
      // 放弃 = 反向保存回滚);此前 {ok} 后自行 GET 全文三路合并/静默应用。
      if (typeof res.body === 'string') {
        serverBodyRef.current = res.body;
        appliedDocBodyRef.current = res.body;
        // #1134: 注入结果返回的是重签 token 的服务端正文;本地同时持有旧
        // token。仅 token 不同不弹审阅;真实变化进审阅时用本地同 fileId 的
        // token 复用,避免每条下载链接都被显示成改动。
        const localNorm = normalizeFileDownloadTokens(bodyRef.current);
        const serverNorm = normalizeFileDownloadTokens(res.body);
        if (serverNorm !== localNorm) {
          const next = reuseLocalFileTokens(bodyRef.current, res.body);
          input.setDiffReview({ key: `inject_${Date.now()}`, old: bodyRef.current, next, source: 'results', subject });
          input.setViewMode((m) => (m === 'deck' ? 'document' : m));
          input.setChatSelection('');
        } else {
          // 内容等价(如重复注入、仅 token 轮换)— 本地保持(旧 token 仍有效),
          // 服务端基线已推进。
          input.showNotice(t('writing.unchanged', '内容未变化，未创建新版本'), 3000);
        }
      } else {
        // 旧后端兜底(响应无 body):沿用 getDoc + 三路合并路径。
        const d = await api.getDoc(docId);
        // #983: 服务端已在「服务端正文 + 注入块」上落库（writeDocVersion 单点）。
        // 本地改用三路合并应用增量 — 此前「拉最新 body 整篇覆盖」会静默吞掉
        // 本地未保存修改。base = 最后同步的服务端正文,ours = 本地(可能含
        // 未保存编辑),theirs = 注入后的服务端正文。
        const base = serverBodyRef.current ?? bodyRef.current;
        const merged = mergeThreeWay(base, bodyRef.current, d.body);
        if (merged === null) {
          // 注入块与本地未保存修改在基线坐标上重叠 → 三路合并不安全:
          // 进冲突确认审阅（接受 = 采用服务端版本,不再保存;取消 = 保留本地,
          // 后续保存经 base_sha 失配 409 走冲突横幅），绝不静默覆盖任一侧。
          conflictLoadRef.current = d;
          input.setDiffReview({ key: `inject_${Date.now()}`, old: bodyRef.current, next: d.body, source: 'results', subject });
          input.setViewMode((m) => (m === 'deck' ? 'document' : m));
          input.showNotice(t('writing.injectConflictReview', '结果注入与本地未保存修改冲突 — 已进入审阅确认'), 6000);
        } else {
          // 服务端视角基线推进到注入后的正文 — 后续保存的 base_sha 指纹正确。
          serverBodyRef.current = d.body;
          if (merged !== bodyRef.current) input.setBody(merged);
          input.setDoc((prev) => (prev ? { ...prev, body: merged, updated_at: d.updated_at } : prev));
        }
      }
      input.setInjectOpen(false);
      input.setInjectLabel('');
      input.setInjectResult('');
    } catch (err) {
      input.setMethodsError(err instanceof ApiError ? err.messageText : String(err));
    } finally {
      input.setInjecting(false);
    }
  }, [input, t]);

  return { handleInjectResults };
}
