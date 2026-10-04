import {
  commit,
  loadDB,
  releaseCalibration,
  resetDB,
  tryAcquireCalibration,
} from './storage'
import { describeRules, evaluateReading, recheckReadings } from './rules'
import { ROLES, canEditRules, canManageCalibration, ownsPoint } from './roles'
import type {
  AlarmTicket,
  CalibrationConclusion,
  CalibrationResult,
  ConsistencyReport,
  IrradianceDB,
  MonitorPoint,
  OpResult,
  PointPage,
  PointQuery,
  PointRow,
  PointStatus,
  Reading,
  Role,
} from './types'

function nowText(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function todayPrefix(): string {
  return nowText().slice(0, 10)
}

function isToday(ts: string): boolean {
  return ts.startsWith(todayPrefix())
}

// ── 派生口径 ───────────────────────────────────────────────────────────────

/** 两条标记一律由状态派生：数据异常挂异常标记，异常/待校准都算待处置。 */
function deriveFlags(status: PointStatus): { abnormalFlag: boolean; pendingFlag: boolean } {
  return {
    abnormalFlag: status === '数据异常',
    pendingFlag: status === '数据异常' || status === '待校准',
  }
}

/** 当日辐照量：只取当日有效读数里最新一笔，坏值一律不算。 */
function dailyIrradiation(readings: Reading[], code: string): { daily: number | null; latest: Reading | null } {
  const today = readings
    .filter((reading) => reading.pointCode === code && isToday(reading.ts))
    .sort((a, b) => (a.ts < b.ts ? 1 : -1))
  const latestValid = today.find((reading) => reading.verdict === '有效')
  const latest = today[0] ?? null
  return { daily: latestValid ? latestValid.irradiation : null, latest }
}

function toRow(point: MonitorPoint, db: IrradianceDB): PointRow {
  const { daily, latest } = dailyIrradiation(db.readings, point.code)
  const openTask =
    db.tasks.find((task) => task.pointCode === point.code && task.status === '待校准') ?? null
  const openAlarm =
    db.alarms.find((alarm) => alarm.pointCode === point.code && alarm.status === '待处置') ?? null
  const flags = deriveFlags(point.status)
  return {
    ...point,
    daily,
    latestReading: latest,
    openTask,
    hasOpenAlarm: Boolean(openAlarm),
    ...flags,
  }
}

/**
 * 台账对账（不变量）：
 * - 数据异常/待校准的点位，必须有且只有一条待处置告警；
 * - 监测中可有至多一条（校准后等确认恢复）；已停用不得有待处置告警。
 * 每笔写操作都先跑它再落库，两边“数据异常点数”天然对得上。
 */
function reconcile(db: IrradianceDB): string[] {
  const notes: string[] = []
  for (const point of db.points) {
    const open = db.alarms.filter(
      (alarm) => alarm.pointCode === point.code && alarm.status === '待处置',
    )
    if (point.status === '已停用') {
      for (const alarm of open) {
        alarm.status = '已恢复'
        alarm.closedAt = nowText()
        alarm.closeNote = '点位停用，异常台账自动核销'
        notes.push(`${point.code} 停用，残留异常标记与待处置告警已一并清掉`)
      }
      continue
    }
    if (point.status === '数据异常' || point.status === '待校准') {
      if (open.length === 0) {
        db.seq.alarm += 1
        db.alarms.push({
          id: `ALM-IR-X${String(db.seq.alarm).padStart(4, '0')}`,
          pointCode: point.code,
          level: '二级',
          openedAt: nowText(),
          openedReason: '台账对账补齐：点位处于异常态但缺待处置告警',
          status: '待处置',
          ruleVersion: db.rules.version,
        })
        notes.push(`${point.code} 补齐了缺失的待处置告警`)
      } else if (open.length > 1) {
        for (const extra of open.slice(1)) {
          extra.status = '已恢复'
          extra.closedAt = nowText()
          extra.closeNote = '台账对账去重：同一点位只保留一条待处置告警'
          notes.push(`${point.code} 重复的待处置告警已合并`)
        }
      }
    } else if (open.length > 1) {
      // 监测中只允许挂一条等确认恢复
      for (const extra of open.slice(1)) {
        extra.status = '已恢复'
        extra.closedAt = nowText()
        extra.closeNote = '台账对账去重'
        notes.push(`${point.code} 重复的待处置告警已合并`)
      }
    }
  }
  return notes
}

// ── 查询：片区筛选 + 辐照量排序 + 翻页不丢条件 ──────────────────────────────

export function listPoints(query: Partial<PointQuery> = {}): PointPage {
  const db = loadDB()
  return queryPoints(db, query)
}

function queryPoints(db: IrradianceDB, query: Partial<PointQuery>): PointPage {
  const full: PointQuery = {
    keyword: query.keyword?.trim() ?? '',
    area: query.area ?? '',
    sort: query.sort ?? 'installed',
    page: Math.max(1, query.page ?? 1),
    size: query.size ?? 5,
  }
  let rows = db.points.map((point) => toRow(point, db))
  if (full.area) {
    rows = rows.filter((row) => row.area === full.area)
  }
  if (full.keyword) {
    const key = full.keyword
    rows = rows.filter(
      (row: PointRow) =>
        row.code.includes(key) || row.name.includes(key) || row.deviceModel.includes(key),
    )
  }
  if (full.sort === 'irradianceAsc' || full.sort === 'irradianceDesc') {
    const dir = full.sort === 'irradianceAsc' ? 1 : -1
    rows.sort((a, b) => {
      // 当日无有效值（全是坏值）的排到最后
      if (a.daily === null && b.daily === null) return a.code.localeCompare(b.code)
      if (a.daily === null) return 1
      if (b.daily === null) return -1
      if (a.daily === b.daily) return a.code.localeCompare(b.code)
      return (a.daily - b.daily) * dir
    })
  } else {
    rows.sort((a, b) => (a.installedAt === b.installedAt ? a.id - b.id : a.installedAt.localeCompare(b.installedAt)))
  }
  const total = rows.length
  const pages = Math.max(1, Math.ceil(total / full.size))
  const page = Math.min(full.page, pages)
  return {
    items: rows.slice((page - 1) * full.size, page * full.size),
    total,
    page,
    size: full.size,
    pages,
  }
}

export function listAreas(): string[] {
  const db = loadDB()
  return [...new Set(db.points.map((point) => point.area))].sort()
}

/** 校准工单（待校准在前），同一监测点待校准工单至多一张。 */
export function listTasks() {
  const db = loadDB()
  return [...db.tasks].sort((a, b) => {
    if (a.status !== b.status) return a.status === '待校准' ? -1 : 1
    return a.orderedAt < b.orderedAt ? -1 : 1
  })
}

/** 某监测点当日读数，最新在前，面板里逐笔展示判定。 */
export function readingsOf(pointCode: string): Reading[] {
  const db = loadDB()
  return db.readings
    .filter((reading) => reading.pointCode === pointCode && isToday(reading.ts))
    .sort((a, b) => (a.ts < b.ts ? 1 : -1))
}

/** 找不到点位时，逐格写明是哪一格对不上。 */
export function diagnosePoint(input: { code?: string; name?: string; model?: string; area?: string }): string {
  const db = loadDB()
  const rows = db.points.map((point) => toRow(point, db))
  const code = input.code?.trim() ?? ''
  const name = input.name?.trim() ?? ''
  const model = input.model?.trim() ?? ''
  const area = input.area?.trim() ?? ''
  const filled = [code, name, model, area].filter(Boolean).length
  if (filled === 0) {
    return '没有可核对的查找条件，请先填监测点编号或点位名称'
  }

  // 先按最硬的格（编号 → 名称）锚定一条记录，再逐格对
  const anchor =
    (code ? rows.find((row) => row.code === code) : undefined) ??
    (name ? rows.find((row) => row.name === name) : undefined)

  if (anchor) {
    const diffs: string[] = []
    if (code && anchor.code !== code) diffs.push(`监测点编号应为 ${anchor.code}`)
    if (name && anchor.name !== name) diffs.push(`点位名称这一格对不上：该点名称是「${anchor.name}」`)
    if (model && anchor.deviceModel !== model) diffs.push(`设备型号这一格对不上：该点型号是「${anchor.deviceModel}」，不是「${model}」`)
    if (area && anchor.area !== area) diffs.push(`片区这一格对不上：${anchor.code} 在「${anchor.area}」，不是「${area}」`)
    if (diffs.length === 0) return `各格与 ${anchor.code} 全部对得上`
    return `按${code ? '编号 ' + code : '名称'}锚定到 ${anchor.code}（${anchor.name}），但：${diffs.join('；')}`
  }

  // 锚不住：逐格说明台账里到底有没有这个值
  const mismatches: string[] = []
  if (code && !rows.some((row) => row.code === code)) {
    mismatches.push(`「监测点编号」这一格填的是「${code}」，点位台账里没有这条编号`)
  }
  if (name && !rows.some((row) => row.name === name)) {
    mismatches.push(`「点位名称」这一格填的是「${name}」，台账里没有同名点位`)
  }
  if (model && !rows.some((row) => row.deviceModel === model)) {
    mismatches.push(`「设备型号」这一格填的是「${model}」，台账里没有这个型号`)
  } else if (model) {
    const areas = [...new Set(rows.filter((row) => row.deviceModel === model).map((row) => row.area))]
    if (area && !areas.includes(area)) {
      mismatches.push(`型号「${model}」只在 ${areas.join('、')} 有，「片区」这一格填的「${area}」对不上`)
    }
  }
  if (area && !rows.some((row) => row.area === area)) {
    mismatches.push(`「片区」这一格填的是「${area}」，台账里没有这个片区`)
  }
  return mismatches.length
    ? `找不到该监测点：${mismatches.join('；')}`
    : '各格单独都能找到值，但没有同时满足全部条件的点位（组合条件互相冲突）'
}

/** 按编号直达：算好它落在哪一页，页面带着片区/排序条件直接跳过去。 */
export function locatePoint(code: string): { found: boolean; query?: PointQuery; message: string } {
  const db = loadDB()
  const target = db.points.find((point) => point.code === code.trim())
  if (!target) {
    return { found: false, message: diagnosePoint({ code: code.trim() }) }
  }
  const size = 5
  const ordered = [...db.points].sort((a, b) =>
    a.installedAt === b.installedAt ? a.id - b.id : a.installedAt.localeCompare(b.installedAt),
  )
  const index = ordered.findIndex((point) => point.code === target.code)
  return {
    found: true,
    query: { keyword: '', area: target.area, sort: 'installed', page: Math.floor(index / size) + 1, size },
    message: `已跳到 ${target.code}（${target.area} · 第 ${Math.floor(index / size) + 1} 页）`,
  }
}

// ── 拦截：越权当场拦、越级指出还差哪一步，并顺手把两条标记一起清 ─────────────

function intercept(db: IrradianceDB, reason: string): OpResult {
  // 拦截不落业务数据，但用同一笔事务把挂歪的标记/台账纠正，避免留下半笔
  const notes = reconcile(db)
  const suffix = notes.length ? `；已顺手把异常/待处置两条标记按当前状态清齐：${notes.join('，')}` : ''
  return { ok: false, message: `${reason}${suffix}` }
}

function getPoint(db: IrradianceDB, id: number): MonitorPoint | undefined {
  return db.points.find((point) => point.id === id)
}

export interface PointStats {
  total: number
  abnormal: number
  pendingCalibration: number
  unclosedAlarms: number
  byStatus: { status: PointStatus; count: number }[]
}

export function stats(): PointStats {
  const db = loadDB()
  const rows = db.points
  const statuses: PointStatus[] = ['监测中', '数据异常', '待校准', '已停用']
  return {
    total: rows.length,
    abnormal: rows.filter((point) => point.status === '数据异常').length,
    pendingCalibration: rows.filter((point) => point.status === '待校准').length,
    unclosedAlarms: db.alarms.filter((alarm) => alarm.status === '待处置').length,
    byStatus: statuses.map((status) => ({ status, count: rows.filter((point) => point.status === status).length })),
  }
}

// ── 登记异常 ────────────────────────────────────────────────────────────────

export function registerAnomaly(id: number, role: Role, reason: string): OpResult {
  if (!canManageCalibration(role) && role.key !== 'admin') {
    // 访客无任何写权限：先按当前状态把标记清齐，再当场拦
    return commit((db) =>
      intercept(db, `越权拦截：${role.title}（${role.name}）不能登记异常，这一步只对值班调度/设备专责开放`),
    )
  }
  return commit((db) => {
    const point = getPoint(db, id)
    if (!point) return { ok: false, message: `没有找到编号为 ${id} 的监测点` }

    if (point.status === '待校准') {
      return intercept(
        db,
        `越级拦截：${point.code} 已在待校准，不许再记异常；要先把校准走完（执行校准 → 确认告警恢复）`,
      )
    }
    if (point.status === '数据异常') {
      return { ok: false, message: `${point.code} 已经是数据异常，异常不重复登记` }
    }
    if (point.status === '已停用') {
      return intercept(db, `越级拦截：${point.code} 已停用，得先重新启用监测点才能登记异常`)
    }

    point.status = '数据异常'
    db.seq.alarm += 1
    db.alarms.push({
      id: `ALM-IR-${String(db.seq.alarm).padStart(4, '0')}`,
      pointCode: point.code,
      level: '二级',
      openedAt: nowText(),
      openedReason: reason.trim() || '人工登记数据异常',
      status: '待处置',
      ruleVersion: db.rules.version,
    })
    reconcile(db)
    return { ok: true, message: `${point.code} 已登记数据异常并进入待处置台账，下一步：安排校准` }
  })
}

// ── 安排校准 ────────────────────────────────────────────────────────────────

export function arrangeCalibration(id: number, role: Role): OpResult {
  if (role.key !== 'dispatcher') {
    const hint =
      role.key === 'admin'
        ? '管理员负责判废线，不直接派校准单'
        : role.key === 'viewer'
          ? '访客无写权限'
          : '设备专责负责执行校准，派单这一步由值班调度员完成'
    return commit((db) => intercept(db, `越权拦截：${role.name} 不能安排校准（${hint}）`))
  }
  return commit((db) => {
    const point = getPoint(db, id)
    if (!point) return { ok: false, message: `没有找到编号为 ${id} 的监测点` }

    // 幂等：同一点位只认头一张待校准工单，连点两次不多出第二条
    const existing = db.tasks.find(
      (task) => task.pointCode === point.code && task.status === '待校准',
    )
    if (existing) {
      return {
        ok: false,
        message: `${point.code} 已有待校准工单 ${existing.id}（${existing.orderedAt} 派出），重复点击已忽略，只认头一回`,
      }
    }
    if (point.status === '待校准') {
      return { ok: false, message: `${point.code} 已在待校准，不能重复安排` }
    }
    if (point.status === '监测中') {
      const openAlarm = db.alarms.some(
        (alarm) => alarm.pointCode === point.code && alarm.status === '待处置',
      )
      const nextStep = openAlarm
        ? '告警已在待处置台账，当前无异常标记，等确认恢复即可，不必再派校准'
        : '监测中不能直接安排校准，还差一步：先登记异常'
      return intercept(db, `越级拦截：${point.code} ${nextStep}`)
    }
    if (point.status === '已停用') {
      return intercept(db, `越级拦截：${point.code} 已停用，得先重新启用再走异常 → 校准`)
    }

    db.seq.task += 1
    const taskId = `CAL-${String(db.seq.task).padStart(4, '0')}`
    db.tasks.push({
      id: taskId,
      pointCode: point.code,
      orderedAt: nowText(),
      orderedBy: role.name,
      status: '待校准',
    })
    // 状态推进到待校准：异常标记随之清除（由状态派生），告警继续挂待处置
    point.status = '待校准'
    reconcile(db)
    return { ok: true, message: `${point.code} 校准工单 ${taskId} 已派出，状态转为待校准，下一步：由本点设备专责执行校准` }
  })
}

// ── 执行校准：一步写齐 状态 + 当日辐照量 + 异常标记，写不成整笔退回 ──────────

export interface CalibrationInput {
  result: CalibrationResult
  factor: number
  note: string
}

export function executeCalibration(id: number, role: Role, input: CalibrationInput): OpResult {
  const db = loadDB()
  const point = db.points.find((item) => item.id === id)
  if (!point) return { ok: false, message: `没有找到编号为 ${id} 的监测点` }

  // 越权先拦（不持锁，不产生任何写入）
  if (role.key !== 'specialistA' && role.key !== 'specialistB') {
    return commit((draft) =>
      intercept(
        draft,
        `越权拦截：执行校准只对设备专责开放，${role.name} 不能操作；请由本点设备专责 ${point.specialist} 执行`,
      ),
    )
  }
  if (!ownsPoint(role, point.specialist)) {
    return commit((draft) =>
      intercept(
        draft,
        `越权拦截：${point.code} 的设备专责是 ${point.specialist}，${role.name} 不是本点专责，不能动这台设备的校准`,
      ),
    )
  }
  // 越级先拦
  if (point.status !== '待校准') {
    const missing =
      point.status === '数据异常'
        ? '还差一步：先由值班调度员安排校准'
        : point.status === '监测中'
          ? '当前监测正常，无需校准'
          : '点位已停用'
    return commit((draft) => intercept(draft, `越级拦截：${point.code} 当前是「${point.status}」，${missing}`))
  }

  const task = db.tasks.find(
    (item) => item.pointCode === point.code && item.status === '待校准',
  )
  if (!task) {
    return commit((draft) => intercept(draft, `${point.code} 缺待校准工单，先安排校准`))
  }

  // 幂等锁：同一监测点连点两次，只认头一回
  if (!tryAcquireCalibration(point.code)) {
    return { ok: false, message: `${point.code} 的校准正在提交中，重复点击已忽略，只认头一回结果` }
  }
  try {
    return commit((draft) => {
      const draftPoint = draft.points.find((item) => item.id === id)!
      const draftTask = draft.tasks.find(
        (item) => item.pointCode === draftPoint.code && item.status === '待校准',
      )
      if (!draftTask) {
        // 头一回已经把工单完成了：重复点击直接认头一回的结果，不再写
        const done = draft.tasks
          .filter((item) => item.pointCode === draftPoint.code)
          .sort((a, b) => (a.orderedAt < b.orderedAt ? 1 : -1))[0]
        return {
          ok: false,
          message: `${draftPoint.code} 已完成校准（头一回结果：${done?.conclusion?.result ?? '已完成'}），重复点击只认头一回`,
        }
      }
      if (!Number.isFinite(input.factor) || input.factor <= 0 || input.factor > 2) {
        // 结论不合法：抛错 → 整笔退回，状态/辐照量/标记一个都不改
        throw new Error('校准系数必须在 0~2 之间，本次写入不合法，整笔退回，监测点仍保持校准前状态')
      }

      // 当日辐照量按校准系数重算：只重放当日有效读数，坏值不参与
      const factor = input.result === '合格' ? 1 : input.factor
      for (const reading of draft.readings) {
        if (reading.pointCode === draftPoint.code && isToday(reading.ts) && reading.verdict === '有效' && reading.irradiation !== null) {
          reading.irradiation = Math.round(reading.irradiation * factor)
        }
      }

      const conclusion: CalibrationConclusion = {
        result: input.result,
        factor,
        note: input.note.trim() || '校准结论未填备注',
        operator: role.name,
        at: nowText(),
      }
      draftTask.status = '已完成'
      draftTask.conclusion = conclusion

      // 同一份写入：状态归位 + 异常标记清除（待处置标记也清），告警留台账待确认恢复
      draftPoint.status = '监测中'
      const openAlarm = draft.alarms.find(
        (alarm) => alarm.pointCode === draftPoint.code && alarm.status === '待处置',
      )
      if (openAlarm) {
        openAlarm.conclusion = conclusion
      }
      reconcile(draft)
      const row = toRow(draftPoint, draft)
      return {
        ok: true,
        message:
          `${draftPoint.code} 校准完成（结论：${conclusion.result}，系数 ${factor}）：` +
          `监测状态归位为「监测中」，当日辐照量重算为 ${row.daily ?? '—'} Wh/m²，异常/待处置两条标记已一并清掉；` +
          `校准结论已落到告警事件待处置台账（${openAlarm?.id ?? '无待处置告警'}），请值班调度确认恢复`,
      }
    })
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '校准写入失败，整笔退回' }
  } finally {
    releaseCalibration(point.code)
  }
}

