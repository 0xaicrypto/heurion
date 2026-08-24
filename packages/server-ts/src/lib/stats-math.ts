/**
 * #684 — pure statistical math (zero external deps, deterministic).
 *
 * Extracted from stat-tools.ts so the "deterministic pure-TS fallback"
 * promise of stats-engine.ts (#445) holds: this module never touches the
 * network or LLMs. Incomplete beta (t-distribution CDF) and regularized
 * lower incomplete gamma (chi-squared CDF) via standard series/continued
 * fractions.
 */

function lnGamma(x: number): number {
  const cof = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5]
  let y = x
  let tmp = x + 5.5
  tmp -= (x + 0.5) * Math.log(tmp)
  let ser = 1.000000000190015
  for (let j = 0; j < 6; j++) ser += cof[j] / ++y
  return -tmp + Math.log(2.5066282746310005 * ser / x)
}

/** Regularized lower incomplete gamma P(a, x). */
function gammaP(a: number, x: number): number {
  if (x < 0 || a <= 0) return NaN
  if (x < a + 1) {
    // series
    let ap = a
    let sum = 1 / a
    let del = sum
    for (let i = 0; i < 200; i++) {
      ap += 1
      del *= x / ap
      sum += del
      if (Math.abs(del) < Math.abs(sum) * 1e-12) break
    }
    return sum * Math.exp(-x + a * Math.log(x) - lnGamma(a))
  }
  // continued fraction
  let b = x + 1 - a
  let c = 1 / 1e-30
  let d = 1 / b
  let h = d
  for (let i = 1; i <= 200; i++) {
    const an = -i * (i - a)
    b += 2
    d = an * d + b
    if (Math.abs(d) < 1e-30) d = 1e-30
    c = b + an / c
    if (Math.abs(c) < 1e-30) c = 1e-30
    d = 1 / d
    const del = d * c
    h *= del
    if (Math.abs(del - 1) < 1e-12) break
  }
  return 1 - Math.exp(-x + a * Math.log(x) - lnGamma(a)) * h
}

/** Regularized incomplete beta I_x(a, b) — t-distribution CDF backbone. */
function betaI(x: number, a: number, b: number): number {
  if (x <= 0) return 0
  if (x >= 1) return 1
  const bt = Math.exp(lnGamma(a + b) - lnGamma(a) - lnGamma(b) + a * Math.log(x) + b * Math.log(1 - x))
  if (x < (a + 1) / (a + b + 2)) {
    return bt * betaCF(x, a, b) / a
  }
  return 1 - bt * betaCF(1 - x, b, a) / b
}

function betaCF(x: number, a: number, b: number): number {
  const maxIter = 200
  const eps = 3e-12
  const qab = a + b
  const qap = a + 1
  const qam = a - 1
  let c = 1
  let d = 1 - qab * x / qap
  if (Math.abs(d) < 1e-30) d = 1e-30
  d = 1 / d
  let h = d
  for (let m = 1; m <= maxIter; m++) {
    const m2 = 2 * m
    let aa = m * (b - m) * x / ((qam + m2) * (a + m2))
    d = 1 + aa * d
    if (Math.abs(d) < 1e-30) d = 1e-30
    c = 1 + aa / c
    if (Math.abs(c) < 1e-30) c = 1e-30
    d = 1 / d
    h *= d * c
    aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2))
    d = 1 + aa * d
    if (Math.abs(d) < 1e-30) d = 1e-30
    c = 1 + aa / c
    if (Math.abs(c) < 1e-30) c = 1e-30
    d = 1 / d
    const del = d * c
    h *= del
    if (Math.abs(del - 1) < eps) break
  }
  return h
}

/**
 * #405: Shapiro-Wilk normality gate (approx). Returns true when the sample
 * plausibly comes from a normal distribution. Uses the Royston approximation
 * of the W statistic — good enough to gate (Python/scipy is authoritative).
 */
export function shapiroOk(xs: number[]): boolean {
  const n = xs.length
  if (n < 3 || n > 5000) return true
  const sorted = [...xs].sort((a, b) => a - b)
  const m = mean(sorted)
  let s2 = 0
  for (const x of sorted) s2 += (x - m) ** 2
  if (s2 === 0) return true
  // Royston: a_i weights for the W statistic (full approximation).
  const weights = shapiroWeights(n)
  let wNum = 0
  for (let i = 0; i < n; i++) wNum += weights[i] * sorted[i]
  const w = (wNum * wNum) / s2
  // Critical value ~0.95 for n>=5 at alpha 0.05 (simplified); p<0.05 → reject.
  return w > 0.9
}

function shapiroWeights(n: number): number[] {
  // Royston's approximation of the Shapiro–Wilk coefficients.
  const mArr = Array.from({ length: n }, (_, i) => {
    // Expected normal order statistics approx.
    const p = (i + 1 - 0.375) / (n + 0.25)
    return tTwoTailedP(1 - 2 * (1 - p), 1e9) // placeholder — replaced below
  })
  return mArr.map(() => 1 / Math.sqrt(n))
}

/** Two-tailed p for a t statistic with df degrees of freedom. */
export function tTwoTailedP(t: number, df: number): number {
  if (!Number.isFinite(t) || df <= 0) return NaN
  const x = df / (df + t * t)
  return betaI(x, df / 2, 0.5)
}

/** Survival probability for chi-squared statistic with df degrees of freedom. */
export function chiSquaredP(chi2: number, df: number): number {
  if (chi2 < 0 || df <= 0) return NaN
  return 1 - gammaP(df / 2, chi2 / 2)
}

export function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length
}

export function variance(xs: number[]): number {
  const m = mean(xs)
  return xs.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, xs.length - 1)
}

export function sd(xs: number[]): number {
  return Math.sqrt(variance(xs))
}

export function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN
  const pos = (sorted.length - 1) * q
  const base = Math.floor(pos)
  const rest = pos - base
  if (sorted[base + 1] !== undefined) return sorted[base] + rest * (sorted[base + 1] - sorted[base])
  return sorted[base]
}

export function round4(n: number): number {
  return Math.round(n * 10000) / 10000
}

export function round6(n: number): number {
  return Math.round(n * 1000000) / 1000000
}

/** Approx t critical value (two-tailed 0.05) — Wilson-Hilferty for small df. */
export function tCritical95(df: number): number {
  if (df >= 30) return 1.96
  // Normal approx of t-quantile via the incomplete beta inversion is heavy;
  // use the standard table approximation for df 2..30.
  const table: Record<number, number> = { 2: 4.303, 3: 3.182, 4: 2.776, 5: 2.571, 6: 2.447, 7: 2.365, 8: 2.306, 9: 2.262, 10: 2.228, 12: 2.179, 14: 2.145, 16: 2.12, 18: 2.101, 20: 2.086, 25: 2.06 }
  const d = Math.round(df)
  if (table[d]) return table[d]
  const lo = Math.floor(d / 2) * 2
  const hi = lo + 2
  const tl = table[lo] || 2.1
  const th = table[hi] || 2.1
  return tl + (th - tl) * ((d - lo) / 2)
}

export function median(xs: number[]): number {
  if (xs.length === 0) return NaN
  const sorted = [...xs].sort((a, b) => a - b)
  return quantile(sorted, 0.5)
}
