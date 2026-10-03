/**
 * 化验单位换算：不同医院同一项目用不同单位（肌酐 µmol/L 与 mg/dL、血糖 mmol/L 与 mg/dL……）。
 * 原始数值与单位一律保留（溯源）；化验表、趋势、AI 读到的「标准值」统一换到每个项目的标准单位。
 * 不认识的单位不强行换算：标 unknown_unit，界面与 AI 都会看到「单位不一致」。
 */

/** 单位写法归一：µ / μ / u、大小写、上标。 */
export function normUnit(unit: string | null): string | null {
  if (!unit) return null
  let u = unit.trim().replace(/\s+/g, '')
  u = u.replace(/^[μu]/, 'µ').replace(/[μ]/g, 'µ')
  u = u.replace(/\/l$/i, '/L').replace(/\/dl$/i, '/dL').replace(/^mg\/dl$/i, 'mg/dL').replace(/^g\/dl$/i, 'g/dL')
  u = u.replace(/^mmol\/l$/i, 'mmol/L').replace(/^µmol\/l$/i, 'µmol/L').replace(/^mmol\/mol$/i, 'mmol/mol').replace(/^meq\/l$/i, 'mEq/L')
  u = u.replace(/^(10\^?9|10⁹|x?10\^9)\/L$/i, '10^9/L').replace(/^(10\^?12|10¹²)\/L$/i, '10^12/L').replace(/^(10\^?3|10³|k)\/(µL|ul|mm3|mm³)$/i, '10^3/µL')
  u = u.replace(/^ml\/min\/1\.73m[2²]$/i, 'mL/min/1.73m²').replace(/^u\/l$/i, 'U/L').replace(/^iu\/l$/i, 'U/L')
  return u
}

type Conv = (v: number) => number
interface Spec { unit: string; from: Record<string, Conv> }

/** 每个项目的标准单位与可换算的单位（换算系数见常用检验医学换算表）。 */
const SPECS: Record<string, Spec> = {
  creatinine: { unit: 'µmol/L', from: { 'mg/dL': v => v * 88.42 } },
  urea: { unit: 'mmol/L', from: { 'mg/dL': v => v * 0.357 } }, // mg/dL 按尿素氮（BUN）
  glucose: { unit: 'mmol/L', from: { 'mg/dL': v => v / 18.016 } },
  uric_acid: { unit: 'µmol/L', from: { 'mg/dL': v => v * 59.48 } },
  cholesterol: { unit: 'mmol/L', from: { 'mg/dL': v => v / 38.67 } },
  ldl: { unit: 'mmol/L', from: { 'mg/dL': v => v / 38.67 } },
  hdl: { unit: 'mmol/L', from: { 'mg/dL': v => v / 38.67 } },
  triglycerides: { unit: 'mmol/L', from: { 'mg/dL': v => v / 88.57 } },
  bilirubin: { unit: 'µmol/L', from: { 'mg/dL': v => v * 17.1 } },
  hemoglobin: { unit: 'g/L', from: { 'g/dL': v => v * 10 } },
  albumin: { unit: 'g/L', from: { 'g/dL': v => v * 10 } },
  total_protein: { unit: 'g/L', from: { 'g/dL': v => v * 10 } },
  hba1c: { unit: '%', from: { 'mmol/mol': v => v / 10.929 + 2.15 } },
  potassium: { unit: 'mmol/L', from: { 'mEq/L': v => v } },
  sodium: { unit: 'mmol/L', from: { 'mEq/L': v => v } },
  chloride: { unit: 'mmol/L', from: { 'mEq/L': v => v } },
  wbc: { unit: '10^9/L', from: { '10^3/µL': v => v } },
  platelets: { unit: '10^9/L', from: { '10^3/µL': v => v } },
  crp: { unit: 'mg/L', from: { 'mg/dL': v => v * 10 } },
  egfr: { unit: 'mL/min/1.73m²', from: {} },
  alt: { unit: 'U/L', from: {} },
  ast: { unit: 'U/L', from: {} },
}

export interface Std {
  /** 换算到标准单位后的值（无法换算时为原值） */
  value: number | null
  unit: string | null
  converted: boolean
  /** 单位既不是标准单位也不在换算表里 */
  unknown_unit: boolean
}

const round = (v: number) => Number(v.toPrecision(4))

export function standardize(key: string, value: number | null, unit: string | null): Std {
  const u = normUnit(unit)
  const spec = SPECS[key]
  if (value === null) return { value: null, unit: u, converted: false, unknown_unit: false }
  if (!spec || !u || u === spec.unit) return { value, unit: u ?? spec?.unit ?? null, converted: false, unknown_unit: false }
  const f = spec.from[u]
  if (!f) return { value, unit: u, converted: false, unknown_unit: true }
  return { value: round(f(value)), unit: spec.unit, converted: true, unknown_unit: false }
}

/** 参考范围一起换算（两端用同一个函数）。 */
export function standardizeRange(key: string, low: number | null, high: number | null, unit: string | null): { low: number | null; high: number | null } {
  // 换算出来的参考范围保留 3 位有效数字（57–111 这样的写法，而不是 61.89–114.9）；没换算的保持报告原样
  const r = (v: number | null, d: Std) => v === null || !d.converted ? d.value : Number(Number(d.value).toPrecision(3))
  const lo = standardize(key, low, unit), hi = standardize(key, high, unit)
  return { low: r(low, lo), high: r(high, hi) }
}
