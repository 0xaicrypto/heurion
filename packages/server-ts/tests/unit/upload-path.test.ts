import { describe, test, expect } from 'vitest'
import { safeUploadPath, sanitizeFilename } from '../../src/lib/upload-path.js'

/** #553 — 上传路径安全:fileId 拒绝路径穿越。 */
describe('#553 upload path safety', () => {
  test('正常 fileId 解析到 uploads 目录', () => {
    const p = safeUploadPath('u1', '1750000000000_report.txt')
    expect(p).toContain('uploads')
    expect(p).toContain('report.txt')
  })

  test('拒绝路径穿越(fileId 含 ..)', () => {
    expect(safeUploadPath('u1', '../../etc/passwd')).toBeNull()
    expect(safeUploadPath('u1', 'a/../../etc/passwd')).toBeNull()
  })

  test('拒绝路径分隔符与绝对路径', () => {
    expect(safeUploadPath('u1', 'a/b.txt')).toBeNull()
    expect(safeUploadPath('u1', 'a\\b.txt')).toBeNull()
    expect(safeUploadPath('u1', '/etc/passwd')).toBeNull()
    expect(safeUploadPath('u1', '')).toBeNull()
  })

  test('sanitizeFilename 仅保留 basename 并去控制字符', () => {
    expect(sanitizeFilename('../../etc/passwd')).toBe('passwd')
    expect(sanitizeFilename('a/b/c.txt')).toBe('c.txt')
    expect(sanitizeFilename('evil\u0000name.txt')).toBe('evilname.txt')
    expect(sanitizeFilename(undefined)).toBe('file')
    expect(sanitizeFilename('')).toBe('file')
  })
})
