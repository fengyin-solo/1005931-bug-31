import {
  IRRADIANCE_RULE_VERSION,
  effectiveDaily,
  evaluateReading,
  isReadingAbnormal,
  latestReading,
  reevaluateRow,
} from './irradiance-rules'
import {
  POINT_STATUS,
  assertInvariant,
  canonicalFlags,
  pointCodeOf,
  findOpenLedger,
  upsertLedger,
} from './ledger'
import type { EntryReading, EntryRow } from './types'
import type { RoleKey } from '@/stores/session'

/**
 * 辐照监测业务域：全部是纯函数，输入点位数组 + 告警数组，输出新数组。
 * 服务层负责锁、持久化和「一笔提交」；这里只负责规则，改回后端时整层可平移。
 */

export type Actor = {
  role: RoleKey
  name: string
  /** 是否本监测点的设备专责 */
  owns: (pointCode: string) => boolean
}

export type CalibrationReading = {
  daily: number | null
  peak: number | null
  moduleTemp: number | null
  ambientTemp: number | null
}

export type DomainChange = {
  points: EntryRow[]
  alarms: EntryRow[]
  message: string
  /** 第二次（或更多次）点击时命中：直接认头一回的结果，不再产生新记录 */
  idempotent?: boolean
}

const DEFAULT_ZONE = '未分区'
const DEFAULT_INSTALLED_AT = '2025-12-01'
const DEFAULT_HEIGHT = 1.5

function toNumberOr(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Number(value)
  }
  return fallback
}

function normalizePoint(point: EntryRow): EntryRow {
  const readings = Array.isArray(point.readings) ? (point.readings as EntryReading[]) : []
  const next: EntryRow = { ...point, readings }
  if (typeof next['所属片区'] !== 'string' || !next['所属片区']) next['所属片区'] = DEFAULT_ZONE
  if (typeof next['安装时间'] !== 'string' || !next['安装时间']) next['安装时间'] = DEFAULT_INSTALLED_AT
  if (typeof next['设备型号'] !== 'string' || !next['设备型号']) next['设备型号'] = '未登记型号'
  next['安装高度'] = toNumberOr(next['安装高度'], DEFAULT_HEIGHT)
  return next
}

/** 用最近一条读数回填列表上的当日值列；坏值保留原始读数但不计入有效辐照量。 */
function syncDenormalized(point: EntryRow): EntryRow {
  const reading = latestReading(point)
  if (!reading) {
    const daily = effectiveDaily(point)
    return { ...point, 当日辐照量: daily }
  }
  return {
    ...point,
    当日辐照量: reading.daily,
    峰值辐照: reading.peak,
    组件温度: reading.moduleTemp,
    环境温度: reading.ambientTemp,
  }
}

/** 按读数重判监测状态；已明确「待校准/已停用」的人工流程不被自动状态覆盖。 */
function reconcileStatus(point: EntryRow): string {
  const status = String(point.status)
  if (status === POINT_STATUS.calibrating || status === POINT_STATUS.stopped) return status
  return isReadingAbnormal(point) ? POINT_STATUS.abnormal : POINT_STATUS.normal
}

function applyStatus(point: EntryRow, status: string): EntryRow {
  const flags = canonicalFlags(status)
  return { ...point, status, pending: flags.pending, abnormal: flags.abnormal }
}

/**
 * 一次性迁移：补片区/安装时间等新列、读数照新线重过、状态与台账对齐。
 * 兼容既有监测点记录：老记录缺读数流水时沿用其现有状态与标记。
 */
