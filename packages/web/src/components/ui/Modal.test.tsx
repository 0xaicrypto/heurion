import { describe, test, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Modal } from './Modal';

/**
 * #408-followup — 共享 Modal 的 Portal/关闭行为/层级 token。
 * 此前 writing-editor 的弹窗各自手写 fixed 包裹层,内联渲染且硬编码
 * z-50;Portal + z-modal token 是弹窗基础设施收敛的回归护栏。
 */
describe('Modal — 共享弹窗外壳', () => {
  test('open=false 不渲染;open=true 经 Portal 挂到 document.body', () => {
    const { container, rerender } = render(
      <Modal open={false}>
        <div data-testid="panel" />
      </Modal>,
    );
    expect(screen.queryByTestId('panel')).toBeNull();

    rerender(
      <Modal open>
        <div data-testid="panel" />
      </Modal>,
    );
    expect(screen.getByTestId('panel')).toBeTruthy();
    // Portal: 渲染容器里没有弹窗节点,节点在 body 下。
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
    // 层级 token 默认 z-modal(tailwind zIndex 扩展),不再散落 z-50 硬编码。
    expect((document.body.querySelector('[role="dialog"]') as HTMLElement).className).toContain('z-modal');
  });

  test('escClose=true 时 Esc 关闭,缺省不响应', () => {
    const onClose = vi.fn();
    const { rerender } = render(<Modal open onClose={onClose}>x</Modal>);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled(); // escClose 缺省 false

    rerender(<Modal open onClose={onClose} escClose>x</Modal>);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test('backdropClose=true 仅点击遮罩空白处关闭,面板内点击不关闭', () => {
    const onClose = vi.fn();
    render(
      <Modal open onClose={onClose} backdropClose>
        <div data-testid="panel">content</div>
      </Modal>,
    );
    fireEvent.click(screen.getByTestId('panel'));
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(document.body.querySelector('[role="dialog"]') as HTMLElement);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
