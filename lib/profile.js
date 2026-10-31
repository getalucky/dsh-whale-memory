/**
 * profile.js —— 用户/群画像
 *
 * 画像不是「再记一堆」，而是把已经记下的零散事实压成两三句人话，
 * 塞进 system prompt 最前面。她读到的应该是：
 *
 *   【画像】老爹：记得 7 件事，4 件还热着。偏好：吃烤鱼、熬夜。
 *          常提到：D盘、杭州。最近：明天 8:30 上班。
 *
 * 全是规则拼出来的，不调 LLM：
 *   · 偏好数量 ← kind=pref 的条目
 *   · 常提到 ← L3 图谱里挂在这个分片上的实体（按权重取前几）
 *   · 最近   ← lastHit 最新的一条
 *
 * 输出控制在 120 字内：注入段一共 1200 字预算，画像不能喧宾夺主。
 */

import { normalizeText } from './store.js'
import { buildGraph } from './graph.js'

const MAX_SUMMARY = 120

function 短(s, n) {
  const v = String(s ?? '').replace(/\s+/g, '').trim()
  return v.length > n ? v.slice(0, n) + '…' : v
}

function 去重(list) {
  const seen = new Set()
  const out = []
  for (const x of list) {
    const k = normalizeText(x)
    if (!k || seen.has(k)) continue
    seen.add(k)
    out.push(x)
  }
  return out
}

/** 偏好转成短标签：「喜欢吃烤鱼」→「吃烤鱼」。 */
export function toTrait(text) {
  return 短(String(text ?? '').replace(/^(?:我|老爹|爹|老爸)?(?:最|比较|特别|很)?(?:喜欢|爱|讨厌|不喜欢|怕|习惯)/, ''), 8)
}

/**
 * 生成画像。
 * @param {object} scope 分片
 * @param {{nodes:object[],edges:object[]}} [graph] 已经算好的图谱（省一次重建）
 */
export function buildProfile(scope, graph) {
  const items = (scope.items || []).filter((x) => x.state !== 'archived' && x.state !== 'superseded' && x.state !== 'expired')
  const now = Date.now()
  const 热 = items.filter((x) => {
    const age = (now - Date.parse(x.lastHit || x.created || '')) / 86400000
    return age <= 7 || (x.hits || 0) >= 2
  })

  // 偏好标签：conf 高的在前
  const traits = 去重(
    items
      .filter((x) => x.kind === 'pref')
      .sort((a, b) => (b.conf || 0) - (a.conf || 0))
      .map((x) => toTrait(x.text))
      .filter((x) => x.length >= 1),
  ).slice(0, 4)

  // 常提到的实体：图谱里挂在本分片、且不是主人自己
  const g = graph ?? buildGraph([scope])
  const deg = new Map()
  for (const e of g.edges || []) {
    if (e.scope && e.scope !== scope.scope) continue
    deg.set(e.from, (deg.get(e.from) || 0) + e.weight)
    deg.set(e.to, (deg.get(e.to) || 0) + e.weight)
  }
  const topics = 去重(
    (g.nodes || [])
      .filter((n) => (n.scopes || []).includes(scope.scope) && n.type !== 'person')
      // 跟偏好重名的（「吃烤鱼」）已经在偏好里了，别再报一遍
      .filter((n) => !traits.some((tr) => tr.includes(n.name) || n.name.includes(tr)))
      .map((n) => ({ name: n.name, s: deg.get(n.id) || 0 }))
      .sort((a, b) => b.s - a.s)
      .map((x) => 短(x.name, 8)),
  ).slice(0, 3)

  // 同一毫秒写入的条目时间戳会撞车；只按时间排，"最近"每次跑都可能换人，
  // 画像就会抖，system prompt 跟着抖。时间相同用 id 兜底（id 单调递增）。
  const 最近 = [...items].sort((a, b) => {
    const d = Date.parse(b.lastHit || b.created || 0) - Date.parse(a.lastHit || a.created || 0)
    return d || String(b.id).localeCompare(String(a.id))
  })[0]

  // 称呼：群就叫「这个群」；私聊有昵称用昵称，只有一串数字就用「这个人」
  // （截半截数字比不写还难看，prompt 里她自己知道在跟谁说话）
  let 谁 = '这个群'
  if (scope.kind !== 'group') {
    const lb = String(scope.label ?? '').replace(/^用户\s*/, '').trim()
    谁 = lb && !/^\d+$/.test(lb) && lb.length <= 10 ? lb : '这个人'
  }
  const parts = []
  parts.push(`${谁}：记得 ${items.length} 件事${热.length && 热.length !== items.length ? `，${热.length} 件还热着` : ''}。`)
  if (traits.length) parts.push(`偏好：${traits.join('、')}。`)
  if (topics.length) parts.push(`常提到：${topics.join('、')}。`)
  if (最近) parts.push(`最近：${短(最近.text, 20)}`)

  let summary = parts.join('')
  if (summary.length > MAX_SUMMARY) summary = summary.slice(0, MAX_SUMMARY - 1) + '…'

  return {
    summary,
    traits,
    topics,
    total: items.length,
    hot: 热.length,
    updated: new Date().toISOString(),
  }
}

/** 重算并挂回分片（不落盘，调用方 saveScope）。 */
export function applyProfile(scope, graph) {
  scope.profile = buildProfile(scope, graph)
  return scope
}

/**
 * 群成员聚合：谁说过多少条、最近一次是什么时候。
 *
 * 群里「我」认不出是谁，但消息头带了昵称（ingest 早解析好了），
 * 记下来至少能回答「上次谁提过这事」。只留昵称，不落 QQ 号——
 * 注入进提示词的东西越少越好。
 */
export function buildMembers(scope, limit = 8) {
  const acc = new Map()
  for (const it of scope.items || []) {
    if (it.state === 'archived' || it.state === 'superseded' || it.state === 'expired') continue
    const name = String(it.speaker ?? '').trim()
    if (!name) continue
    let m = acc.get(name)
    if (!m) {
      m = { name, items: 0, last: '' }
      acc.set(name, m)
    }
    m.items += 1
    const at = String(it.observedAt || it.created || '')
    if (at > m.last) m.last = at
  }
  return [...acc.values()]
    .map((m) => ({ ...m, last: m.last ? m.last.slice(5, 10) : '' }))
    .sort((a, b) => b.items - a.items || a.name.localeCompare(b.name))
    .slice(0, limit)
}
