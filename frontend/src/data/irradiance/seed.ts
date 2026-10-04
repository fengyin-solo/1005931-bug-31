import { DEFAULT_RULES_V1 } from './rules'
import type {
  AlarmTicket,
  CalibrationConclusion,
  CalibrationTask,
  IrradianceDB,
  MonitorPoint,
  PointStatus,
  Reading,
} from './types'

/** 今天的本地时间字符串，往前推 hour 小时，保证种子读数落在“当日”。 */
function todayAt(hoursAgo: number): string {
  const d = new Date()
  d.setHours(d.getHours() - hoursAgo, 0, 0, 0)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

interface PointSeed {
  code: string
  name: string
  area: string
  model: string
  height: number
  specialist: string
  installedAt: string
  status: PointStatus
}

const POINT_SEEDS: PointSeed[] = [
  { code: 'IRRA-0001', name: '东区一号方阵辐照仪', area: '东区', model: 'FS-S100', height: 2.0, specialist: '王建国', installedAt: '2025-03-12', status: '监测中' },
  { code: 'IRRA-0002', name: '东区二号方阵辐照仪', area: '东区', model: 'FS-S100', height: 2.0, specialist: '王建国', installedAt: '2025-04-02', status: '监测中' },
  { code: 'IRRA-0003', name: '南区一期方阵辐照仪', area: '南区', model: 'FS-S200', height: 1.8, specialist: '王建国', installedAt: '2025-06-18', status: '监测中' },
  { code: 'IRRA-0004', name: '西区一期方阵辐照仪', area: '西区', model: 'FS-S200', height: 2.2, specialist: '李卫国', installedAt: '2025-09-25', status: '监测中' },
  { code: 'IRRA-0005', name: '东区三号方阵辐照仪', area: '东区', model: 'FS-S100', height: 2.0, specialist: '王建国', installedAt: '2025-11-07', status: '数据异常' },
  { code: 'IRRA-0006', name: '南区二期方阵辐照仪', area: '南区', model: 'FS-S200', height: 1.8, specialist: '王建国', installedAt: '2026-01-15', status: '数据异常' },
  { code: 'IRRA-0007', name: '北区一期方阵辐照仪', area: '北区', model: 'FS-T300', height: 2.5, specialist: '李卫国', installedAt: '2026-03-30', status: '待校准' },
  { code: 'IRRA-0008', name: '西区二期方阵辐照仪', area: '西区', model: 'FS-T300', height: 2.5, specialist: '李卫国', installedAt: '2026-07-21', status: '监测中' },
]

type ReadingSeed = [string, number | null, number | null, number | null, number | null]

const READING_SEEDS: ReadingSeed[] = [
  ['IRRA-0001', 4200, 1180, 46, 29],
  ['IRRA-0001', 6850, 1320, 51, 31],
  ['IRRA-0002', 3900, 1090, 44, 27],
  ['IRRA-0002', 6500, 1260, 49, 30],
  ['IRRA-0003', 4100, 1150, 45, 28],
  ['IRRA-0003', 7020, 1345, 52, 32],
  ['IRRA-0004', 3550, 1010, 40, 24],
  ['IRRA-0004', 6100, 1205, 46, 27],
  // 0005：最新一笔组件温度 91℃ 越线判废，当日辐照量只认上一笔有效值
  ['IRRA-0005', 3800, 1120, 47, 28],
  ['IRRA-0005', 7120, 1310, 91, 30],
  // 0006：最新一笔辐照量 -120 为负，坏值不进当日辐照量
  ['IRRA-0006', 4300, 1200, 48, 29],
  ['IRRA-0006', -120, 1350, 50, 30],
  // 0007：已派校准工单，坏值还挂着等执行
  ['IRRA-0007', 3100, 980, 39, 22],
  ['IRRA-0007', 6900, 1280, 88, 31],
  // 0008：校准后补录的有效读数；告警仍挂在待处置台账等确认恢复
  ['IRRA-0008', 6700, 1300, 48, 65],
  ['IRRA-0008', 5200, 1240, 49, 26],
]

export function buildSeed(): IrradianceDB {
  const rules = { ...DEFAULT_RULES_V1, version: 1, updatedAt: '2026-09-01 09:00', updatedBy: '系统管理员' }

  const points: MonitorPoint[] = POINT_SEEDS.map((seed, index) => ({
    id: index + 1,
    code: seed.code,
    name: seed.name,
    area: seed.area,
    deviceModel: seed.model,
    height: seed.height,
    specialist: seed.specialist,
    installedAt: seed.installedAt,
    status: seed.status,
    createdAt: seed.installedAt,
  }))

  const readings: Reading[] = READING_SEEDS.map(([pointCode, irradiation, peak, moduleTemp, ambientTemp], index) => {
    const judged = evaluateInline({ irradiation, peak, moduleTemp, ambientTemp }, rules)
    return {
      id: index + 1,
      pointCode,
      ts: todayAt(8 - (index % 2) * 6),
      irradiation,
      peak,
      moduleTemp,
      ambientTemp,
      verdict: judged.verdict,
      reasons: judged.reasons,
      ruleVersion: rules.version,
    }
  })

  const doneConclusion: CalibrationConclusion = {
    result: '合格',
    factor: 1,
    note: '标准源比对偏差 0.8%，在校准允差内，结论：合格。',
    operator: '李卫国',
    at: todayAt(3),
  }

  const tasks: CalibrationTask[] = [
    { id: 'CAL-0001', pointCode: 'IRRA-0007', orderedAt: todayAt(26), orderedBy: '值班调度员', status: '待校准' },
    { id: 'CAL-0002', pointCode: 'IRRA-0008', orderedAt: todayAt(30), orderedBy: '值班调度员', status: '已完成', conclusion: doneConclusion },
  ]

  const alarms: AlarmTicket[] = [
    { id: 'ALM-IR-0001', pointCode: 'IRRA-0005', level: '二级', openedAt: todayAt(4), openedReason: '最新读数判废：组件温度 91 越线（允许 -40~85）', status: '待处置', ruleVersion: 1 },
    { id: 'ALM-IR-0002', pointCode: 'IRRA-0006', level: '一级', openedAt: todayAt(4), openedReason: '最新读数判废：当日辐照量 -120 越线（允许 0~10000）', status: '待处置', ruleVersion: 1 },
    { id: 'ALM-IR-0003', pointCode: 'IRRA-0007', level: '二级', openedAt: todayAt(26), openedReason: '最新读数判废：组件温度 88 越线（允许 -40~85）', status: '待处置', ruleVersion: 1 },
    { id: 'ALM-IR-0004', pointCode: 'IRRA-0008', level: '二级', openedAt: todayAt(28), openedReason: '环境温度读数越线，派单校准', status: '待处置', conclusion: doneConclusion, ruleVersion: 1 },
  ]

  return {
    version: 1,
    points,
    readings,
    tasks,
    alarms,
    rules,
    seq: { reading: readings.length, alarm: alarms.length, task: tasks.length },
  }
}

// 与 rules.ts 同一份判定口径，种子构建时直接内联，避免循环依赖写法。
function evaluateInline(
  values: Pick<Reading, 'irradiation' | 'peak' | 'moduleTemp' | 'ambientTemp'>,
  rules: IrradianceDB['rules'],
): Pick<Reading, 'verdict' | 'reasons'> {
  const fields: { key: keyof typeof values; label: string; range: [number, number] }[] = [
    { key: 'irradiation', label: '当日辐照量', range: rules.irradiation },
    { key: 'peak', label: '峰值辐照', range: rules.peak },
    { key: 'moduleTemp', label: '组件温度', range: rules.moduleTemp },
    { key: 'ambientTemp', label: '环境温度', range: rules.ambientTemp },
  ]
  const reasons: string[] = []
  for (const { key, label, range } of fields) {
    const value = values[key]
    if (value === null || Number.isNaN(value)) {
      reasons.push(`${label}缺测`)
      continue
    }
    if (value < range[0] || value > range[1]) {
      reasons.push(`${label} ${value} 越线（允许 ${range[0]}~${range[1]}）`)
    }
  }
  return { verdict: reasons.length === 0 ? '有效' : '无效', reasons }
}
