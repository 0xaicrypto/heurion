#!/usr/bin/env node
/**
 * #466 — Upload Reactome pathway diagrams to object storage
 * (S3-compatible, e.g. DigitalOcean Spaces).
 *
 * The renderer loads diagrams at runtime from a public base URL
 * (REACTOME_DIAGRAMS_BASE_URL) with a local cache — no large files in git.
 *
 * Usage:
 *   S3_ENDPOINT=https://nyc3.digitaloceanspaces.com \
 *   S3_REGION=us-east-1 \
 *   S3_ACCESS_KEY_ID=... S3_SECRET_ACCESS_KEY=... \
 *   S3_BUCKET=heurion-assets S3_PREFIX=reactome-diagrams \
 *   node scripts/upload-reactome-diagrams.js [diagrams.svg.tgz] [--limit 70]
 *
 * Diagrams: https://reactome.org/download/current/diagrams.svg.tgz (272MB,
 * all ~2400 human pathways). Content: Reactome pathway diagrams —
 * CC BY 4.0 (https://reactome.org/license). Attribution required.
 */
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'
import { readdirSync, createReadStream, mkdtempSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { execFileSync } from 'child_process'

const ENDPOINT = process.env.S3_ENDPOINT || 'https://nyc3.digitaloceanspaces.com'
const REGION = process.env.S3_REGION || 'us-east-1'
const BUCKET = process.env.S3_BUCKET
const PREFIX = (process.env.S3_PREFIX || 'reactome-diagrams').replace(/\/$/, '')
const ACCESS_KEY = process.env.S3_ACCESS_KEY_ID
const SECRET_KEY = process.env.S3_SECRET_ACCESS_KEY

if (!BUCKET || !ACCESS_KEY || !SECRET_KEY) {
  console.error('Missing S3 env: S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY required')
  process.exit(2)
}

const LIMIT = (() => {
  const i = process.argv.indexOf('--limit')
  return i >= 0 ? parseInt(process.argv[i + 1], 10) : undefined
})()

const tgzPath = process.argv[2] || 'diagrams.svg.tgz'
if (!existsSync(tgzPath)) {
  console.error(`diagrams tgz not found: ${tgzPath}`)
  console.error(`Download first: curl -L https://reactome.org/download/current/diagrams.svg.tgz -o ${tgzPath}`)
  process.exit(2)
}

const client = new S3Client({
  endpoint: ENDPOINT,
  region: REGION,
  forcePathStyle: true,
  credentials: { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY },
})

async function upload(key, localPath) {
  await client.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: `${PREFIX}/${key}`,
    Body: createReadStream(localPath),
    ContentType: 'image/svg+xml',
    CacheControl: 'public, max-age=86400',
  }))
}

async function main() {
  console.log(`Extracting ${tgzPath} ...`)
  const tmpDir = mkdtempSync(join(tmpdir(), 'reactome-up-'))
  try {
    execFileSync('tar', ['-xzf', tgzPath, '-C', tmpDir])
    const files = readdirSync(tmpDir).filter((f) => f.endsWith('.svg'))
    if (LIMIT) files.length = Math.min(files.length, LIMIT)
    console.log(`Uploading ${files.length} diagrams -> s3://${BUCKET}/${PREFIX}/`)

    let uploaded = 0
    for (const f of files) {
      await upload(f, join(tmpDir, f))
      uploaded++
      if (uploaded % 100 === 0) console.log(`  ${uploaded}/${files.length}`)
    }
    console.log(`Done: ${uploaded} diagrams uploaded`)
  } catch (err) {
    console.error('Upload failed:', err.message)
    process.exitCode = 1
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
}

main()
