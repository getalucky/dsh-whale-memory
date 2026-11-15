/**
 * turns.js —— 按真实用户回合计数（文档 12.7 回合内审查）
 *
 * 为什么单独一个文件：ingest 要记数，distill 要读阈值；两边直接互相 import
 * 会形成环。这里只存内存计数，进程重启就清零，属于「本轮会话」的临时状态。
 */

const MAX = 500
const turns = new Map()

/** 记一条真实用户消息（投递包、脚手架、她的发言都不算）。 */
export function noteTurn(sid, { kind = '', now = Date.now() } = {}) {
  const id = String(sid || '')
  if (!id) return 0
  const prev = turns.get(id) || { count: 0, kind: '', at: now }
  const next = { count: (Number(prev.count) || 0) + 1, kind: kind || prev.kind || '', at: now }
  if (turns.size >= MAX && !turns.has(id)) turns.delete(turns.keys().next().value)
  turns.set(id, next)
  return next.count
}

/** 到没到该做一次回合内审查的阈值。 */
export function shouldReview(sid, interval = 10) {
  const n = Number(interval) || 0
  if (n <= 0) return false
  const cur = turns.get(String(sid || ''))
  return Boolean(cur && cur.count >= n)
}

export function reviewCount(sid) {
  return Number(turns.get(String(sid || ''))?.count) || 0
}

export function clearReview(sid) {
  const id = String(sid || '')
  if (!id) return
  const cur = turns.get(id)
  if (cur) turns.set(id, { ...cur, count: 0 })
}

export function resetTurns() {
  turns.clear()
}
