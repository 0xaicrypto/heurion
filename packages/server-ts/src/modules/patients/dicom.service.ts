import fs from 'fs'
import path from 'path'
import zlib from 'zlib'
import crypto from 'crypto'

let dicomParser: any = null
try { dicomParser = require('dicom-parser') } catch { }

interface DicomInstance {
  fileId: string
  sliceIndex: number
  rows: number
  cols: number
  pixelData: Uint16Array
  rescaleIntercept: number
  rescaleSlope: number
  windowCenter: number
  windowWidth: number
}

interface DicomSeries {
  seriesInstanceUid: string
  seriesNumber: number
  modality: string
  bodyPart: string
  seriesDescription: string
  instances: DicomInstance[]
}

interface DicomStudy {
  studyId: string
  studyInstanceUid: string
  studyDate: string
  studyDescription: string
  modality: string
  patientHash: string
  patientAgeGroup: string
  patientSex: string
  series: DicomSeries[]
  createdMs: number
}

const WINDOW_PRESETS: Record<string, { center: number; width: number }> = {
  lung: { center: -600, width: 1500 },
  mediastinum: { center: 40, width: 400 },
  bone: { center: 300, width: 1500 },
  brain: { center: 40, width: 80 },
  abdomen: { center: 60, width: 350 },
  default: { center: 40, width: 400 },
}

function uid(): string { return crypto.randomBytes(8).toString('hex') }

function getDicomPath(userId: string, fileId: string): string {
  const dir = path.join(process.env.TWIN_BASE_DIR || '.nexus/twins', userId, 'uploads')
  let p = path.join(dir, fileId)
  if (fs.existsSync(p)) return p
  p = path.join(dir, fileId + '.dcm')
  if (fs.existsSync(p)) return p
  return p
}

function parseInstance(filepath: string): DicomInstance | null {
  if (!dicomParser || !fs.existsSync(filepath)) return null
  try {
    const buffer = fs.readFileSync(filepath)
    const arr = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
    const ds = dicomParser.parseDicom(arr)
    const rows = ds.uint16('x00280010')
    const cols = ds.uint16('x00280011')
    if (!rows || !cols) return null

    const pixelDataElement = ds.elements.x7fe00010
    if (!pixelDataElement) return null
    const pixelData = new Uint16Array(
      ds.byteArray.buffer,
      ds.byteArray.byteOffset + pixelDataElement.dataOffset,
      pixelDataElement.length / 2,
    )

    return {
      fileId: path.basename(filepath),
      sliceIndex: 0,
      rows, cols,
      pixelData,
      rescaleIntercept: parseFloat(ds.string('x00281052') || '-1000'),
      rescaleSlope: parseFloat(ds.string('x00281053') || '1'),
      windowCenter: parseFloat((ds.string('x00281050') || '40').split('\\')[0]),
      windowWidth: parseFloat((ds.string('x00281051') || '400').split('\\')[0]),
    }
  } catch { return null }
}

function renderGrayscalePng(
  instance: DicomInstance,
  presetName: string = 'default',
  wlOverride?: number,
  wwOverride?: number,
  maxDim: number = 512,
): Buffer | null {
  const preset = WINDOW_PRESETS[presetName] || WINDOW_PRESETS.default
  const wc = wlOverride ?? instance.windowCenter ?? preset.center
  const ww = wwOverride ?? instance.windowWidth ?? preset.width
  const { rows, cols, pixelData, rescaleSlope, rescaleIntercept } = instance

  const gray = Buffer.alloc(rows * cols)
  for (let i = 0; i < rows * cols; i++) {
    const hu = pixelData[i] * rescaleSlope + rescaleIntercept
    const low = wc - ww / 2
    const v = Math.round((hu - low) / ww * 255)
    gray[i] = Math.max(0, Math.min(255, v))
  }

  const scale = Math.min(1, maxDim / Math.max(rows, cols))
  const outW = Math.floor(cols * scale)
  const outH = Math.floor(rows * scale)

  const raw = Buffer.alloc(outH * (1 + outW))
  for (let y = 0; y < outH; y++) {
    raw[y * (1 + outW)] = 0
    const srcY = Math.floor(y / scale)
    for (let x = 0; x < outW; x++) {
      raw[y * (1 + outW) + 1 + x] = gray[srcY * cols + Math.floor(x / scale)]
    }
  }

  const deflated = zlib.deflateSync(raw)
  const pngChunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0)
    const crcData = Buffer.concat([Buffer.from(type), data])
    let crc = 0xFFFFFFFF
    for (let i = 0; i < crcData.length; i++) { crc ^= crcData[i]; for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0) }
    const crcBuf = Buffer.alloc(4); crcBuf.writeUInt32BE((crc ^ 0xFFFFFFFF) >>> 0, 0)
    return Buffer.concat([len, Buffer.from(type), data, crcBuf])
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(outW, 0); ihdr.writeUInt32BE(outH, 4)
  ihdr[8] = 8; ihdr[9] = 0; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr), pngChunk('IDAT', deflated), pngChunk('IEND', Buffer.alloc(0)),
  ])
}