// ── 确认告警恢复（待处置台账出队） ──────────────────────────────────────────

export function recoverAlarm(id: number, role: Role, note: string): OpResult {
  if (role.key !== 'dispatcher' && role.key !== 'admin') {
    return commit((db) =>
      intercept(
        db,
        `越权拦截：确认告警恢复由值班调度员执行，${role.name} 只能查看待处置台账`,
      ),
    )
  }
  return commit((db) => {
    const point = getPoint(db, id)
    if (!point) return { ok: false, message: `没有找到编号为 ${id} 的监测点` }
    const alarm = db.alarms.find(
      (item) => item.pointCode === point.code && item.status === '待处置',
    )
    if (!alarm) {
      return { ok: false, message: `${point.code} 没有待处置的辐照异常告警` }
    }
    if (point.status === '数据异常') {
      return intercept(db, `越级拦截：${point.code} 仍是数据异常，还差两步：安排校准 → 执行校准，之后才能确认恢复`)
    }
    if (point.status === '待校准') {
      return intercept(db, `越级拦截：${point.code} 校准还没执行，还差一步：由本点设备专责 ${point.specialist} 执行校准`)
    }
    alarm.status = '已恢复'
    alarm.closedAt = nowText()
    alarm.closeNote = note.trim() || '值班调度确认恢复，待处置台账出队'
    reconcile(db)
    return { ok: true, message: `${point.code} 告警 ${alarm.id} 已确认恢复，待处置台账出队，两处异常计数同步归零` }
  })
}

