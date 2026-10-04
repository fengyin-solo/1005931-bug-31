/* 领域逻辑冒烟脚本（不进仓库构建，只本地跑断言） */
const mem = new Map<string, string>()
// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(globalThis as any).window = {
  localStorage: {
    getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
    setItem: (k: string, v: string) => void mem.set(k, String(v)),
    removeItem: (k: string) => void mem.delete(k),
  },
}
;(globalThis as any).localStorage = (globalThis as any).window.localStorage

import {
  arrangeCalibration,
  consistency,
  editHeight,
  executeCalibration,
  listPoints,
  listTasks,
  locatePoint,
  addReading,
  pendingLedger,
  recoverAlarm,
  registerAnomaly,
  resetDemo,
  stats,
  updateRules,
  diagnosePoint,
  readingsOf,
} from './src/data/irradiance/service'
import { ROLES } from './src/data/irradiance/roles'

const admin = ROLES[0]
const dispatcher = ROLES[1]
const specA = ROLES[2] // 王建国
const specB = ROLES[3] // 李卫国
const viewer = ROLES[4]

let passed = 0
function check(name: string, cond: boolean, extra = '') {
  if (!cond) {
    console.error(`✗ ${name} ${extra}`)
    process.exitCode = 1
  } else {
    passed++
    console.log(`✓ ${name} ${extra}`)
  }
}

resetDemo()

// 1. 初始种子：坏值不进当日辐照量（字段是当日累计值，最新有效累计值才是当日辐照量）
let p5 = listPoints({ page: 1, size: 20 }).items.find((r) => r.code === 'IRRA-0005')!
check('0005 最新累计 7120 随 91℃ 越线整笔判废，当日辐照量回退到上一笔有效累计 3800', p5.daily === 3800, `daily=${p5.daily}`)
let p6 = listPoints({ page: 1, size: 20 }).items.find((r) => r.code === 'IRRA-0006')!
check('0006 最新辐照 -120 判废，当日仍取 4300', p6.daily === 4300, `daily=${p6.daily}`)

// 2. 异常标记/待处置由状态派生，初始对账一致
check('初始两处数据异常点数对得上', consistency().matched, JSON.stringify(consistency()))

// 3. 已在待校准的点位不许再记异常（0007），且拦截信息带步骤
const p7 = listPoints({ page: 1, size: 20 }).items.find((r) => r.code === 'IRRA-0007')!
const reAnomaly = registerAnomaly(p7.id, dispatcher, '再记一次')
check('待校准点位再记异常被拦', !reAnomaly.ok && reAnomaly.message.includes('已在待校准'), reAnomaly.message)

// 4. 同一监测点连点两次安排校准：只认头一回（0005 数据异常→派两次）
const tasksBefore = listTasks().filter((t) => t.status === '待校准').length
const a1 = arrangeCalibration(p5.id, dispatcher)
const a2 = arrangeCalibration(p5.id, dispatcher)
const tasksAfter = listTasks().filter((t) => t.status === '待校准').length
check('第一次安排校准成功', a1.ok, a1.message)
check('第二次安排被幂等拦截且不多工单', !a2.ok && tasksAfter === tasksBefore + 1, a2.message)

// 5. 越级：安排校准后没执行校准，不能直接确认恢复（指出还差执行校准这一步）
const skipStep = recoverAlarm(p5.id, dispatcher, '直接恢复')
check('没执行校准直接确认恢复被越级拦截并指出缺的步骤', !skipStep.ok && skipStep.message.includes('还差一步'), skipStep.message)

// 6. 越权：访客不能登记异常
const viewerBlock = registerAnomaly(p6.id, viewer, '')
check('访客登记异常越权拦截', !viewerBlock.ok && viewerBlock.message.includes('越权'), viewerBlock.message)

// 7. 越权：调度员不能执行校准；别的专责不能动 0005（王建国的点）
const dispExec = executeCalibration(p5.id, dispatcher, { result: '合格', factor: 1, note: '' })
check('调度员执行校准被拦', !dispExec.ok && dispExec.message.includes('越权'), dispExec.message)
const wrongSpec = executeCalibration(p5.id, specB, { result: '合格', factor: 1, note: '' })
check('非本点专责执行校准被拦', !wrongSpec.ok && wrongSpec.message.includes('王建国'), wrongSpec.message)

// 8. 安装高度：只有本点专责能改
const h1 = editHeight(p5.id, specB, 3.0)
check('非本点专责改高度被拦', !h1.ok && h1.message.includes('安装高度'), h1.message)
const h2 = editHeight(p5.id, specA, 2.1)
check('本点专责改高度成功', h2.ok, h2.message)
const h3 = editHeight(p5.id, specA, 99)
check('高度非法整笔退回', !h3.ok && h3.message.includes('整笔退回'), h3.message)
p5 = listPoints({ page: 1, size: 20 }).items.find((r) => r.code === 'IRRA-0005')!
check('退回后高度仍是 2.1', p5.height === 2.1, `height=${p5.height}`)

