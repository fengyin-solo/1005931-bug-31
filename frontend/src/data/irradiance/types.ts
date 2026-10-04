/** 辐照监测领域模型：监测点、读数、校准工单、判废线、告警待处置台账。 */

export type PointStatus = '监测中' | '数据异常' | '待校准' | '已停用'

export type RoleKey = 'admin' | 'dispatcher' | 'specialistA' | 'specialistB' | 'viewer'

export interface Role {
  key: RoleKey
  /** 与人名挂钩：设备专责按人名确认点位归属 */
  name: string
  title: string
}

/** 读数判定结论：有效才参与当日辐照量计算 */
export type ReadingVerdict = '有效' | '无效'

export interface Reading {
  id: number
  pointCode: string
  /** 采集时间，本地时区 ISO 风格字符串 */
  ts: string
  /** 当日累计辐照量 Wh/m² */
  irradiation: number | null
  /** 峰值辐照 W/m² */
  peak: number | null
  /** 组件温度 ℃ */
  moduleTemp: number | null
  /** 环境温度 ℃ */
  ambientTemp: number | null
  verdict: ReadingVerdict
  /** 判废原因，逐格写明 */
  reasons: string[]
  ruleVersion: number
}

export type CalibrationResult = '合格' | '修正系数' | '更换探头'

export interface CalibrationConclusion {
  result: CalibrationResult
  /** 校准系数，合格时为 1 */
  factor: number
  note: string
  operator: string
  at: string
}

export interface CalibrationTask {
  id: string
  pointCode: string
  orderedAt: string
  orderedBy: string
  status: '待校准' | '已完成'
  conclusion?: CalibrationConclusion
}

/** 四格判废线，任一越线整笔读数判废；异常怎么判集中在这一份配置里 */
export interface AnomalyRules {
  version: number
  updatedAt: string
  updatedBy: string
  irradiation: [number, number]
  peak: [number, number]
  moduleTemp: [number, number]
  ambientTemp: [number, number]
}

export interface MonitorPoint {
  id: number
  code: string
  name: string
  /** 片区，用于筛选 */
  area: string
  deviceModel: string
  /** 安装高度 m，仅本点设备专责可改 */
  height: number
  /** 设备专责姓名 */
  specialist: string
  /** 安装时间，缺失按安装时间补齐 */
  installedAt: string
  status: PointStatus
  createdAt: string
}

/** 告警事件里的辐照异常待处置台账条目 */
export interface AlarmTicket {
  id: string
  pointCode: string
  level: '一级' | '二级'
  openedAt: string
  openedReason: string
  status: '待处置' | '已恢复'
  closedAt?: string
  closeNote?: string
  /** 校准结论落在这里：待处置期间也能看到结论，告警确认恢复后才出队 */
  conclusion?: CalibrationConclusion
  ruleVersion: number
}

export interface IrradianceDB {
  version: 1
  points: MonitorPoint[]
  readings: Reading[]
  tasks: CalibrationTask[]
  alarms: AlarmTicket[]
  rules: AnomalyRules
  seq: {
    reading: number
    alarm: number
    task: number
  }
}

/** 列表行：领域数据 + 实时派生值 */
export interface PointRow extends MonitorPoint {
  /** 当日辐照量：只取当日有效读数，坏值不参与 */
  daily: number | null
  latestReading: Reading | null
  openTask: CalibrationTask | null
  /** 是否有未闭环异常告警（未闭环异常点口径） */
  hasOpenAlarm: boolean
  /** 两条标记，全部由状态/台账派生，页面不允许手改 */
  pendingFlag: boolean
  abnormalFlag: boolean
}

export interface PointQuery {
  keyword: string
  area: string
  sort: 'installed' | 'irradianceAsc' | 'irradianceDesc'
  page: number
  size: number
}

export interface PointPage {
  items: PointRow[]
  total: number
  page: number
  size: number
  pages: number
}

export interface OpResult {
  ok: boolean
  message: string
}

export interface ConsistencyReport {
  /** 告警待处置台账里的辐照异常条数 */
  ledgerCount: number
  /** 辐照监测这边的未闭环异常点数 */
  pointCount: number
  matched: boolean
  /** 对不上时逐点列出 */
  diffs: string[]
}
