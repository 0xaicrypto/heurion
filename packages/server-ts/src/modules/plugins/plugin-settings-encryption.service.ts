import crypto from 'node:crypto'

const ENCRYPTION_PREFIX = 'enc:'

function getKey(): Buffer {
  const raw = process.env.PLUGIN_ENCRYPTION_KEY || process.env.SERVER_SECRET
  if (!raw) {
    // Dev-only fallback; never use in production without an explicit key.
    return crypto.createHash('sha256').update('heurion-dev-plugin-key').digest()
  }
  return crypto.createHash('sha256').update(raw).digest()
}

export function encryptSettingValue(plaintext: string): string {
  if (plaintext.startsWith(ENCRYPTION_PREFIX)) return plaintext
  if (plaintext === '') return plaintext

  const key = getKey()
  const iv = crypto.randomBytes(16)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()])
  const tag = cipher.getAuthTag()

  const payload = Buffer.concat([iv, tag, encrypted]).toString('base64')
  return `${ENCRYPTION_PREFIX}${payload}`
}

export function decryptSettingValue(ciphertext: string): string {
  if (!ciphertext.startsWith(ENCRYPTION_PREFIX)) return ciphertext

  const key = getKey()
  const payload = Buffer.from(ciphertext.slice(ENCRYPTION_PREFIX.length), 'base64')
  if (payload.length < 32) {
    throw new Error('invalid encrypted setting value')
  }

  const iv = payload.subarray(0, 16)
  const tag = payload.subarray(16, 32)
  const encrypted = payload.subarray(32)

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf-8')
}

export function isSecretField(schemaProperty: unknown): boolean {
  return (
    typeof schemaProperty === 'object' &&
    schemaProperty !== null &&
    (schemaProperty as Record<string, unknown>).format === 'secret'
  )
}

export function transformSecretValues(
  config: Record<string, unknown>,
  schema: Record<string, unknown> | undefined,
  transform: (value: string) => string,
): Record<string, unknown> {
  if (!schema) return config
  const properties = (schema.properties || {}) as Record<string, Record<string, unknown>>
  const result: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(config)) {
    const prop = properties[key]
    if (prop && isSecretField(prop) && typeof value === 'string') {
      result[key] = transform(value)
    } else {
      result[key] = value
    }
  }

  return result
}
