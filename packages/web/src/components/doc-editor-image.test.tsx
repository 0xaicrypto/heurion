import { describe, test, expect, vi, beforeEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { Editor } from '@tiptap/react';
import { DocEditor } from './DocEditor';
// i18n 初始化 — 工具栏按钮/错误态文案经 t() 解析,未初始化时拿到 key 原串。
import i18n from '@/i18n';

// #1055: en 词条补齐后 jsdom 探测语言为 en,组件会渲染英文 — 固定 zh-CN 维持中文文案断言。
beforeAll(async () => {
  await i18n.changeLanguage('zh-CN');
});

// #1038: DocEditor 走 api.uploadFile + getDownloadUrl 既有上传链路 —
// mock 掉 '@/lib/api',只提供本用例需要的方法。
const { uploadFileMock, getDownloadUrlMock } = vi.hoisted(() => ({
  uploadFileMock: vi.fn(),
  getDownloadUrlMock: vi.fn(),
}));
vi.mock('@/lib/api', () => ({
  ApiError: class ApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  },
  api: { uploadFile: uploadFileMock, getDownloadUrl: getDownloadUrlMock },
}));

// TipTap needs a real selection API in jsdom(与 doc-editor.test.tsx 同款桩)
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
  getClientRects = () => [] as unknown as DOMRectList;
  getBoundingClientRect = () => ({ top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
}
if (!(Range.prototype as unknown as { getClientRects?: unknown }).getClientRects) {
  (Range.prototype as unknown as { getClientRects: () => DOMRectList }).getClientRects = () => [] as unknown as DOMRectList;
}
if (!(Range.prototype as unknown as { getBoundingClientRect?: unknown }).getBoundingClientRect) {
  (Range.prototype as unknown as { getBoundingClientRect: () => DOMRect }).getBoundingClientRect =
    () => ({ top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
}

const wait = (ms = 200) => new Promise((r) => setTimeout(r, ms));

async function setupEditor(value: string, onChange = vi.fn()) {
  const ref: { current: Editor | null } = { current: null };
  const utils = render(<DocEditor value={value} onChange={onChange} editorRef={ref} />);
  await wait(250);
  return { ref, onChange, ...utils };
}

const pngFile = (name = '截图.png') => new File(['x'], name, { type: 'image/png' });

beforeEach(() => {
  uploadFileMock.mockReset();
  getDownloadUrlMock.mockReset();
  vi.spyOn(document, 'createRange' as any).mockImplementation(() => new FakeRange() as any);
});

// #1038 用例 1:工具栏「插入图片」按钮选择本地文件 — 触发上传,成功后文档出现图片节点。
describe('#1038 用例1 工具栏按钮上传', () => {
  test('点击按钮选文件 → 上传中显示 loading 占位,成功后替换为真实图片', async () => {
    const { ref, onChange, container } = await setupEditor('正文段落。');
    const file = pngFile();
    let resolveUpload!: (v: Record<string, unknown>) => void;
    uploadFileMock.mockImplementation(() => new Promise((res) => { resolveUpload = res; }));
    getDownloadUrlMock.mockResolvedValue({ file_id: 'file_img1', url: '/api/v1/files/download/file_img1?token=tok' });

    // 文件选择:按钮 → 隐藏 input[type=file] change
    fireEvent.click(screen.getByTitle('插入图片'));
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input).toBeTruthy();
    fireEvent.change(input, { target: { files: [file] } });

    // 走既有上传端点(api.uploadFile),不新建
    expect(uploadFileMock).toHaveBeenCalledWith(file);
    // 上传中 — 文档内出现 loading 占位图片节点
    await waitFor(() => expect(ref.current!.getHTML()).toContain('data-loading="true"'));
    expect(ref.current!.getHTML()).toContain('data-upload-id="');

    // 上传完成 → 占位替换为真实图片(canonical token URL,与 AI 出图同形态)
    resolveUpload({ file_id: 'file_img1', name: '截图.png', mime: 'image/png', size_bytes: 1 });
    await waitFor(() => expect(ref.current!.getHTML()).toContain('src="/api/v1/files/download/file_img1?token=tok"'));
    expect(ref.current!.getHTML()).not.toContain('data-loading="true"');

    // markdown 保存形态(GFM 图片语法)
    await waitFor(() =>
      expect(onChange.mock.calls.some((c) => String(c[0]).includes('/api/v1/files/download/file_img1'))).toBe(true),
    );
  });
});

// #1038 用例 2:拖拽图片文件到编辑区 — 同一上传链路,插入位置取落点。
describe('#1038 用例2 拖拽图片', () => {
  test('drop 图片文件 → 触发上传,成功后文档出现图片节点', async () => {
    const { ref, container } = await setupEditor('拖拽目标段落。');
    const file = pngFile('drop.png');
    uploadFileMock.mockResolvedValue({ file_id: 'file_drop1', name: 'drop.png', mime: 'image/png', size_bytes: 1 });
    getDownloadUrlMock.mockResolvedValue({ file_id: 'file_drop1', url: '/api/v1/files/download/file_drop1?token=tok' });

    const editorDom = container.querySelector('.ProseMirror') as HTMLElement;
    // jsdom 无布局,PM 内部先 posAtCoords 判落点 — 打桩到正文内。
    ref.current!.view.posAtCoords = vi.fn(() => ({ pos: 4, inside: -1 }));
    fireEvent.drop(editorDom, {
      dataTransfer: { files: [file], getData: () => '' },
    });

    await waitFor(() => expect(uploadFileMock).toHaveBeenCalledWith(file));
    await waitFor(() => expect(ref.current!.getHTML()).toContain('src="/api/v1/files/download/file_drop1'));
  });

  test('drop 非图片文件不触发上传(交给默认行为)', async () => {
    const { ref, container } = await setupEditor('拖拽目标段落。');
    // jsdom 无布局 — PM 内部落点判定打桩(负例同样需要走完 drop 流程)。
    ref.current!.view.posAtCoords = vi.fn(() => ({ pos: 4, inside: -1 }));
    const editorDom = container.querySelector('.ProseMirror') as HTMLElement;
    const txt = new File(['x'], 'note.txt', { type: 'text/plain' });
    fireEvent.drop(editorDom, { dataTransfer: { files: [txt], getData: () => '' } });
    expect(uploadFileMock).not.toHaveBeenCalled();
  });
});

// #1038 用例 3:粘贴剪贴板图片 — 同一上传链路。
describe('#1038 用例3 粘贴图片', () => {
  test('paste 图片文件 → 触发上传,成功后文档出现图片节点', async () => {
    const { ref, container } = await setupEditor('粘贴目标段落。');
    const file = pngFile('paste.png');
    uploadFileMock.mockResolvedValue({ file_id: 'file_paste1', name: 'paste.png', mime: 'image/png', size_bytes: 1 });
    getDownloadUrlMock.mockResolvedValue({ file_id: 'file_paste1', url: '/api/v1/files/download/file_paste1?token=tok' });

    const editorDom = container.querySelector('.ProseMirror') as HTMLElement;
    fireEvent.paste(editorDom, { clipboardData: { files: [file], getData: () => '' } });

    await waitFor(() => expect(uploadFileMock).toHaveBeenCalledWith(file));
    await waitFor(() => expect(ref.current!.getHTML()).toContain('src="/api/v1/files/download/file_paste1'));
  });
});

// #1038 用例 4:上传失败 — 显示可重试的错误态,不留下坏图片节点;重试成功后恢复。
describe('#1038 用例4 上传失败可重试', () => {
  test('失败出现错误提示与重试按钮,占位节点被移除;重试成功后插入图片', async () => {
    const { ref, container } = await setupEditor('失败重试段落。');
    const file = pngFile('fail.png');
    uploadFileMock.mockRejectedValueOnce(new Error('network down')).mockResolvedValueOnce({ file_id: 'file_retry1', name: 'fail.png', mime: 'image/png', size_bytes: 1 });
    getDownloadUrlMock.mockResolvedValue({ file_id: 'file_retry1', url: '/api/v1/files/download/file_retry1?token=tok' });

    fireEvent.click(screen.getByTitle('插入图片'));
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [file] } });

    // 失败:错误态可见(非静默),含失败原因
    await screen.findByRole('alert');
    expect(screen.getByText('图片上传失败')).toBeInTheDocument();
    expect(screen.getByText(/network down/)).toBeInTheDocument();
    // 不留坏图片节点(无空 src 占位/无 loading 残留)
    const htmlAfterFail = ref.current!.getHTML();
    expect(htmlAfterFail).not.toContain('data-loading="true"');
    expect(htmlAfterFail).not.toContain('<img');

    // 重试 → 重新走上传链路,成功后插入图片,错误态消失
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(uploadFileMock).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(ref.current!.getHTML()).toContain('src="/api/v1/files/download/file_retry1'));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  // #1066-1: 上传失败重试使用过期 pos — 内容位移后旧 pos 会把占位节点插到
  // 错误位置;重试必须按当前光标位置重算。
  test('#1066-1 重试时重算当前位置 — 内容位移后图片落在当前光标处而非旧 pos', async () => {
    const { ref, container } = await setupEditor('拖拽目标段落。');
    const file = pngFile('stale.png');
    uploadFileMock
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce({ file_id: 'file_stale1', name: 'stale.png', mime: 'image/png', size_bytes: 1 });
    getDownloadUrlMock.mockResolvedValue({ file_id: 'file_stale1', url: '/api/v1/files/download/file_stale1?token=tok' });

    // 拖拽落点 pos=4(第一段中部),上传失败进入错误态。
    const editorDom = container.querySelector('.ProseMirror') as HTMLElement;
    ref.current!.view.posAtCoords = vi.fn(() => ({ pos: 4, inside: -1 }));
    fireEvent.drop(editorDom, { dataTransfer: { files: [file], getData: () => '' } });
    await screen.findByRole('alert');

    // 内容位移:文档开头插入新段落,并把光标移到文末 — 旧 pos=4 已过期。
    ref.current!.commands.insertContentAt(0, '前置');
    ref.current!.commands.setTextSelection(ref.current!.state.doc.content.size);

    // 重试成功:图片应落在文末(当前光标处),而不是旧 pos(文档中部,其后还有文本段落)。
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    await waitFor(() => expect(ref.current!.getHTML()).toContain('src="/api/v1/files/download/file_stale1'));
    // 图片之后不允许再有带文本的段落(旧代码按过期 pos=4 插入,图片落在
    // 文档中部;修复后按当前光标插入,其后至多剩 insertContentAt 补出的空段落)。
    const doc = ref.current!.state.doc;
    let imageIdx = -1;
    doc.forEach((node, _o, i) => { if (node.type.name === 'image') imageIdx = i; });
    expect(imageIdx).toBeGreaterThanOrEqual(0);
    let textAfterImage = false;
    doc.forEach((node, _o, i) => { if (i > imageIdx && node.textContent) textAfterImage = true; });
    expect(textAfterImage).toBe(false);
  });
});

