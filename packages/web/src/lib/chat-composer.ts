/**
 * #653 — shared chat-composer behavior kernel.
 * The three composer surfaces (chat / patient-chat / doc-chat) drifted in
 * surrounding panels, but this behavior was copy-pasted verbatim:
 */

/** IME-safe Enter-to-send — #704: 组词阶段按 Enter 确认候选词,不能触发发送。 */
export function isEnterSendKey(e: React.KeyboardEvent<HTMLTextAreaElement>): boolean {
  if (e.nativeEvent.isComposing || e.keyCode === 229) return false;
  return e.key === 'Enter' && !e.shiftKey;
}
