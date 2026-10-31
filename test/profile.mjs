/**
 * test/profile.mjs —— 画像自检
 *   node test/profile.mjs
 */

import { buildProfile, toTrait } from '../lib/profile.js'
import { buildGraph } from '../lib/graph.js'
import { emptyScope } from '../lib/store.js'

let pass = 0
let fail = 0
const t = (name, fn) => {
  try { fn(); pass += 1; console.log('  ok  ' + name) }
  catch (e) { fail += 1; console.log('  !!  ' + name + ' —— ' + String(e?.message ?? e)) }
}
const ok = (v, m) => { if (!v) throw new Error(m || '断言失败') }

const now = new Date().toISOString()
const item = (id, text, kind, extra = {}) => ({ id, text, kind, conf: 0.8, hits: 1, state: 'active', created: now, lastHit: now, ...extra })

t('偏好去掉「喜欢」前缀', () => {
  ok(toTrait('老爹最喜欢吃烤鱼') === '吃烤鱼', '得到：' + toTrait('老爹最喜欢吃烤鱼'))
})

t('空分片也有画像', () => {
  const sc = emptyScope('private', '1', '用户 1')
  const p = buildProfile(sc)
  ok(p.summary.includes('记得 0 件事'), p.summary)
  ok(Array.isArray(p.traits), 'traits 不是数组')
})

const sc = emptyScope('private', '123456789', '用户 123456789')
sc.items = [
  item('a', '老爹最喜欢吃烤鱼', 'pref'),
  item('b', '老爹住在杭州', 'fact'),
  item('c', '老爹在D盘上班', 'fact', { hits: 3 }),
  item('d', '老爹明天8:30上班', 'event', { lastHit: new Date(Date.now() + 1000).toISOString() }),
]
const g = buildGraph([sc])
const p = buildProfile(sc, g)

t('traits 抽到偏好', () => {
  ok(p.traits.includes('吃烤鱼'), JSON.stringify(p.traits))
})

t('topics 抽到实体', () => {
  ok(p.topics.includes('杭州'), JSON.stringify(p.topics))
})

t('summary 有数量、偏好、最近', () => {
  ok(p.summary.includes('4 件事'), p.summary)
  ok(p.summary.includes('偏好'), p.summary)
  ok(p.summary.includes('最近'), p.summary)
})

t('summary 不超过 120 字', () => {
  ok(p.summary.length <= 120, '长度 ' + p.summary.length)
})

t('群画像用「这个群」', () => {
  const gsc = emptyScope('group', '123456789', '群 123456789')
  gsc.items = [item('x', '老爹住在杭州', 'fact')]
  const gp = buildProfile(gsc)
  ok(gp.summary.startsWith('这个群'), gp.summary)
})

t('归档条目不进画像', () => {
  const s2 = emptyScope('private', '2', '用户 2')
  s2.items = [item('z', '老爹住在杭州', 'fact', { state: 'archived' })]
  const p2 = buildProfile(s2)
  ok(p2.summary.includes('记得 0 件事'), p2.summary)
})

t('没有图谱也不炸（自己现建一份）', () => {
  const p3 = buildProfile(sc, undefined)
  ok(typeof p3.summary === 'string' && p3.summary.length > 0, '空摘要')
})

console.log('\n示例：' + p.summary)
console.log(`${pass} 通过 · ${fail} 失败`)
process.exit(fail ? 1 : 0)
