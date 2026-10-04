import { listRows, dropModule } from '@/data/local-store'
import type { EntryRow } from '@/data/types'
import { DEFAULT_RULES_V1, evaluateReading } from './rules'
import { buildSeed } from './seed'
import type {
  AlarmTicket,
  AnomalyRules,
  CalibrationTask,
  IrradianceDB,
  MonitorPoint,
  PointStatus,
  Reading,
} from './types'

const DB_KEY = 'pv-plant-ops:irradiance:v1'
/** 老版本写在通用台账里的辐照记录，迁移后落在这里做标记 */
const MIGRATION_FLAG_KEY = 'pv-plant-ops:irradiance:migrated-from-entries'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function nowText(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Number(value))) {
    return Number(value)
  }
  return null
}

/** 监测点按安装时间补齐：缺安装时间的既有记录，按编号顺序依次补到已有最晚时间之后。 */
export function backfillInstalledAt(points: MonitorPoint[]): boolean {
  const sorted = [...points].sort((a, b) => a.id - b.id)
  let cursor: Date | null = null
  for (const point of sorted) {
    if (point.installedAt && /^\d{4}-\d{2}-\d{2}/.test(point.installedAt)) {
      const parsed = new Date(point.installedAt)
      if (!Number.isNaN(parsed.getTime()) && (cursor === null || parsed > cursor)) {
        cursor = parsed
      }
    }
  }
  if (cursor === null) {
    cursor = new Date('2025-01-15T00:00:00')
  }
  let changed = false
  for (const point of sorted) {
    if (!point.installedAt || !/^\d{4}-\d{2}-\d{2}/.test(point.installedAt)) {
      cursor = new Date(cursor.getTime())
      cursor.setMonth(cursor.getMonth() + 1)
      const pad = (n: number) => String(n).padStart(2, '0')
      point.installedAt = `${cursor.getFullYear()}-${pad(cursor.getMonth() + 1)}-${pad(cursor.getDate())}`
      point.createdAt = point.createdAt || point.installedAt
      changed = true
    }
  }
  return changed
}

function defaultRules(): AnomalyRules {
  return { ...DEFAULT_RULES_V1, version: 1, updatedAt: nowText(), updatedBy: '系统初始化' }
}

/** 兼容既有监测点记录：把老通用台账里的辐照记录整体迁到领域库。 */
function migrateLegacy(): IrradianceDB | null {
  if (typeof window === 'undefined' || !window.localStorage) return null
  if (window.localStorage.getItem(MIGRATION_FLAG_KEY)) return null

  let legacy: EntryRow[]
  try {
    legacy = listRows('irradiance')
  } catch {
    return null
  }
  // 只有长得像真实老数据（确实存在记录）才迁；全新环境直接走种子。
  if (!legacy.length) return null

  const migratedAt = nowText()
  const points: MonitorPoint[] = legacy.map((row, index) => {
    const rawStatus = String(row.status ?? '')
    const status: PointStatus =
      rawStatus === '数据异常' || rawStatus === '待校准' || rawStatus === '已停用' ? rawStatus : '监测中'
    const code = String(row['监测点编号'] ?? `IRRA-M${index + 1}`)
    return {
      id: Number(row.id) || index + 1,
      code,
      name: `${code}（既有记录迁入）`,
      area: '未分区',
      deviceModel: String(row['设备型号'] ?? '未知型号'),
      height: toNumber(row['安装高度']) ?? 0,
      specialist: '王建国',
      installedAt: '',
      status,
      createdAt: migratedAt,
    }
  })
  backfillInstalledAt(points)

  const readings: Reading[] = []
  let readingSeq = 0
  const alarms: AlarmTicket[] = []
  const tasks: CalibrationTask[] = []
  const rules = defaultRules()

  for (const point of points) {
    const legacyRow = legacy.find((row) => Number(row.id) === point.id)
    const daily = toNumber(legacyRow?.['当日辐照量'])
    const peak = toNumber(legacyRow?.['峰值辐照'])
    if (daily !== null || peak !== null) {
      readingSeq += 1
      const candidate: Reading = {
        id: readingSeq,
        pointCode: point.code,
        ts: migratedAt,
        irradiation: daily,
        peak,
        moduleTemp: null,
        ambientTemp: null,
        verdict: '有效',
        reasons: [],
        ruleVersion: rules.version,
      }
      // 既有读数也照规则过一遍，不搞特殊口径
      Object.assign(candidate, evaluateReading(candidate, rules))
      readings.push(candidate)
    }
    if (point.status === '数据异常' || point.status === '待校准') {
      alarms.push({
        id: `ALM-IR-M${String(point.id).padStart(4, '0')}`,
        pointCode: point.code,
        level: '二级',
        openedAt: migratedAt,
        openedReason: `既有记录迁入：监测点处于「${point.status}」，异常待闭环`,
        status: '待处置',
        ruleVersion: rules.version,
      })
    }
    if (point.status === '待校准') {
      tasks.push({
        id: `CAL-M${String(point.id).padStart(4, '0')}`,
        pointCode: point.code,
        orderedAt: migratedAt,
        orderedBy: '迁移补齐',
        status: '待校准',
      })
    }
  }

  const db: IrradianceDB = {
    version: 1,
    points,
    readings,
    tasks,
    alarms,
    rules,
    seq: { reading: readingSeq, alarm: alarms.length, task: tasks.length },
  }

  // 迁移落库成功后，才把老表摘走并打标记；任何一步失败都不破坏老数据。
  persist(db)
  dropModule('irradiance')
  window.localStorage.setItem(MIGRATION_FLAG_KEY, migratedAt)
  return db
}

function persist(db: IrradianceDB): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(DB_KEY, JSON.stringify(db))
  }
}

let cache: IrradianceDB | null = null

export function loadDB(): IrradianceDB {
  if (cache) return cache
  if (typeof window === 'undefined' || !window.localStorage) {
    return (cache = buildSeed())
  }
  const raw = window.localStorage.getItem(DB_KEY)
  if (raw) {
    try {
      cache = JSON.parse(raw) as IrradianceDB
      // 版本漂移时兜底补齐
      if (backfillInstalledAt(cache.points)) persist(cache)
      return cache
    } catch {
      window.localStorage.removeItem(DB_KEY)
    }
  }
  cache = migrateLegacy() ?? buildSeed()
  persist(cache)
  return cache
}

export function saveDB(db: IrradianceDB): void {
  cache = db
  persist(db)
}

/** 整笔事务：先在草稿上跑，任何一步抛错就整笔退回，只有全过才一次落库。 */
export function commit<T>(fn: (db: IrradianceDB) => T): T {
  const db = loadDB()
  const draft = clone(db)
  let result: T
  try {
    result = fn(draft)
  } catch (error) {
    // 不落库 = 整笔退回，调用方把原因带给页面
    throw error instanceof Error ? error : new Error('操作失败，整笔已退回')
  }
  saveDB(draft)
  return result
}

/** 执行校准的幂等锁：同一监测点连点两次，只认头一回。 */
const calibrationLocks = new Set<string>()

export function tryAcquireCalibration(pointCode: string): boolean {
  if (calibrationLocks.has(pointCode)) return false
  calibrationLocks.add(pointCode)
  return true
}

export function releaseCalibration(pointCode: string): void {
  calibrationLocks.delete(pointCode)
}

/** 重置回演示数据（供页面“恢复演示数据”入口使用）。 */
export function resetDB(): IrradianceDB {
  const db = buildSeed()
  saveDB(db)
  return db
}
