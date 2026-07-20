import { FastifyInstance } from 'fastify'
import { authGuard } from '../../common/auth.guard.js'
import prisma from '../../common/prisma.js'
import { deepseekStream, deepseekChat, getApiKey } from '../../common/llm.js'
import crypto from 'crypto'
import { Document, Packer, Paragraph, TextRun, HeadingLevel } from 'docx'

function uid() { return crypto.randomBytes(8).toString('hex') }

export async function documentsRouter(app: FastifyInstance) {
  app.addHook('preHandler', authGuard)

  // ── Docs CRUD ──
  app.get('/api/v1/docs', async (request) => {
    const docs = await (prisma as any).doc.findMany({
      where: { userId: request.user!.userId }, orderBy: { updatedAt: 'desc' },
    })
    return { docs: docs.map((d: any) => ({
      id: d.id, title: d.title, body: d.body,
      updated_at: d.updatedAt, created_at: d.createdAt, ref_count: 0,
    }))}
  })

  app.post('/api/v1/docs', async (request) => {
    const { title } = request.body as any
    const id = `doc_${uid()}`
    const now = new Date().toISOString()
    await (prisma as any).doc.create({ data: { id, userId: request.user!.userId, title: title || 'Untitled', body: '', createdAt: now, updatedAt: now } })
    return { id, title: title || 'Untitled', body: '', created_at: now, updated_at: now }
  })

  app.get('/api/v1/docs/:docId', async (request, reply) => {
    const doc = await (prisma as any).doc.findFirst({ where: { id: (request.params as any).docId, userId: request.user!.userId } })
    if (!doc) return reply.status(404).send({ error: 'Not found' })
    return { id: doc.id, title: doc.title, body: doc.body, created_at: doc.createdAt, updated_at: doc.updatedAt }
  })

  app.put('/api/v1/docs/:docId', async (request, reply) => {
    const { docId } = request.params as any
    const { title, body } = request.body as any
    const existing = await (prisma as any).doc.findFirst({ where: { id: docId, userId: request.user!.userId } })
    if (!existing) return reply.status(404).send({ error: 'Document not found' })

    const now = new Date().toISOString()
    const data: any = { updatedAt: now }
    if (title !== undefined) data.title = title

    // Snapshot before body changes so users can restore previous versions.
    if (body !== undefined && body !== existing.body) {
      await (prisma as any).docSnapshot.create({
        data: {
          docId,
          userId: request.user!.userId,
          body: existing.body,
          label: 'Manual save',
          createdAt: now,
        },
      })
      data.body = body
    }

    await (prisma as any).doc.update({ where: { id: docId }, data })
    const doc = await (prisma as any).doc.findFirst({ where: { id: docId } })
    return { id: doc!.id, title: doc!.title, body: doc!.body, created_at: doc!.createdAt, updated_at: doc!.updatedAt }
  })

  app.delete('/api/v1/docs/:docId', async (request, reply) => {
    const { docId } = request.params as any
    const userId = request.user!.userId
    const existing = await (prisma as any).doc.findFirst({ where: { id: docId, userId } })
    if (!existing) return reply.status(404).send({ error: 'Document not found' })
    await (prisma as any).doc.delete({ where: { id: docId } })
    return { deleted: true }
  })

  // ── Snapshots ──
  app.get('/api/v1/docs/:docId/snapshots', async (request) => {
    const snaps = await (prisma as any).docSnapshot.findMany({
      where: { docId: (request.params as any).docId }, orderBy: { id: 'desc' },
    })
    return { snapshots: snaps.map((s: any) => ({ id: s.id, body: s.body, label: s.label, created_at: s.createdAt })) }
  })

  app.post('/api/v1/docs/:docId/snapshots/:snapId/restore', async (request, reply) => {
    const { docId, snapId } = request.params as any
    const snap = await (prisma as any).docSnapshot.findFirst({ where: { id: Number(snapId), docId } })
    if (!snap) return reply.status(404).send({ error: 'Not found' })
    await (prisma as any).doc.update({ where: { id: docId }, data: { body: snap.body, updatedAt: new Date().toISOString() } })
    return { restored: true }
  })

  // ── PHI Scan ──
  app.post('/api/v1/docs/:docId/phi-scan', async (request) => {
    const doc = await (prisma as any).doc.findFirst({ where: { id: (request.params as any).docId, userId: request.user!.userId } })
    if (!doc) return { findings: [] }
    const suggestions: Record<string, string> = {
      SSN: 'Potential Social Security Number — consider removing or replacing with a surrogate ID.',
      Name: 'Potential patient name — consider using initials or a de-identified label.',
    }
    const findings: Array<{ kind: string; text: string; start: number; end: number; suggestion: string }> = []
    for (const { regex, kind } of [
      { regex: /\b\d{3}-\d{2}-\d{4}\b/g, kind: 'SSN' },
      { regex: /\b[A-Z][a-z]+ [A-Z][a-z]+\b/g, kind: 'Name' },
    ]) {
      let match
      while ((match = regex.exec(doc.body)) !== null) {
        findings.push({ kind, text: match[0], start: match.index, end: match.index + match[0].length, suggestion: suggestions[kind] || 'Review for potential PHI.' })
      }
    }
    return { findings }
  })

  // #3: AI Polish SSE — uses DeepSeek
  app.post('/api/v1/docs/:docId/polish', async (request, reply) => {
    const { selection, instruction } = request.body as any
    const apiKey = getApiKey()
    const prompt = `Polish the following clinical text${instruction ? ` with instruction: "${instruction}"` : ''}. Keep the meaning but improve clarity and professionalism:\n\n${selection || ''}`
    reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
    const send = (d: any) => reply.raw.write(`data: ${JSON.stringify(d)}\n\n`)
    try {
      for await (const chunk of deepseekStream([{ role: 'user', content: prompt }], apiKey)) {
        send({ text: chunk })
      }
      send({ done: true })
    } catch (err: any) {
      send({ type: 'error', message: err.message })
    } finally {
      reply.raw.end()
    }
  })

  // #3: Doc Chat SSE — structured output that can edit the document
  app.post('/api/v1/docs/:docId/chat', async (request, reply) => {
    const { docId } = request.params as any
    const { message } = request.body as any
    const userId = request.user!.userId
    const doc = await (prisma as any).doc.findFirst({ where: { id: docId, userId } })
    if (!doc) return reply.status(404).send({ error: 'Document not found' })

    const apiKey = getApiKey()
    reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
    const send = (d: any) => reply.raw.write(`data: ${JSON.stringify(d)}\n\n`)

    try {
      send({ type: 'turn_started' })

      // Load document references to provide context to the AI
      const refs = await (prisma as any).docReference.findMany({
        where: { userId, docId },
        orderBy: { createdAt: 'asc' },
      })
      let refContext = ''
      if (refs && refs.length > 0) {
        refContext = '\n\n## Reference Materials (uploaded documents and references)\n'
        for (const r of refs) {
          const content = (r.snapshot || r.body || '').toString().slice(0, 8000)
          refContext += `\n### ${r.label || r.id}\n${content}\n`
        }
      }

      const structuredPrompt = `You are helping edit a clinical document titled "${doc.title}".

Current document content:
${doc.body}
${refContext}
User request: ${message || 'Help me with this document.'}

Respond using EXACTLY this format:

REPLY:
<your concise, helpful response to the user>

UPDATED_DOCUMENT:
<the complete updated document content>

Instructions:
- Use the reference materials above as authoritative sources.
- If the user wants you to modify the document, write the full new document content after UPDATED_DOCUMENT:.
- If no changes are needed, repeat the current document content exactly after UPDATED_DOCUMENT:.
- Do not wrap the document content in markdown code fences.
- The REPLY section should briefly explain what you changed or answer the user's question.`

      const fullResponse = await deepseekChat([
        { role: 'system' as const, content: 'You are a precise clinical document editor.' },
        { role: 'user' as const, content: structuredPrompt },
      ], apiKey)

      const parsed = parseDocChatResponse(fullResponse, doc.body)

      // Stream reply to client
      for (const chunk of chunkText(parsed.reply, 80)) {
        send({ type: 'reply_chunk', text: chunk })
      }

      let docBody: string | undefined
      if (parsed.updatedBody && parsed.updatedBody !== doc.body) {
        const now = new Date().toISOString()
        // Snapshot before AI edit
        await (prisma as any).docSnapshot.create({
          data: {
            docId,
            userId,
            body: doc.body,
            label: 'Before AI edit',
            createdAt: now,
          },
        })
        // Update document
        await (prisma as any).doc.update({
          where: { id: docId },
          data: { body: parsed.updatedBody, updatedAt: now },
        })
        docBody = parsed.updatedBody
      }

      // Persist chat messages
      const msgNow = new Date().toISOString()
      await (prisma as any).docChatMessage.create({
        data: { id: `dcm_${uid()}`, docId, userId, role: 'user', text: message || '', docApplied: 0, createdAt: msgNow },
      })
      await (prisma as any).docChatMessage.create({
        data: { id: `dcm_${uid()}`, docId, userId, role: 'assistant', text: parsed.reply, docApplied: docBody ? 1 : 0, createdAt: msgNow },
      })

      send({ type: 'done', doc_body: docBody })
    } catch (err: any) {
      send({ type: 'error', message: err.message || 'Chat failed' })
    } finally {
      reply.raw.end()
    }
  })

   app.post('/api/v1/docs/:docId/export', async (request, reply) => {
    const { docId } = request.params as any
    const userId = request.user!.userId
    const doc = await (prisma as any).doc.findFirst({ where: { id: docId, userId } })
    if (!doc) return reply.status(404).send({ error: 'Document not found' })

    const children = parseMarkdownToDocx(doc.title || 'Untitled', doc.body || '')
    const docx = new Document({
      sections: [{ properties: {}, children }],
    })

    const buffer = await Packer.toBuffer(docx)
    const safeName = (doc.title || 'document').replace(/[^a-z0-9\u4e00-\u9fa5 _-]/gi, '_').trim() || 'document'
    const asciiName = safeName.replace(/[^\x20-\x7E]/g, '_')
    const encoded = encodeURIComponent(safeName)
    return reply
      .header('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
      .header('Content-Disposition', `attachment; filename="${asciiName}.docx"; filename*=UTF-8''${encoded}.docx`)
      .send(buffer)
  })

function parseMarkdownToDocx(title: string, body: string): any[] {
  const children: any[] = []

  // Title
  children.push(new Paragraph({
    spacing: { after: 200 },
    children: [new TextRun({ text: title, bold: true, size: 32 })],
    heading: HeadingLevel.TITLE,
  }))

  // Parse body
  const lines = body.split('\n')
  let i = 0
  while (i < lines.length) {
    const line = lines[i]

    // Code block
    if (line.startsWith('```')) {
      i++
      const codeLines: string[] = []
      while (i < lines.length && !lines[i].startsWith('```')) {
        codeLines.push(lines[i])
        i++
      }
      i++ // skip closing ```
      if (codeLines.length > 0) {
        children.push(new Paragraph({
          spacing: { before: 80, after: 80 },
          border: { left: { style: 'single', size: 4, color: 'CCCCCC' } },
          indent: { left: 400 },
          children: [new TextRun({ text: codeLines.join('\n'), font: 'Consolas', size: 18 })],
        }))
      }
      continue
    }

    // Heading
    const headingMatch = line.match(/^(#{1,6})\s+(.+)/)
    if (headingMatch) {
      const level = headingMatch[1].length
      const text = parseInlineMarkdown(headingMatch[2])
      children.push(new Paragraph({
        spacing: { before: 240, after: 120 },
        children: text,
        heading: (['', HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_3, HeadingLevel.HEADING_3, HeadingLevel.HEADING_3] as any)[level] || HeadingLevel.HEADING_1,
      }))
      i++
      continue
    }

    // Unordered list
    if (/^[-*+]\s/.test(line)) {
      const listItems: string[] = []
      while (i < lines.length && /^[-*+]\s/.test(lines[i])) {
        listItems.push(lines[i].replace(/^[-*+]\s/, ''))
        i++
      }
      for (const item of listItems) {
        children.push(new Paragraph({
          spacing: { before: 40, after: 40 },
          bullet: { level: 0 },
          indent: { left: 400 },
          children: parseInlineMarkdown(item),
        }))
      }
      continue
    }

    // Ordered list
    if (/^\d+[.)]\s/.test(line)) {
      const listItems: string[] = []
      while (i < lines.length && /^\d+[.)]\s/.test(lines[i])) {
        listItems.push(lines[i].replace(/^\d+[.)]\s/, ''))
        i++
      }
      let num = 1
      for (const item of listItems) {
        children.push(new Paragraph({
          spacing: { before: 40, after: 40 },
          numbering: { reference: 'ordered', level: 0 },
          indent: { left: 400 },
          children: [new TextRun({ text: `${num}. ` }), ...parseInlineMarkdown(item)],
        }))
        num++
      }
      continue
    }

    // Horizontal rule
    if (/^[-*_]{3,}$/.test(line)) {
      children.push(new Paragraph({
        spacing: { before: 200, after: 200 },
        border: { bottom: { style: 'single', size: 6, color: 'CCCCCC' } },
        children: [],
      }))
      i++
      continue
    }

    // Empty line → paragraph break
    if (!line.trim()) {
      children.push(new Paragraph({ spacing: { before: 60 }, children: [] }))
      i++
      continue
    }

    // Regular paragraph
    children.push(new Paragraph({
      spacing: { before: 60, after: 60 },
      children: parseInlineMarkdown(line),
    }))
    i++
  }

  return children
}

function parseInlineMarkdown(text: string): any[] {
  const runs: any[] = []
  let remaining = text
  // Bold **text** or __text__
  const boldRegex = /\*\*(.+?)\*\*|__(.+?)__/g
  // Italic *text* or _text_
  const italicRegex = /\*(.+?)\*|_(.+?)_/g
  // Inline code `text`
  const codeRegex = /`([^`]+)`/g

  type Token = { type: 'bold' | 'italic' | 'code'; text: string; start: number; end: number }
  const tokens: Token[] = []

  for (const match of remaining.matchAll(boldRegex)) {
    tokens.push({ type: 'bold', text: match[1] || match[2], start: match.index!, end: match.index! + match[0].length })
  }
  for (const match of remaining.matchAll(codeRegex)) {
    tokens.push({ type: 'code', text: match[1], start: match.index!, end: match.index! + match[0].length })
  }
  for (const match of remaining.matchAll(italicRegex)) {
    if (!tokens.some(t => t.start <= match.index! && t.end >= match.index! + match[0].length)) {
      tokens.push({ type: 'italic', text: match[1] || match[2], start: match.index!, end: match.index! + match[0].length })
    }
  }

  if (tokens.length === 0) return [new TextRun(remaining)]

  tokens.sort((a, b) => a.start - b.start)
  let pos = 0
  for (const tok of tokens) {
    if (pos < tok.start) runs.push(new TextRun(remaining.slice(pos, tok.start)))
    const opts: any = {}
    if (tok.type === 'bold') opts.bold = true
    if (tok.type === 'italic') opts.italics = true
    if (tok.type === 'code') opts.font = 'Consolas'
    runs.push(new TextRun({ text: tok.text, ...opts }))
    pos = tok.end
  }
  if (pos < remaining.length) runs.push(new TextRun(remaining.slice(pos)))

  return runs.length > 0 ? runs : [new TextRun(remaining)]
}

  // ── References ──
  app.post('/api/v1/docs/:docId/references', async (request, reply) => {
    const { docId } = request.params as any
    const userId = request.user!.userId
    const doc = await (prisma as any).doc.findFirst({ where: { id: docId, userId } })
    if (!doc) return reply.status(404).send({ error: 'Document not found' })

    const { kind, content, label, source_patient_hash } = request.body as any
    const id = `ref_${uid()}`
    const now = new Date().toISOString()
    await (prisma as any).docReference.create({
      data: {
        id,
        docId,
        userId,
        refType: kind || 'note',
        targetId: source_patient_hash || '',
        snapshot: content || '',
        sourceNodes: JSON.stringify({ label: label || '' }),
        granularity: 'doc',
        createdAt: now,
      },
    })
    return { reference_id: id, kind: kind || 'note', content: content || '', label: label || '', source_patient_hash: source_patient_hash || '', created_at: now }
  })

  app.get('/api/v1/docs/:docId/references', async (request, reply) => {
    const { docId } = request.params as any
    const userId = request.user!.userId
    const refs = await (prisma as any).docReference.findMany({
      where: { docId, userId },
      orderBy: { createdAt: 'desc' },
    })
    return {
      references: refs.map((r: any) => {
        let meta: any = {}
        try { meta = JSON.parse(r.sourceNodes || '{}') } catch { /* ignore */ }
        return {
          reference_id: r.id,
          kind: r.refType,
          content: r.snapshot,
          label: meta.label || '',
          source_patient_hash: r.targetId,
          created_at: r.createdAt,
        }
      }),
    }
  })
}

function parseDocChatResponse(response: string, currentBody: string): { reply: string; updatedBody: string } {
  const replyMatch = response.match(/REPLY:\s*([\s\S]*?)(?=UPDATED_DOCUMENT:|$)/)
  const docMatch = response.match(/UPDATED_DOCUMENT:\s*([\s\S]*?)$/)

  const reply = replyMatch ? replyMatch[1].trim() : response.trim()
  const updatedBody = docMatch ? docMatch[1].trim() : currentBody

  return { reply, updatedBody }
}

function chunkText(text: string, size: number): string[] {
  const chunks: string[] = []
  for (let i = 0; i < text.length; i += size) {
    chunks.push(text.slice(i, i + size))
  }
  return chunks
}
