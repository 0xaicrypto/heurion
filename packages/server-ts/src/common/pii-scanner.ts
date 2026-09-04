/**
 * #842 — PII 扫描器:skill 落库(graph SkillNode)前的强制闸门。
 * D4:marketplace install 亦强制本扫描。命中即拒,不做静默脱敏 —
 * skill 剧本若含患者身份信息,说明采集/归纳环节出了问题,应回炉。
 */

export interface PiiHit {
  kind: 'id_card' | 'phone' | 'medical_record_no' | 'patient_hash' | 'person_name'
  sample: string
}

export interface PiiScanResult {
  clean: boolean
  hits: PiiHit[]
}

const ID_CARD_RE = /\b\d{17}[\dXx]\b/
const PHONE_RE = /\b1[3-9]\d{9}\b/
const MRN_RE = /(?:住院|病历|门诊|检查|床)\s*[号牌]\s*[:：#]?\s*[A-Za-z0-9\-]{4,}/
/** patientHash 约定前缀(ph_/patient_) — 出现在剧本里即视为标识符泄漏。 */
const PATIENT_HASH_RE = /\b(?:ph|patient)[_-][0-9a-zA-Z_-]{4,}\b/
/** 中文姓名:仅上下文锚定(患者/医生/主任等 + 常见姓氏 + 1-2 字名),
 *  避免对普通名词的误报;采样即拒足够(不需要全量姓名库)。 */
const PERSON_NAME_RE =
  /(?:患者|病人|医师|医生|主任|教授|主治|护士|家属)[\s:：为是]*[张王李赵刘陈杨黄周吴徐孙马朱胡郭何林罗高郑梁谢宋唐许韩冯邓曹彭曾肖田董潘袁蔡蒋余杜叶程苏魏吕丁任沈姚卢姜崔钟谭陆汪范金石廖贾夏韦付方白邹孟熊秦邱江尹薛闫段雷侯龙史陶黎贺顾毛郝龚邵万钱严覃武戴莫孔向汤][一-龥]{1,2}/

export function scanPii(text: string): PiiScanResult {
  const hits: PiiHit[] = []
  const push = (kind: PiiHit['kind'], m: string) => hits.push({ kind, sample: m.slice(0, 40) })

  for (const m of text.matchAll(new RegExp(ID_CARD_RE.source, 'g'))) push('id_card', m[0])
  for (const m of text.matchAll(new RegExp(PHONE_RE.source, 'g'))) push('phone', m[0])
  for (const m of text.matchAll(new RegExp(MRN_RE.source, 'g'))) push('medical_record_no', m[0])
  for (const m of text.matchAll(new RegExp(PATIENT_HASH_RE.source, 'g'))) push('patient_hash', m[0])
  for (const m of text.matchAll(new RegExp(PERSON_NAME_RE.source, 'g'))) push('person_name', m[0])

  return { clean: hits.length === 0, hits }
}

/** skill 落库前的组合扫描:剧本全部文本字段一并检查。 */
export function scanSkillPii(input: {
  name: string
  description: string
  steps: string[]
  promptTemplate: string
}): PiiScanResult {
  const combined = [
    input.name,
    input.description,
    ...input.steps,
    input.promptTemplate,
  ].join('\n')
  return scanPii(combined)
}
