import fs from 'fs'
import path from 'path'
import zlib from 'zlib'
import type { IngestionAnalyzer, IngestionJob, IngestionResult, MedicalRecordEntryDraft } from '../ingestion.service.js'
import { geminiVisionAnalyze } from './gemini-vision.adapter.js'

let dicomParser: any = null
try {
  dicomParser = require('dicom-parser')
} catch { /* optional dependency */ }

function getUploadPath(job: IngestionJob): string | null {
  const candidates: string[] = []
  if (process.env.UPLOAD_DIR) {
    candidates.push(path.join(process.env.UPLOAD_DIR, job.userId, job.fileId))
  }
  candidates.push(path.join('.nexus/twins', job.userId, 'uploads', job.fileId))
  candidates.push(path.join('./uploads', job.userId, job.fileId))

  for (const p of candidates) {
    if (fs.existsSync(p)) return p
  }

  // DICOM files are sometimes stored with .dcm extension
  if (job.mimeType === 'application/dicom' || job.fileName.toLowerCase().endsWith('.dcm')) {
    for (const p of candidates) {
      const withExt = p + '.dcm'
      if (fs.existsSync(withExt)) return withExt
    }
  }

  return null
}

interface DicomMeta {
  patientName?: string
  patientId?: string
  sex?: string
  age?: string
  studyDescription?: string
  studyDate?: string
  modality?: string
  institution?: string
  manufacturer?: string
  model?: string
  rows?: number
  cols?: number
  sliceThickness?: string
  tags?: number
}

function parseDicomMeta(filePath: string): { meta: DicomMeta; summary: string } | null {
  if (!dicomParser || !fs.existsSync(filePath)) return null
  try {
    const buffer = fs.readFileSync(filePath)
    const arr = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
    const dataSet = dicomParser.parseDicom(new Uint8Array(arr))

    const s = (tag: string) => { try { return dataSet.string(tag) } catch { return undefined } }
    const n = (tag: string) => { try { return dataSet.uint16(tag) } catch { return 0 } }

    const meta: DicomMeta = {
      patientName: s('x00100010'),
      patientId: s('x00100020'),
      sex: s('x00100040'),
      age: s('x00101010'),
      studyDescription: s('x00081030'),
      studyDate: s('x00080020'),
      modality: s('x00080060'),
      institution: s('x00080080'),
      manufacturer: s('x00080070'),
      model: s('x00081090'),
      rows: n('x00280010') || undefined,
      cols: n('x00280011') || undefined,
      sliceThickness: s('x00180050'),
      tags: Object.keys(dataSet.elements || {}).length,
    }

    const parts: string[] = []
    if (meta.studyDescription) parts.push(`Study: ${meta.studyDescription}`)
    if (meta.studyDate) parts.push(`Date: ${meta.studyDate}`)
    if (meta.modality) parts.push(`Modality: ${meta.modality}`)
    if (meta.rows && meta.cols) parts.push(`Size: ${meta.rows}x${meta.cols}`)
    const summary = parts.join(' | ') || 'DICOM metadata unavailable'

    return { meta, summary }
  } catch {
    return null
  }
}