// ── 安装高度：只有本监测点的设备专责能改 ─────────────────────────────────────

export function editHeight(id: number, role: Role, height: number): OpResult {
  try {
    return commit((db) => {
      const point = getPoint(db, id)
      if (!point) return { ok: false, message: `没有找到编号为 ${id} 的监测点` }
      if (role.key !== 'specialistA' && role.key !== 'specialistB') {
        return intercept(db, `越权拦截：安装高度只认本点设备专责，${role.name} 无权修改 ${point.code}`)
      }
      if (!ownsPoint(role, point.specialist)) {
        return intercept(db, `越权拦截：${point.code} 的设备专责是 ${point.specialist}，${role.name} 不能改本点安装高度`)
      }
      if (!Number.isFinite(height) || height <= 0 || height > 20) {
        throw new Error('安装高度必须在 0~20 米之间，本次写入不合法，整笔退回')
      }
      point.height = Math.round(height * 100) / 100
      reconcile(db)
      return { ok: true, message: `${point.code} 安装高度已更新为 ${point.height} m` }
    })
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '安装高度写入失败，整笔退回' }
  }
}

// ── 补录读数 ────────────────────────────────────────────────────────────────

export interface ReadingInput {
  irradiation: number | null
  peak: number | null
  moduleTemp: number | null
  ambientTemp: number | null
}

