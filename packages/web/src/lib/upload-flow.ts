import { api } from '@/lib/api';

/**
 * #922 重复实现收敛 — "上传 → 挂附件 → dedup 提示 → 入聊天记录 → 记附件日志"
 * 公共流程(chat.tsx handleFile/handlePaste 与 writing-editor/doc-chat.ts
 * attachUploaded 三份复制收敛为一;handleDocUpload 的 doc 专属部分留在调用点)。
 * store action / 回调全部注入,本模块不耦合具体页面状态。
 */

export interface UploadedFileResult {
  file_id: string;
  name: string;
  dedup?: boolean;
}

export interface UploadFlowHooks {
  /** 附件落库(store action 注入 — chat 按会话 Map,doc-chat 平铺数组)。 */
  addAttached: (entry: { name: string; fileId: string }) => void;
  /** #619 dedup 命中提示 setter(4s 后由本流程自动清空)。 */
  setKbDedupNotice: (text: string | null) => void;
  /** 上传即入聊天记录(store action 注入;sessionId 为空则跳过)。 */
  appendMessage: (
    sessionId: string,
    message: { id: string; role: 'user'; text: string; createdAt: number },
  ) => void;
}

export interface UploadFlowOptions {
  /** 附件/聊天记录归属会话;空串 = 只挂附件、不入聊天记录。 */
  sessionId: string;
  /**
   * TODO(#922 i18n): dedup 提示文案 i18n 化不在本 issue 范围 — 缺省保持
   * 原硬编码中文字符串(chat.tsx 现状);doc-chat 传 t('writing.kbDedup',…)
   * 保持其已有 i18n 行为。
   */
  dedupNoticeText?: (name: string) => string;
}

/**
 * 执行公共上传落地流程。upload() 由调用点提供(各自的上传实现:
 * 裸 api.uploadFile + 进度条 / uploadWithProgress 阶段机 + 可取消),
 * 本函数只负责上传成功后的公共落地。
 */
export async function runUploadAttachFlow(
  upload: () => Promise<UploadedFileResult>,
  hooks: UploadFlowHooks,
  options: UploadFlowOptions,
): Promise<UploadedFileResult> {
  const result = await upload();
  const { name, file_id: fileId } = result;

  hooks.addAttached({ name, fileId: fileId });

  // #619: 上传命中知识库(sha256 dedup)→ 提示,4s 自动消失(两处原实现同款)。
  if (result.dedup) {
    const text = options.dedupNoticeText
      ? options.dedupNoticeText(name)
      : `📚 已在知识库,已加入上下文: ${name}`;
    hooks.setKbDedupNotice(text);
    setTimeout(() => hooks.setKbDedupNotice(null), 4000);
  }

  // #598/#fix: 上传即入聊天历史(与服务端 user_message 事件一致),刷新后仍可见。
  if (options.sessionId) {
    hooks.appendMessage(options.sessionId, {
      id: crypto.randomUUID(),
      role: 'user',
      text: `[📎 已上传] ${name}`, // TODO(#922 i18n): 文案 i18n 化不在本 issue 范围。
      createdAt: Date.now(),
    });
    api.logAttachments(options.sessionId, [{ name, file_id: fileId }]).catch(() => {});
  }

  return result;
}
