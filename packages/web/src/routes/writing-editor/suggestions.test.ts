import { describe, test, expect } from 'vitest';
import type { TFunction } from 'i18next';
import { suggestionReasonText } from './suggestions';

/** #1036: 建议原因本地化 — code → i18n，旧数据回退服务端原文。 */

const fakeT = ((key: string, opts?: Record<string, unknown>) => `${key}|${JSON.stringify(opts ?? {})}`) as unknown as TFunction;

describe('#1036 suggestionReasonText', () => {
  test('opening_keyword 带 score 走 i18n', () => {
    const out = suggestionReasonText({ reason: '开局关键词命中（相关度 3）', reasonCode: 'opening_keyword', score: 3 }, fakeT);
    expect(out).toContain('chat.suggestReasonOpening');
    expect(out).toContain('"score":3');
  });

  test('conversation_semantic 走 i18n', () => {
    const out = suggestionReasonText({ reason: '对话内容命中未引用材料', reasonCode: 'conversation_semantic', score: null }, fakeT);
    expect(out).toContain('chat.suggestReasonConversation');
  });

  test('旧数据（无 code）回退服务端原文', () => {
    expect(suggestionReasonText({ reason: '历史原因文本', reasonCode: null, score: null }, fakeT)).toBe('历史原因文本');
    expect(suggestionReasonText({ reason: '历史原因文本', score: null }, fakeT)).toBe('历史原因文本');
  });
});