export function migrateIrradiance(
  data: Record<string, EntryRow[]>,
): { data: Record<string, EntryRow[]>; changed: boolean } {
  const sourcePoints = data.irradiance
  if (!sourcePoints) return { data, changed: false }

  let changed = false
  let points = sourcePoints.map((row) => {
    let next = normalizePoint(row)
    if (JSON.stringify(next) !== JSON.stringify(row)) changed = true

    if (Array.isArray(next.readings) && next.readings.length > 0) {
      const reviewed = reevaluateRow(next)
      if (reviewed.flipped) changed = true
      next = reviewed.row
    }

    const status = reconcileStatus(next)
    if (status !== String(next.status)) changed = true
    next = applyStatus(next, status)

    const synced = syncDenormalized(next)
    if (JSON.stringify(synced) !== JSON.stringify(next)) changed = true
    return synced
  })

  let alarms = Array.isArray(data.alarm) ? [...data.alarm] : []
  const alarmBefore = alarms.length
  for (const point of points) {
    const code = pointCodeOf(point)
    const needsOpen =
      point.status === POINT_STATUS.abnormal || point.status === POINT_STATUS.calibrating
    if (needsOpen && findOpenLedger(alarms, code) < 0) {
      const reading = latestReading(point)
      alarms = upsertLedger(alarms, {
        code,
        pointStatus: point.status,
        happenedAt: reading?.at ?? String(point['安装时间'] ?? ''),
      })
    }
  }
  if (alarms.length !== alarmBefore) changed = true

  const nextData = { ...data, irradiance: points, alarm: alarms }
  assertInvariant(points, alarms)
  return { data: nextData, changed }
}

function findPoint(points: EntryRow[], id: number): EntryRow {
  const point = points.find((row) => Number(row.id) === id)
  if (!point) {
    throw new Error(`没有找到编号为 ${id} 的辐照监测点`)
  }
  return point
}

function assertCanCalibrate(actor: Actor, point: EntryRow): void {
  const code = pointCodeOf(point)
  if (actor.role === 'admin') return
  if (actor.role === 'dispatcher') return
  if (actor.role === 'specialist' && actor.owns(code)) return
  if (actor.role === 'specialist') {
    throw new Error(
      `越级拦截：${actor.name} 不是 ${code} 的设备专责；请联系该点位专责或值班管理员处理`,
    )
  }
  throw new Error(`越权拦截：${actor.name}（只读访客）无权安排校准；请由值班管理员或调度员发起`)
}

function assertCanRecover(actor: Actor, point: EntryRow): void {
  const code = pointCodeOf(point)
  if (actor.role === 'admin' || actor.role === 'dispatcher') return
  if (actor.role === 'specialist' && actor.owns(code)) return
  if (actor.role === 'specialist') {
    throw new Error(`越级拦截：${actor.name} 不是 ${code} 的设备专责，不能回填该点校准结论`)
  }
  throw new Error(`越权拦截：${actor.name} 无权确认恢复；请由值班管理员、调度员或本点位专责操作`)
}