export function addReading(id: number, role: Role, input: ReadingInput): OpResult {
  if (role.key === 'viewer') {
    return commit((db) => intercept(db, `越权拦截：访客不能补录读数`))
  }
  try {
    return commit((db) => {
    const point = getPoint(db, id)
    if (!point) return { ok: false, message: `没有找到编号为 ${id} 的监测点` }
    if (point.status === '已停用') {
      return intercept(db, `越级拦截：${point.code} 已停用，不再接收读数`)
    }
    if (point.status === '待校准') {
      return intercept(db, `越级拦截：${point.code} 在待校准，等执行校准后再录新读数`)
    }
    const judged = evaluateReading(input, db.rules)
    db.seq.reading += 1
    const reading: Reading = {
      id: db.seq.reading,
      pointCode: point.code,
      ts: nowText(),
      ...input,
      verdict: judged.verdict,
      reasons: judged.reasons,
      ruleVersion: db.rules.version,
    }
    db.readings.push(reading)

    if (judged.verdict === '无效' && point.status === '监测中') {
      point.status = '数据异常'
      db.seq.alarm += 1
      db.alarms.push({
        id: `ALM-IR-${String(db.seq.alarm).padStart(4, '0')}`,
        pointCode: point.code,
        level: judged.reasons.some((reason) => reason.includes('辐照')) ? '一级' : '二级',
        openedAt: nowText(),
        openedReason: `新读数判废：${judged.reasons.join('；')}`,
        status: '待处置',
        ruleVersion: db.rules.version,
      })
    }
    reconcile(db)
    const row = toRow(point, db)
    return {
      ok: true,
      message:
        judged.verdict === '无效'
          ? `${point.code} 新读数判废（${judged.reasons.join('；')}），已转数据异常并进待处置台账；当日辐照量仍只认有效读数：${row.daily ?? '—'} Wh/m²`
          : `${point.code} 读数有效，当日辐照量更新为 ${row.daily ?? '—'} Wh/m²`,
    }
    })
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '读数写入失败，整笔退回' }
  }
}

