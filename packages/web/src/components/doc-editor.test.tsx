import { describe, test, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DocEditor } from './DocEditor';

// TipTap needs a real selection API in jsdom
class FakeRange {
  startContainer: Node = document;
  startOffset = 0;
  endContainer: Node = document;
  endOffset = 0;
  collapsed = true;
  commonAncestorContainer: Node = document;
  setStart() {}
  setEnd() {}
  collapse() {}
  selectNodeContents() {}
  deleteContents() {}
  insertNode() {}
  createContextualFragment = () => document.createDocumentFragment();
  toString = () => '';
}

describe('DocEditor (TipTap canvas)', () => {
  test('#1 markdown loads as editor content (table becomes <table>)', async () => {
    vi.spyOn(document, 'createRange' as any).mockImplementation(() => new FakeRange() as any);
    const md = '# 标题\n\n| 药物 | 剂量 |\n|---|---|\n| A | 100mg |';
    render(<DocEditor value={md} onChange={() => {}} />);
    // wait for the editor to hydrate
    await new Promise((r) => setTimeout(r, 100));
    expect(screen.getByText('药物')).toBeInTheDocument();
    expect(screen.getByText('100mg')).toBeInTheDocument();
  });
});

describe('DocEditor behaviors', () => {
  test('#2/#3 editor edits round-trip to markdown (table insert → pipe rows)', async () => {
    vi.spyOn(document, 'createRange' as any).mockImplementation(() => new FakeRange() as any);
    const onChange = vi.fn();
    render(<DocEditor value="# 标题" onChange={onChange} />);
    await new Promise((r) => setTimeout(r, 100));

    const insertTableBtn = screen.getByTitle('Insert table');
    insertTableBtn.click();
    await new Promise((r) => setTimeout(r, 100));

    // onChange receives markdown containing a GFM table
    const calls = onChange.mock.calls.map((c) => String(c[0]));
    expect(calls.some((md) => md.includes('|') && md.includes('---'))).toBe(true);
  });

  test('#4 AI update: value prop change applies new markdown', async () => {
    vi.spyOn(document, 'createRange' as any).mockImplementation(() => new FakeRange() as any);
    const { rerender, container } = render(<DocEditor value="# 旧标题" onChange={() => {}} />);
    await new Promise((r) => setTimeout(r, 100));

    rerender(<DocEditor value="# 新标题\n\n| A | B |\n|---|---|\n| 1 | 2 |" onChange={() => {}} />);
    await new Promise((r) => setTimeout(r, 400));

    const text = container.querySelector('.ProseMirror')?.textContent ?? '';
    expect(text).toContain('新标题');
    expect(text).toContain('1');
    expect(text).not.toContain('旧标题');
  });
});
