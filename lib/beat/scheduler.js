/**
 * beat/scheduler.js —— 谁在调度
 *
 * 文档 13.1：beat 与 dsh-heartbeat 不并存。heartbeat 2.1 没有暴露服务，
 * 这里按桌面 profile 的 bundle 清单判断它是否被挂载；比猜进程名可靠。
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export function dshHome() {
  return String(process.env.DSH_HOME || join(homedir(), '.dsh')).replace(/\\/g, '/').replace(/\/+$/, '')
}

export function heartbeatMounted() {
  const file = join(dshHome(), 'profiles', 'desktop', 'package.json')
  try {
    const pkg = JSON.parse(readFileSync(file, 'utf8'))
    const bundles = pkg?.dsh?.profile?.bundles
    return Array.isArray(bundles) && bundles.includes('dsh-heartbeat')
  } catch {
    return false
  }
}

/**
 * @returns {{envOff:boolean, heartbeat:boolean, enabled:boolean, active:'beat'|'heartbeat'|'off', reason:string}}
 */
export function schedulerState({ config = {} } = {}) {
  const envOff = String(process.env.DSH_MEMORY_BEAT || '').toLowerCase() === 'off'
  const heartbeat = heartbeatMounted()
  const enabled = config.enabled === true
  const active = envOff ? 'off' : heartbeat ? 'heartbeat' : (enabled ? 'beat' : 'off')
  const reason = envOff ? 'env-off' : heartbeat ? 'heartbeat-mounted' : (enabled ? '' : 'disabled')
  return { envOff, heartbeat, enabled, active, reason }
}
