/**
 * itemstate.js —— 记忆条目「活着 / 死了」的统一判断。
 *
 * 以前每个模块各写一份 live/dead 判断，条件还不完全一样：
 * 有的把 merged 当死，有的不把 expired 当死，有的不把 suggested 当死。
 * 这里用显式选项把这些差异表达出来，调用方按原语义传参，
 * 既能去重，又不会在「统一」时悄悄改掉某处的行为。
 */

/** 最常见的四种死状态：归档 / 被取代 / 待确认 / 过期。 */
export const DEAD_STATES = Object.freeze(['archived', 'superseded', 'suggested', 'expired'])

/** 合并掉的条目也算死：检索和骨架不该再展示。 */
export const DEAD_STATES_WITH_MERGED = Object.freeze([...DEAD_STATES, 'merged'])

const DEFAULT_DEAD = new Set(DEAD_STATES)

/**
 * 条目是否还活着。
 *
 * @param {object|null|undefined} item
 * @param {{mergedDead?:boolean, expiredDead?:boolean, suggestedDead?:boolean}} [opts]
 *   mergedDead：把 state==='merged' 也当死（funnel / skeleton）
 *   expiredDead：把 state==='expired' 当死（默认 true；deepen / ingest 传 false）
 *   suggestedDead：把 state==='suggested' 当死（默认 true；tools 的简化判断传 false）
 */
export function isLive(item, opts = {}) {
  if (!item) return false
  const s = item.state
  if (s === 'archived' || s === 'superseded') return false
  if (opts.suggestedDead !== false && s === 'suggested') return false
  if (opts.expiredDead !== false && s === 'expired') return false
  if (opts.mergedDead && s === 'merged') return false
  return true
}

/** 条目是否已死（isLive 的反面，同样受选项控制）。 */
export function isDead(item, opts = {}) {
  return !isLive(item, opts)
}

/** 从分片或条目数组里挑出还活着的。 */
export function liveItems(scopeOrItems, opts = {}) {
  const items = Array.isArray(scopeOrItems) ? scopeOrItems : (scopeOrItems?.items || [])
  return items.filter((x) => isLive(x, opts))
}

/** 默认死状态集合的副本，给仍想用 Set.has 的调用方。 */
export function deadSet() {
  return new Set(DEFAULT_DEAD)
}
