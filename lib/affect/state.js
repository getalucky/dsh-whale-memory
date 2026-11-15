/**
 * state.js —— 情绪状态的磁盘层与数学
 *
 * 文档 14.3：两层共用一个公式，读时算，不跑定时器。
 *
 *   decay:   v(t) = b + (v0 - b) * 2^(-Δt/τ)
 *   impulse: v'   = clamp(v + k * (1 - v), 0, cap)
 *
 * 惰性求值：只在读时按 now 折算，纯衰减不写盘；有事件才写。
 * 所有函数收 now，单测不依赖真实时间。
 */

import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { writeAtomic } from '../store.js'
import {
  EMOTIONS, EMOTION_NAMES, DEFAULT_TAU_HOURS, DEFAULT_CAP,
  STANCE_BASE, STANCE_FLOOR, STANCE_TAU_DAYS,
} from './lexicon.js'

export const VERSION = 1
const HOUR = 3600 * 1000
const DAY = 24 * HOUR

/** 情绪文件都落在 <root>/affect/ 下，不进 scopes（14.9）。 */
export function affectPaths(root) {
  const dir = join(root, 'affect')
  return { dir, state: join(dir, 'state.json'), events: join(dir, 'events.jsonl'), paint: join(dir, 'paint.jsonl') }
}

export function emptyState() {
  return { version: VERSION, mood: {}, stance: {} }
}

export async function loadState(root) {
  try {
    const raw = JSON.parse(await readFile(affectPaths(root).state, 'utf8'))
    return normalize(raw)
  } catch {
    return emptyState()
  }
}

/** 读旧文件时补字段，别让缺一项就整份丢掉。 */
function normalize(raw) {
  const out = emptyState()
  if (!raw || typeof raw !== 'object') return out
  const mood = raw.mood && typeof raw.mood === 'object' ? raw.mood : {}
  for (const name of EMOTION_NAMES) {
    const e = mood[name]
    if (!e) continue
    const v = Number(e.v)
    if (!Number.isFinite(v)) continue
    out.mood[name] = {
      v: clamp(v, 0, 1),
      at: Number.isFinite(Number(e.at)) ? Number(e.at) : 0,
      n: Number.isFinite(Number(e.n)) ? Number(e.n) : 0,
    }
  }
  const stance = raw.stance && typeof raw.stance === 'object' ? raw.stance : {}
  for (const [peer, s] of Object.entries(stance)) {
    if (!s || typeof s !== 'object') continue
    out.stance[peer] = {
      close: clamp(num(s.close, STANCE_BASE.close), 0, 1),
      trust: clamp(num(s.trust, STANCE_BASE.trust), 0, 1),
      patience: clamp(num(s.patience, STANCE_BASE.patience), 0, 1),
      at: Number.isFinite(Number(s.at)) ? Number(s.at) : 0,
    }
  }
  if (raw.updated) out.updated = String(raw.updated)
  return out
}

export async function saveState(root, state) {
  const { dir, state: file } = affectPaths(root)
  await mkdir(dir, { recursive: true })
  const body = { ...state, version: VERSION, updated: new Date().toISOString() }
  await writeAtomic(file, JSON.stringify(body, null, 2))
  return body
}

export function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v))
}

function num(x, fallback) {
  const n = Number(x)
  return Number.isFinite(n) ? n : fallback
}

/** 单条分量的当前值：从上次更新时刻按半衰期折算到 now。 */
export function valueAt(entry, now, { tauHours = DEFAULT_TAU_HOURS, base = 0 } = {}) {
  if (!entry) return base
  // at=0 是合法值（单测用），别用 || 把它当"没有"
  const raw = Number(entry.at)
  const at = Number.isFinite(raw) ? raw : now
  const dt = Math.max(0, now - at)
  const decayed = base + (Number(entry.v) - base) * Math.pow(2, -dt / (tauHours * HOUR))
  return clamp(decayed, 0, 1)
}

/** 冲量：越接近上限加得越少，永远不越 cap。 */
export function impulse(v, k, cap = DEFAULT_CAP) {
  const next = Number(v) + Number(k) * (1 - Number(v))
  return clamp(next, 0, Math.min(1, cap))
}

/** 整份快照：数值 + 每个 peer 的 stance，全部按 now 折算。 */
export function snapshot(state, now) {
  const mood = {}
  for (const name of EMOTION_NAMES) {
    mood[name] = valueAt(state.mood?.[name], now, { base: EMOTIONS[name].base })
  }
  const stance = {}
  for (const [peer, s] of Object.entries(state.stance || {})) {
    stance[peer] = {
      close: stanceValue(s.close, s.at, now, 'close'),
      trust: stanceValue(s.trust, s.at, now, 'trust'),
      patience: stanceValue(s.patience, s.at, now, 'patience'),
      at: s.at,
    }
  }
  return { mood, stance }
}

function stanceValue(v, at, now, axis) {
  const base = STANCE_BASE[axis]
  const raw = Number(at)
  const dt = Math.max(0, now - (Number.isFinite(raw) ? raw : now))
  const decayed = base + (num(v, base) - base) * Math.pow(2, -dt / (STANCE_TAU_DAYS[axis] * DAY))
  return clamp(decayed, STANCE_FLOOR[axis], 1)
}

/**
 * 记一次情绪事件。同 kind 60 秒内只计一次（防抖），
 * 10 分钟内重复累到第 3 次起 k×0.4（习惯化，14.3）。
 * @returns {{changed:boolean, value:number}}
 */
export function applyMood(state, kind, intensity, now) {
  const meta = EMOTIONS[kind]
  if (!meta) return { changed: false, value: 0 }
  const prev = state.mood[kind]
  const cur = valueAt(prev, now, { base: meta.base })
  const since = prev ? now - (Number(prev.at) || 0) : Infinity
  if (since < 60 * 1000) {
    // 同一句话里命中两条同义规则，不该加两次
    state.mood[kind] = { ...prev, v: cur, at: now }
    return { changed: false, value: cur }
  }
  const n = since < 10 * 60 * 1000 ? (Number(prev?.n) || 1) + 1 : 1
  const k = Number(intensity) * (n >= 3 ? 0.4 : 1)
  const next = impulse(cur, k, meta.cap ?? DEFAULT_CAP)
  state.mood[kind] = { v: next, at: now, n }
  return { changed: next !== cur, value: next }
}

/** 慢层：一次事件只动 ±0.05 量级，靠地板上锁（14.3）。 */
export function applyStance(state, peer, delta, now) {
  if (!peer) return
  const s = state.stance[peer] || { ...STANCE_BASE, at: 0 }
  const cur = snapshot({ stance: { [peer]: s } }, now).stance[peer]
  const next = {
    close: clamp(cur.close + num(delta?.close, 0), STANCE_FLOOR.close, 1),
    trust: clamp(cur.trust + num(delta?.trust, 0), STANCE_FLOOR.trust, 1),
    patience: clamp(cur.patience + num(delta?.patience, 0), STANCE_FLOOR.patience, 1),
    at: now,
  }
  state.stance[peer] = next
}

/** 读某个人的 stance（没聊过就是基线）。 */
export function stanceOf(snap, peer) {
  if (!peer) return { ...STANCE_BASE, at: 0 }
  return snap.stance[peer] || { ...STANCE_BASE, at: 0 }
}
