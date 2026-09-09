import { describe, test, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { KbPicker, type KbPickerItem } from './KbPicker';

// vi.mock 工厂被提升到文件顶 — mock 函数必须经 vi.hoisted 创建。
const pickerMock = vi.hoisted(() => vi.fn(async () => ({
  summaries: [
    { id: 'a1', title: '_km 文章', summary: 's', kind: 'summary' },
    { id: 'd1', title: 'km 文件', summary: 's', kind: 'document' },
  ] satisfies KbPickerItem[],
})));

vi.mock('@/lib/api', () => ({
  api: {
    getKnowledgePicker: pickerMock,
  },
}));

/**
 * #786 回归: initialItems 必须在打开时播种勾选态 — 旧实现只做了比较
 * 从未 setPicked,chat 页重开弹窗时上次勾选永远不回显。
 */
describe('KbPicker pre-selection (#786)', () => {
  test('打开时 initialItems 显示为已勾选', async () => {
    render(
      <KbPicker
        open
        onClose={() => {}}
        onConfirm={() => {}}
        initialItems={[{ id: 'a1', title: '_km 文章', summary: 's', kind: 'summary' }]}
      />,
    );
    // 等搜索结果渲染出 checkbox 行
    const boxes = (await screen.findAllByRole('checkbox')) as HTMLInputElement[];
    const checked = boxes.filter((b) => b.checked);
    expect(checked).toHaveLength(1);
    // 未播种的行保持未勾选
    expect(boxes.find((b) => !b.checked)).toBeTruthy();
  });

  test('无 initialItems 时打开为全空勾选', async () => {
    render(<KbPicker open onClose={() => {}} onConfirm={() => {}} />);
    const boxes = (await screen.findAllByRole('checkbox')) as HTMLInputElement[];
    expect(boxes.every((b) => !b.checked)).toBe(true);
  });

  test('取消勾选后确认,confirm 回传最终选择', async () => {
    const onConfirm = vi.fn();
    render(
      <KbPicker
        open
        onClose={() => {}}
        onConfirm={onConfirm}
        initialItems={[
          { id: 'a1', title: '_km 文章', summary: 's', kind: 'summary' },
          { id: 'd1', title: 'km 文件', summary: 's', kind: 'document' },
        ]}
      />,
    );
    const boxes = await screen.findAllByRole('checkbox');
    fireEvent.click(boxes[0]); // 取消第一个
    fireEvent.click(screen.getByRole('button', { name: /完成/ }));
    expect(onConfirm).toHaveBeenCalledWith([
      expect.objectContaining({ id: 'd1' }),
    ]);
  });
});

/** #932 回归: 结果按类型分组 — 总结(📝)与文件(📎)两个 section,组内保持相关性排序。 */
describe('KbPicker grouping by type (#932)', () => {
  test('总结与文件分别成组,组头带计数', async () => {
    render(
      <KbPicker
        open
        onClose={() => {}}
        onConfirm={() => {}}
      />,
    );
    expect(await screen.findByText(/总结 \(1\)/)).toBeTruthy();
    expect(screen.getByText(/文件 \(1\)/)).toBeTruthy();
    // 两行 checkbox 都渲染
    const boxes = (await screen.findAllByRole('checkbox')) as HTMLInputElement[];
    expect(boxes).toHaveLength(2);
  });

  test('只有总结时不出文件分组头', async () => {
    pickerMock.mockResolvedValueOnce({
      summaries: [{ id: 'a2', title: '仅总结', summary: 's', kind: 'summary' }],
    });
    render(<KbPicker open onClose={() => {}} onConfirm={() => {}} />);
    expect(await screen.findByText(/总结 \(1\)/)).toBeTruthy();
    expect(screen.queryByText(/文件 \(/)).toBeNull();
  });
});
