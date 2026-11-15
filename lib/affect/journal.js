/**
 * journal.js —— 每天那行心情（写进日记末尾，不单开文件）
 *
 * 文档 14.9（2026-11-15 定）：不做 affect-journal.enc，情绪跟着日记一起明文，
 * 省一个文件、省一把密钥。这一行由代码拼，模型只写正文、不碰它；
 * 日记重写时重算覆盖，幂等。
 */

import { readFile } from 'node:fs/promises'

import { affectPaths } from './state.js'
import { EMOTIONS } from './lexicon.js'

const DAY_LIMIT = 4000

/** YYYY-MM-DD（本地时区，和 diary.js 的 dayKey 一致）。 */
function localDay(ts) {
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return ''
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/**
 * 当天被什么推动得最多。用事件而不是当前状态算：夜里状态早就衰减回底色了，
 * 但"今天被逗了三次"应该留在日记里。
 * @returns {Promise<string>} 空串表示这天没有情绪事件
 */
export async function dayLine(root, day) {
  let raw = ''
  try {
    raw = await readFile(affectPaths(root).events, 'utf8')
  } catch {
    return ''
  }
  const counts = new Map()
  for (const line of raw.split('\n').slice(-DAY_LIMIT)) {
    if (!line.trim()) continue
    let e = null
    try { e = JSON.parse(line) } catch { continue }
    if (!e || !EMOTIONS[e.kind]) continue
    if (localDay(e.ts ?? Date.parse(e.at || '')) !== day) continue
    counts.set(e.kind, (counts.get(e.kind) || 0) + 1)
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2)
  if (!top.length) return ''
  const bits = top.map(([k, n]) => (n > 1 ? `${k} ×${n}` : k)).join(' · ')
  return `> 今日心情：${bits}`
}
