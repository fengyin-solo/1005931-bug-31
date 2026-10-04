import type { EntryReading, EntryRow } from './types'

/**
 * 辐照监测判定规则（新线）。
 *
 * 坏值判定（任一命中即为数据异常）：
 *  1. 缺测：当日辐照量、峰值辐照为空；
 *  2. 超量程：当日辐照量超出 [0, 9000] Wh/m²，或峰值辐照超出 [0, 1500] W/m²；
 *  3. 峰均倒挂：峰值折算的辐照总量低于当日累计值（峰值功率 × 有效日照时长都补不上累计值）；
 *  4. 温度越界：组件温度超出 [-40, 85] ℃，或环境温度超出 [-40, 60] ℃。
 * 峰值为 0 但当日辐照量大于 0 属于倒挂的特例，同样判坏值。
 */
export const IRRADIANCE_RULE_VERSION = 2
export const DAILY_LIMIT = 9000
export const PEAK_LIMIT = 1500
export const MODULE_TEMP_MIN = -40
export const MODULE_TEMP_MAX = 85
export const AMBIENT_TEMP_MIN = -40
export const AMBIENT_TEMP_MAX = 60
/** 折算有效日照时长（h）：峰值功率持续这么久得到的辐照量为当日值的合理上限。 */
export const EFFECTIVE_SUN_HOURS = 12

export type ReadingInput = Omit<EntryReading, 'ruleVersion' | 'reasons'>

export type Evaluation = Pick<EntryReading, 'reasons'> & {
  abnormal: boolean
  daily: number | null
  peak: number | null
}

function outside(value: number | null, min: number, max: number): boolean {
  return value !== null && (value < min || value > max)
}

/** 按当前规则线评估一条读数，返回是否坏值与具体原因。 */
export function evaluateReading(input: ReadingInput): Evaluation {
  const reasons: string[] = []
  const daily = input.daily
  const peak = input.peak

  if (daily === null || peak === null) {
    if (daily === null) reasons.push('当日辐照量缺测')
    if (peak === null) reasons.push('峰值辐照缺测')
  } else {
    if (outside(daily, 0, DAILY_LIMIT)) {
      reasons.push(`当日辐照量 ${daily} 超出 0~${DAILY_LIMIT} Wh/m² 量程`)
    }
    if (outside(peak, 0, PEAK_LIMIT)) {
      reasons.push(`峰值辐照 ${peak} 超出 0~${PEAK_LIMIT} W/m² 量程`)
    }
    if (daily >= 0 && peak >= 0 && peak * EFFECTIVE_SUN_HOURS < daily) {
      reasons.push('峰值辐照与当日辐照量倒挂')
    }
  }

  if (outside(input.moduleTemp, MODULE_TEMP_MIN, MODULE_TEMP_MAX)) {
    reasons.push(`组件温度 ${input.moduleTemp} 越出 ${MODULE_TEMP_MIN}~${MODULE_TEMP_MAX} ℃`)
  }
  if (outside(input.ambientTemp, AMBIENT_TEMP_MIN, AMBIENT_TEMP_MAX)) {
    reasons.push(`环境温度 ${input.ambientTemp} 越出 ${AMBIENT_TEMP_MIN}~${AMBIENT_TEMP_MAX} ℃`)
  }

  return { abnormal: reasons.length > 0, reasons, daily: input.daily, peak: input.peak }
}

/** 用当前规则线重新评估一条已录读数（改线后回放过账）。 */
export function reevaluateReading(reading: EntryReading): EntryReading {
  const { abnormal, reasons } = evaluateReading(reading)
  // 正常读数保留原值；坏值不参与统计，累计量回退为 null。
  return {
    ...reading,
    daily: abnormal ? null : reading.daily,
    peak: abnormal ? null : reading.peak,
    ruleVersion: IRRADIANCE_RULE_VERSION,
    reasons,
  }
}

/** 取最近一条读数；一条都没有时返回 null。 */
export function latestReading(row: EntryRow): EntryReading | null {
  const readings = Array.isArray(row.readings) ? (row.readings as EntryReading[]) : []
  return readings.length ? readings[readings.length - 1] : null
}

/**
 * 有效当日辐照量：最近读数为坏值时不按坏值算，返回 null（页面展示「数据异常·不计入」）。
 * 兼容没有读数流水的既有记录：回退使用记录上的「当日辐照量」字段，
 * 字段不是数字（例如旧示例的占位文本）时按缺测处理。
 */
export function effectiveDaily(row: EntryRow): number | null {
  const reading = latestReading(row)
  if (reading) {
    return reading.reasons.length > 0 ? null : reading.daily
  }
  const raw = row['当日辐照量']
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw
  if (typeof raw === 'string' && raw.trim() !== '' && Number.isFinite(Number(raw))) return Number(raw)
  return null
}

/** 监测点是否数据异常：以最近一条读数的判定为准；无读数流水的旧记录回退到 abnormal 标记。 */
export function isReadingAbnormal(row: EntryRow): boolean {
  const reading = latestReading(row)
  if (reading) return reading.reasons.length > 0
  return row.abnormal === true
}

/** 把读数流水照新线全部重过一遍，返回是否有判定发生翻转。 */
export function reevaluateRow(row: EntryRow): { row: EntryRow; flipped: boolean } {
  const readings = Array.isArray(row.readings) ? (row.readings as EntryReading[]) : []
  if (!readings.length) return { row, flipped: false }
  let flipped = false
  const nextReadings = readings.map((reading) => {
    const reviewed = reevaluateReading(reading)
    const wasAbnormal = reading.reasons.length > 0
    const nowAbnormal = reviewed.reasons.length > 0
    if (wasAbnormal !== nowAbnormal || reading.ruleVersion !== reviewed.ruleVersion) {
      flipped = true
    }
    return reviewed
  })
  return { row: { ...row, readings: nextReadings }, flipped }
}
