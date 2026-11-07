/**
 * beat/schedule.js —— 节律：时间窗、间隔、抖动、下一次
 *
 * 全部本地计算，不调模型。时间窗支持跨午夜（21:00–02:00）。
 */

export function toMinutes(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm ?? '').trim())
  if (!m) return -1
  const h = Number(m[1])
  const min = Number(m[2])
  if (h < 0 || h > 23 || min < 0 || min > 59) return -1
  return h * 60 + min
}

function dayMinutes(date) {
  return date.getHours() * 60 + date.getMinutes()
}

/** 一个时间窗是否包含此刻；start > end 表示跨午夜。 */
export function inWindow(date, window) {
  const start = toMinutes(window?.start)
  const end = toMinutes(window?.end)
  if (start < 0 || end < 0) return false
  const now = dayMinutes(date)
  if (start === end) return true
  if (start < end) return now >= start && now < end
  return now >= start || now < end
}

export function inAnyWindow(date, windows) {
  if (!Array.isArray(windows) || !windows.length) return true
  return windows.some((w) => inWindow(date, w))
}

/** 下一个时间窗开始时刻；今天已过就找明天。找不到返回 null。 */
export function nextWindowStart(date, windows) {
  if (!Array.isArray(windows) || !windows.length) return new Date(date)
  const day = new Date(date)
  day.setHours(0, 0, 0, 0)
  for (let d = 0; d < 8; d += 1) {
    const base = new Date(day.getTime() + d * 86400000)
    for (const w of windows) {
      const start = toMinutes(w?.start)
      if (start < 0) continue
      const at = new Date(base)
      at.setMinutes(start)
      if (at.getTime() > date.getTime()) return at
    }
  }
  return null
}

/** 本地日期键，用来算“今天投了几次 / 逛了几次”。 */
export function dayKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

/** 间隔抖动：base ± pct，pct 0–50。 */
export function jitter(ms, pct = 0, rng = Math.random) {
  const p = Math.max(0, Math.min(50, Number(pct) || 0)) / 100
  if (!p) return ms
  const factor = 1 - p + rng() * p * 2
  return Math.round(ms * factor)
}

/**
 * 这一跳该不该去网上逛。
 * @returns {{due:boolean, reason:string, focus?:string}}
 */
export function wanderDue({ now = new Date(), config, state = {}, materialCount = 0 } = {}) {
  const cfg = config || {}
  if (!inAnyWindow(now, cfg.windows)) return { due: false, reason: 'window' }

  const last = Date.parse(state.lastWanderAt || '') || 0
  const gap = Math.max(0, Number(cfg.minIntervalHours) || 0) * 3600000
  if (last && now.getTime() - last < gap) return { due: false, reason: 'interval' }

  const day = dayKey(now)
  const count = state.wanderDay === day ? Number(state.wanderCount) || 0 : 0
  if (count >= (Number(cfg.maxWanderPerDay) || 0)) return { due: false, reason: 'daily_cap' }

  // 连续两次空结果当天不再闲逛（文档 13.6）。
  if (state.wanderEmptyDay === day && (Number(state.wanderEmptyCount) || 0) >= 2) {
    return { due: false, reason: 'empty_streak' }
  }

  const refillBelow = Number(cfg.refillBelow) || 0
  const lastRefill = Date.parse(state.lastRefillAt || '') || 0
  if (materialCount >= refillBelow && lastRefill && now.getTime() - lastRefill < 12 * 3600000) {
    return { due: false, reason: 'enough' }
  }
  if (materialCount >= refillBelow && !lastRefill) return { due: false, reason: 'enough' }

  return { due: true, reason: 'due' }
}

/** 兴趣归一化：字符串 / { focus } 都认。 */
export function focusList(interests) {
  return (Array.isArray(interests) ? interests : [])
    .map((x) => (typeof x === 'string' ? x : x?.focus))
    .map((x) => String(x ?? '').trim())
    .filter(Boolean)
}

/**
 * 可用焦点：同一焦点 3 天冷却（文档 13.8）。
 * 全都在冷却时返回空数组，调用方应跳过这一跳，而不是硬换一个。
 */
export function availableFocuses(interests, { focusLastUsed = {}, now = new Date(), cooldownDays = 3 } = {}) {
  const list = focusList(interests)
  const days = Math.max(0, Number(cooldownDays) || 0)
  if (!days) return list
  const cutoff = now.getTime() - days * 86400000
  return list.filter((f) => {
    const last = Date.parse(focusLastUsed?.[f] || '') || 0
    return !last || last <= cutoff
  })
}

/** 挑一个焦点：优先没在最近用过的；都不在冷却里就按上次焦点轮换。 */
export function pickFocus(interests, lastFocus = '') {
  const list = focusList(interests)
  if (!list.length) return ''
  const at = list.indexOf(lastFocus)
  return at >= 0 ? list[(at + 1) % list.length] : list[0]
}
