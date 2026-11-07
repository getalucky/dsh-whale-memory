/**
 * beat/feedback.js —— 投递之后的反馈闭环
 *
 * 文档 13.11：报账是主证据，回复是结构信号，行为信号只调素材权重，
 * 不生成「用户喜欢 X」的记忆。所有判断都在本地跑，不额外调模型。
 *
 * 关键约束：
 *   - feedback.jsonl 只存 hash / 分数 / 标签，不存回复原文；
 *   - 素材与画像、人格物理隔离，这里的加减分不会进 memory 分片；
 *   - 用户说「别发这个」直接退役，不再复活。
 */

import { createHash } from 'node:crypto'

import { appendJsonl } from '../store.js'
import { feedbackPath, loadConfig } from './config.js'
import { loadState, saveState } from './state.js'
import { adjustMaterial, retireMaterial } from './material.js'

const DAY_MS = 24 * 3600000

// 强拒绝：只认明确指向投递的话，不把普通抱怨当「别发了」。
const NEGATIVE = /(别发这个|别发这种|不要发这个|不想看这个|别推了|别烦我|烦不烦|关掉主动|别主动|闭嘴)/

// 追问：问号 / 接话词。够粗，但只用于加分，不用于记忆。
const FOLLOWUP = /[?？]|后来|为什么|怎么|然后呢|真的吗|哪[个里儿]/

function charsOf(text) {
  return [...String(text ?? '')].length
}

function hashOf(text) {
  return createHash('sha1').update(String(text ?? '')).digest('hex').slice(0, 16)
}

function atMs(v) {
  const n = Date.parse(v || '')
  return Number.isFinite(n) ? n : 0
}

function withinDay(iso, now) {
  const t = atMs(iso)
  return Boolean(t) && now.getTime() - t >= 0 && now.getTime() - t <= DAY_MS
}

function firstId(materials) {
  return String((Array.isArray(materials) ? materials : []).find((x) => x?.id)?.id || '')
}

function focusHit(text, info) {
  const body = String(text ?? '')
  const focus = String(info?.focus || '').trim()
  const tags = Array.isArray(info?.tags) ? info.tags : []
  if (focus && focus.length >= 2 && body.includes(focus)) return focus
  for (const tag of tags) {
    const t = String(tag || '').trim()
    if (t.length >= 2 && body.includes(t)) return t
  }
  return ''
}

async function writeFeedback(root, entry) {
  await appendJsonl(feedbackPath(root), entry).catch(() => {})
}

/**
 * 投递成功时打标：等目标会话的下一条真实用户消息。
 * @param {object[]} materials 这一跳投出去的候选（含 id/focus/tags）
 */
export async function noteDelivery(root, { deliveryId, at = new Date(), sessionId = '', materials = [] } = {}) {
  if (!deliveryId) return { ok: false, why: 'no-delivery-id' }
  const st = await loadState(root)
  const ids = (Array.isArray(materials) ? materials : []).map((m) => String(m.id || '')).filter(Boolean)
  const focus = String((materials || []).find((m) => m?.focus)?.focus || '').trim()
  const tags = [...new Set((materials || []).flatMap((m) => (Array.isArray(m.tags) ? m.tags : [])))].map(String).slice(0, 8)
  const iso = at instanceof Date ? at.toISOString() : new Date(at).toISOString()
  st.pendingDelivery = { deliveryId, at: iso, sessionId: String(sessionId || ''), materialIds: ids, focus, tags }
  st.lastDeliveryInfo = { deliveryId, at: iso, materialIds: ids, focus, tags, focusBoosted: false }
  await saveState(root, st)
  return { ok: true }
}

/**
 * 真实用户消息进来：更新活动时间、回一条投递、按本地信号加减分。
 * 只认「投递 → 她回 → 用户回」这个顺序；投递包本身在 ingest 就被 meta 过滤了。
 * armDelivery=false 表示还没看见她的回复，只记活动，不消费投递。
 * @returns {Promise<{ok:boolean, acted:boolean, repliedNow:boolean, deliveryId:string, deliveryAt:string, why?:string}>}
 */
