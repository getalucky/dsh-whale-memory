/**
 * beat/feedback.js —— 投递之后的反馈闭环
 *
 * 文档 13.11：报账是主证据，回复是结构信号，行为信号只调素材权重，
 * 不生成「用户喜欢 X」的记忆。所有判断都在本地跑，不额外调模型。
 *
 * 关键约束：
 *   - feedback.jsonl 只存随机短 id / 分数 / 标签，不存回复原文；
 *     不能存内容摘要——短回复的 SHA1 用字典就能反推，等于变相存原文；
 *   - 素材与画像、人格物理隔离，这里的加减分不会进 memory 分片；
 *   - 用户说「别发这个」直接退役，不再复活。
 */

import { randomBytes } from 'node:crypto'

import { appendJsonl } from '../store.js'
import { completeText, llmReady } from '../llm.js'
import { feedbackPath, loadConfig } from './config.js'
import { loadState, saveState, updateState, withStateLock } from './state.js'
import { adjustMaterial, retireMaterial } from './material.js'

const DAY_MS = 24 * 3600000

// 强拒绝：只认明确指向投递的话，不把普通抱怨当「别发了」。
const NEGATIVE = /(别发这个|别发这种|不要发这个|不想看这个|别推了|别烦我|烦不烦|关掉主动|别主动|闭嘴)/

// 追问：问号 / 接话词。够粗，但只用于加分，不用于记忆。
const FOLLOWUP = /[?？]|后来|为什么|怎么|然后呢|真的吗|哪[个里儿]/

function charsOf(text) {
  return [...String(text ?? '')].length
}

