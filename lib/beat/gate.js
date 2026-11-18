/**
 * beat/gate.js —— 纯代码闸门
 *
 * 规则顺序：专注 → 静默时段 → 绑定会话刚聊过 → 所有会话闲置 → 日限 →
 * 冷却 → 素材 → 去重。全部本地判断，判“不说”时调用方不得再调模型。
 */

import { idleMinutesOf } from './config.js'
import { dayKey, inWindow } from './schedule.js'

function minutesSince(iso, now) {
  const t = Date.parse(iso || '')
  if (!Number.isFinite(t)) return Infinity
  return (now.getTime() - t) / 60000
}

function dailySent(state, now) {
  const day = dayKey(now)
  if (state?.daily?.day !== day) return 0
  return Math.max(0, Number(state.daily.sent) || 0)
}

function sessionKey(id) {
  return String(id ?? '').trim().replace(/^session-/, '')
}

function sameSession(a, b) {
  const x = sessionKey(a)
  return Boolean(x) && x === sessionKey(b)
}

/** 绑定会话里最后一次真实用户发言；老状态没有这张表时返回空串。 */
function lastUserAtFor(state, sessionId) {
  const map = state?.lastUserAtBySession
  if (!map || typeof map !== 'object') return ''
  for (const [id, at] of Object.entries(map)) {
    if (sameSession(id, sessionId)) return String(at || '')
  }
  return ''
}

/** 心情低 → 开口阈值上调（文档 14.8）：只改冷却时长，不碰权限和日限。 */
const NEGATIVE_MOOD = ['委屈', '烦躁', '生气', '失落', '累']

export function moodLoad(mood) {
  if (!mood || typeof mood !== 'object') return 0
  let sum = 0
  for (const k of NEGATIVE_MOOD) sum += Math.max(0, Number(mood[k]) || 0)
  return Math.min(1, sum / 2)
}

export function moodCooldownMinutes(mood, base = 0) {
  const load = moodLoad(mood)
  if (load < 0.4) return Math.max(0, Number(base) || 0)
  return Math.max(0, Number(base) || 0) + Math.round(Math.min(60, load * 60))
}

/** 好奇高 → 优先知识类素材（web），只影响候选排序。 */
export function preferKnowledge(mood) {
  return (Number(mood?.好奇) || 0) >= 0.5
}

/**
 * @param {object} opts
 * @param {Date} opts.now
 * @param {object} opts.config
 * @param {object} opts.state      focusUntil / lastDeliveryAt / daily / recentMaterialIds
 * @param {object} opts.counts     { active }
 * @param {object} opts.env        { idleMinutes, locked, away, presenceKnown }
 * @param {object} opts.chat       { lastUserAt, lastChatAt } 绑定会话最近的活动
 * @param {string[]} opts.candidates 这一轮准备投的素材 id
 * @param {object} opts.mood       情绪快照（文档 14.8），缺省按中性
 * @returns {{ok:boolean, reason:string, detail?:object}}
 */
export function checkGate({ now = new Date(), config = {}, state = {}, counts = {}, env = {}, chat = null, candidates = [], mood = null } = {}) {
  const focusUntil = Date.parse(state.focusUntil || '')
  if (Number.isFinite(focusUntil) && now.getTime() < focusUntil) {
    return { ok: false, reason: 'focus_mode', detail: { until: state.focusUntil } }
  }

  if (inWindow(now, config.quietHours)) return { ok: false, reason: 'quiet_hours' }

  // 绑定会话刚聊过就别插话。这个阈值和「所有会话闲置」共用同一个数。
  const target = String(config.targetSessionId || '').trim()
  const idleLimit = idleMinutesOf(config)
  if (target && idleLimit > 0) {
    // 取用户发言和整段对话里最新的那个：她刚回完话、用户还没接，也不算「安静」。
    const stamps = [lastUserAtFor(state, target), chat?.lastUserAt, chat?.lastChatAt]
      .map((v) => Date.parse(String(v || '')))
      .filter((n) => Number.isFinite(n))
    const sinceChat = stamps.length
      ? (now.getTime() - Math.max(...stamps)) / 60000
      : Infinity
    if (Number.isFinite(sinceChat) && sinceChat < idleLimit) {
      return {
        ok: false,
        reason: 'chatting',
        detail: { minutes: Math.round(sinceChat), idleMinutes: idleLimit },
      }
    }
  }

  // 读不到全局会话活动时 presenceKnown=false：不能拿别的时间冒充「离开」，
  // 否则会把「很久没聊天」正好变成挡投递的理由。
  const presenceKnown = env.presenceKnown !== false && env.source !== 'unknown'
  const idle = Number(env.idleMinutes)
  if (env.locked) return { ok: false, reason: 'away', detail: { locked: true } }
  if (idleLimit > 0 && presenceKnown && Number.isFinite(idle) && idle >= idleLimit) {
    return { ok: false, reason: 'away', detail: { minutes: Math.round(idle), idleMinutes: idleLimit } }
  }
  if (env.away) return { ok: false, reason: 'away', detail: { idleMinutes: env.idleMinutes ?? null } }

  const sent = dailySent(state, now)
  const cap = Number(config.maxDailySend) || 0
  if (cap > 0 && sent >= cap) return { ok: false, reason: 'daily_cap', detail: { sent, cap } }

  const since = minutesSince(state.lastDeliveryAt, now)
  const cooldown = moodCooldownMinutes(mood, config.cooldownMinutes)
  if (Number.isFinite(since) && since < cooldown) {
    return { ok: false, reason: 'cooldown', detail: { minutes: Math.round(since), cooldown, mood: Number(moodLoad(mood).toFixed(2)) } }
  }

  // 今天同一个目标已经失败过：不重试，避免刷屏。
  if (state.deliveryFailed?.day === dayKey(now)) {
    return { ok: false, reason: 'delivery_failed', detail: { why: state.deliveryFailed.why || '' } }
  }

  // 连续三次「决定不说」后的降频窗。
  const backoff = Date.parse(state.deliveryBackoffUntil || '')
  if (Number.isFinite(backoff) && now.getTime() < backoff) {
    return { ok: false, reason: 'backoff', detail: { until: state.deliveryBackoffUntil } }
  }

  if ((Number(counts.active) || 0) <= 0) return { ok: false, reason: 'no_material' }

  if (Array.isArray(candidates) && candidates.length) {
    const recent = new Set(
      (Array.isArray(state.recentMaterialIds) ? state.recentMaterialIds : [])
        .filter((x) => x && Number.isFinite(Date.parse(x.at || '')) && now.getTime() - Date.parse(x.at) < 24 * 3600000)
        .map((x) => String(x.id)),
    )
    if (candidates.every((id) => recent.has(String(id)))) {
      return { ok: false, reason: 'duplicate', detail: { candidates: candidates.length } }
    }
  }

  return { ok: true, reason: 'pass', detail: { sent, cap } }
}
