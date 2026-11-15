/**
 * index.js —— 情绪层（文档第十四章）
 *
 * 边界（14.1）：不进 scopes、不建索引、不参与检索/画像/人格蒸馏。
 * 只做三件事：收到消息算一次情绪、按 now 惰性衰减、需要时渲染成注入里的一行。
 *
 * 开关：DSH_MEMORY_AFFECT=off 或 config.affect.enabled=false 时整个模块空转，
 * 行为与没装这一层完全一致（14.12 的关机差分）。
 */

import { mkdir } from 'node:fs/promises'

import { appendJsonl } from '../store.js'
import {
  emptyState, loadState, saveState, snapshot, applyMood, applyStance,
  affectPaths, stanceOf,
} from './state.js'
import { readEvents, stanceDeltas } from './events.js'
import { renderLine, signature, bucketOf, stanceWord } from './render.js'
import { EMOTION_NAMES, EMOTIONS } from './lexicon.js'

export const AFFECT_SECTION = 'whale:affect'
export const AFFECT_ORDER = 8570

/** 冷却与上限（14.6 / 14.14 定：60 分钟、每会话 3 次、累计变化 ≥0.25）。 */
export const REWRITE = { minGapMs: 60 * 60 * 1000, maxPerSession: 3, minDelta: 0.25 }

let current = null

/** 单实例插件，图省事用模块级引用；测试里 install(null) 就能关掉。 */
export function installAffect(inst) {
  current = inst
  return inst
}

export function currentAffect() {
  return current
}

/** 12 个分量里变化最大的那一个：跨档门槛按它算，不看总和。 */
export function maxAbsDelta(a, b) {
  let max = 0
  for (const name of EMOTION_NAMES) {
    const d = Math.abs((Number(a?.[name]) || 0) - (Number(b?.[name]) || 0))
    if (d > max) max = d
  }
  return max
}

/**
 * 重画三关：跨档、冷却、次数（14.6 / 14.14）。纯函数，单测直接打这里。
 * 没过关就别更新签名——让变化继续累积，下一轮再来。
 */
export function paintDecision({ prev, snap, peer, now, sig }) {
  if (!prev) return { paint: true, count: 0, reason: 'first' }
  if (prev.sig === sig) return { paint: false, reason: 'same' }
  const delta = maxAbsDelta(prev.mood, snap.mood)
  if (delta < REWRITE.minDelta) return { paint: false, reason: 'delta' }
  if (now - prev.at < REWRITE.minGapMs) return { paint: false, reason: 'cooldown' }
  if (prev.count >= REWRITE.maxPerSession) return { paint: false, reason: 'budget' }
  return { paint: true, count: prev.count + 1, reason: 'ok' }
}

