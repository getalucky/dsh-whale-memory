/**
 * confirm.js —— 待确认条目转正（文档 4.6 / 7.7）
 *
 * suggested 是「模型觉得该记、但还没用户点头」的中间态：不进副库、不进注入、
 * 不参与检索。用户确认后才变成 active，并顺手做一次同槽位取代。
 *
 * 工具（memory_confirm）和界面（POST /confirm）共用这一条路径，
 * 免得两处各写一套状态改动，日久之后一边记得取代、一边忘了。
 * 调用方负责持锁（withWriteLock）。
 */

import { loadScope, supersedeConflicts } from './store.js'
import { reindexScope } from './maintain.js'
import { promoteMemory } from './agentdoc.js'

export async function confirmItem(root, kind, id, itemId) {
  const sc = await loadScope(root, kind, id)
  const it = (sc.items || []).find((x) => x.id === itemId)
  if (!it) return { ok: false, why: '没有这条记忆' }
  if (it.state !== 'suggested') return { ok: false, why: `不是待确认状态（现在是 ${it.state}）` }

  const now = new Date().toISOString()
  it.state = 'active'
  it.conf = Math.max(it.conf ?? 0, 0.7)
  it.lastHit = now
  const replaced = supersedeConflicts(sc, it, now)
  await reindexScope(root, sc)
  // 转正之后才沉淀进 AGENT.md / USER.md（文档 4.8）：待确认的东西不许进常驻文件。
  // 仓库库里的偏好不落 USER.md —— 那是私人画像，别跟着仓库提交出去。
  if (it.kind === 'lesson' || (it.kind === 'pref' && sc.kind !== 'project')) {
    await promoteMemory(root, it).catch(() => {})
  }
  return { ok: true, id: itemId, scope: sc.scope, superseded: replaced.length }
}
