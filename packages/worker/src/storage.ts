import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { createWriteStream } from 'fs'
import { mkdir, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { v4 as uuid } from 'uuid'

const outputDir = join(tmpdir(), 'heurion-worker')
const DOWNLOAD_URL_TTL_SECONDS = 3600

const s3 = process.env.S3_ENDPOINT
  ? new S3Client({
      endpoint: process.env.S3_ENDPOINT,
      region: process.env.S3_REGION || 'us-east-1',
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY_ID || '',
        secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || '',
      },
      forcePathStyle: true,
    })
  : null

const bucket = process.env.S3_BUCKET || 'heurion-worker'

export interface StorageResult {
  fileId: string
  fileName: string
  mimeType: string
  s3Key?: string
  downloadUrl?: string
}

/** Local files stay on disk; fileId → local path (in-memory; #446 persists). */
const localFiles = new Map<string, { path: string; fileName: string; mimeType: string }>()

export async function saveFile(
  content: Buffer,
  fileName: string,
  mimeType: string,
  prefix = 'renders',
): Promise<StorageResult> {
  const fileId = uuid()
  await mkdir(outputDir, { recursive: true })

  const localPath = join(outputDir, `${fileId}_${fileName}`)
  const s3Key = `${prefix}/${fileId}/${fileName}`
  await writeFile(localPath, content)
  localFiles.set(fileId, { path: localPath, fileName, mimeType })

  if (s3) {
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: s3Key,
        Body: content,
        ContentType: mimeType,
      }),
    )
  }

  const result: StorageResult = { fileId, fileName, mimeType, s3Key: s3 ? s3Key : undefined }
  if (s3) {
    result.downloadUrl = (await getDownloadUrl(s3Key)) || undefined
  }
  return result
}

/**
 * #447 — honest download URLs:
 *  - S3 mode: a REAL presigned URL (GetObject, valid for 1h).
 *  - local mode: the worker's own proxy endpoint (/files/:fileId/content),
 *    which the control plane proxies through its authenticated files route.
 * No more fake "expires_in: 3600" on unsigned public URLs.
 */
export async function getDownloadUrl(s3Key: string): Promise<string | null> {
  if (!s3) return null
  return getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: bucket, Key: s3Key }),
    { expiresIn: DOWNLOAD_URL_TTL_SECONDS },
  )
}

export function getLocalFile(fileId: string): { path: string; fileName: string; mimeType: string } | null {
  return localFiles.get(fileId) ?? null
}

export function localDownloadUrl(fileId: string): string {
  return `/api/v1/files/${fileId}/content`
}

export function downloadUrlTtlSeconds(): number {
  return DOWNLOAD_URL_TTL_SECONDS
}

// keep createWriteStream import (used by callers via storage module)
export { createWriteStream }
