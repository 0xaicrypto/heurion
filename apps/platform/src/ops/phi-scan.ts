/**
 * 生产合规与 PHI (Protected Health Information) 敏感数据扫描与脱敏器。
 * 纯本地算法与正则实现，零网络请求、零外部模型调用。
 * 支持：
 * 1. 中国大陆 18 位居民身份证号码（含 ISO 7064:1983.MOD 11-2 校验和与出生日期校验）
 * 2. 中国大陆 11 位手机号码（严格前缀与边界防误报）
 * 3. 银行卡号（11-19 位，含 Luhn 模 10 校验和）
 * 4. 医疗记录编号（住院号、门诊号、就诊号、病案号等上下文）
 * 5. 真实姓名与敏感疾病诊断强关联组合
 */

export type PhiType = 'id_card' | 'phone' | 'bank_card' | 'medical_record_no' | 'name_with_diagnosis'

export interface PhiFinding {
  type: PhiType
  value: string
  redacted: string
  start: number
  end: number
  score: number // 0 ~ 1.0 置信度
  description: string
}

// 身份证校验权重与校验码
const ID_CARD_WEIGHTS = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2] as const
const ID_CARD_CHECKS = ['1', '0', 'X', '9', '8', '7', '6', '5', '4', '3', '2'] as const

/** 验证中国大陆 18 位身份证号码校验和与日期 */
export function validateIdCard(id: string): boolean {
  if (!/^[1-9]\d{5}(?:18|19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]$/.test(id)) {
    return false
  }
  const year = Number(id.slice(6, 10))
  const month = Number(id.slice(10, 12))
  const day = Number(id.slice(12, 14))
  const currentYear = new Date().getFullYear()
  if (year < 1900 || year > currentYear) return false

  // 验证月份天数
  const date = new Date(year, month - 1, day)
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return false
  }

  // 计算 MOD 11-2 校验码
  let sum = 0
  for (let i = 0; i < 17; i++) {
    const char = id[i]
    const weight = ID_CARD_WEIGHTS[i]
    if (!char || weight === undefined) return false
    sum += Number(char) * weight
  }
  const checkChar = ID_CARD_CHECKS[sum % 11]
  const lastChar = id[17]
  return lastChar !== undefined && lastChar.toUpperCase() === checkChar
}

/** 验证银行卡 Luhn 算法（模 10 校验） */
export function validateLuhn(num: string): boolean {
  if (!/^\d{11,19}$/.test(num)) return false
  let sum = 0
  let alternate = false
  for (let i = num.length - 1; i >= 0; i--) {
    const char = num[i]
    if (!char) return false
    let digit = Number(char)
    if (alternate) {
      digit *= 2
      if (digit > 9) digit -= 9
    }
    sum += digit
    alternate = !alternate
  }
  return sum % 10 === 0
}

/** 脱敏工具函数 */
function maskMiddle(val: string, prefixLen: number, suffixLen: number): string {
  if (val.length <= prefixLen + suffixLen) return '*'.repeat(val.length)
  const maskLen = val.length - prefixLen - suffixLen
  return val.slice(0, prefixLen) + '*'.repeat(maskLen) + val.slice(val.length - suffixLen)
}

/**
 * 扫描文本中的所有 PHI 实体。
 */
