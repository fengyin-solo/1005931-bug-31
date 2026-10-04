/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryValue =
  | string
  | number
  | boolean
  | null
  | EntryRow
  | EntryRow[]
  | EntryReading
  | EntryReading[]

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: EntryValue
}

/** 辐照监测点已录读数：改线/调整阈值后，已录读数要照新线重新过一遍判定。 */
export type EntryReading = {
  /** 读数产生时间（yyyy-MM-dd HH:mm），也是读数的业务键 */
  at: string
  /** 当日辐照量 Wh/m² */
  daily: number | null
  /** 峰值辐照 W/m² */
  peak: number | null
  /** 组件温度 ℃ */
  moduleTemp: number | null
  /** 环境温度 ℃ */
  ambientTemp: number | null
  /** 判定时刻所用阈值版本，便于区分「老线」与「新线」 */
  ruleVersion: number
  /** 判为坏值的原因清单；空数组即读数正常 */
  reasons: string[]
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}
