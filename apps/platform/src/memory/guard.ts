/**
 * 记忆的敏感内容守卫（写前，AI 提议、用户手动添加、导入都过）：患者可识别信息与金融账号不进记忆，
 * 用户要求也不行。返回拦截原因（给用户看），没问题返回 null。
 */

const SURNAMES = '王李张刘陈杨黄赵吴周徐孙马朱胡郭何高林罗郑梁谢宋唐许韩冯邓曹彭曾肖田董袁潘于蒋蔡余杜叶程苏魏吕丁任沈姚卢姜崔钟谭陆汪范金石廖贾夏韦付方白邹孟熊秦邱江尹薛闫段雷侯龙史陶黎贺顾毛郝龚邵万钱严覃武戴莫孔向汤'

const RULES: Array<{ re: RegExp; why: string }> = [
  { re: /(?<![0-9])\d{17}[\dXx](?![0-9A-Za-z])/, why: '身份证号' },
  { re: /(?<!\d)1[3-9]\d{9}(?!\d)/, why: '手机号' },
  { re: /(住院号|病历号|病案号|门诊号|就诊号|登记号|床号|MRN|patient\s*id)\s*[:：#]?\s*[A-Za-z0-9-]{2,}/i, why: '住院号 / 病历号等患者编号' },
  { re: /(?<!\d)\d{16,19}(?!\d)/, why: '银行卡号等账号' },
  { re: /(出生日期|生日|DOB|date of birth)\s*[:：]?\s*\d{4}/i, why: '出生日期' },
  { re: /(家庭住址|住址|家住|home address)\s*[:：]?\s*\S{4,}/i, why: '住址' },
  { re: /(姓名|患者姓名)\s*[:：]\s*\S/, why: '患者姓名' },
  // 「患者王某某，男，65 岁」这类：患者 + 姓 + 名 + 性别 / 年龄
  { re: new RegExp(`(患者|病人|病友)\\s*[${SURNAMES}][\\u4e00-\\u9fa5某*Xx]{1,2}\\s*[，,、(（]?\\s*(男|女|\\d{1,3}\\s*岁)`), why: '患者姓名与个人信息' },
]

export function sensitiveReason(text: string): string | null {
  for (const r of RULES) if (r.re.test(text)) return `包含${r.why}，记忆里不保存可识别患者或个人账号的信息`
  return null
}
