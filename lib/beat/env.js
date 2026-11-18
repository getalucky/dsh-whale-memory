/**
 * beat/env.js —— 在场信号
 *
 * 只看全局会话：宿主里任一会话最近有动静就算「在用 DSH」，全都静了
 * 达到 idleMinutes 就算离开。不监听键鼠。
 *
 * 绑定会话本身的活动要拆开看：主动投递会往目标会话里写消息，缓存 mtime
 * 会被自己写热，导致「离开」永远触发不了。所以目标会话的宿主/缓存时间
 * 一律不参与在场判断，只认它里面的真实用户消息（state.lastUserAt）。
 */

import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import { idleMinutesOf } from './config.js'
import { loadSessions } from './session.js'

// 宿主版本不同，活动时间可能挂在会话对象、session 子对象或 metadata 上。
const ACTIVITY_FIELDS = [
  'updatedAt', 'lastActiveAt', 'lastActivityAt', 'lastPromptAt', 'lastMessageAt', 'lastUsedAt',
]

function toMs(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    // 有的宿主给 epoch 秒，有的给毫秒；秒级时间戳小于 1e12。
    return value < 1e12 ? value * 1000 : value
  }
  const n = Date.parse(String(value ?? ''))
  return Number.isFinite(n) && n > 0 ? n : NaN
}

function latestTime(obj) {
  if (!obj || typeof obj !== 'object') return NaN
  const sources = [obj, obj.session, obj.meta, obj.metadata, obj._meta, obj.session?.metadata]
  let max = NaN
  for (const src of sources) {
    if (!src || typeof src !== 'object') continue
    for (const key of ACTIVITY_FIELDS) {
      const t = toMs(src[key])
      if (Number.isFinite(t)) max = Number.isFinite(max) ? Math.max(max, t) : t
    }
  }
  return max
}

function sessionKey(id) {
  return String(id ?? '').trim().replace(/^session-/, '')
}

function sameSession(a, b) {
  const x = sessionKey(a)
  return Boolean(x) && x === sessionKey(b)
}

function listOf(value) {
  if (Array.isArray(value)) return value
  if (Array.isArray(value?.sessions)) return value.sessions
  return null
}

function service(ctx, name) {
  try {
    const viaGet = ctx?.get?.(name)
    if (viaGet) return viaGet
  } catch { /* 服务还没注入 */ }
  try { return ctx?.[name] || null } catch { return null }
}

function dshHome(root) {
  if (process.env.DSH_HOME) return String(process.env.DSH_HOME)
  if (root) return dirname(resolve(root))
  return join(homedir(), '.dsh')
}

async function hostSessions(ctx) {
  const svc = service(ctx, 'sessions')
  if (!svc || typeof svc.list !== 'function') return null
  try { return listOf(await svc.list()) } catch { return null }
}

async function hostAgents(ctx) {
  const svc = service(ctx, 'agents')
  if (!svc || typeof svc.list !== 'function') return null
  try { return listOf(await svc.list()) } catch { return null }
}

/** 会话缓存的 mtime 是最后一次落盘时间，也就是最后一次活动。 */
async function cacheLatest(home, skip) {
  const dir = join(home, 'storages', 'session_projcache', 'sessions')
  let names
  try { names = await readdir(dir) } catch { return null }
  let latest = NaN
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    if (skip(name.slice(0, -5))) continue
    try {
      const st = await stat(join(dir, name))
      if (!st.isFile()) continue
      if (!Number.isFinite(latest) || st.mtimeMs > latest) latest = st.mtimeMs
    } catch { /* 单个文件读不到不影响其他会话 */ }
  }
  return Number.isFinite(latest) ? latest : null
}

/** @returns {Promise<{known:boolean, at:number, source:string}>} */
async function globalActivity({ ctx, root, state, config }) {
  if (!ctx) return { known: false, at: NaN, source: 'unknown' }
  const target = String(config.targetSessionId || '').trim()
  const beat = await loadSessions(root).catch(() => null)
  // 专用闲逛会话和投递目标都不算「用户在场」：前者是 beat 自己，后者会被投递写热。
  const skip = (id) => sameSession(beat?.sessionId, id) || (Boolean(target) && sameSession(target, id))

  let known = false
  let count = 0
  let latest = NaN
  let fromHost = false
  const absorb = (item) => {
    const t = latestTime(item)
    if (!Number.isFinite(t)) return
    latest = Number.isFinite(latest) ? Math.max(latest, t) : t
    fromHost = true
  }

  const sessions = await hostSessions(ctx)
  if (sessions) {
    known = true
    for (const s of sessions) {
      const id = s?.sessionId ?? s?.id ?? s?.session?.id
      if (skip(id)) continue
      count += 1
      absorb(s)
    }
  }
  const agents = await hostAgents(ctx)
  if (agents) {
    known = true
    for (const a of agents) {
      const id = a?.session?.id ?? a?.sessionId ?? a?.id
      if (skip(id)) continue
      count += 1
      absorb(a)
    }
  }

  // 宿主接口给的时间可能比缓存旧一点，两边取最大值。
  let fromCache = false
  const cached = await cacheLatest(dshHome(root), skip)
  if (cached != null) {
    latest = Number.isFinite(latest) ? Math.max(latest, cached) : cached
    known = true
    fromCache = true
  }

  // 目标会话只认真实用户消息：投递写进去的缓存/更新时间一律不参与。
  let fromUser = false
  const lastUser = toMs(state?.lastUserAt)
  if (Number.isFinite(lastUser)) {
    latest = Number.isFinite(latest) ? Math.max(latest, lastUser) : lastUser
    fromUser = true
    known = true
  }

  if (!known) return { known: false, at: NaN, source: 'unknown' }
  if (!Number.isFinite(latest) && count > 0) {
    // 确实有会话，但宿主和缓存都给不出时间：宁可不知道，也别当成「没人用」。
    return { known: false, at: NaN, source: 'unknown' }
  }
  return {
    known: true,
    at: latest,
    source: fromHost ? 'sessions' : fromCache ? 'session-cache' : fromUser ? 'user-messages' : 'sessions',
  }
}

function isLocked(ctx) {
  try {
    const pm = service(ctx, 'powerMonitor')
    return Boolean(pm && typeof pm.isLocked === 'function' && pm.isLocked())
  } catch {
    return false
  }
}

/**
 * @returns {Promise<{idleMinutes:number|null,locked:boolean,away:boolean,source:string,presenceKnown:boolean}>}
 */
export async function senseEnv({ ctx, root, state = {}, config = {}, now = new Date() } = {}) {
  const locked = isLocked(ctx)
  const limit = idleMinutesOf(config)
  const act = await globalActivity({ ctx, root, state, config })
  if (!act.known) {
    return {
      idleMinutes: null,
      locked,
      away: locked,
      source: 'unknown',
      presenceKnown: false,
    }
  }

  // 一个会话有活动都算在场；没有任何可读活动才按「一直没人用」算。
  const idleMinutes = Number.isFinite(act.at)
    ? Math.max(0, (now.getTime() - act.at) / 60000)
    : Infinity
  return {
    idleMinutes: Number.isFinite(idleMinutes) ? Math.round(idleMinutes * 10) / 10 : null,
    locked,
    away: locked || (limit > 0 && idleMinutes >= limit),
    source: act.source,
    presenceKnown: true,
  }
}
