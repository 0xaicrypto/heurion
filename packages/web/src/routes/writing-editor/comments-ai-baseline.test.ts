import { describe, test, expect } from 'vitest'
import { armDeckVersionAtTurnStart } from './comments-ai';

/**
 * #review-6 — deck 评论收口基线的轮开始 re-arm。
 *
 * 场景：A、B 两条 deck 评论排队；A 的那轮先执行并推高了工件版本；B 自己
 * 那轮实际是 no-op（工具报错/模型拒绝）。若 B 的基线仍停留在登记时（A 写
 * 之前）的版本，turn 收口会把 A 的写回算到 B 头上 → 误报「已按评论意见
 * 修改」。轮开始时按「本轮指令」精确重取基线后，B 的 no-op 会被如实判失败。
 */
describe('#review-6 armDeckVersionAtTurnStart', () => {
  const entry = (instruction: string, target: 'section' | 'deck_slide' = 'deck_slide') => ({
    target,
    instruction: instruction,
    deckVersionAtStart: 'v-before-A',
  });

  test('只重写「本轮指令」匹配的 deck 评论基线（排队前排写回不计入）', () => {
    const pending = new Map<string, ReturnType<typeof entry>>([
      ['A', entry('指令 A')],
      ['B', entry('指令 B')],
      ['C', entry('指令 C', 'section')],
    ]);
    const armed = armDeckVersionAtTurnStart(pending, '指令 B', 'v-after-A');
    expect(armed).toBe(1);
    expect(pending.get('B')!.deckVersionAtStart).toBe('v-after-A');
    // A 的登记未被本轮污染（它自己的轮次尚未开始）。
    expect(pending.get('A')!.deckVersionAtStart).toBe('v-before-A');
    // 正文评论不参与 deck 版本基线。
    expect(pending.get('C')!.deckVersionAtStart).toBe('v-before-A');
  });

  test('无当前指令（会话首帧/附件提示）→ 不重写任何登记', () => {
    const pending = new Map([['A', entry('指令 A')]]);
    expect(armDeckVersionAtTurnStart(pending, null, 'v2')).toBe(0);
    expect(pending.get('A')!.deckVersionAtStart).toBe('v-before-A');
  });

  test('同指令并发（同文案多评论）→ 一并 re-arm（无法区分，同基线是保守解）', () => {
    const pending = new Map([['A', entry('同指令')], ['B', entry('同指令')]]);
    const armed = armDeckVersionAtTurnStart(pending, '同指令', 'v2');
    expect(armed).toBe(2);
    expect(pending.get('A')!.deckVersionAtStart).toBe('v2');
    expect(pending.get('B')!.deckVersionAtStart).toBe('v2');
  });
});
