import { SEED_ROWS } from './seed'
import { migrateIrradiance } from './irradiance-domain'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'pv-plant-ops:entries'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/**
 * 把浏览器里的旧数据和最新种子合并：
 * 辐照点按监测点编号、告警按告警编号去重，已经操作过的记录保留，
 * 种子里新增的点位/台账补进来（监测点按安装时间补齐）。
 */
function mergeWithSeed(parsed: Record<string, EntryRow[]>): Record<string, EntryRow[]> {
  const merged = clone(SEED_ROWS)
  for (const [key, savedRows] of Object.entries(parsed)) {
    if (!Array.isArray(savedRows)) continue
    if (key === 'irradiance') {
      const known = new Set(savedRows.map((row) => String(row['监测点编号'] ?? '')))
      merged.irradiance = [
        ...savedRows,
        ...(merged.irradiance ?? []).filter((row) => !known.has(String(row['监测点编号'] ?? ''))),
      ]
    } else if (key === 'alarm') {
      const known = new Set(savedRows.map((row) => String(row['告警编号'] ?? '')))
      merged.alarm = [
        ...savedRows,
        ...(merged.alarm ?? []).filter((row) => !known.has(String(row['告警编号'] ?? ''))),
      ]
    } else {
      merged[key] = savedRows
    }
  }
  return merged
}

function persist(data: Record<string, EntryRow[]>): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
  }
}

function readStorage(): Record<string, EntryRow[]> {
  if (typeof window === 'undefined' || !window.localStorage) {
    const fallback = clone(SEED_ROWS)
    return migrateIrradiance(fallback).data
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    const fallback = clone(SEED_ROWS)
    const result = migrateIrradiance(fallback)
    persist(result.data)
    return result.data
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    const merged = mergeWithSeed(parsed)
    const result = migrateIrradiance(merged)
    // 迁移发生过（补列、读数重过、台账补齐）就立刻落盘，下次不再重复。
    if (result.changed) persist(result.data)
    return result.data
  } catch {
    const fallback = clone(SEED_ROWS)
    const result = migrateIrradiance(fallback)
    persist(result.data)
    return result.data
  }
}

let cache: Record<string, EntryRow[]> | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  commitAll({ [key]: rows })
}

/**
 * 整笔提交：多个模块（辐照点位 + 告警台账）一次写入，
 * 调用方必须在写之前把校验全部做完——这里不再做单模块半写。
 */
export function commitAll(changes: Record<string, EntryRow[]>): void {
  const next = { ...allRows(), ...changes }
  cache = next
  persist(next)
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}

/** 仅供测试：清掉内存缓存与浏览器存储，下一次读取重新播种并迁移。 */
export function __resetStoreForTest(): void {
  cache = null
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.removeItem(STORAGE_KEY)
  }
}