function renderDicomPng(filePath: string): Buffer | null {
  if (!dicomParser || !fs.existsSync(filePath)) return null
  try {
    const buffer = fs.readFileSync(filePath)
    const arr = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
    const dataSet = dicomParser.parseDicom(new Uint8Array(arr))

    const rows = dataSet.uint16('x00280010')
    const cols = dataSet.uint16('x00280011')
    if (!rows || !cols) return null

    const pixelData = new Uint16Array(dataSet.byteArray.buffer, dataSet.byteArray.byteOffset, rows * cols)
    const wc = parseFloat((dataSet.string('x00281050') || '40').split('\\')[0])
    const ww = parseFloat((dataSet.string('x00281051') || '400').split('\\')[0])
    const ri = parseFloat(dataSet.string('x00281052') || '-1000')
    const rs = parseFloat(dataSet.string('x00281053') || '1')

    const gray = Buffer.alloc(rows * cols)
    for (let i = 0; i < rows * cols; i++) {
      const hu = pixelData[i] * rs + ri
      const low = wc - ww / 2
      gray[i] = Math.max(0, Math.min(255, Math.round((hu - low) / ww * 255)))
    }

    const scale = Math.min(1, 512 / Math.max(rows, cols))
    const outW = Math.floor(cols * scale)
    const outH = Math.floor(rows * scale)

    const raw = Buffer.alloc(outH * (1 + outW))
    for (let y = 0; y < outH; y++) {
      raw[y * (1 + outW)] = 0
      const srcY = Math.floor(y / scale)
      for (let x = 0; x < outW; x++) {
        const srcX = Math.floor(x / scale)
        raw[y * (1 + outW) + 1 + x] = gray[srcY * cols + srcX]
      }
    }

    const deflated = zlib.deflateSync(raw)

    const chunk = (type: string, data: Buffer): Buffer => {
      const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0)
      const crc = crc32(Buffer.concat([Buffer.from(type), data]))
      const cb = Buffer.alloc(4); cb.writeUInt32BE(crc, 0)
      return Buffer.concat([len, Buffer.from(type), data, cb])
    }

    const ihdr = Buffer.alloc(13)
    ihdr.writeUInt32BE(outW, 0); ihdr.writeUInt32BE(outH, 4)
    ihdr[8] = 8; ihdr[9] = 0; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0

    return Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk('IHDR', ihdr),
      chunk('IDAT', deflated),
      chunk('IEND', Buffer.alloc(0)),
    ])
  } catch {
    return null
  }
}

function parseDicomDate(value?: string): string {
  if (!value || value.length !== 8) return new Date().toISOString()
  const y = parseInt(value.slice(0, 4), 10)
  const m = parseInt(value.slice(4, 6), 10)
  const d = parseInt(value.slice(6, 8), 10)
  const date = new Date(y, m - 1, d)
  if (isNaN(date.getTime())) return new Date().toISOString()
  return date.toISOString()
}

function crc32(buf: Buffer): number {
  let crc = 0xFFFFFFFF
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i]
    for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0)
  }
  return (crc ^ 0xFFFFFFFF) >>> 0
}

function imageMimeType(job: IngestionJob): string {
  if (job.mimeType.startsWith('image/')) return job.mimeType
  const ext = path.extname(job.fileName).toLowerCase()
  if (ext === '.png') return 'image/png'
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg'
  if (ext === '.gif') return 'image/gif'
  if (ext === '.webp') return 'image/webp'
  return 'image/png'
}

function buildVisionPrompt(modality?: string, region?: string): string {
  const ctx = [modality && `Modality: ${modality}`, region && `Body region: ${region}`]
    .filter(Boolean)
    .join('; ')

  return `You are a clinical imaging assistant. Analyze the provided medical image${ctx ? ` (${ctx})` : ''} and return ONLY a JSON object with this exact shape:
{
  "region": "body region or empty",
  "modality": "modality or empty",
  "findings": ["finding 1", "finding 2"],
  "impression": "concise clinical impression",
  "confidence": "high" | "medium" | "low"
}
If the image is not a medical image or no findings can be identified, return {"findings": [], "impression": "", "confidence": "low"}.

JSON:`
}

function extractVisionJson(text: string): any {
  try {
    const match = text.match(/\{[\s\S]*\}/)
    return JSON.parse(match ? match[0] : text)
  } catch {
    return null
  }
}