export async function noteUserMessage(root, { sessionId = '', text = '', at = new Date(), armDelivery = true } = {}) {
  const body = String(text ?? '').trim()
  const iso = at instanceof Date ? at.toISOString() : new Date(at).toISOString()
  const now = at instanceof Date ? at : new Date(at)
  if (!body || !Number.isFinite(now.getTime())) return { ok: false, acted: false, repliedNow: false, deliveryId: '', deliveryAt: '', why: 'empty' }

  const st = await loadState(root)
  const chars = charsOf(body)
  const prevAvg = Math.max(0, Number(st.replyStats?.avgChars) || 0)
  const count = (Number(st.replyStats?.count) || 0) + 1
  const avg = count <= 1 ? chars : Math.round(prevAvg * 0.8 + chars * 0.2)

  st.lastUserAt = iso
  st.replyStats = { count, avgChars: avg }

  let acted = false
  let repliedNow = false
  let deliveryId = ''
  let deliveryAt = ''
  const pending = armDelivery ? st.pendingDelivery : null
  if (pending && withinDay(pending.at, now) && (!pending.sessionId || String(pending.sessionId) === String(sessionId))) {
    const minutes = Math.max(0, Math.round((now.getTime() - atMs(pending.at)) / 60000))
    const negative = NEGATIVE.test(body)
    let delta = 0
    const signals = { minutes, chars, baseline: prevAvg, negative }
    if (minutes <= 30) delta += 0.1
    if (prevAvg > 0 && chars > prevAvg * 1.2 && chars >= 6) delta += 0.1
    if (FOLLOWUP.test(body)) delta += 0.2
    if (negative) delta = -1

    const target = pending.materialIds?.[0] || ''
    if (target) {
      const r = await adjustMaterial(root, target, negative ? -0.5 : delta, { now })
      if (r.ok || r.why === 'not-found') {
        await writeFeedback(root, {
          at: iso,
          deliveryId: pending.deliveryId,
          materialId: target,
          source: 'reply',
          engagement: delta,
          signals,
          replyHash: hashOf(body),
          chars,
          beforeBoost: r.before ?? 0,
          afterBoost: r.after ?? 0,
        })
      }
    }
    if (negative) {
      for (const id of pending.materialIds || []) {
        await retireMaterial(root, id, 'user-rejected', { now }).catch(() => {})
      }
    }
    st.pendingDelivery = null
    acted = true
    repliedNow = true
    deliveryId = String(pending.deliveryId || '')
    deliveryAt = String(pending.at || '')
  }

  // 24 小时内再提到同一焦点：只加一次，避免同一段聊天反复顶权重。
  // 投递后的第一条回复不算「再次提到」，防止一条消息拿两次分。
  const last = st.lastDeliveryInfo
  if (!repliedNow && last && !last.focusBoosted && withinDay(last.at, now)) {
    const hit = focusHit(body, last)
    if (hit) {
      const target = last.materialIds?.[0] || ''
      if (target) {
        const r = await adjustMaterial(root, target, 0.3, { now })
        if (r.ok) {
          await writeFeedback(root, {
            at: iso,
            deliveryId: last.deliveryId,
            materialId: target,
            source: 'focus',
            engagement: 0.3,
            signals: { focus: hit, chars },
            replyHash: hashOf(body),
            chars,
            beforeBoost: r.before ?? 0,
            afterBoost: r.after ?? 0,
          })
        }
      }
      last.focusBoosted = true
      acted = true
    }
  }

  await saveState(root, st)
  return { ok: true, acted, repliedNow, deliveryId, deliveryAt }
}

/**
 * 投递 24 小时没报账、也没等到用户回复：记 unreported，轻微降权。
 * 由 tick / maintain 调用；不阻塞对话。
 */