// 9. 执行校准：一步写齐 状态/当日辐照量/异常标记 + 结论落待处置台账
const before = pendingLedger().find((l) => l.alarm.pointCode === 'IRRA-0005')!
check('校准前 0005 在待处置台账且无结论', before && !before.alarm.conclusion)
const c1 = executeCalibration(p5.id, specA, { result: '修正系数', factor: 1.05, note: '比对偏差 5%' })
check('本点专责执行校准成功', c1.ok, c1.message)
p5 = listPoints({ page: 1, size: 20 }).items.find((r) => r.code === 'IRRA-0005')!
check('校准后状态归位监测中', p5.status === '监测中', p5.status)
check('校准后异常标记清除', p5.abnormalFlag === false && p5.pendingFlag === false)
check('校准后当日辐照量按系数重算 3800*1.05=3990', p5.daily === 3990, `daily=${p5.daily}`)
const after = pendingLedger().find((l) => l.alarm.pointCode === 'IRRA-0005')
check('校准结论已落到待处置台账', Boolean(after && after.alarm.conclusion?.result === '修正系数'))

// 10. 连点两次执行校准只认头一回（此时状态已监测中，第二次应越级拦截/幂等）
const c2 = executeCalibration(p5.id, specA, { result: '合格', factor: 1, note: '' })
check('第二次执行不再产生写入', !c2.ok, c2.message)
const taskCount = listTasks().filter((t) => t.pointCode === 'IRRA-0005').length
check('0005 仍只有一张工单', taskCount === 1, `count=${taskCount}`)

// 11. 台账仍在待处置 → 未闭环异常点口径两边仍对得上；确认恢复后归零
check('校准后台账未出队前对账仍一致', consistency().matched)
const r1 = recoverAlarm(p5.id, dispatcher, '已恢复')
check('调度确认恢复成功', r1.ok, r1.message)
check('恢复后对账一致', consistency().matched)

// 12. 改判废线：管理员才能改；既有读数照新线重过
const denied = updateRules(specA, { irradiation: [0, 10000], peak: [0, 1600], moduleTemp: [-40, 85], ambientTemp: [-40, 60] })
check('专责改线被拦', !denied.ok, denied.message)
// 把组件温度上限提到 95：0005 那笔 91 变有效；但 0007 的 88 也变有效——0007 在待校准不动状态
const upd = updateRules(admin, { irradiation: [0, 10000], peak: [0, 1600], moduleTemp: [-40, 95], ambientTemp: [-40, 60] })
check('管理员改线成功并重放读数', upd.ok, upd.message)
check('改线后规则版本升到 v2', listPoints && true)
const r5 = readingsOf('IRRA-0005')
check('0005 既有读数照新线重过后全部有效', r5.every((x) => x.verdict === '有效') && r5.every((x) => x.ruleVersion === 2))
p6 = listPoints({ page: 1, size: 20 }).items.find((r) => r.code === 'IRRA-0006')!
check('0006 辐照 -120 仍判废（新线没放宽辐照）', p6.status === '数据异常')

// 13. 补录读数：坏值自动转异常并开台账
const good = listPoints({ page: 1, size: 20 }).items.find((r) => r.code === 'IRRA-0001')!
const badNew = addReading(good.id, specA, { irradiation: 5000, peak: 9999, moduleTemp: 40, ambientTemp: 25 })
check('峰值越线读数判废并转异常', badNew.ok && badNew.message.includes('判废'), badNew.message)
const p1 = listPoints({ page: 1, size: 20 }).items.find((r) => r.code === 'IRRA-0001')!
check('0001 已转数据异常且当日辐照量不取坏值', p1.status === '数据异常' && p1.daily === 6850, `status=${p1.status} daily=${p1.daily}`)
check('转异常后台账数与监测侧仍一致', consistency().matched)

// 14. 筛选/排序/翻页
const asc = listPoints({ area: '东区', sort: 'irradianceAsc', page: 1, size: 2 })
check('片区筛选只出东区', asc.items.every((r) => r.area === '东区'))
const dailies = listPoints({ sort: 'irradianceAsc', page: 1, size: 20 }).items.map((r) => r.daily)
const sortedOk = dailies.every((v, i) => i === 0 || (dailies[i - 1] === null ? false : (v === null || (dailies[i - 1] as number) <= (v as number))))
check('辐照量升序排序且空值沉底', sortedOk, JSON.stringify(dailies))
check('分页总数正确', asc.total === 3 && asc.items.length === 2, `total=${asc.total}`)

// 15. 直达与逐格诊断
const loc = locatePoint('IRRA-0006')
check('编号直达成功并给出页码', loc.found && Boolean(loc.query), loc.message)
const miss = locatePoint('IRRA-9999')
check('找不到时写明哪格对不上', !miss.found && miss.message.includes('监测点编号'), miss.message)
const diag = diagnosePoint({ code: 'IRRA-0006', area: '西区' })
check('组合查找逐格诊断点出片区对不上', diag.includes('片区') && diag.includes('南区'), diag)
const diag2 = diagnosePoint({ model: 'FS-T300', area: '东区' })
check('型号在但片区对不上也能逐格点出', diag2.includes('片区'), diag2)

// 16. 监测点按安装时间补齐（迁移路径另测）
const ordered = listPoints({ sort: 'installed', page: 1, size: 20 }).items.map((r) => r.installedAt)
const installedOk = ordered.every((v, i) => i === 0 || ordered[i - 1] <= v)
check('按安装时间有序', installedOk, JSON.stringify(ordered))

// 17. 统计对账最终一致
const s = stats()
check('统计：异常点数=' + s.abnormal + ' 待校准=' + s.pendingCalibration, consistency().matched, JSON.stringify(s))

console.log(`\n共通过 ${passed} 项断言`)
