import type { Role, RoleKey } from './types'

export const ROLES: Role[] = [
  { key: 'admin', name: '系统管理员', title: '管理员（可改判废线，不直接执行校准）' },
  { key: 'dispatcher', name: '值班调度员', title: '可登记异常、安排校准、确认告警恢复' },
  { key: 'specialistA', name: '王建国', title: '设备专责·王建国（东区/南区）' },
  { key: 'specialistB', name: '李卫国', title: '设备专责·李卫国（西区/北区）' },
  { key: 'viewer', name: '外协访客', title: '只读访客' },
]

export const ROLE_BY_KEY: Map<RoleKey, Role> = new Map(ROLES.map((role) => [role.key, role]))

export function canManageCalibration(role: Role): boolean {
  // 管理员改线、访客旁观，都不碰校准；只有调度派单、专责执行
  return role.key === 'dispatcher' || role.key === 'specialistA' || role.key === 'specialistB'
}

export function canEditRules(role: Role): boolean {
  return role.key === 'admin'
}

/** 安装高度只认本监测点的设备专责：姓名与点位上登记的专责一致才放行 */
export function ownsPoint(role: Role, specialist: string): boolean {
  return (role.key === 'specialistA' || role.key === 'specialistB') && role.name === specialist
}