function parseStudy(userId: string, studyId: string): DicomStudy | null {
  const filepath = getDicomPath(userId, studyId)
  if (!fs.existsSync(filepath) || !dicomParser) return null
  try {
    const buffer = fs.readFileSync(filepath)
    const arr = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
    const ds = dicomParser.parseDicom(arr)

    const inst = parseInstance(filepath)
    if (!inst) return null

    return {
      studyId,
      studyInstanceUid: ds.string('x0020000d') || studyId,
      studyDate: ds.string('x00080020') || '',
      studyDescription: ds.string('x00081030') || '',
      modality: ds.string('x00080060') || 'CT',
      patientHash: ds.string('x00100020') || '',
      patientAgeGroup: ds.string('x00101010') || '',
      patientSex: ds.string('x00100040') || '',
      createdMs: Date.now(),
      series: [{
        seriesInstanceUid: ds.string('x0020000e') || '1',
        seriesNumber: ds.uint16('x00200011') || 1,
        modality: ds.string('x00080060') || 'CT',
        bodyPart: '',
        seriesDescription: ds.string('x0008103e') || '',
        instances: [inst],
      }],
    }
  } catch { return null }
}

export function loadStudy(userId: string, studyId: string): DicomStudy | null {
  return parseStudy(userId, studyId)
}

export function renderSlicePng(
  userId: string, studyId: string,
  sliceIdx: number = 0,
  preset: string = 'default',
  wlOverride?: number,
  wwOverride?: number,
): Buffer | null {
  const study = loadStudy(userId, studyId)
  if (!study || study.series.length === 0) return null
  const series = study.series[0]
  const inst = series.instances[Math.min(sliceIdx, series.instances.length - 1)]
  if (!inst) return null
  return renderGrayscalePng(inst, preset, wlOverride, wwOverride, 768)
}

export function renderMipPng(
  userId: string, studyId: string,
  preset: string = 'default',
): Buffer | null {
  const study = loadStudy(userId, studyId)
  if (!study || study.series.length === 0) return null
  const series = study.series[0]
  if (series.instances.length === 0) return null

  const inst = series.instances[0]
  const { rows, cols } = inst
  const maxDim = 512
  const scale = Math.min(1, maxDim / Math.max(rows, cols))
  const outW = Math.floor(cols * scale)
  const outH = Math.floor(rows * scale)

  const mip = Buffer.alloc(rows * cols)
  for (const i of series.instances) {
    for (let p = 0; p < rows * cols; p++) {
      const hu = i.pixelData[p] * i.rescaleSlope + i.rescaleIntercept
      if (hu > mip[p]) mip[p] = Math.min(255, hu + 1000)
    }
  }

  const raw = Buffer.alloc(outH * (1 + outW))
  for (let y = 0; y < outH; y++) {
    raw[y * (1 + outW)] = 0
    const srcY = Math.floor(y / scale)
    for (let x = 0; x < outW; x++) {
      raw[y * (1 + outW) + 1 + x] = Math.max(0, Math.min(255, mip[srcY * cols + Math.floor(x / scale)]))
    }
  }

  const deflated = zlib.deflateSync(raw)
  const pngChunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0)
    const crcData = Buffer.concat([Buffer.from(type), data])
    let crc = 0xFFFFFFFF
    for (let i = 0; i < crcData.length; i++) { crc ^= crcData[i]; for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0) }
    const crcBuf = Buffer.alloc(4); crcBuf.writeUInt32BE((crc ^ 0xFFFFFFFF) >>> 0, 0)
    return Buffer.concat([len, Buffer.from(type), data, crcBuf])
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(outW, 0); ihdr.writeUInt32BE(outH, 4)
  ihdr[8]=8; ihdr[9]=0; ihdr[10]=0; ihdr[11]=0; ihdr[12]=0
  return Buffer.concat([
    Buffer.from([137,80,78,71,13,10,26,10]),
    pngChunk('IHDR', ihdr), pngChunk('IDAT', deflated), pngChunk('IEND', Buffer.alloc(0)),
  ])
}

