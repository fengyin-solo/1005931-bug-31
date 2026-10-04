import { defineStore } from 'pinia'

import { ROLES } from '@/data/irradiance/roles'
import type { Role, RoleKey } from '@/data/irradiance/types'

export const useSessionStore = defineStore('session', {
  state: () => ({
    operator: '值班调度员',
    roleKey: 'dispatcher' as RoleKey,
    shiftLabel: '白班 08:00-20:00',
    scope: '光伏电站运行维护管理平台',
  }),
  getters: {
    canOperate: (state) => state.operator.length > 0,
    role(state): Role {
      return ROLES.find((item) => item.key === state.roleKey) ?? ROLES[0]
    },
  },
  actions: {
    setShift(label: string) {
      this.shiftLabel = label
    },
    setRole(roleKey: RoleKey) {
      const role = ROLES.find((item) => item.key === roleKey)
      if (!role) return
      this.roleKey = roleKey
      this.operator = role.name
    },
  },
})