// ── 改判废线：异常怎么判由管理员权衡；既有读数照新线重过一遍 ──────────────────

export interface RulesInput {
  irradiation: [number, number]
  peak: [number, number]
  moduleTemp: [number, number]
  ambientTemp: [number, number]
}

export function currentRules() {
  return loadDB().rules
}

export function updateRules(role: Role, input: RulesInput): OpResult {
  if (!canEditRules(role)) {
    return commit((db) => intercept(db, `越权拦截：判废线只由管理员调整，${role.name} 不能改线`))
  }
  for (const [label, range] of Object.entries(input) as [string, [number, number]][]) {
    if (!Number.isFinite(range[0]) || !Number.isFinite(range[1]) || range[0] >= range[1]) {
      return { ok: false, message: `「${label}」上下限不合法（下限必须小于上限），改线整笔退回，既有读数与状态不动` }
    }
  }
  return commit((db) => {
    const oldVersion = db.rules.version
    db.rules = {
      ...db.rules,
      ...input,
      version: oldVersion + 1,
      updatedAt: nowText(),
      updatedBy: role.name,
    }
    // 改线后已录的读数照新线重过一遍
    recheckReadings(db.readings, db.rules)

    // 按新线重新判定点位：监测中冒出坏值 → 异常；异常点位全部恢复有效 → 自动回监测中并销告警
    for (const point of db.points) {
      const own = db.readings.filter((reading) => reading.pointCode === point.code)
      const hasBad = own.some((reading) => reading.verdict === '无效')
      if (point.status === '监测中' && hasBad) {
        point.status = '数据异常'
      } else if (point.status === '数据异常' && !hasBad) {
        point.status = '监测中'
        for (const alarm of db.alarms.filter(
          (item) => item.pointCode === point.code && item.status === '待处置',
        )) {
          alarm.status = '已恢复'
          alarm.closedAt = nowText()
          alarm.closeNote = `判废线升级至 v${db.rules.version} 后重过，既有读数全部有效，异常自动撤销`
        }
      }
    }
    reconcile(db)
    return {
      ok: true,
      message: `判废线已升级到 v${db.rules.version}（${describeRules(db.rules)}），全部 ${db.readings.length} 笔既有读数已照新线重过，点位状态与告警台账已同步`,
    }
  })
}

