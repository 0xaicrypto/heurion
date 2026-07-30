import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'
import { createWriteStream } from 'fs'
import { mkdir, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { v4 as uuid } from 'uuid'

const outputDir = join(tmpdir(), 'heurion-worker')

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
    result.downloadUrl = getDownloadUrl(s3Key)
  }
  return result
}

export function getDownloadUrl(s3Key: string): string {
  const endpoint = process.env.S3_ENDPOINT || ''
  return `${endpoint}/${bucket}/${s3Key}`
}
