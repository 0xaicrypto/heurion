import { describe, test, expect, vi, afterEach } from 'vitest';
import React, { StrictMode } from 'react';
import { render, screen, fireEvent, waitFor, act, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PluginUIProvider, type HeurionPluginRuntime } from './PluginUIRegistry';
import { PluginExtensionPoint } from './PluginExtensionPoint';

/**
 * #1135 回归 — closed shadow root 下的 PluginHost:
 * 旧守卫 `if (host.shadowRoot) return` 在 closed 模式恒为 null,StrictMode
 * 双跑 effect / 父组件重渲染(调用方内联 context 对象)会二次 attachShadow
 * 抛 NotSupportedError,RouteBoundary 捕获后整页「出错了」。
 * 修复:ref 缓存 root 复用 + context 内容 key 稳定 effect。
 */
vi.mock('@/lib/api', () => ({
  ApiError: class ApiError extends Error {},
  api: {
    hasToken: () => true,
    getToken: () => 't',
    getClientApiVersion: () => 1,
    listInstalledUIPlugins: vi.fn(async () => ({ plugins: [] })),
  },
}));

type Runtime = HeurionPluginRuntime;

function runtime(): Runtime {
  return (window as unknown as { __HEURION_PLUGIN_RUNTIME__: Runtime }).__HEURION_PLUGIN_RUNTIME__;
}

function Harness() {
  const [, setN] = React.useState(0);
  return (
    <>
      <button onClick={() => setN((n) => n + 1)}>bump</button>
      {/* 调用方真实形态:内联 context 对象,每次渲染新引用 */}
      <PluginExtensionPoint point="chat_toolbar" context={{ route: '/app/chat', extra: { a: 1 } }} />
    </>
  );
}

afterEach(() => {
  cleanup();
  delete (window as unknown as { __HEURION_PLUGIN_RUNTIME__?: Runtime }).__HEURION_PLUGIN_RUNTIME__;
  vi.clearAllMocks();
});

describe('#1135 PluginExtensionPoint closed shadow root 稳定性', () => {
  test('StrictMode 双跑 + 父组件重渲染:不崩溃、插件 DOM 不重建', async () => {
    const factory = vi.fn(() => {
      const el = document.createElement('div');
      el.textContent = 'plugin-ui';
      return el;
    });

    const { container } = render(
      <MemoryRouter>
        <StrictMode>
          <PluginUIProvider>
            <Harness />
          </PluginUIProvider>
        </StrictMode>
      </MemoryRouter>,
    );

    await waitFor(() => expect((window as unknown as { __HEURION_PLUGIN_RUNTIME__?: Runtime }).__HEURION_PLUGIN_RUNTIME__).toBeTruthy());
    act(() => {
      const rt = runtime();
      rt.__currentPluginId = 'p1';
      rt.register('chat_toolbar', factory);
    });

    await waitFor(() => {
      expect(container.querySelector('[data-plugin-id="p1"]')).toBeTruthy();
    });
    const callsAfterMount = factory.mock.calls.length;
    expect(callsAfterMount).toBeGreaterThanOrEqual(1);

    // 父组件重渲染 → 修复前 effect 重跑二次 attachShadow 抛错(整页崩)
    fireEvent.click(screen.getByText('bump'));
    await act(async () => {});
    expect(container.querySelector('[data-plugin-id="p1"]')).toBeTruthy();
    // context 内容未变 → 插件 DOM 不重建(每键重挂载抖动消除)
    expect(factory.mock.calls.length).toBe(callsAfterMount);
  });
});
