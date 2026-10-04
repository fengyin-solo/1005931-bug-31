import { commitAll, listRows } from '@/data/local-store'
import { isLedger, isLedgerOpen, ledgerPoint, ledgerCounters, assertInvariant } from '@/data/ledger'
import type { EntryRow } from '@/data/types'

/** 告警事件页的「辐照校准待处置台账」查询与处置动作。 */

export type LedgerView = {
  id: number
  code: string
  level: string
  pointCode: string
  happenedAt: string
  handler: string
  status: string
  conclusion: string
  closedAt: string
}

function toLedgerView(row: EntryRow): LedgerView {
  return {
    id: row.id,
    code: String(row['告警编号'] ?? ''),
    level: String(row['告警等级'] ?? ''),
    pointCode: ledgerPoint(row),
    happenedAt: String(row['发生时间'] ?? ''),
    handler: String(row['处置人员'] ?? ''),
    status: String(row.status),
    conclusion: String(row['校准结论'] ?? ''),
    closedAt: String(row['结论时间'] ?? ''),
  }
}

export function listCalibrationLedgers(): { open: LedgerView[]; closed: LedgerView[]; counters: ReturnType<typeof ledgerCounters> } {
  const ledgers = listRows('alarm').filter(isLedger)
  const open = ledgers.filter(isLedgerOpen).map(toLedgerView)
  const closed = ledgers.filter((row) => !isLedgerOpen(row)).map(toLedgerView)
  return { open, closed, counters: ledgerCounters(listRows('irradiance'), listRows('alarm')) }
}

/** 台账认领处置：待确认 → 处理中；已在处理中则幂等提示。 */
export function startLedgerDisposal(id: number, handler: string): string {
  const alarms = [...listRows('alarm')]
  const index = alarms.findIndex((row) => Number(row.id) === id)
  if (index < 0 || !isLedger(alarms[index])) {
    throw new Error(`待处置台账中找不到编号为 ${id} 的记录`)
  }
  if (String(alarms[index].status) === '处理中') {
    return `台账 ${alarms[index]['告警编号']} 已在处置中，认头一回的认领结果`
  }
  if (!isLedgerOpen(alarms[index])) {
    throw new Error(`台账 ${alarms[index]['告警编号']} 已闭环，不能再认领`)
  }
  alarms[index] = {
    ...alarms[index],
    status: '处理中',
    pending: true,
    告警状态: '处理中',
    处置人员: handler || String(alarms[index]['处置人员'] ?? ''),
  }
  assertInvariant(listRows('irradiance'), alarms)
  commitAll({ alarm: alarms })
  return `台账 ${alarms[index]['告警编号']} 已认领，转入处置中`
}