// #1066-2: 外部内容替换后上传结果静默丢弃 — 上传成功但占位节点已被外部
// 内容替换掉时,给出提示,不再无声。
describe('#1066-2 上传结果无处落时不静默', () => {
  test('占位被外部内容替换后上传完成 → 提示可见(而非静默丢弃)', async () => {
    const { ref, container } = await setupEditor('正文段落。');
    const file = pngFile('replaced.png');
    let resolveUpload!: (v: Record<string, unknown>) => void;
    uploadFileMock.mockImplementation(() => new Promise((res) => { resolveUpload = res; }));
    getDownloadUrlMock.mockResolvedValue({ file_id: 'file_rep1', url: '/api/v1/files/download/file_rep1?token=tok' });

    fireEvent.click(screen.getByTitle('插入图片'));
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() => expect(ref.current!.getHTML()).toContain('data-loading="true"'));

    // 上传期间外部内容替换(占位节点被清掉 — 模拟 applyExternalContent 重建文档)。
    ref.current!.commands.setContent('<p>外部替换后的内容</p>');
    resolveUpload({ file_id: 'file_rep1', name: 'replaced.png', mime: 'image/png', size_bytes: 1 });

    // 上传成功但占位找不到 → 提示(此前静默返回 false,无任何反馈)。
    await screen.findByRole('status');
    expect(screen.getByText(/图片已上传/)).toBeInTheDocument();
  });
});

