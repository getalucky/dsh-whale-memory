/**
 * maintain.js —— 写完一条之后把画像和图谱拉平
 *
 * 工具写入（memory_save / memory_correct）以前只存分片，图谱要等下一次蒸馏
 * 或遗忘才更新，中间这一段时间界面上的图谱是旧的。这里做一个统一出口。
 *
 * 调用方负责持锁（withWriteLock），这里不再加锁，避免自锁。
 */

import { listScopes, saveScope } from './store.js'
import { buildGraph, saveGraph } from './graph.js'
import { buildProfile, buildMembers } from './profile.js'

export async function reindexScope(root, scope) {
  const others = (await listScopes(root).catch(() => [])).filter((s) => s.scope !== scope.scope)
  const g = buildGraph([...others, scope])
  scope.profile = buildProfile(scope, g)
  scope.members = buildMembers(scope)
  await saveScope(root, scope)
  await saveGraph(root, g).catch(() => {})
  return g
}
