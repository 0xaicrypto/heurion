import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { extractDocumentText } from '../../src/lib/document-extractor.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

describe('document-extractor', () => {
  it('extracts text from .txt files', async () => {
    const text = await extractDocumentText(Buffer.from('Hello world'), 'notes.txt')
    expect(text).toBe('Hello world')
  })

  it('extracts text from .md files', async () => {
    const text = await extractDocumentText(Buffer.from('# Heading'), 'doc.md')
    expect(text).toBe('# Heading')
  })

  it('extracts text from a PDF file', async () => {
    const pdfPath = path.join(__dirname, 'fixtures', 'test.pdf')
    const buffer = fs.readFileSync(pdfPath)
    const text = await extractDocumentText(buffer, 'test.pdf')
    expect(text).toContain('Hello from PDF')
  })

  it('respects maxChars limit', async () => {
    const long = 'a'.repeat(100)
    const text = await extractDocumentText(Buffer.from(long), 'long.txt', undefined, { maxChars: 10 })
    expect(text.length).toBe(10)
  })
})