// ── 告警待处置台账 + 两处异常点数对账 ────────────────────────────────────────

export function pendingLedger(): { alarm: AlarmTicket; point: MonitorPoint }[] {
  const db = loadDB()
  return db.alarms
    .filter((alarm) => alarm.status === '待处置')
    .sort((a, b) => (a.openedAt < b.openedAt ? -1 : 1))
    .map((alarm) => ({ alarm, point: db.points.find((point) => point.code === alarm.pointCode)! }))
    .filter((item) => Boolean(item.point))
}

export function consistency(): ConsistencyReport {
  const db = loadDB()
  const openAlarms = db.alarms.filter((alarm) => alarm.status === '待处置')
  const unclosedPoints = db.points.filter((point) =>
    openAlarms.some((alarm) => alarm.pointCode === point.code),
  )
  const diffs: string[] = []
  for (const alarm of openAlarms) {
    if (!db.points.some((point) => point.code === alarm.pointCode)) {
      diffs.push(`告警 ${alarm.id} 指向的点位 ${alarm.pointCode} 已不存在`)
    }
  }
  for (const point of db.points) {
    const count = openAlarms.filter((alarm) => alarm.pointCode === point.code).length
    if ((point.status === '数据异常' || point.status === '待校准') && count === 0) {
      diffs.push(`${point.code} 处于「${point.status}」却没有待处置告警`)
    }
    if (count > 1) {
      diffs.push(`${point.code} 挂了 ${count} 条待处置告警，应只有一条`)
    }
  }
  return {
    ledgerCount: openAlarms.length,
    pointCount: unclosedPoints.length,
    matched: openAlarms.length === unclosedPoints.length && diffs.length === 0,
    diffs,
  }
}

