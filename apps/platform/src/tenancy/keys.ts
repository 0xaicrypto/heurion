import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'
import type { Store } from '../store/db.ts'

/**
 * 机构数据密钥（docs/design/TENANCY.md §3）：每个机构一把 256 位数据密钥（DEK），用平台主密钥（KEK）以 AES-256-GCM 包裹后存主库。
 * 患者的原始文件与自由文本用 DEK 加密；销毁 DEK（删除机构）后密文不可恢复（加密擦除），包括备份里的。
 * KEK：环境变量 HEURION_KEK（base64 的 32 字节）；没配时从 HEURION_SECRET 派生（开发 / 测试）。以后换 KMS。
 * 说明：患者库（SQLite）里的结构化数值不加密——node:sqlite 不支持整库加密；隔离靠每机构一个库文件 + 访问控制。
 */

const ALG = 'aes-256-gcm'
const IV = 12
const TAG = 16

export function kekFrom(env: { kek?: string; secret: string }): Buffer {
  if (env.kek) {
    const k = Buffer.from(env.kek, 'base64')
    if (k.length !== 32) throw new Error('HEURION_KEK 必须是 base64 编码的 32 字节')
    return k
  }
  return Buffer.from(hkdfSync('sha256', env.secret, 'heurion', 'tenant-kek-v1', 32))
}

function seal(key: Buffer, plain: Buffer): Buffer {
  const iv = randomBytes(IV)
  const c = createCipheriv(ALG, key, iv)
  const body = Buffer.concat([c.update(plain), c.final()])
  return Buffer.concat([iv, c.getAuthTag(), body])
}

function open(key: Buffer, sealed: Buffer): Buffer {
  if (sealed.length < IV + TAG) throw new Error('密文太短')
  const d = createDecipheriv(ALG, key, sealed.subarray(0, IV))
  d.setAuthTag(sealed.subarray(IV, IV + TAG))
  return Buffer.concat([d.update(sealed.subarray(IV + TAG)), d.final()])
}

export class KeyDestroyedError extends Error {}

export class TenantKeys {
  private cache = new Map<string, Buffer>()
  constructor(private readonly store: Store, private readonly kek: Buffer) {}

  /** 机构的 DEK：第一次用时生成。已销毁的机构抛 KeyDestroyedError。 */
  dek(tenantId: string): Buffer {
    const hit = this.cache.get(tenantId)
    if (hit) return hit
    const t = this.store.getTenant(tenantId)
    if (!t) throw new Error(`机构 ${tenantId} 不存在`)
    let wrapped = this.store.getTenantDek(tenantId)
    if (wrapped === 'destroyed') throw new KeyDestroyedError('这个机构的数据密钥已销毁')
    if (!wrapped) {
      wrapped = seal(this.kek, randomBytes(32)).toString('base64')
      this.store.setTenantDek(tenantId, wrapped)
    }
    const key = open(this.kek, Buffer.from(wrapped, 'base64'))
    this.cache.set(tenantId, key)
    return key
  }

  encrypt(tenantId: string, plain: Buffer | string): Buffer {
    return seal(this.dek(tenantId), typeof plain === 'string' ? Buffer.from(plain, 'utf8') : plain)
  }

  decrypt(tenantId: string, sealed: Buffer): Buffer {
    return open(this.dek(tenantId), sealed)
  }

  encryptText(tenantId: string, text: string | null): string | null {
    return text === null ? null : this.encrypt(tenantId, text).toString('base64')
  }

  decryptText(tenantId: string, sealed: string | null): string | null {
    return sealed === null ? null : this.decrypt(tenantId, Buffer.from(sealed, 'base64')).toString('utf8')
  }

  /** 销毁机构的 DEK（删除机构时）：之后这个机构的所有密文都不能再解开。 */
  destroy(tenantId: string): void {
    this.cache.delete(tenantId)
    this.store.setTenantDek(tenantId, 'destroyed')
  }
}
