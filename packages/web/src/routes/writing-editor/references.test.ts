import { describe, test, expect } from 'vitest';
import { fileRefKindFromName, filterNewFileRefs, type DocReferenceItem, type FileLibraryItem } from './references';

/** #930 回归: Reference 弹层"从文件库选择"的纯函数 — kind 映射与已登记过滤。 */
describe('fileRefKindFromName (#930)', () => {
  test('按扩展名映射 kind(与聊天上传挂参考一致)', () => {
    expect(fileRefKindFromName('paper.PDF')).toBe('pdf');
    expect(fileRefKindFromName('manuscript.docx')).toBe('docx');
    expect(fileRefKindFromName('old.doc')).toBe('docx');
    expect(fileRefKindFromName('notes.txt')).toBe('file');
    expect(fileRefKindFromName('slides.pptx')).toBe('file');
  });
});

describe('filterNewFileRefs (#930)', () => {
  const refList: DocReferenceItem[] = [
    { reference_id: 'r1', kind: 'pdf', label: 'paper.pdf', content: 'paper.pdf', created_at: '' },
    { reference_id: 'r2', kind: 'guideline', label: '', content: 'pasted text', created_at: '' },
  ];
  const files: FileLibraryItem[] = [
    { file_id: 'f1', name: 'paper.pdf', mime: 'application/pdf', size_bytes: 10, created_at: '' },
    { file_id: 'f2', name: 'PAPER.PDF', mime: 'application/pdf', size_bytes: 10, created_at: '' },
    { file_id: 'f3', name: 'other.docx', mime: '', size_bytes: 10, created_at: '' },
  ];

  test('已登记文件(大小写不敏感)被过滤', () => {
    const rest = filterNewFileRefs(files, refList);
    expect(rest.map((f) => f.file_id)).toEqual(['f3']);
  });

  test('空参考列表时全部可选', () => {
    expect(filterNewFileRefs(files, [])).toHaveLength(3);
  });
});
