import type { EntryRow } from './types'

/**
 * 辐照校准结论落到告警事件的「待处置台账」。
 * 台账复用 alarm 表的行结构，用 台账类别 与普通告警区分，
 * 业务键是关联设备（监测点编号）：同一监测点只允许有一条未闭环台账。
 */

export const LEDGER_CATEGORY = '辐照校准'
export const LEDGER_CODE_PREFIX = 'IRAL'

export const POINT_STATUS = {
  normal: '监测中',
  abnormal: '数据异常',
  calibrating: '待校准',
  stopped: '已停用',
} as const

/** 台账开放态：还在待处置口径里。 */
const OPEN_LEDGER_STATUS = ['待确认', '处理中']

export function isLedger(row: EntryRow): boolean {
  return row['台账类别'] === LEDGER_CATEGORY
}

export function ledgerPoint(row: EntryRow): string {
  return String(row['关联设备'] ?? '')
}

export function isLedgerOpen(row: EntryRow): boolean {
  return OPEN_LEDGER_STATUS.includes(String(row.status))
}

export function pointCodeOf(point: EntryRow): string {
  return String(point['监测点编号'] ?? '')
}

/** 同一监测点的未闭环台账，有则返回行号。 */
export function findOpenLedger(alarms: EntryRow[], code: string): number {
  return alarms.findIndex((row) => isLedger(row) && ledgerPoint(row) === code && isLedgerOpen(row))
}

function nextLedgerId(alarms: EntryRow[]): number {
  return alarms.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

function nextLedgerSeq(alarms: EntryRow[]): number {
  return alarms.reduce((max, row) => {
    if (!isLedger(row)) return max
    const code = String(row['告警编号'] ?? '')
    const seq = Number(code.split('-')[1])
    return Number.isFinite(seq) ? Math.max(max, seq) : max
  }, 0) + 1
}

export type LedgerUpsert = {
  code: string
  pointStatus: string
  happenedAt: string
  level?: string
  actor?: string
  conclusion?: string
}

/**
 * 建/改一条校准台账，返回新数组（纯函数）。
 * 数据异常 → 待确认（严重）；安排校准 → 处理中（一般）；确认恢复 → 已闭环并写结论。
 */
export function upsertLedger(alarmsInput: EntryRow[], input: LedgerUpsert): EntryRow[] {
  const alarms = [...alarmsInput]
  const existIndex = findOpenLedger(alarms, input.code)
  const now = new Date()
  const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
    now.getDate(),
  ).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(
    now.getMinutes(),
  ).padStart(2, '0')}`

  let status: string
  let level: string
  let abnormal: boolean
  if (input.pointStatus === POINT_STATUS.abnormal) {
    status = '待确认'
    level = '严重'
    abnormal = true
  } else if (input.pointStatus === POINT_STATUS.calibrating) {
    status = '处理中'
    level = '一般'
    abnormal = false
  } else {
    status = '已闭环'
    level = '一般'
    abnormal = false
  }

  if (existIndex >= 0) {
    const old = alarms[existIndex]
    alarms[existIndex] = {
      ...old,
      status,
      pending: status !== '已闭环',
      abnormal,
      告警等级: input.level ?? (status === '已闭环' ? old['告警等级'] : level),
      告警状态: status,
      处置人员: input.actor ?? old['处置人员'] ?? '',
      校准结论: input.conclusion ?? (status === '已闭环' ? '校准合格，监测恢复正常' : old['校准结论'] ?? ''),
      结论时间: status === '已闭环' ? stamp : old['结论时间'] ?? '',
    }
    return alarms
  }

  const seq = nextLedgerSeq(alarms)
  const row: EntryRow = {
    id: nextLedgerId(alarms),
    status,
    pending: status !== '已闭环',
    abnormal,
    告警编号: `${LEDGER_CODE_PREFIX}-${String(seq).padStart(4, '0')}`,
    告警等级: input.level ?? level,
    告警来源: '辐照监测',
    发生时间: input.happenedAt,
    持续时长: '',
    关联设备: input.code,
    处置人员: input.actor ?? '',
    告警状态: status,
    台账类别: LEDGER_CATEGORY,
    校准结论: input.conclusion ?? (status === '已闭环' ? '校准合格，监测恢复正常' : ''),
    结论时间: status === '已闭环' ? stamp : '',
  }
  alarms.push(row)
  return alarms
}

/** 点位状态对应的两条布尔标记（pending/abnormal）规范值。 */
export function canonicalFlags(status: string): { pending: boolean; abnormal: boolean } {
  switch (status) {
    case POINT_STATUS.abnormal:
      return { pending: true, abnormal: true }
    case POINT_STATUS.calibrating:
      return { pending: true, abnormal: false }
    case POINT_STATUS.stopped:
      return { pending: false, abnormal: false }
    default:
      return { pending: false, abnormal: false }
  }
}

export type LedgerCounters =
  | {
      data异常点数: number
      待校准点数: number
      待处置台账: number
      已闭环台账: number
    }

/**
 * 两边点数对账：
 * 数据异常点 + 待校准点，必须各有一条未闭环台账；
 * 监测中/已停用点位不允许挂着未闭环台账。
 */
export function ledgerCounters(points: EntryRow[], alarms: EntryRow[]) {
  const abnormal = points.filter((row) => row.status === POINT_STATUS.abnormal).length
  const calibrating = points.filter((row) => row.status === POINT_STATUS.calibrating).length
  const ledgers = alarms.filter(isLedger)
  const openByCode = new Set(
    ledgers.filter(isLedgerOpen).map((row) => ledgerPoint(row)),
  )
  const pointCodes = new Set(points.map(pointCodeOf))
  const strayOpen = [...openByCode].filter((code) => !pointCodes.has(code)).length
  return {
    数据异常点数: abnormal,
    待校准点数: calibrating,
    待处置台账: ledgers.filter(isLedgerOpen).length - strayOpen,
    已闭环台账: ledgers.filter((row) => !isLedgerOpen(row)).length,
  }
}

/** 一致性断言：两处数据异常点数对得上，且每条异常/待校准都有台账。对不上就抛错，事务整笔退回。 */
export function assertInvariant(points: EntryRow[], alarms: EntryRow[]): void {
  const counters = ledgerCounters(points, alarms)
  const expectOpen = counters.数据异常点数 + counters.待校准点数
  const actualOpen = alarms.filter((row) => isLedger(row) && isLedgerOpen(row)).length
  if (actualOpen !== expectOpen) {
    throw new Error(
      `台账一致性校验失败：数据异常 ${counters.数据异常点数} 点、待校准 ${counters.待校准点数} 点，应挂 ${expectOpen} 条待处置台账，实际 ${actualOpen} 条`,
    )
  }
  for (const point of points) {
    const code = pointCodeOf(point)
    const openIndex = findOpenLedger(alarms, code)
    const needsOpen =
      point.status === POINT_STATUS.abnormal || point.status === POINT_STATUS.calibrating
    if (needsOpen && openIndex < 0) {
      throw new Error(`台账一致性校验失败：监测点 ${code}（${point.status}）缺少待处置台账`)
    }
    if (!needsOpen && openIndex >= 0) {
      throw new Error(`台账一致性校验失败：监测点 ${code}（${point.status}）仍挂着未闭环台账`)
    }
  }
}