export function createAffect({ root, log, enabled = true } = {}) {  const on = enabled !== false && String(process.env.DSH_MEMORY_AFFECT ?? '').toLowerCase() !== 'off'
  const say = (m) => log?.(m)
  let state = emptyState()
  let loaded = false
  let loading = null
  const paints = new Map()   // sid -> { sig, text, at, count, mood }
  const lastPeer = new Map() // sid -> 这个会话最近一次是谁在说话（群里按人分 stance 要用）
  let timer = null
  let writing = Promise.resolve()
  let dirReady = null

  /** events.jsonl 是 append，目录得先有；只建一次。 */
  function ensureDir() {
    dirReady ||= mkdir(affectPaths(root).dir, { recursive: true }).catch(() => {})
    return dirReady
  }

  async function ready() {
    if (loaded) return state
    if (!loading) {
      loading = loadState(root).then((s) => {
        state = s
        loaded = true
        return state
      }).catch(() => {
        loaded = true
        return state
      })
    }
    return loading
  }

  function scheduleSave() {
    if (!on || timer) return
    timer = setTimeout(() => {
      timer = null
      flush()
    }, 800)
    // 别为了一个 800ms 的防抖把进程钉住
    if (typeof timer.unref === 'function') timer.unref()
  }

  /** 落盘（测试里显式调，正式路径靠 800ms 防抖）。 */
  function flush() {
    if (!on) return Promise.resolve()
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    const copy = JSON.parse(JSON.stringify(state))
    writing = writing.then(() => saveState(root, copy)).catch((e) => {
      say(`[whale] 情绪状态写盘失败 ${String(e?.message ?? e).slice(0, 120)}`)
    })
    return writing
  }

  /**
   * 一条真实用户消息 → 情绪事件。规则快路，同步生效（14.5）。
   * @param {{text:string, peer?:string, at?:number, hour?:number, source?:string}} m
   */
  async function noteUserMessage({ text, peer, at, hour, source, evidenceIds } = {}) {
    if (!on) return null
    await ready()
    const now = Number(at) || Date.now()
    const key = String(peer ?? '').trim()
    const prev = key ? state.stance[key] : null
    const gapMs = prev?.at ? now - prev.at : 0
    const h = Number.isFinite(Number(hour)) ? Number(hour) : new Date(now).getHours()

    // 先落 lastSeen：久别判定只用上一轮的时间，不能被这次覆盖
    if (key) {
      if (!state.stance[key]) state.stance[key] = { close: 0.55, trust: 0.6, patience: 0.7, at: now }
      applyStance(state, key, stanceDeltas(text, h), now)
    }
    // 注入段拿不到"现在是谁在说话"，靠这里记一笔；群里才不会把 A 的态度套到 B 身上
    if (source && key) {
      if (lastPeer.size > 500 && !lastPeer.has(String(source))) lastPeer.delete(lastPeer.keys().next().value)
      lastPeer.set(String(source), key)
    }

    const events = readEvents({ text, hour: h, gapMs })
    const ids = (Array.isArray(evidenceIds) ? evidenceIds : []).map(String).filter(Boolean).slice(-3)
    const applied = []
    for (const e of events) {
      const r = applyMood(state, e.kind, e.i, now)
      if (r.changed) applied.push({ ...e, v: Number(r.value.toFixed(3)), peer: key, ts: now, at: new Date(now).toISOString(), source: source || 'chat', ...(ids.length ? { evidenceIds: ids } : {}) })
    }
    if (applied.length) {
      await ensureDir()
      const file = affectPaths(root).events
      for (const e of applied) await appendJsonl(file, e).catch(() => {})
      scheduleSave()
    } else if (key) {
      // 只有 stance.at 动了，也要落盘，否则久别判定永远算不出来
      scheduleSave()
    }
    return applied.length ? applied : null
  }

  /** 蒸馏旁路回填：只认词表内的名字和 0~0.5 的强度（appraise.js 已经收过口）。 */
  async function noteAppraisal(list, { peer, at } = {}) {
    if (!on || !Array.isArray(list) || !list.length) return null
    await ready()
    const now = Number(at) || Date.now()
    const key = String(peer ?? '').trim()
    const applied = []
    for (const e of list) {
      const r = applyMood(state, e.kind, e.i, now)
      if (r.changed) applied.push({ ...e, v: Number(r.value.toFixed(3)), peer: key, ts: now, at: new Date(now).toISOString(), source: 'llm' })
    }
    if (applied.length) {
      await ensureDir()
      const file = affectPaths(root).events
      for (const e of applied) await appendJsonl(file, e).catch(() => {})
      scheduleSave()
    }
    return applied.length ? applied : null
  }

  /**
   * 注入用的一行。跨档 + 冷却 + 次数三关都过了才换文本（14.6）。
   * 没跨档就返回上一次的原文——签名不变，system prompt 的哈希也不变。
   */
  function lineFor(sid, peer) {
    if (!on) return ''
    const now = Date.now()
    const id = String(sid ?? '')
    // 优先用这个会话最近说话的人：群里 stance 是按人分的，用群号会串味
    const who = peer || lastPeer.get(id) || ''
    const snap = snapshot(state, now)
    const sig = signature(snap, who)
    const prev = paints.get(id)

    const dec = paintDecision({ prev, snap, peer: who, now, sig })
    if (!dec.paint) return prev ? prev.text : renderLine(snap, who)
    const text = renderLine(snap, who)
    if (paints.size > 500 && !paints.has(id)) paints.delete(paints.keys().next().value)
    paints.set(id, { sig, text, at: now, count: dec.count, mood: { ...snap.mood } })
    // 档位变化流水（14.11）：只记签名和原因，不记原话。
    appendJsonl(affectPaths(root).paint, { at: new Date(now).toISOString(), sig, count: dec.count, reason: dec.reason })
      .catch(() => {})
    return text
  }

  /** 面板 / status.md 用；只读，不参与注入。 */
  function status() {
    const snap = snapshot(state, Date.now())
    const mood = EMOTION_NAMES
      .map((name) => {
        const value = snap.mood[name]
        return {
          name,
          value: Number(value.toFixed(3)),
          bucket: bucketOf(value),
          lift: Number((value - (EMOTIONS[name].base || 0)).toFixed(3)),
        }
      })
      .filter((x) => x.bucket > 0)
      .sort((a, b) => (b.lift - a.lift) || (b.value - a.value))
    const words = { 1: '轻', 2: '中', 3: '明显' }
    const head = mood.slice(0, 3).map((x) => `${x.name}（${words[x.bucket]}）`).join(' · ')
    const stance = Object.entries(snap.stance)
      .map(([peer, s]) => ({
        peer,
        close: Number(s.close.toFixed(2)),
        trust: Number(s.trust.toFixed(2)),
        patience: Number(s.patience.toFixed(2)),
        at: s.at ? new Date(s.at).toISOString() : '',
      }))
      .sort((a, b) => String(b.at).localeCompare(String(a.at)))
      .slice(0, 40)
    return {
      enabled: on,
      mood,
      stance,
      line: renderLine(snap, ''),
      // 人读的一行：给 status.md / 面板用，不带注入指令。
      summary: head ? `${head}｜${stanceWord(snap, '')}` : `平静｜${stanceWord(snap, '')}`,
    }
  }

  /** 闸门读的数值快照：只读，不写盘。 */
  function mood() {
    if (!on) return null
    return snapshot(state, Date.now()).mood
  }

  function stanceFor(peer) {
    return stanceOf(snapshot(state, Date.now()), peer)
  }

  async function reset() {
    state = emptyState()
    paints.clear()
    return flush()
  }

  return {
    enabled: on,
    ready,
    flush,
    noteUserMessage,
    noteAppraisal,
    lineFor,
    stanceFor,
    status,
    mood,
    reset,
    get state() { return state },
  }
}
