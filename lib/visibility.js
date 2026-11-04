/**
 * visibility.js —— 分片可见性（隐私边界）
 *
 * 三级记忆池：
 *   · 公共池（public） 网上学到的公开内容，群、私聊、本机都能读，但只有本机能写
 *   · 圈子池（group）  每个群一份，群之间不互通；私聊可以读圈子池
 *   · 私聊池（private）每个私聊一份，私聊之间不互通
 *
 * 检索能看哪些分片，按「谁在问」决定：
 *   · 群会话   → 本群 + 公共池 + 仓库共识
 *   · 私聊     → 本人 + 圈子池（全部群）+ 本机 + 公共池 + 仓库共识
 *   · 本机会话 → 全部（自己的机器，没有第三人在场）
 *
 * 仓库共识（project）对所有场合可见：它本来就是随 git 分享的团队内容。
 * 显式传 scope 也只能在可见范围内取；群会话传 private:xxx 一样拒绝——
 * 群里任何人都能往聊天里打字，模型没法证明「这是我爹让我查的」。
 *
 * 写路径单独一把尺：公共池是所有人共享的，群友和私聊对象不能凭 id 改、删、
 * 转正公共条目，只有本机会话能写（见 writableScope）。
 */

/** 一个目标分片在某个场合下是否可见。 */
export function visibleScope(src, target) {
  const kind = String(target?.kind ?? '')
  if (!kind) return false
  if (!src) return false
  if (src.kind === 'local') return true
  // 公共池和仓库共识：本来就是拿出来分享的
  if (kind === 'public' || kind === 'project') return true
  if (src.kind === 'group') {
    return kind === 'group' && String(target.id) === String(src.id)
  }
  if (src.kind === 'private') {
    if (kind === 'local') return true
    if (kind === 'private') return String(target.id) === String(src.id)
    // 私聊可以读圈子池：群是多人场合，没有额外的私密性
    if (kind === 'group') return true
    return false
  }
  return false
}

/** 能不能改这个分片。读得到不代表能改：公共池只有本机能动。 */
export function writableScope(src, target) {
  const kind = String(target?.kind ?? '')
  if (kind === 'public') return src?.kind === 'local'
  // 来源不明时沿用旧口径：写入按原分片走，不在这里加新闸
  if (!src) return true
  return visibleScope(src, target)
}

/** 过滤一组已加载的分片。 */
export function filterScopes(src, scopes) {
  return (Array.isArray(scopes) ? scopes : []).filter((s) => visibleScope(src, s))
}

/** 拒绝时给模型看的一句话。要能指导下一步，不能只说「不行」。 */
export function denyWhy(src) {
  if (!src) return '这个会话没有识别到来源，先不跨分片查记忆；本分片的内容仍可查。'
  if (src.kind === 'group') {
    return '群会话只查本群、公共池和仓库共识；私聊和别的群不在这个场合的可见范围，要查请私聊或桌面问。'
  }
  if (src.kind === 'private') {
    return '私聊只查本人、圈子池、本机、公共池和仓库共识；别人的私聊不在可见范围。'
  }
  return '这个分片不在当前会话的可见范围。'
}

/** 写入被拒时的说明。读得到但改不得，和「看不到」分开讲。 */
export function denyWriteWhy(src, target) {
  if (String(target?.kind ?? '') === 'public') {
    return '公共记忆池只有本机会话能写、能改、能删；群里和私聊里只能读。'
  }
  return denyWhy(src)
}
