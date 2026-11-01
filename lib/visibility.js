/**
 * visibility.js —— 分片可见性（隐私边界）
 *
 * 群聊是公开场合：群友在场，一句「搜一下」不该把私聊内容捞出来。
 * 所以检索能看哪些分片，按「谁在问」决定：
 *   · 群会话   → 本群 + 仓库共识
 *   · 私聊     → 本人 + 本机（local:dsh）+ 仓库共识
 *   · 本机会话 → 全部（自己的机器，没有第三人在场）
 *
 * 仓库共识（project）对所有场合可见：它本来就是随 git 分享的团队内容。
 * 显式传 scope 也只能在可见范围内取；群会话传 private:xxx 一样拒绝——
 * 群里任何人都能往聊天里打字，模型没法证明「这是我爹让我查的」。
 *
 * 只约束读路径（search / read / profile / pending）。写入与删除仍按原分片走：
 * 群会话已经看不到私聊的 id 了，再收写入只会让「忘了那条」在群里没法用。
 */

/** 一个目标分片在某个场合下是否可见。 */
export function visibleScope(src, target) {
  const kind = String(target?.kind ?? '')
  if (!kind) return false
  // 仓库共识随 git 分享，谁都能看
  if (kind === 'project') return true
  if (!src) return false
  if (src.kind === 'local') return true
  if (src.kind === 'group') {
    return kind === 'group' && String(target.id) === String(src.id)
  }
  if (src.kind === 'private') {
    if (kind === 'local') return true
    return kind === 'private' && String(target.id) === String(src.id)
  }
  return false
}

/** 过滤一组已加载的分片。 */
export function filterScopes(src, scopes) {
  return (Array.isArray(scopes) ? scopes : []).filter((s) => visibleScope(src, s))
}

/** 拒绝时给模型看的一句话。要能指导下一步，不能只说「不行」。 */
export function denyWhy(src) {
  if (!src) return '这个会话没有识别到来源，先不跨分片查记忆；本分片的内容仍可查。'
  if (src.kind === 'group') {
    return '群会话只查本群和仓库共识；私聊和别的群不在这个场合的可见范围，要查请私聊或桌面问。'
  }
  if (src.kind === 'private') {
    return '私聊只查本人和本机记忆；别人的私聊和其他群不在可见范围。'
  }
  return '这个分片不在当前会话的可见范围。'
}
