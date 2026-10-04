import { defineStore } from 'pinia'

export type RoleKey = 'admin' | 'dispatcher' | 'specialist' | 'viewer'

export type RoleOption = {
  key: RoleKey
  name: string
  /** 可执行的辐照监测动作；空数组表示只有查看权 */
  actions: string[]
  /** 可修改安装高度的角色 */
  canEditHeight: boolean
}

export const ROLE_OPTIONS: RoleOption[] = [
  { key: 'admin', name: '值班管理员', actions: ['登记异常', '安排校准', '确认恢复'], canEditHeight: false },
  { key: 'dispatcher', name: '调度员', actions: ['安排校准', '确认恢复'], canEditHeight: false },
  { key: 'specialist', name: '设备专责', actions: ['登记异常', '安排校准', '确认恢复'], canEditHeight: true },
  { key: 'viewer', name: '只读访客', actions: [], canEditHeight: false },
]

export const ROLE_BY_KEY: Map<RoleKey, RoleOption> = new Map(ROLE_OPTIONS.map((item) => [item.key, item]))

export const useSessionStore = defineStore('session', {
  state: () => ({
    operator: '值班管理员',
    role: 'admin' as RoleKey,
    /** 设备专责名下的监测点编号；只有本监测点的设备专责能改安装高度 */
    responsibility: ['IRRA-0001', 'IRRA-0002', 'IRRA-0004'] as string[],
    shiftLabel: '白班 08:00-20:00',
    scope: '光伏电站运行维护管理平台',
  }),
  getters: {
    canOperate: (state) => state.operator.length > 0,
    roleOption(state): RoleOption {
      return ROLE_BY_KEY.get(state.role) ?? ROLE_OPTIONS[0]
    },
  },
  actions: {
    setShift(label: string) {
      this.shiftLabel = label
    },
    setRole(role: RoleKey) {
      this.role = role
      const option = ROLE_BY_KEY.get(role)
      if (option) {
        this.operator = option.name
      }
    },
    /** 当前角色是否有权执行某动作（越权拦截） */
    canRunAction(action: string): boolean {
      return this.roleOption.actions.includes(action)
    },
    /** 是否为指定监测点的设备专责（越级拦截 + 安装高度修改） */
    ownsPoint(pointCode: string): boolean {
      return this.role === 'specialist' && this.responsibility.includes(pointCode)
    },
  },
})
