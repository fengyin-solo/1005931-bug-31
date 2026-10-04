import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'pv-plant-ops:entries'
// 已迁入领域库、要从通用台账摘走的模块：存在这里，刷新后也不会被种子合并带回来。
const DROPPED_KEY = 'pv-plant-ops:entries-dropped'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function readDropped(): Set<string> {
  if (typeof window === 'undefined' || !window.localStorage) return new Set()
  try {
    const raw = window.localStorage.getItem(DROPPED_KEY)
    return new Set(raw ? (JSON.parse(raw) as string[]) : [])
  } catch {
    return new Set()
  }
}

function writeDropped(keys: Set<string>): void {
  if (typeof window === 'undefined' || !window.localStorage) return
  window.localStorage.setItem(DROPPED_KEY, JSON.stringify([...keys]))
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    // 已迁入别的库的模块不再回填种子
    for (const dropped of readDropped()) {
      delete fallback[dropped]
      delete parsed[dropped]
    }
    return { ...fallback, ...parsed }
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
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
  const next = { ...allRows(), [key]: rows }
  cache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
}

/** 把某个模块从通用台账摘走（已迁入独立领域库时用）。 */
export function dropModule(key: string): void {
  const dropped = readDropped()
  dropped.add(key)
  writeDropped(dropped)
  cache = null
  if (typeof window !== 'undefined' && window.localStorage) {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
        delete parsed[key]
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(parsed))
      } catch {
        // 老台账解析失败时不影响领域库迁移
      }
    }
  }
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}