export const imagingAnalyzer: IngestionAnalyzer = {
  name: 'imaging',
  async analyze(job: IngestionJob): Promise<IngestionResult> {
    const filePath = getUploadPath(job)
    const isDicom = job.mimeType === 'application/dicom' || job.fileName.toLowerCase().endsWith('.dcm')

    let dicomMeta: DicomMeta | null = null
    let dicomSummary = ''
    let imageBase64: string | null = null
    let imageMime = imageMimeType(job)

    if (isDicom) {
      const parsed = filePath ? parseDicomMeta(filePath) : null
      if (parsed) {
        dicomMeta = parsed.meta
        dicomSummary = parsed.summary
      }
      const png = filePath ? renderDicomPng(filePath) : null
      if (png) {
        imageBase64 = png.toString('base64')
        imageMime = 'image/png'
      }
    } else if (filePath) {
      try {
        imageBase64 = fs.readFileSync(filePath).toString('base64')
      } catch {
        imageBase64 = null
      }
    }

    if (isDicom && !imageBase64) {
      throw new Error('Unable to render DICOM image for vision analysis')
    }

    // Merge DICOM metadata from extraction stage if present
    if (job.extractedJson && typeof job.extractedJson === 'object' && job.extractedJson.dicom) {
      dicomMeta = { ...(dicomMeta || {}), ...job.extractedJson.dicom }
    }

    const modality = dicomMeta?.modality || job.extractedJson?.modality
    const region = dicomMeta?.studyDescription || job.extractedJson?.region

    let visionText = ''
    if (imageBase64) {
      try {
        visionText = await geminiVisionAnalyze({
          prompt: buildVisionPrompt(modality, region),
          base64Image: imageBase64,
          mimeType: imageMime,
          userId: job.userId,
        })
      } catch (err: any) {
        return fallbackNote(job, dicomMeta, dicomSummary, `Vision analysis failed: ${err.message}`)
      }
    }

    const parsed = visionText ? extractVisionJson(visionText) : null
    const findings = Array.isArray(parsed?.findings) ? parsed.findings : []
    const impression = parsed?.impression || ''
    const confidence = parsed?.confidence || 'low'

    if (findings.length === 0 && !impression) {
      return fallbackNote(job, dicomMeta, dicomSummary, visionText || 'No findings identified.')
    }

    const title = `[AI Vision] ${parsed?.region || dicomMeta?.studyDescription || '医学影像'} ${modality || ''}`.trim()
    const contentLines = [
      ...(findings.length ? ['影像所见：', ...findings.map((f: string) => `• ${f}`)] : []),
      ...(impression ? [`影像结论：${impression}`] : []),
    ]
    const content = contentLines.join('\n')

    const entry: MedicalRecordEntryDraft = {
      type: 'imaging',
      title,
      date: parseDicomDate(dicomMeta?.studyDate),
      content,
      aiSummary: impression || findings.join('; '),
      status: 'pending_review',
      createdBy: 'system',
      extractedText: visionText,
      rawJson: {
        source: isDicom ? 'dicom' : 'image',
        modality,
        region: parsed?.region || dicomMeta?.studyDescription,
        dicom: dicomMeta,
        vision: parsed,
      },
    }

    return {
      confidence: confidence === 'high' ? 'high' : confidence === 'medium' ? 'medium' : 'low',
      reasoning: `Extracted imaging findings from ${isDicom ? 'DICOM' : 'image'} via Gemini Vision.`,
      entries: [entry],
    }
  },
}

function fallbackNote(
  job: IngestionJob,
  dicomMeta: DicomMeta | null,
  dicomSummary: string,
  detail: string,
): IngestionResult {
  const isDicom = job.mimeType === 'application/dicom' || job.fileName.toLowerCase().endsWith('.dcm')
  const content = isDicom
    ? `DICOM metadata:\n${dicomSummary || 'Unable to parse'}\n\n${detail}`
    : detail

  return {
    confidence: 'low',
    reasoning: isDicom
      ? 'Could not perform vision analysis; stored raw DICOM metadata as a note.'
      : 'Could not extract findings from image; stored raw note.',
    entries: [
      {
        type: 'note',
        title: `[AI Vision] ${job.fileName}`,
        date: new Date().toISOString(),
        content,
        status: 'pending_review',
        createdBy: 'system',
        extractedText: detail,
        rawJson: { source: isDicom ? 'dicom' : 'image', dicom: dicomMeta, summary: dicomSummary },
      },
    ],
  }
}
