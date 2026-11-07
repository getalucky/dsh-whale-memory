/**
 * beat/env.js —— 忙闲 / 在场信号
 *
 * 文档 13.9：忙、token-saver、锁屏都用本地信号，不调模型。
 * Windows 走一个只输出「键鼠闲置秒数」的小探针（不读窗口标题、不读内容）；
 * 探针不可用时退回「最后一条真实用户消息」的时间。
 */

import { execFile } from 'node:child_process'
import { readFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PROBE = fileURLToPath(new URL('../../assets/beat/idle.ps1', import.meta.url))
const CACHE_MS = 60 * 1000

let cache = { at: 0, value: null }

export function resetIdleCache() {
  cache = { at: 0, value: null }
}

function run(cmd, args) {
  return new Promise((resolve) => {
    const child = execFile(cmd, args, {
      windowsHide: true,
      timeout: 2500,
      maxBuffer: 64 * 1024,
    }, (error, stdout) => resolve({ error, stdout: String(stdout ?? '') }))
    child.on?.('error', () => resolve({ error: new Error('spawn-failed'), stdout: '' }))
  })
}

/** @returns {Promise<number|null>} 键鼠闲置秒数；探针不可用返回 null */
export async function probeIdleSeconds({ now = Date.now(), force = false } = {}) {
  if (process.platform !== 'win32') return null
  if (!force && now - cache.at < CACHE_MS) return cache.value
  const out = join(tmpdir(), `whale-idle-${process.pid}-${Math.random().toString(36).slice(2, 8)}.txt`)
  try {
    const r = await run('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', PROBE, '-out', out,
    ])
    if (r.error) {
      cache = { at: now, value: null }
      return null
    }
    const raw = await readFile(out, 'utf8')
    const n = Number(String(raw).trim())
    const value = Number.isFinite(n) && n >= 0 ? n : null
    cache = { at: now, value }
    return value
  } catch {
    cache = { at: now, value: null }
    return null
  } finally {
    await unlink(out).catch(() => {})
  }
}

function powerMonitor(ctx) {
  try {
    return ctx?.get?.('powerMonitor') || null
  } catch {
    return null
  }
}

/**
 * @returns {Promise<{busy:boolean,idleMinutes:number,locked:boolean,away:boolean,source:string}>}
 */
export async function senseEnv({ ctx, state = {}, config = {}, now = new Date() } = {}) {
  const pm = powerMonitor(ctx)
  let locked = false
  let idleSec = null
  if (pm) {
    try {
      if (typeof pm.isLocked === 'function') locked = Boolean(pm.isLocked())
      if (typeof pm.getSystemIdleTime === 'function') {
        const n = Number(pm.getSystemIdleTime())
        if (Number.isFinite(n) && n >= 0) idleSec = n
      }
    } catch { /* 宿主没有这个服务就退回探针 */ }
  }
  if (idleSec == null) idleSec = await probeIdleSeconds({ now: now.getTime() })

  const lastUserAt = Date.parse(state.lastUserAt || '')
  let idleMinutes
  let source
  if (idleSec != null) {
    idleMinutes = idleSec / 60
    source = 'idle-probe'
  } else if (Number.isFinite(lastUserAt)) {
    idleMinutes = Math.max(0, (now.getTime() - lastUserAt) / 60000)
    source = 'last-message'
  } else {
    // 刚装好、还没有任何消息：不凭 0 分钟判「在忙」
    return { busy: false, idleMinutes: 0, locked, away: false, source: 'unknown' }
  }

  // busyMinutes=0 是合法配置（不把“刚说过话”当忙），别被 `|| 10` 吃掉。
  const rawBusy = config.busyMinutes
  const busyMinutes = rawBusy === undefined || rawBusy === null || rawBusy === ''
    ? 10
    : Math.max(0, Number(rawBusy) || 0)
  const rawAway = config.tokenSaverIdleMinutes
  const awayMinutes = rawAway === undefined || rawAway === null || rawAway === ''
    ? 30
    : Math.max(1, Number(rawAway) || 30)
  const busy = !locked && idleMinutes < busyMinutes
  const away = !locked && idleMinutes >= awayMinutes
  return {
    busy,
    idleMinutes: Math.round(idleMinutes * 10) / 10,
    locked,
    away,
    source,
  }
}