export function scanPhi(text: string): PhiFinding[] {
  if (!text || typeof text !== 'string') return []
  const findings: PhiFinding[] = []

  // 1. 身份证号（18 位带校验）
  const idCardRegex = /(?:^|[^\d])([1-9]\d{5}(?:18|19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx])(?=[^\d]|$)/g
  let m: RegExpExecArray | null
  while ((m = idCardRegex.exec(text)) !== null) {
    const raw = m[1]
    if (!raw) continue
    const start = m.index + (m[0].length - raw.length)
    const end = start + raw.length
    if (validateIdCard(raw)) {
      findings.push({
        type: 'id_card',
        value: raw,
        redacted: maskMiddle(raw, 6, 4),
        start,
        end,
        score: 0.99,
        description: '居民身份证号（校验和通过）',
      })
    }
  }

  // 2. 手机号（11 位）
  const phoneRegex = /(?:^|[^\d])(1[3-9]\d{9})(?=[^\d]|$)/g
  while ((m = phoneRegex.exec(text)) !== null) {
    const raw = m[1]
    if (!raw) continue
    const start = m.index + (m[0].length - raw.length)
    const end = start + raw.length
    findings.push({
      type: 'phone',
      value: raw,
      redacted: maskMiddle(raw, 3, 4),
      start,
      end,
      score: 0.95,
      description: '中国大陆手机号码',
    })
  }

  // 3. 银行卡号（13-19位，带 Luhn 校验）
  const cardRegex = /(?:^|[^\d])(\d{13,19})(?=[^\d]|$)/g
  while ((m = cardRegex.exec(text)) !== null) {
    const raw = m[1]
    if (!raw) continue
    const start = m.index + (m[0].length - raw.length)
    const end = start + raw.length
    // 如果已经属于身份证，则跳过
    if (findings.some(f => f.type === 'id_card' && start >= f.start && end <= f.end)) continue
    if (validateLuhn(raw)) {
      findings.push({
        type: 'bank_card',
        value: raw,
        redacted: maskMiddle(raw, 6, 4),
        start,
        end,
        score: 0.95,
        description: '银行卡号（Luhn 校验通过）',
      })
    }
  }

  // 4. 就诊号 / 住院号 / 病案号 / 门诊号
  const medNoRegex = /(?:住院号|就诊号|病案号|门诊号|病历号|床号)[:：\s]+([A-Za-z0-9\-_]{4,24})/g
  while ((m = medNoRegex.exec(text)) !== null) {
    const full = m[0]
    const raw = m[1]
    if (!raw) continue
    const start = m.index
    const end = start + full.length
    findings.push({
      type: 'medical_record_no',
      value: full,
      redacted: full.replace(raw, maskMiddle(raw, 2, 2)),
      start,
      end,
      score: 0.9,
      description: '医疗记录编号（就诊号/住院号/病案号）',
    })
  }

  // 5. 姓名与敏感疾病诊断强关联组合
  // 例如：“患者姓名：张三，确诊为肺腺癌” 或 “姓名:李四 诊断: 2型糖尿病”
  const nameDiagRegex = /(?:(?:患者|病人)?(?:姓名|名字)[:：\s]*([\u4e00-\u9fa5]{2,4}))([^\n。；！？]{0,25}?(?:确诊|诊断|患有|考虑为|临床表现为)[:：\s]*)([\u4e00-\u9fa5]{2,12}(?:癌|瘤|炎|症|病|综合征|感染|结石|结节|甲流|乙流|骨折|衰竭|梗死|狭窄|硬化|坏死|损伤))/g
  while ((m = nameDiagRegex.exec(text)) !== null) {
    const full = m[0]
    const name = m[1]
    if (!name) continue
    const start = m.index
    const end = start + full.length
    findings.push({
      type: 'name_with_diagnosis',
      value: full,
      redacted: full.replace(name, maskMiddle(name, 1, 0)),
      start,
      end,
      score: 0.85,
      description: '患者真实姓名与敏感诊断关联',
    })
  }

  // 按照起始位置排序
  findings.sort((a, b) => a.start - b.start)

  // 过滤重叠区域，保留优先级高的
  const filtered: PhiFinding[] = []
  for (const f of findings) {
    const overlap = filtered.find(existing => Math.max(existing.start, f.start) < Math.min(existing.end, f.end))
    if (!overlap) {
      filtered.push(f)
    } else if (f.score > overlap.score) {
      const idx = filtered.indexOf(overlap)
      filtered[idx] = f
    }
  }

  return filtered
}

/**
 * 将文本中识别到的所有 PHI 实体进行脱敏替换。
 */
export function redactPhi(text: string): string {
  const findings = scanPhi(text)
  if (findings.length === 0) return text

  // 从后向前替换，保持 index 稳定
  let result = text
  for (let i = findings.length - 1; i >= 0; i--) {
    const f = findings[i]
    if (!f) continue
    result = result.slice(0, f.start) + f.redacted + result.slice(f.end)
  }
  return result
}
