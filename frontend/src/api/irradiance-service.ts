import { commitAll, listRows } from '@/data/local-store'
import {
  arrangeCalibration,
  confirmRecovery,
  markAbnormal,
  replayReadings,
  updateHeight,
  type Actor,
  type CalibrationReading,
} from '@/data/irradiance-domain'
import { effectiveDaily, latestReading } from '@/data/irradiance-rules'
import type { EntryRow } from '@/data/types'

/**
 * 辐照监测服务：对外只暴露「一次请求一笔结果」。
 * 动作执行期按点位加锁，连点两次只认头一回；
 * 域层任何一步校验失败都会抛错，这里不提交、不留半成品。
 */

export type IrradianceFilters = {
  zone?: string
  status?: string
  keyword?: string
}

export type IrradianceSortKey = '当日辐照量' | '安装时间' | '监测点编号'
export type SortOrder = 'asc' | 'desc'

export type IrradianceQuery = {
  filters?: IrradianceFilters
  sortKey?: IrradianceSortKey
  sortOrder?: SortOrder
  page?: number
  size?: number
}

export const PAGE_SIZE = 8

export type PointView = {
  id: number
  code: string
  zone: string
  model: string
  height: number
  installedAt: string
  daily: number | null
  peak: number | null
  moduleTemp: number | null
  ambientTemp: number | null
  status: string
  abnormal: boolean
  pending: boolean
  reasons: string[]
  ruleVersion: number
}

function toView(row: EntryRow): PointView {
  const reading = latestReading(row)
  return {
    id: row.id,
    code: String(row['监测点编号'] ?? ''),
    zone: String(row['所属片区'] ?? '未分区'),
    model: String(row['设备型号'] ?? '未登记型号'),
    height: Number(row['安装高度'] ?? 0),
    installedAt: String(row['安装时间'] ?? ''),
    daily: effectiveDaily(row),
    peak: reading ? reading.peak : (row['峰值辐照'] as number | null) ?? null,
    moduleTemp: reading ? reading.moduleTemp : (row['组件温度'] as number | null) ?? null,
    ambientTemp: reading ? reading.ambientTemp : (row['环境温度'] as number | null) ?? null,
    status: String(row.status),
    // 设备格异常旗标跟业务状态走：已送校的点位不再挂异常，坏值原因在详情面板里仍可查。
    abnormal: row.abnormal === true,
    pending: Boolean(row.pending),
    reasons: reading?.reasons ?? [],
    ruleVersion: reading?.ruleVersion ?? 0,
  }
}

function textOf(value: unknown): string {
  return value === null || value === undefined ? '' : String(value)
}

function applyFilters(points: EntryRow[], filters: IrradianceFilters): EntryRow[] {
  const zone = filters.zone?.trim() ?? ''
  const status = filters.status?.trim() ?? ''
  const keyword = filters.keyword?.trim().toLowerCase() ?? ''
  return points.filter((row) => {
    if (zone && String(row['所属片区'] ?? '') !== zone) return false
    if (status && String(row.status) !== status) return false
    if (keyword) {
      const haystack = [
        row['监测点编号'],
        row['设备型号'],
        row['所属片区'],
        latestReading(row)?.reasons.join(' '),
      ]
        .map(textOf)
        .join(' ')
        .toLowerCase()
      if (!haystack.includes(keyword)) return false
    }
    return true
  })
}

function sortValue(row: EntryRow, key: IrradianceSortKey): number | string {
  if (key === '当日辐照量') {
    const daily = effectiveDaily(row)
    return daily === null ? Number.NEGATIVE_INFINITY : daily
  }
  if (key === '安装时间') return String(row['安装时间'] ?? '')
  return String(row['监测点编号'] ?? '')
}

function applySort(points: EntryRow[], key: IrradianceSortKey, order: SortOrder): EntryRow[] {
  if (key === '当日辐照量') {
    // 坏值不计入排序，始终沉底；有效值再按升降序排。
    return [...points].sort((a, b) => {
      const va = effectiveDaily(a)
      const vb = effectiveDaily(b)
      if (va === null && vb === null) return 0
      if (va === null) return 1
      if (vb === null) return -1
      return order === 'desc' ? vb - va : va - vb
    })
  }
  const factor = order === 'desc' ? -1 : 1
  return [...points].sort((a, b) => {
    const va = sortValue(a, key)
    const vb = sortValue(b, key)
    if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * factor
    return String(va).localeCompare(String(vb), 'zh-CN') * factor
  })
}

export type IrradiancePage = {
  views: PointView[]
  total: number
  page: number
  size: number
  totalPages: number
  zones: string[]
}