export function renderGridPng(
  userId: string, studyId: string,
  preset: string = 'default',
): Buffer | null {
  const study = loadStudy(userId, studyId)
  if (!study || study.series.length === 0) return null
  const series = study.series[0]
  if (series.instances.length === 0) return null

  const gridSize = 4
  const thumbDim = 200
  const gap = 4
  const canvasW = gridSize * thumbDim + (gridSize - 1) * gap
  const nSlices = Math.min(gridSize * gridSize, series.instances.length)

  const grid = Buffer.alloc(canvasW * thumbDim * 4, 0)

  for (let idx = 0; idx < nSlices; idx++) {
    const inst = series.instances[idx]
    const png = renderGrayscalePng(inst, preset, undefined, undefined, thumbDim)
    if (!png) continue

    const gx = idx % gridSize
    const gy = Math.floor(idx / gridSize)
    const dstX = gx * (thumbDim + gap)
    const dstY = gy * (thumbDim + gap)

    const pngData = png.slice(37 + 8 + 13 + 8) // skip PNG sig + IHDR chunk
    const rawStart = pngData.indexOf(Buffer.from([0x78, 0x9c])) // zlib header
    if (rawStart < 0) continue
    const deflated = pngData.slice(rawStart)
    try {
      const raw = zlib.inflateSync(deflated)
      for (let y = 0; y < thumbDim && y + dstY < canvasW; y++) {
        const srcRowStart = y * (1 + thumbDim) + 1
        for (let x = 0; x < thumbDim && x + dstX < canvasW; x++) {
          const val = raw[srcRowStart + x]
          const dstIdx = ((dstY + y) * canvasW + (dstX + x)) * 4
          grid[dstIdx] = val; grid[dstIdx+1] = val; grid[dstIdx+2] = val; grid[dstIdx+3] = 255
        }
      }
    } catch { continue }
  }

  const raw = Buffer.alloc(canvasW * (1 + canvasW))
  for (let y = 0; y < canvasW; y++) {
    raw[y * (1 + canvasW)] = 0
    for (let x = 0; x < canvasW; x++) {
      const srcIdx = (y * canvasW + x) * 4
      raw[y * (1 + canvasW) + 1 + x] = grid[srcIdx]
    }
  }

  const deflated = zlib.deflateSync(raw)
  const pngChunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0)
    const crcData = Buffer.concat([Buffer.from(type), data])
    let crc = 0xFFFFFFFF
    for (let i = 0; i < crcData.length; i++) { crc ^= crcData[i]; for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0) }
    const crcBuf = Buffer.alloc(4); crcBuf.writeUInt32BE((crc ^ 0xFFFFFFFF) >>> 0, 0)
    return Buffer.concat([len, Buffer.from(type), data, crcBuf])
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(canvasW, 0); ihdr.writeUInt32BE(canvasW, 4)
  ihdr[8]=8; ihdr[9]=0; ihdr[10]=0; ihdr[11]=0; ihdr[12]=0
  return Buffer.concat([
    Buffer.from([137,80,78,71,13,10,26,10]),
    pngChunk('IHDR', ihdr), pngChunk('IDAT', deflated), pngChunk('IEND', Buffer.alloc(0)),
  ])
}

export function getMetadata(userId: string, studyId: string): Record<string, any> | null {
  const filepath = getDicomPath(userId, studyId)
  if (!dicomParser || !fs.existsSync(filepath)) return null
  try {
    const buffer = fs.readFileSync(filepath)
    const arr = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
    const ds = dicomParser.parseDicom(arr)
    const meta: Record<string, any> = {}
    for (const [tag, el] of Object.entries(ds.elements || {})) {
      try {
        const t = tag.toLowerCase().replace(/^x/, '')
        const elem = el as any
        if (elem.length > 0 && elem.length < 256) {
          meta[t] = ds.string(tag) || `[${elem.length} bytes]`
        }
      } catch { }
    }
    return meta
  } catch { return null }
}

export function getPatientContextBlock(userId: string, studyId: string): string {
  const study = loadStudy(userId, studyId)
  if (!study) return ''
  const parts: string[] = ['## Patient Imaging Context']
  if (study.patientHash) parts.push(`- Patient ID: ${study.patientHash}`)
  if (study.patientAgeGroup) parts.push(`- Age: ${study.patientAgeGroup}`)
  if (study.patientSex) parts.push(`- Sex: ${study.patientSex}`)
  if (study.studyDescription) parts.push(`- Study: ${study.studyDescription}`)
  if (study.modality) parts.push(`- Modality: ${study.modality}`)
  if (study.studyDate) parts.push(`- Date: ${study.studyDate}`)
  parts.push(`- Study ID: ${study.studyId}`)
  return parts.join('\n')
}
