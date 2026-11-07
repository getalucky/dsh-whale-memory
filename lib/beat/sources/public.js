/**
 * beat/sources/public.js —— 从公共记忆池挑近期素材
 *
 * 公共池是共享知识，不是用户事实。只复制摘要和来源 id，不把整条记忆搬进素材；
 * 30 天内退休过的同一个 originId 不再捡回来。
 */

import { loadScope } from '../../store.js'
import { addMaterial } from '../material.js'

const MAX_AGE_DAYS = 30
const MIN_WEIGHT = 0.4
const MAX_TEXT = 120
// 公共池条目会按时间落到 warm（权重 0.4~0.5 就够用），只收 active 会让整个池子空掉。
// 只排除真正不能用的状态；权重和 30 天窗口下面还会再卡一次。
const DEAD_STATES = new Set(['archived', 'superseded', 'expired', 'suggested'])

function atOf(item) {
  return item?.observedAt || item?.created || item?.lastHit || ''
}

/** 摘要列被索引层截成 40 字左右，还会带省略号；素材要正文，不要那半句。 */
function clipText(text, max = MAX_TEXT) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (s.length <= max) return s
  const head = s.slice(0, max)
  const cut = Math.max(
    head.lastIndexOf('。'), head.lastIndexOf('！'), head.lastIndexOf('？'),
    head.lastIndexOf('；'), head.lastIndexOf('!'), head.lastIndexOf('?'), head.lastIndexOf(';'),
  )
  return cut >= Math.floor(max * 0.5) ? head.slice(0, cut + 1) : `${head}…`
}

export async function pullPublic(root, { config = {}, now = new Date(), limit = 4, log } = {}) {
  const scope = await loadScope(root, 'public', 'web').catch(() => null)
  const items = (scope?.items || [])
    .filter((x) => x && !DEAD_STATES.has(x.state))
    .filter((x) => {
      const at = Date.parse(atOf(x))
      return !Number.isFinite(at) || now.getTime() - at <= MAX_AGE_DAYS * 86400000
    })
    .filter((x) => Number(x.weight ?? x.conf ?? 0) >= MIN_WEIGHT)
    .sort((a, b) => Number(b.weight ?? b.conf ?? 0) - Number(a.weight ?? a.conf ?? 0))

  let added = 0
  let duplicate = 0
  let skipped = 0
  for (const it of items) {
    if (added >= Math.max(0, limit)) break
    const text = clipText(it.text || it.summary || '')
    if (!text) { skipped += 1; continue }
    const r = await addMaterial(root, {
      text,
      quote: clipText(it.text || it.summary || '', 200),
      refs: it.refs || [],
      originId: it.id,
      source: 'public',
      focus: (it.tags || [])[0] || '公共',
      at: atOf(it) || now.toISOString(),
      conf: Math.min(0.4, Number(it.conf) || 0.4),
      tags: it.tags || [],
    }, { config, now })
    if (r.ok && r.duplicate) duplicate += 1
    else if (r.ok) added += 1
    else skipped += 1
  }
  if (added) log?.(`[whale] 公共池素材 +${added}${duplicate ? ` · 重复 ${duplicate}` : ''}`)
  return { ok: true, seen: items.length, added, duplicate, skipped }
}
