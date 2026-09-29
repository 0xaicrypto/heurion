import { describe, test, expect } from 'vitest';

/**
 * #1145 — App 路由代码分割的源码级回归：
 * 入口包曾 3.1MB（30+ 页面静态 import，连带 cytoscape/katex/tiptap 首屏加载）。
 * 修复后仅 landing/login 可静态导入，其余业务路由必须 React.lazy。
 */
const SRC = import.meta.glob('../App.tsx', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

describe('#1145 路由代码分割', () => {
  const app = SRC['../App.tsx'];

  test('除 landing/login 外无静态 @/routes 导入', () => {
    const staticRouteImports = app.match(/import\s+\{[^}]*\}\s+from\s+'@\/routes\/[^']+'/g) ?? [];
    const allowed = staticRouteImports.filter((line) => /@\/routes\/(landing|login)'/.test(line));
    expect(
      staticRouteImports.length,
      `eager route imports (含首屏依赖): ${staticRouteImports.join('; ')}`,
    ).toBe(allowed.length);
    expect(allowed.length).toBeGreaterThanOrEqual(2); // landing + login 保留急加载
  });

  test('业务路由经 lazy() 分割并由 Suspense 兜底', () => {
    const lazies = app.match(/lazy\(\(\) => import\('@\/routes\//g) ?? [];
    expect(lazies.length).toBeGreaterThanOrEqual(25);
    expect(app).toContain('Suspense');
  });
});