// ── 导出 / 演示数据 ──────────────────────────────────────────────────────────

export function exportCsv(): { filename: string; content: string } {
  const db = loadDB()
  const header = ['监测点编号', '点位名称', '片区', '设备型号', '安装高度(m)', '设备专责', '安装时间', '监测状态', '当日辐照量(Wh/m²)', '待处置告警']
  const lines = [header.join(',')]
  for (const row of db.points.map((point) => toRow(point, db)).sort((a, b) => a.installedAt.localeCompare(b.installedAt))) {
    const alarm = db.alarms.find((item) => item.pointCode === row.code && item.status === '待处置')
    lines.push(
      [
        row.code,
        row.name,
        row.area,
        row.deviceModel,
        row.height,
        row.specialist,
        row.installedAt,
        row.status,
        row.daily ?? '',
        alarm ? `${alarm.id}(${alarm.conclusion?.result ?? '待校准结论'})` : '',
      ]
      .map((value) => String(value).replace(/,/g, '，'))
      .join(','),
    )
  }
  return { filename: '辐照监测清单.csv', content: `﻿${lines.join('\n')}` }
}

export function downloadCsv(): void {
  const { filename, content } = exportCsv()
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function resetDemo(): OpResult {
  resetDB()
  return { ok: true, message: '辐照监测演示数据已恢复初始状态' }
}

export { ROLES }
export type { PointRow }