export function queryIrradiance(query: IrradianceQuery = {}): IrradiancePage {
  const all = listRows('irradiance')
  const zones = [...new Set(all.map((row) => String(row['所属片区'] ?? '未分区')))].sort((a, b) =>
    a.localeCompare(b, 'zh-CN'),
  )
  const filtered = applyFilters(all, query.filters ?? {})
  const sortKey = query.sortKey ?? '安装时间'
  const sortOrder = query.sortOrder ?? 'asc'
  const sorted = applySort(filtered, sortKey, sortOrder)
  const size = query.size && query.size > 0 ? query.size : PAGE_SIZE
  const totalPages = Math.max(1, Math.ceil(sorted.length / size))
  const page = Math.min(Math.max(1, query.page ?? 1), totalPages)
  const start = (page - 1) * size
  return {
    views: sorted.slice(start, start + size).map(toView),
    total: sorted.length,
    page,
    size,
    totalPages,
    zones,
  }
}

/** 兼容旧调用的简单列表（导出/对通用表格），不做分页。 */
export function listIrradianceViews(): PointView[] {
  return listRows('irradiance').map(toView)
}

export type LocateResult =
  | { ok: true; view: PointView; page: number }
  | { ok: false; message: string }

/**
 * 按监测点编号定位：沿用当前筛选/排序/每页条数，算出它落在第几页。
 * 找不到时写明是哪一格对不上：编号本身、片区、状态还是关键词。
 */
export function locatePoint(
  code: string,
  query: IrradianceQuery = {},
): LocateResult {
  const target = code.trim().toUpperCase()
  if (!target) {
    return { ok: false, message: '请先填写要定位的监测点编号（例如 IRRA-0004）' }
  }
  const all = listRows('irradiance')
  const exact = all.find((row) => String(row['监测点编号'] ?? '').toUpperCase() === target)
  if (!exact) {
    return { ok: false, message: `监测点编号格对不上：台账里没有「${code}」这个点位，请核对编号` }
  }

  const filters = query.filters ?? {}
  const filtered = applyFilters(all, filters)
  const inFilter = filtered.some((row) => Number(row.id) === Number(exact.id))
  if (!inFilter) {
    const parts: string[] = []
    if (filters.zone?.trim()) parts.push(`所属片区=${filters.zone.trim()}`)
    if (filters.status?.trim()) parts.push(`监测状态=${filters.status.trim()}`)
    if (filters.keyword?.trim()) parts.push(`关键词=${filters.keyword.trim()}`)
    return {
      ok: false,
      message: `点位「${code}」存在，但被当前条件（${parts.join('，')}）筛掉了：它实际片区为「${exact['所属片区'] ?? '未分区'}」、状态为「${exact.status}」，请调整对应筛选格`,
    }
  }

  const sortKey = query.sortKey ?? '安装时间'
  const sortOrder = query.sortOrder ?? 'asc'
  const sorted = applySort(filtered, sortKey, sortOrder)
  const size = query.size && query.size > 0 ? query.size : PAGE_SIZE
  const index = sorted.findIndex((row) => Number(row.id) === Number(exact.id))
  const page = Math.floor(index / size) + 1
  return { ok: true, view: toView(exact), page }
}

function withLock<T>(key: string, task: () => T): T {
  if (inFlight.has(key)) {
    throw new Error('该监测点正在处理中，连点只认头一回，请稍候')
  }
  inFlight.add(key)
  try {
    return task()
  } finally {
    inFlight.delete(key)
  }
}

const inFlight = new Set<string>()

export function registerAbnormal(id: number, actor: Actor): string {
  return withLock(`登记异常:${id}`, () => {
    const change = markAbnormal(listRows('irradiance'), listRows('alarm'), actor, id)
    commitAll({ irradiance: change.points, alarm: change.alarms })
    return change.message
  })
}

export function scheduleCalibration(id: number, actor: Actor): string {
  return withLock(`安排校准:${id}`, () => {
    const change = arrangeCalibration(listRows('irradiance'), listRows('alarm'), actor, id)
    // 幂等命中（头一回已落库的结果）不需要再写。
    if (!change.idempotent) {
      commitAll({ irradiance: change.points, alarm: change.alarms })
    }
    return change.message
  })
}

export function recoverPoint(
  id: number,
  actor: Actor,
  reading: CalibrationReading,
  conclusion: string,
): string {
  return withLock(`确认恢复:${id}`, () => {
    const change = confirmRecovery(
      listRows('irradiance'),
      listRows('alarm'),
      actor,
      id,
      reading,
      conclusion,
    )
    commitAll({ irradiance: change.points, alarm: change.alarms })
    return change.message
  })
}

export function changeHeight(id: number, actor: Actor, height: number): string {
  return withLock(`修改安装高度:${id}`, () => {
    const change = updateHeight(listRows('irradiance'), actor, id, height)
    commitAll({ irradiance: change.points })
    return change.message
  })
}

export function replayAllReadings(): string {
  return withLock('replay', () => {
    const change = replayReadings(listRows('irradiance'), listRows('alarm'))
    commitAll({ irradiance: change.points, alarm: change.alarms })
    return change.message
  })
}
