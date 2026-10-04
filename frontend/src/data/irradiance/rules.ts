import type { AnomalyRules, Reading } from './types'

/**
 * 异常判定规则：当日辐照量 / 峰值辐照 / 组件温度 / 环境温度四格各设上下限。
 * 只要有一格缺失或越线，整笔读数判废——当日辐照量只认有效读数，坏值不算。
 * 改线只改 rules 这一份，既有读数照新线重过一遍（recheckReadings）。
 */
export const DEFAULT_RULES_V1: Omit<
  AnomalyRules,
  'version' | 'updatedAt' | 'updatedBy'
> = {
  irradiation: [0, 10000],
  peak: [0, 1600],
  moduleTemp: [-40, 85],
  ambientTemp: [-40, 60],
}

export interface FieldIssue {
  field: string
  label: string
  value: number | null
}

export function evaluateReading(
  values: Pick<Reading, 'irradiation' | 'peak' | 'moduleTemp' | 'ambientTemp'>,
  rules: AnomalyRules,
): Pick<Reading, 'verdict' | 'reasons'> {
  const fields: { key: keyof typeof values; label: string; range: [number, number] }[] = [
    { key: 'irradiation', label: '当日辐照量', range: rules.irradiation },
    { key: 'peak', label: '峰值辐照', range: rules.peak },
    { key: 'moduleTemp', label: '组件温度', range: rules.moduleTemp },
    { key: 'ambientTemp', label: '环境温度', range: rules.ambientTemp },
  ]
  const reasons: string[] = []
  for (const { key, label, range } of fields) {
    const value = values[key]
    if (value === null || Number.isNaN(value)) {
      reasons.push(`${label}缺测`)
      continue
    }
    const [min, max] = range
    if (value < min || value > max) {
      reasons.push(`${label} ${value} 越线（允许 ${min}~${max}）`)
    }
  }
  return {
    verdict: reasons.length === 0 ? '有效' : '无效',
    reasons,
  }
}

/** 改线后把一批读数照新线逐笔重过，返回是否有判定翻转。 */
export function recheckReadings(readings: Reading[], rules: AnomalyRules): boolean {
  let flipped = false
  for (const reading of readings) {
    const next = evaluateReading(reading, rules)
    if (next.verdict !== reading.verdict || next.reasons.join('；') !== reading.reasons.join('；')) {
      flipped = true
    }
    reading.verdict = next.verdict
    reading.reasons = next.reasons
    reading.ruleVersion = rules.version
  }
  return flipped
}

export function describeRules(rules: AnomalyRules): string {
  return [
    `当日辐照量 ${rules.irradiation[0]}~${rules.irradiation[1]} Wh/m²`,
    `峰值辐照 ${rules.peak[0]}~${rules.peak[1]} W/m²`,
    `组件温度 ${rules.moduleTemp[0]}~${rules.moduleTemp[1]} ℃`,
    `环境温度 ${rules.ambientTemp[0]}~${rules.ambientTemp[1]} ℃`,
  ].join('；')
}
