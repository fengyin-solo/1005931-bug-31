import { beforeEach, describe, expect, it } from 'vitest'

import {
  locatePoint,
  queryIrradiance,
  recoverPoint,
  registerAbnormal,
  scheduleCalibration,
  PAGE_SIZE,
} from './irradiance-service'
import { isLedger, isLedgerOpen, ledgerPoint } from '@/data/ledger'
import { listRows, __resetStoreForTest } from '@/data/local-store'
import type { Actor } from '@/data/irradiance-domain'

const admin: Actor = { role: 'admin', name: '值班管理员', owns: () => false }
const viewer: Actor = { role: 'viewer', name: '只读访客', owns: () => false }

function idOf(code: string): number {
  const point = listRows('irradiance').find((row) => String(row['监测点编号']) === code)
  if (!point) throw new Error(`missing ${code}`)
  return point.id
}

beforeEach(() => {
  __resetStoreForTest()
})

describe('列表查询', () => {
  it('按片区筛选 + 按当日辐照量排序（坏值沉底）', () => {
    const result = queryIrradiance({
      filters: { zone: '东区B方阵' },
      sortKey: '当日辐照量',
      sortOrder: 'asc',
    })
    expect(result.views.map((row) => row.code)).toEqual(
      expect.arrayContaining(['IRRA-0003', 'IRRA-0004']),
    )
    expect(result.views.every((row) => row.zone === '东区B方阵')).toBe(true)
    // 两个点最新读数都是坏值，有效辐照量为 null，统一沉底。
    expect(result.views.every((row) => row.daily === null)).toBe(true)
  })

  it('全量按辐照量升序：有效值在前、坏值在后', () => {
    const result = queryIrradiance({
      sortKey: '当日辐照量',
      sortOrder: 'asc',
      size: 50,
    })
    const dailies = result.views.map((row) => row.daily)
    const valid = dailies.filter((value): value is number => value !== null)
    const nulls = dailies.slice(valid.length)
    expect([...valid].sort((a, b) => a - b)).toEqual(valid)
    expect(nulls.every((value) => value === null)).toBe(true)
  })

  it('翻页不丢条件', () => {
    const first = queryIrradiance({
      filters: { status: '监测中' },
      sortKey: '当日辐照量',
      sortOrder: 'desc',
      page: 1,
    })
    expect(first.page).toBe(1)
    const second = queryIrradiance({
      filters: { status: '监测中' },
      sortKey: '当日辐照量',
      sortOrder: 'desc',
      page: 2,
    })
    expect(second.views.every((row) => row.status === '监测中')).toBe(true)
    expect(first.total).toBe(second.total)
  })
})

describe('点位定位', () => {
  it('按编号在当前排序下算出所在页', () => {
    const result = locatePoint('irra-0012', {
      sortKey: '安装时间',
      sortOrder: 'asc',
      size: PAGE_SIZE,
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.view.code).toBe('IRRA-0012')
      expect(result.page).toBeGreaterThanOrEqual(1)
    }
  })

  it('编号不存在时写明是编号格对不上', () => {
    const result = locatePoint('IRRA-9999', {})
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain('监测点编号格对不上')
  })

  it('点位被片区条件筛掉时写明是片区格对不上', () => {
    const result = locatePoint('IRRA-0001', { filters: { zone: '南区F方阵' } })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.message).toContain('所属片区')
      expect(result.message).toContain('东区A方阵')
    }
  })
})

describe('整笔提交', () => {
  it('安排校准成功：点位与台账一次落库', () => {
    const id = idOf('IRRA-0002')
    const message = scheduleCalibration(id, admin)
    expect(message).toContain('待校准')
    const point = listRows('irradiance').find((row) => row.id === id)
    expect(point?.status).toBe('待校准')
    expect(point?.abnormal).toBe(false)
    const ledger = listRows('alarm').find(
      (row) => isLedger(row) && ledgerPoint(row) === 'IRRA-0002',
    )
    expect(ledger?.status).toBe('处理中')
  })

  it('越权拦截不落任何数据（整笔退回）', () => {
    const id = idOf('IRRA-0002')
    const beforePoints = JSON.stringify(listRows('irradiance'))
    const beforeAlarms = JSON.stringify(listRows('alarm'))
    expect(() => scheduleCalibration(id, viewer)).toThrow(/越权拦截/)
    expect(JSON.stringify(listRows('irradiance'))).toBe(beforePoints)
    expect(JSON.stringify(listRows('alarm'))).toBe(beforeAlarms)
  })

  it('连点两次只认头一回：只有一条台账', () => {
    const id = idOf('IRRA-0002')
    scheduleCalibration(id, admin)
    const second = scheduleCalibration(id, admin)
    expect(second).toContain('重复点击只认头一回')
    const ledgers = listRows('alarm').filter(
      (row) => isLedger(row) && ledgerPoint(row) === 'IRRA-0002',
    )
    expect(ledgers).toHaveLength(1)
  })

  it('待校准点位登记异常被拦，台账不增', () => {
    const id = idOf('IRRA-0003')
    const before = listRows('alarm').length
    expect(() => registerAbnormal(id, admin)).toThrow(/已在待校准/)
    expect(listRows('alarm').length).toBe(before)
  })

  it('确认恢复后点位回监测中、台账闭环、两处异常点口径一致', () => {
    const id = idOf('IRRA-0003')
    recoverPoint(
      id,
      admin,
      { daily: 5480, peak: 960, moduleTemp: 45, ambientTemp: 30 },
      '标准表比对合格',
    )
    const point = listRows('irradiance').find((row) => row.id === id)
    expect(point?.status).toBe('监测中')
    expect(point?.abnormal).toBe(false)
    const ledger = listRows('alarm').find(
      (row) => isLedger(row) && ledgerPoint(row) === 'IRRA-0003',
    )
    expect(ledger?.status).toBe('已闭环')
    expect(ledger).toBeDefined()
    expect(isLedgerOpen(ledger!)).toBe(false)

    const openAbnormal = listRows('irradiance').filter(
      (row) => row.status === '数据异常' || row.status === '待校准',
    ).length
    const openLedgers = listRows('alarm').filter((row) => isLedger(row) && isLedgerOpen(row)).length
    expect(openLedgers).toBe(openAbnormal)
  })
})