/** 只做行标识，跟回复内容无关；界面上显示前 8 位。 */
function replyTag() {
  return randomBytes(8).toString('hex')
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
  const ids = (Array.isArray(materials) ? materials : []).map((m) => String(m.id || '')).filter(Boolean)
  const focus = String((materials || []).find((m) => m?.focus)?.focus || '').trim()
  const tags = [...new Set((materials || []).flatMap((m) => (Array.isArray(m.tags) ? m.tags : [])))].map(String).slice(0, 8)
  const iso = at instanceof Date ? at.toISOString() : new Date(at).toISOString()
  await updateState(root, (st) => {
    st.pendingDelivery = { deliveryId, at: iso, sessionId: String(sessionId || ''), materialIds: ids, focus, tags }
    st.lastDeliveryInfo = { deliveryId, at: iso, materialIds: ids, focus, tags, focusBoosted: false }
  })
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

  return updateState(root, async (st) => {
    const chars = charsOf(body)
    const prevAvg = Math.max(0, Number(st.replyStats?.avgChars) || 0)
    const count = (Number(st.replyStats?.count) || 0) + 1
    const avg = count <= 1 ? chars : Math.round(prevAvg * 0.8 + chars * 0.2)

    st.lastUserAt = iso
    if (sessionId) {
      // 每个会话只留最近一次：投递闸门要知道「绑定的那个会话刚聊过没有」。
      const map = {
        ...(st.lastUserAtBySession && typeof st.lastUserAtBySession === 'object' ? st.lastUserAtBySession : {}),
        [String(sessionId)]: iso,
      }
      st.lastUserAtBySession = Object.fromEntries(
        Object.entries(map)
          .filter(([, at]) => Number.isFinite(Date.parse(at)))
          .sort((a, b) => Date.parse(b[1]) - Date.parse(a[1]))
          .slice(0, 40),
      )
    }
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
            replyHash: replyTag(),
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
      // 第四层只处理「前三层看不出态度」的回复：中性、或只有一两个字的客气话。
      // 不在这里直接调模型，先入内存队列，由 maintain / tick 批量判，避免每句话都加延迟。
      if (target && !negative && (delta === 0 || (delta <= 0.1 && chars <= 6))) {
        queueJudge({ root, deliveryId: pending.deliveryId, materialIds: pending.materialIds || [], text: body, at: iso })
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
              replyHash: replyTag(),
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

    return { ok: true, acted, repliedNow, deliveryId, deliveryAt }
  })
}

/**
 * 投递 24 小时没报账、也没等到用户回复：记 unreported，轻微降权。
 * 由 tick / maintain 调用；不阻塞对话。
 */
export async function settleUnreported(root, { now = new Date(), log } = {}) {
  const result = await withStateLock(root, async () => {
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
    return { ok: true, settled: 1, deliveryId: pending.deliveryId }
  })
  if (result.settled) log?.(`[whale] 投递未报账 ${result.deliveryId} · 24h 无回复，已降权`)
  return { ok: true, settled: result.settled }
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

  await updateState(root, async (st) => {
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
  })
  return { ok: true, adjusted: rows.length }
}

// ---- 第四层：AI 判语义（文档 13.11）----
//
// 只在前三层给不出态度时用：中性回复、或一两个字的客气话。
// 独立便宜模型 + 窄 rubric，结论最多移动权重 0.2；连续两次 annoyed 直接退役。
// 不存回复原文，feedback.jsonl 里只有 label / confidence / 分数。

const JUDGE_QUEUE_MAX = 50
const judgeQueue = []

function queueJudge(item) {
  if (!item?.text) return
  if (judgeQueue.some((x) => x.deliveryId && x.deliveryId === item.deliveryId)) return
  if (judgeQueue.length >= JUDGE_QUEUE_MAX) judgeQueue.shift()
  judgeQueue.push({ ...item, text: String(item.text).slice(0, 200) })
}

export function pendingJudges() {
  return judgeQueue.length
}

/** 窄 rubric；模型只回 JSON，理由最多 20 字，不写回原文。 */
export function judgePrompt(text) {
  return [
    '判断用户对一条主动消息的态度。只回严格 JSON，不要解释、不要 markdown：',
    '{"label":"engaged|neutral|annoyed","confidence":0到1,"reason":"≤20字"}',
    'engaged=接话、追问、明显感兴趣；annoyed=明确嫌烦、让别发；其余算 neutral。',
    `用户回复：${String(text ?? '').slice(0, 300)}`,
  ].join('\n')
}

export function parseJudge(content) {
  const s = String(content ?? '')
  const a = s.indexOf('{')
  const b = s.lastIndexOf('}')
  if (a < 0 || b <= a) return null
  let o = null
  try { o = JSON.parse(s.slice(a, b + 1)) } catch { return null }
  const label = String(o?.label || '').trim().toLowerCase()
  if (!['engaged', 'neutral', 'annoyed'].includes(label)) return null
  return {
    label,
    confidence: Math.max(0, Math.min(1, Number(o?.confidence) || 0)),
    reason: String(o?.reason || '').slice(0, 40),
  }
}

/** 单次判定；失败返回 null，调用方保留队列下一轮再试。 */
export async function judgeEngagement(text, { fetchImpl = globalThis.fetch, timeoutMs = 12000 } = {}) {
  if (!llmReady()) return null
  const content = await completeText(
    [{ role: 'system', content: '你是对话反馈分类器，只输出 JSON。' }, { role: 'user', content: judgePrompt(text) }],
    { fetchImpl, timeoutMs, temperature: 0.1, maxTokens: 120 },
  ).catch(() => null)
  return content ? parseJudge(content) : null
}

/**
 * 批量处理队列。由 maintain / tick 调用；没有模型或队列空时零成本。
 * @returns {Promise<{judged:number, retired:number, skipped:number}>}
 */
export async function drainJudgeQueue(root, { fetchImpl, log, limit = 3, now = new Date() } = {}) {
  if (!judgeQueue.length) return { judged: 0, retired: 0, skipped: 0 }
  if (!llmReady()) return { judged: 0, retired: 0, skipped: judgeQueue.length }
  let judged = 0
  let retired = 0
  let skipped = 0
  for (let n = 0; n < Math.min(limit, judgeQueue.length); n += 1) {
    const item = judgeQueue[0]
    const verdict = await judgeEngagement(item.text, { fetchImpl }).catch(() => null)
    if (!verdict) { skipped += 1; break }
    judgeQueue.shift()
    const delta = verdict.label === 'engaged' ? 0.1 : verdict.label === 'annoyed' ? -0.2 : 0
    if (!delta) { judged += 1; continue }
    const target = String(item.materialIds?.[0] || '')
    if (!target) { judged += 1; continue }
    const r = await adjustMaterial(root, target, delta, { now }).catch(() => null)
    if (!r?.ok) { judged += 1; continue }
    let strikes = 0
    if (verdict.label === 'annoyed') {
      strikes = await updateState(root, async (st) => {
        st.judgeStrikes = st.judgeStrikes || {}
        st.judgeStrikes[target] = (Number(st.judgeStrikes[target]) || 0) + 1
        return st.judgeStrikes[target]
      }).catch(() => 0)
      if (strikes >= 2) {
        await retireMaterial(root, target, 'ai-annoyed', { now }).catch(() => {})
        retired += 1
      }
    }
    await writeFeedback(root, {
      at: now.toISOString(),
      deliveryId: String(item.deliveryId || ''),
      materialId: target,
      source: 'ai',
      engagement: delta,
      label: verdict.label,
      confidence: verdict.confidence,
      reason: verdict.reason,
      replyHash: replyTag(),
      beforeBoost: r.before ?? 0,
      afterBoost: r.after ?? 0,
    })
    judged += 1
  }
  if (judged) log?.(`[whale] 语义判定 ${judged} 条${retired ? `，退役 ${retired}` : ''}`)
  return { judged, retired, skipped }
}

/** 给界面读：只回摘要，不回回复原文。signals 只挑数值和素材标签，避免以后误带内容。 */
export function summarizeFeedback(row) {  if (!row || typeof row !== 'object') return null
  const s = row.signals && typeof row.signals === 'object' ? row.signals : {}
  return {
    at: String(row.at || ''),
    deliveryId: String(row.deliveryId || ''),
    materialId: String(row.materialId || ''),
    source: String(row.source || ''),
    mode: String(row.mode || ''),
    engagement: Number(row.engagement) || 0,
    chars: Number(row.chars) || 0,
    replyHash: String(row.replyHash || ''),
    summary: row.summary === true,
    signals: {
      minutes: Number(s.minutes) || 0,
      chars: Number(s.chars) || 0,
      baseline: Number(s.baseline) || 0,
      hours: Number(s.hours) || 0,
      negative: s.negative === true,
      focus: String(s.focus || ''),
    },
  }
}