function nowStamp(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
    now.getDate(),
  ).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(
    now.getMinutes(),
  ).padStart(2, '0')}`
}

/** 登记异常：只接受最近读数真的触发了判据的点位；待校准中的点位不许再记异常。 */
export function markAbnormal(
  pointsInput: EntryRow[],
  alarmsInput: EntryRow[],
  actor: Actor,
  id: number,
): DomainChange {
  const points = [...pointsInput]
  const index = points.findIndex((row) => Number(row.id) === id)
  const point = findPoint(points, id)
  const code = pointCodeOf(point)

  if (actor.role === 'viewer') {
    throw new Error(`越权拦截：${actor.name} 只有查看权；登记异常请联系值班管理员或设备专责`)
  }
  if (actor.role === 'dispatcher') {
    throw new Error(`越权拦截：调度员不能登记异常；请联系值班管理员或设备专责`)
  }
  if (actor.role === 'specialist' && !actor.owns(code)) {
    throw new Error(`越级拦截：${actor.name} 不是 ${code} 的设备专责，不能登记该点异常`)
  }

  if (point.status === POINT_STATUS.calibrating) {
    throw new Error(`${code} 已在待校准，不能重复记异常；待校准点位以校准流程为准，如需退出请「确认恢复」`)
  }
  if (point.status === POINT_STATUS.stopped) {
    throw new Error(`${code} 已停用，不再登记异常；如需监测请先重新投用`)
  }
  if (point.status === POINT_STATUS.abnormal) {
    throw new Error(`${code} 已是数据异常，待处置台账中已有记录，无需重复登记`)
  }

  const reading = latestReading(point)
  if (reading && reading.reasons.length === 0) {
    throw new Error(`${code} 最近一条读数各项均在阈值内，没有可登记的异常；缺一步：先出现坏值读数`)
  }
  if (!reading) {
    throw new Error(`${code} 还没有任何读数，无法判定异常；缺一步：先录入读数`)
  }

  points[index] = applyStatus(point, POINT_STATUS.abnormal)
  const alarms = upsertLedger(alarmsInput, {
    code,
    pointStatus: POINT_STATUS.abnormal,
    happenedAt: reading.at,
  })
  assertInvariant(points, alarms)
  return { points, alarms, message: `${code} 已登记数据异常（${reading.reasons.join('；')}），待处置台账已建账` }
}

/** 安排校准：监测状态、当日辐照量口径、异常标记与台账在同一事务里改，任何一步不成都整笔退回。 */
export function arrangeCalibration(
  pointsInput: EntryRow[],
  alarmsInput: EntryRow[],
  actor: Actor,
  id: number,
): DomainChange {
  const points = [...pointsInput]
  const index = points.findIndex((row) => Number(row.id) === id)
  const point = findPoint(points, id)
  const code = pointCodeOf(point)

  // 连点第二次起：不报错、不新增台账，只把头一回的结果原样回给界面。
  if (point.status === POINT_STATUS.calibrating) {
    return {
      points: pointsInput,
      alarms: alarmsInput,
      idempotent: true,
      message: `${code} 已在待校准，重复点击只认头一回的安排结果`,
    }
  }

  assertCanCalibrate(actor, point)

  if (point.status === POINT_STATUS.stopped) {
    throw new Error(`${code} 已停用，不能安排校准；缺一步：先重新投用该监测点`)
  }

  if (point.status === POINT_STATUS.normal) {
    const reading = latestReading(point)
    if (!reading || reading.reasons.length === 0) {
      throw new Error(`${code} 当前读数正常，没有校准依据；缺一步：先登记数据异常`)
    }
  }

  points[index] = applyStatus(point, POINT_STATUS.calibrating)
  const alarms = upsertLedger(alarmsInput, {
    code,
    pointStatus: POINT_STATUS.calibrating,
    happenedAt: nowStamp(),
  })
  assertInvariant(points, alarms)
  return { points, alarms, message: `${code} 已转入待校准：异常标记清除、待处置台账同步更新` }
}

/** 确认恢复：录入校准后的读数并下结论；读数仍坏则整笔退回，台账不闭环。 */
export function confirmRecovery(
  pointsInput: EntryRow[],
  alarmsInput: EntryRow[],
  actor: Actor,
  id: number,
  readingInput: CalibrationReading,
  conclusion: string,
): DomainChange {
  const points = [...pointsInput]
  const index = points.findIndex((row) => Number(row.id) === id)
  const point = findPoint(points, id)
  const code = pointCodeOf(point)

  assertCanRecover(actor, point)

  if (point.status === POINT_STATUS.stopped) {
    throw new Error(`${code} 已停用，不能确认恢复`)
  }
  if (point.status === POINT_STATUS.abnormal) {
    throw new Error(`${code} 还在数据异常态；缺一步：先「安排校准」再回填校准结论`)
  }
  if (point.status === POINT_STATUS.normal) {
    throw new Error(`${code} 已是监测中，无需确认恢复`)
  }

  const evaluation = evaluateReading({ at: nowStamp(), ...readingInput })
  if (evaluation.abnormal) {
    throw new Error(`校准后读数仍不合格，整笔退回：${evaluation.reasons.join('；')}`)
  }

  const readings = Array.isArray(point.readings) ? (point.readings as EntryReading[]) : []
  const reading: EntryReading = {
    at: nowStamp(),
    daily: readingInput.daily,
    peak: readingInput.peak,
    moduleTemp: readingInput.moduleTemp,
    ambientTemp: readingInput.ambientTemp,
    ruleVersion: IRRADIANCE_RULE_VERSION,
    reasons: [],
  }
  let next: EntryRow = {
    ...point,
    readings: [...readings, reading],
  }
  next = applyStatus(next, POINT_STATUS.normal)
  next = syncDenormalized(next)
  points[index] = next

  const alarms = upsertLedger(alarmsInput, {
    code,
    pointStatus: POINT_STATUS.normal,
    happenedAt: reading.at,
    actor: actor.name,
    conclusion: conclusion.trim() || '校准合格，监测恢复正常',
  })
  assertInvariant(points, alarms)
  return { points, alarms, message: `${code} 校准完成并恢复监测，台账已闭环；当日辐照量 ${readingInput.daily} Wh/m²` }
}

/** 修改安装高度：只有本监测点的设备专责能动。 */
export function updateHeight(
  pointsInput: EntryRow[],
  actor: Actor,
  id: number,
  height: number,
): DomainChange {
  const points = [...pointsInput]
  const index = points.findIndex((row) => Number(row.id) === id)
  const point = findPoint(points, id)
  const code = pointCodeOf(point)

  if (actor.role !== 'specialist') {
    throw new Error(`越权拦截：安装高度只允许设备专责修改，${actor.name} 当前角色无权操作`)
  }
  if (!actor.owns(code)) {
    throw new Error(`越级拦截：${actor.name} 不是 ${code} 的设备专责，不能改这一格的安装高度`)
  }
  if (!Number.isFinite(height) || height < 0.5 || height > 10) {
    throw new Error(`安装高度 ${height} m 超出 0.5~10 m 的允许范围，整笔退回`)
  }

  points[index] = { ...point, 安装高度: Number(height.toFixed(2)) }
  return { points, alarms: [], message: `${code} 安装高度已改为 ${height} m` }
}

/** 改线后把已录读数照新线全部重过一遍，并按重判结果对齐状态与台账。 */
export function replayReadings(
  pointsInput: EntryRow[],
  alarmsInput: EntryRow[],
): DomainChange {
  let points = pointsInput.map(normalizePoint)
  let alarms = [...alarmsInput]
  let flippedCount = 0

  points = points.map((point) => {
    if (!Array.isArray(point.readings) || point.readings.length === 0) return point
    const reviewed = reevaluateRow(point)
    if (reviewed.flipped) flippedCount += 1
    return reviewed.row
  })

  points = points.map((point) => {
    const status = String(point.status)
    // 已安排校准、已停用属于人工流程，重判不抢状态。
    if (status === POINT_STATUS.calibrating || status === POINT_STATUS.stopped) {
      return syncDenormalized(applyStatus(point, status))
    }
    const nextStatus = reconcileStatus(point)
    const next = syncDenormalized(applyStatus(point, nextStatus))
    const code = pointCodeOf(next)
    const needsOpen =
      nextStatus === POINT_STATUS.abnormal || nextStatus === POINT_STATUS.calibrating
    if (needsOpen && findOpenLedger(alarms, code) < 0) {
      const reading = latestReading(next)
      alarms = upsertLedger(alarms, {
        code,
        pointStatus: nextStatus,
        happenedAt: reading?.at ?? nowStamp(),
      })
    }
    if (!needsOpen && findOpenLedger(alarms, code) >= 0) {
      alarms = upsertLedger(alarms, {
        code,
        pointStatus: POINT_STATUS.normal,
        happenedAt: nowStamp(),
        conclusion: '按新判定线重过读数，指标恢复正常，自动销项',
      })
    }
    return next
  })

  assertInvariant(points, alarms)
  return {
    points,
    alarms,
    message: `已录读数已按新线重过一遍，${flippedCount} 个监测点的历史判定发生变化`,
  }
}
