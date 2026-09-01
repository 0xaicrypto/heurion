import { describe, test, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { BubbleResultPanel, type BubbleRunLike } from './BubbleResultPanel';

const baseRun: BubbleRunLike = {
  status: 'done',
  stream: 'AI 原始结果',
  reasoning: '',
  error: null,
  startedAt: Date.now(),
};

/**
 * #778 回归:润色结果面板 — done 态可直接编辑,「替换选中」应用的是
 * 用户手上的最终版;refine 输入把新要求 + 当前版本发回 polish 管线。
 */
describe('BubbleResultPanel (#778)', () => {
  test('done 态 textarea 预填 AI 结果,编辑后 onApply 收到最终版', () => {
    const onApply = vi.fn();
    render(
      <BubbleResultPanel
        run={baseRun}
        onApply={onApply}
        onDiscard={() => {}}
        onRetry={() => {}}
        onRefine={() => {}}
      />,
    );
    const boxes = screen.getAllByRole('textbox') as HTMLTextAreaElement[];
    const box = boxes.find((b) => b.value === 'AI 原始结果')!;
    fireEvent.change(box, { target: { value: '用户手改的最终版' } });
    fireEvent.click(screen.getByText(/替换选中/));
    expect(onApply).toHaveBeenCalledWith('用户手改的最终版');
  });

  test('refine 提交携带新指令 + 用户改过的当前版本', () => {
    const onRefine = vi.fn();
    render(
      <BubbleResultPanel
        run={{ ...baseRun, round: 1 }}
        onApply={() => {}}
        onDiscard={() => {}}
        onRetry={() => {}}
        onRefine={onRefine}
      />,
    );
    // 第二个 textbox = refine 输入框
    const boxes = screen.getAllByRole('textbox') as HTMLTextAreaElement[];
    const refine = boxes.find((b) => b.value === '')!;
    fireEvent.change(refine, { target: { value: '再压缩一半' } });
    fireEvent.click(screen.getByText(/继续/));
    expect(onRefine).toHaveBeenCalledWith('再压缩一半', 'AI 原始结果');
    // 空指令不可提交
    fireEvent.click(screen.getByText(/继续/));
    expect(onRefine).toHaveBeenCalledTimes(1);
  });

  test('running 态不出现编辑框与替换按钮', () => {
    render(
      <BubbleResultPanel
        run={{ ...baseRun, status: 'running', stream: 'partial' }}
        onApply={() => {}}
        onDiscard={() => {}}
        onRetry={() => {}}
        onRefine={() => {}}
      />,
    );
    expect(screen.queryByText(/替换选中/)).toBeNull();
    expect(screen.getByText(/取消/)).toBeInTheDocument();
  });
});
