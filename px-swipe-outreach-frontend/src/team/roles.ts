import type { Role } from '../api'

export const ROLE_LABEL: Record<Role, string> = { owner: 'Owner', admin: 'Admin', staff: 'Staff' }
export const ROLE_HELP: Record<Role, string> = {
  owner: 'Full access, including billing and owners',
  admin: 'Manage the team and store settings',
  staff: 'Work the outreach queue',
}
export const canManageTeam = (me: Role | null) => me === 'owner' || me === 'admin'
/** Roles `me` may hand out. Only owners grant owner. */
export const grantableRoles = (me: Role | null): Role[] => (me === 'owner' ? ['staff', 'admin', 'owner'] : me === 'admin' ? ['staff', 'admin'] : [])
/** Can `me` change/remove someone who is `target`? Only owners touch owners. */
export const canModify = (me: Role | null, target: Role) => me === 'owner' || (me === 'admin' && target !== 'owner')

export function relativeExpiry(iso: string, now = Date.now()): string {
  const ms = new Date(iso).getTime() - now
  if (ms <= 0) return 'Expired'
  const h = Math.round(ms / 3_600_000)
  if (h < 1) return 'Expires in under an hour'
  if (h < 48) return `Expires in ${h} hour${h === 1 ? '' : 's'}`
  return `Expires in ${Math.round(h / 24)} days`
}
