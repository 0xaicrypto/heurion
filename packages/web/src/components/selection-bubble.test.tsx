import { describe, test, expect, vi, beforeAll } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import type { ReactNode } from 'react';
import type { Editor } from '@tiptap/react';
import i18n from '@/i18n';
import { SelectionBubble } from './selection-bubble';

// #1097: 气泡菜单精简回归 — UI 仅保留 ✨润色(+添加评论);改写/更学术/
// 总结 按钮下线,但 preset 分发机制(handleBubbleAction/POLISH_PRESETS)
// 保留为机制锚点。BubbleMenu 浮层内容在 jsdom 经 portal 渲染于插件管理
// 的容器外,这里以透传组件替身让子树直接可查。
vi.mock('@tiptap/react/menus', () => ({
  BubbleMenu: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));

const fakeEditor = () => ({
  state: {
    selection: { from: 0, to: 8 },
    doc: { textBetween: () => 'selected text' },
  },
  isActive: () => false,
  getAttributes: () => ({}),
  can: () => ({ undo: () => false, redo: () => false, addRowAfter: () => false, deleteRow: () => false }),
  on: () => {},
  off: () => {},
}) as unknown as Editor;

const renderBubble = (onAction = vi.fn(), onAddComment?: () => void) =>
  render(
    <I18nextProvider i18n={i18n}>
      <SelectionBubble
        editor={fakeEditor()}
        isReviewing={() => false}
        run={null}
        onAction={onAction}
        onStart={() => {}}
        onApply={() => {}}
        onDiscard={() => {}}
        onRetry={() => {}}
        onRefine={() => {}}
        onAddComment={onAddComment}
      />
    </I18nextProvider>,
  );

describe('#1097 气泡菜单精简(仅润色 + 添加评论)', () => {
  beforeAll(async () => {
    await i18n.changeLanguage('zh-CN');
  });

  test('保留 润色 按钮', () => {
    renderBubble();
    expect(screen.getByTitle('润色')).toBeTruthy();
  });

  test('移除 改写/更学术/总结 按钮', () => {
    renderBubble();
    expect(screen.queryByTitle('改写')).toBeNull();
    expect(screen.queryByTitle('更学术')).toBeNull();
    expect(screen.queryByTitle('总结')).toBeNull();
  });

  test('添加评论 按钮存在且位于最后', () => {
    renderBubble(undefined, () => {});
    const add = screen.getByTestId('bubble-add-comment');
    expect(add).toBeTruthy();
    const toolbar = add.parentElement!;
    const buttons = Array.from(toolbar.querySelectorAll(':scope > button'));
    expect(buttons[buttons.length - 1]).toBe(add);
  });

  test('点击润色按钮分发 onAction("polish", 选区)', () => {
    const onAction = vi.fn();
    renderBubble(onAction);
    fireEvent.pointerDown(screen.getByTitle('润色'));
    expect(onAction).toHaveBeenCalledWith('polish', { text: 'selected text', from: 0, to: 8 });
  });
});
