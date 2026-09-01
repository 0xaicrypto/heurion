import { describe, test, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { KbPicker, type KbPickerItem } from './KbPicker';

vi.mock('@/lib/api', () => ({
  api: {
    getKnowledgePicker: vi.fn(async () => ({
      articles: [
        { id: 'a1', title: '_km 文章', summary: 's', kind: 'article' },
        { id: 'd1', title: 'km 文件', summary: 's', kind: 'document' },
      ] satisfies KbPickerItem[],
    })),
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
        initialItems={[{ id: 'a1', title: '_km 文章', summary: 's', kind: 'article' }]}
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
          { id: 'a1', title: '_km 文章', summary: 's', kind: 'article' },
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