// #1069: 多图拖拽/粘贴插入顺序 — 占位插入循环复用同一固定 pos 会导致
// 后插占位顶在先插占位前面(落地顺序与操作顺序相反)。断言文档中图片
// 出现顺序 === 操作顺序(占位顺序决定最终顺序:异步 finalize 按 uploadId
// 原位替换,不重排)。
describe('#1069 多图插入顺序与操作顺序一致', () => {
  /** getDownloadUrl 按 file_id 回显 URL — 每张图 src 唯一,可作顺序标记。 */
  const mockUploads = (n: number, prefix: string) => {
    for (let i = 1; i <= n; i++) {
      uploadFileMock.mockResolvedValueOnce({ file_id: `${prefix}_${i}`, name: `${prefix}-${i}.png`, mime: 'image/png', size_bytes: 1 });
    }
    getDownloadUrlMock.mockImplementation(async (fid: string) => ({ file_id: fid, url: `/api/v1/files/download/${fid}?token=tok` }));
  };
  /** 文档中各图片 src 的出现次序(重复 src 取首个占位 — 本用例 src 唯一)。 */
  const imageOrder = (ref: { current: Editor | null }): string[] => {
    const html = ref.current!.getHTML();
    return [...html.matchAll(/\/api\/v1\/files\/download\/([\w-]+)\?/g)].map((m) => m[1]);
  };

  test('用例1 拖入 3 张图 → 文档中图片顺序 === 拖入顺序', async () => {
    const { ref, container } = await setupEditor('拖拽目标段落。');
    mockUploads(3, 'file_m');
    const editorDom = container.querySelector('.ProseMirror') as HTMLElement;
    ref.current!.view.posAtCoords = vi.fn(() => ({ pos: 4, inside: -1 }));

    fireEvent.drop(editorDom, {
      dataTransfer: { files: [pngFile('m-1.png'), pngFile('m-2.png'), pngFile('m-3.png')], getData: () => '' },
    });

    await waitFor(() => expect(ref.current!.getHTML()).toContain('src="/api/v1/files/download/file_m_3'));
    expect(imageOrder(ref)).toEqual(['file_m_1', 'file_m_2', 'file_m_3']);
  });

  test('用例2 粘贴 2 张图 → 文档中图片顺序 === 粘贴顺序', async () => {
    const { ref, container } = await setupEditor('粘贴目标段落。');
    mockUploads(2, 'file_p');

    const editorDom = container.querySelector('.ProseMirror') as HTMLElement;
    fireEvent.paste(editorDom, {
      clipboardData: { files: [pngFile('p-1.png'), pngFile('p-2.png')], getData: () => '' },
    });

    await waitFor(() => expect(ref.current!.getHTML()).toContain('src="/api/v1/files/download/file_p_2'));
    expect(imageOrder(ref)).toEqual(['file_p_1', 'file_p_2']);
  });

  test('用例3 单图拖入(回归) → 不变,仍触发上传并落位', async () => {
    const { ref, container } = await setupEditor('拖拽目标段落。');
    mockUploads(1, 'file_s');
    const editorDom = container.querySelector('.ProseMirror') as HTMLElement;
    ref.current!.view.posAtCoords = vi.fn(() => ({ pos: 4, inside: -1 }));

    fireEvent.drop(editorDom, { dataTransfer: { files: [pngFile('s-1.png')], getData: () => '' } });

    await waitFor(() => expect(ref.current!.getHTML()).toContain('src="/api/v1/files/download/file_s_1'));
    expect(imageOrder(ref)).toEqual(['file_s_1']);
  });
});