export async function settleUnreported(root, { now = new Date(), log } = {}) {
  const st = await loadState(root)
  const pending = st.pendingDelivery
  if (!pending) return { ok: true, settled: 0 }
  const age = now.getTime() - atMs(pending.at)
  if (!Number.isFinite(age) || age < DAY_MS) return { ok: true, settled: 0 }

  const target = pending.materialIds?.[0] || ''
  if (target) {
    const r = await adjustMaterial(root, target, -0.2, { now })
    if (r.ok || r.why === 'not-found') {
      await writeFeedback(root, {
        at: now.toISOString(),
        deliveryId: pending.deliveryId,
        materialId: target,
        source: 'unreported',
        engagement: -0.2,
        signals: { hours: Math.round(age / 3600000) },
        replyHash: '',
        chars: 0,
        beforeBoost: r.before ?? 0,
        afterBoost: r.after ?? 0,
      })
    }
  }
  st.pendingDelivery = null
  if (st.lastDeliveryInfo && st.lastDeliveryInfo.deliveryId === pending.deliveryId) {
    st.lastDeliveryInfo.focusBoosted = true
  }
  await saveState(root, st)
  log?.(`[whale] 投递未报账 ${pending.deliveryId} · 24h 无回复，已降权`)
  return { ok: true, settled: 1 }
}

/**
 * material_report 的主证据落账：用上的条目精确加分；mode=none 不扣素材分，
 * 但连续 3 次「决定不说」会把下一次投递间隔拉长。
 */
export async function applyReport(root, { deliveryId, usedIds = [], mode = 'none', at = new Date(), log } = {}) {
  const id = String(deliveryId || '').trim()
  if (!id) return { ok: false, why: 'no-delivery-id' }
  const iso = at instanceof Date ? at.toISOString() : new Date(at).toISOString()
  const now = at instanceof Date ? at : new Date(at)
  const ids = [...new Set((Array.isArray(usedIds) ? usedIds : []).map(String).filter(Boolean))].slice(0, 8)
  const rows = []

  if (mode === 'quote' || mode === 'improvise') {
    for (const mid of ids) {
      const r = await adjustMaterial(root, mid, mode === 'quote' ? 0.2 : 0.1, { now })
      if (!r.ok) continue
      rows.push({
        at: iso,
        deliveryId: id,
        materialId: mid,
        source: 'report',
        mode,
        engagement: mode === 'quote' ? 0.2 : 0.1,
        replyHash: '',
        chars: 0,
        beforeBoost: r.before,
        afterBoost: r.after,
      })
    }
  }
  await writeFeedback(root, {
    at: iso,
    deliveryId: id,
    usedIds: ids,
    mode,
    source: 'report',
    engagement: rows.reduce((n, x) => n + x.engagement, 0),
    summary: true,
  })

  const st = await loadState(root)
  if (st.pendingDelivery?.deliveryId === id) st.pendingDelivery = null
  if (mode === 'none') {
    st.noneStreak = (Number(st.noneStreak) || 0) + 1
    if (st.noneStreak >= 3) {
      const cfg = await loadConfig(root).catch(() => ({}))
      const cooldown = Math.max(1, Number(cfg.cooldownMinutes) || 30)
      st.deliveryBackoffUntil = new Date(now.getTime() + cooldown * 2 * 60000).toISOString()
      st.noneStreak = 0
      log?.('[whale] 连续三次决定不说，下一轮投递间隔拉长')
    }
  } else {
    st.noneStreak = 0
  }
  await saveState(root, st)
  return { ok: true, adjusted: rows.length }
}

/** 给界面读：只回摘要，不回回复原文。 */
export function summarizeFeedback(row) {
  if (!row || typeof row !== 'object') return null
  return {
    at: String(row.at || ''),
    deliveryId: String(row.deliveryId || ''),
    materialId: String(row.materialId || ''),
    source: String(row.source || ''),
    mode: String(row.mode || ''),
    engagement: Number(row.engagement) || 0,
    chars: Number(row.chars) || 0,
    replyHash: String(row.replyHash || ''),
  }
}
