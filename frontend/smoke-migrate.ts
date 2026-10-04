/* 老通用台账 → 领域库 迁移冒烟 */
const mem = new Map<string, string>()
const store: Record<string, string> = {}
;(globalThis as any).window = {
  localStorage: {
    getItem: (k: string) => (k in store ? store[k] : null),
    setItem: (k: string, v: string) => { store[k] = String(v); mem.set(k, String(v)) },
    removeItem: (k: string) => { delete store[k]; mem.delete(k) },
  },
}
;(globalThis as any).localStorage = (globalThis as any).window.localStorage

// 先种一份“老版本”通用台账（三条辐照记录，其中一条数据异常、一条待校准、字段全是占位串）
const legacy = {
  irradiance: [
    { id: 1, status: '监测中', pending: true, abnormal: false,
      '监测点编号': 'IRRA-OLD-01', '设备型号': 'FS-900', '安装高度': '1.9', '当日辐照量': '5200',
      '峰值辐照': '1200', '组件温度': '44', '环境温度': '28', '监测状态': '监测中' },
    { id: 2, status: '数据异常', pending: true, abnormal: true,
      '监测点编号': 'IRRA-OLD-02', '设备型号': 'FS-900', '安装高度': '2.0', '当日辐照量': '-50',
      '峰值辐照': '1300', '组件温度': '46', '环境温度': '29', '监测状态': '数据异常' },
    { id: 3, status: '待校准', pending: false, abnormal: false,
      '监测点编号': 'IRRA-OLD-03', '设备型号': 'FS-800', '安装高度': '2.2', '当日辐照量': 'abc',
      '峰值辐照': '1100', '组件温度': '40', '环境温度': '25', '监测状态': '待校准' },
  ],
}
store['pv-plant-ops:entries'] = JSON.stringify(legacy)

const { loadDB } = await import('./src/data/irradiance/storage')
const { listPoints, consistency, pendingLedger, listTasks } = await import('./src/data/irradiance/service')

let passed = 0
function check(name: string, cond: boolean, extra = '') {
  if (!cond) { console.error(`✗ ${name} ${extra}`); process.exitCode = 1 }
  else { passed++; console.log(`✓ ${name} ${extra}`) }
}

const db = loadDB()
check('三条老记录都迁进来了', db.points.length === 3, String(db.points.length))
const rows = listPoints({ page: 1, size: 20 }).items
const p1 = rows.find((r) => r.code === 'IRRA-OLD-01')!
const p2 = rows.find((r) => r.code === 'IRRA-OLD-02')!
const p3 = rows.find((r) => r.code === 'IRRA-OLD-03')!
check('状态按老记录保留', p1.status === '监测中' && p2.status === '数据异常' && p3.status === '待校准')
check('安装高度从字符串迁移成数值', p1.height === 1.9 && p3.height === 2.2)
check('安装时间已按顺序补齐（月递增）', p1.installedAt < p2.installedAt && p2.installedAt < p3.installedAt, `${p1.installedAt} ${p2.installedAt} ${p3.installedAt}`)
check('老读数照规则判：-50 辐照判废，非数字辐照按缺测判废', p2.daily === null && p3.daily === null, `p2=${p2.daily} p3=${p3.daily}`)
check('数据异常/待校准点位都开了待处置告警', pendingLedger().length === 2, String(pendingLedger().length))
check('待校准点位迁来一张待校准工单', listTasks().filter((t) => t.status === '待校准').length === 1)
check('迁移后两处异常计数对得上', consistency().matched, JSON.stringify(consistency()))
check('老台账已标记摘走（dropped 集合含 irradiance）', JSON.parse(store['pv-plant-ops:entries-dropped']).includes('irradiance'))
check('通用台账里 irradiance 已删除', !('irradiance' in JSON.parse(store['pv-plant-ops:entries'])))

// 领域库已落 localStorage，检查持久化内容而不是内存缓存
check('领域库已持久化且只含迁移的 3 条', JSON.parse(store['pv-plant-ops:irradiance:v1']).points.length === 3)

console.log(`\n迁移用例通过 ${passed} 项`)
