/**
 * test/graph.mjs —— L3 图谱 + 界面接口自检
 *
 * 不连宿主，用假的 ctx.webServer 把路由抓下来直接调。
 *   node test/graph.mjs
 */

import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { extractTriples, buildGraph, saveGraph, loadGraph, neighbors, renderGraph, topNodes } from '../lib/graph.js'
import { registerWebApi, API_PREFIX } from '../lib/webapi.js'
import { emptyScope, saveScope, paths, ensureDirs } from '../lib/store.js'

let pass = 0
let fail = 0
const t = (name, fn) => {
  try {
    fn()
    pass += 1
    console.log('  ok  ' + name)
  } catch (e) {
    fail += 1
    console.log('  !!  ' + name + ' —— ' + String(e?.message ?? e))
  }
}
const eq = (a, b) => {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`)
}
const ok = (v, m) => { if (!v) throw new Error(m || '断言失败') }

// ---- 抽取 ----
t('在X上班', () => {
  const r = extractTriples('老爹在D盘上班')
  eq(r[0].s, '老爹')
  eq(r[0].rel, '上班@')
  eq(r[0].o, 'D盘')
  eq(r[0].oType, 'place')
})

t('住在X（私聊里「我」= 主人）', () => {
  const r = extractTriples('我住在杭州', { self: '老爹' })
  eq([r[0].s, r[0].rel, r[0].o], ['老爹', '住在', '杭州'])
})

t('群里的「我」不认主，宁可不抽', () => {
  eq(extractTriples('我住在杭州', { self: null }), [])
})

t('群里说「老爹」照抽', () => {
  const r = extractTriples('老爹住在杭州', { self: null })
  eq(r[0].s, '老爹')
})

t('喜欢X', () => {
  const r = extractTriples('老爹最喜欢吃烤鱼')
  ok(r.some((x) => x.rel === '喜欢' && x.o.includes('烤鱼')), '没抽到喜欢')
})

t('我是Y', () => {
  const r = extractTriples('大肥鱼是鲸鱼')
  eq([r[0].s, r[0].rel, r[0].o], ['大肥鱼', '是', '鲸鱼'])
})

t('时间状语不当主语（明天也是8:30上班）', () => {
  eq(extractTriples('明天也是8:30上班', { self: '老爹' }), [])
  eq(extractTriples('明天也是8:30上班'), [])
})

t('副词开头不当主语', () => {
  eq(extractTriples('也就是个玩笑'), [])
})

t('谓语不当宾语（我是来打工的）', () => {
  const r = extractTriples('我是来打工的')
  ok(!r.some((x) => x.rel === '是'), JSON.stringify(r))
})

t('问句不瞎抽', () => {
  eq(extractTriples('你明天上班吗'), [])
})

t('长句不当实体', () => {
  const r = extractTriples('我住在今天下午三点要去公司开一个特别长的会议的地方')
  eq(r, [])
})

// ---- 建图 ----
const scopes = [
  { ...emptyScope('private', '1', '私聊 A'), items: [
    { id: 'a1', text: '老爹在D盘上班', kind: 'fact', conf: 0.8, hits: 2, state: 'active', created: '2026-10-30T03:00:00Z', lastHit: '2026-10-30T03:00:00Z' },
    { id: 'a2', text: '老爹住在杭州', kind: 'fact', conf: 0.8, hits: 0, state: 'active', created: '2026-10-30T03:00:00Z', lastHit: '2026-10-30T03:00:00Z' },
  ] },
  { ...emptyScope('group', '2', '群 B'), items: [
    { id: 'b1', text: '老爹在D盘上班', kind: 'fact', conf: 0.7, hits: 1, state: 'active', created: '2026-10-30T03:00:00Z', lastHit: '2026-10-30T03:00:00Z' },
  ] },
]

t('同一实体跨分片合并成一个节点', () => {
  const g = buildGraph(scopes)
  const 老爹 = g.nodes.filter((n) => n.name === '老爹')
  eq(老爹.length, 1)
  eq(老爹[0].scopes.sort(), ['group:2', 'private:1'])
})

t('重复关系合成一条边并加权', () => {
  const g = buildGraph(scopes)
  const e = g.edges.filter((x) => x.rel === '上班@')
  eq(e.length, 1)
  ok(e[0].weight > 1.5, '权重没涨：' + e[0].weight)
})

t('1 跳邻居', () => {
  const g = buildGraph(scopes)
  const nb = neighbors(g, '老爹', 1)
  ok(nb.nodes.some((n) => n.name === '杭州'), '邻居里没有杭州')
})

t('渲染只给相关边', () => {
  const g = buildGraph([
    ...scopes,
    { ...emptyScope('group', '3', '群 C'), items: [
      { id: 'c1', text: '大肥鱼住在深海', kind: 'fact', conf: 0.6, hits: 0, state: 'active', created: '2026-10-30T03:00:00Z', lastHit: '2026-10-30T03:00:00Z' },
    ] },
  ])
  const s = renderGraph(g, ['老爹在D盘上班'])
  ok(s.includes('D盘'), '渲染丢了 D 盘')
  ok(s.includes('杭州'), '老爹的一跳关系没带上')
  ok(!s.includes('深海'), '把完全无关的深海也塞进去了')
})

t('topNodes 排序不炸', () => {
  const g = buildGraph(scopes)
  const top = topNodes(g, 5)
  eq(top[0].name, '老爹')
})

// ---- 落盘 ----
const root = await mkdtemp(join(tmpdir(), 'whale-graph-'))
await ensureDirs(root)
await saveScope(root, scopes[0])
const g0 = buildGraph([scopes[0]])
await saveGraph(root, g0)
const g1 = await loadGraph(root)
t('保存后能读回', () => { eq(g1.nodes.length, g0.nodes.length); eq(g1.edges.length, g0.edges.length) })

// ---- 界面接口 ----
const routes = new Map()
const fakeCtx = { webServer: { register({ path, handler }) { routes.set(path, handler); return () => routes.delete(path) } } }
const api = registerWebApi(fakeCtx, { root, log: () => {}, version: '0.2.0' })
t('注册了 11 条路由', () => eq(routes.size, 11))

const call = (p) => new Promise((resolve) => {
  const chunks = []
  const res = { statusCode: 0, setHeader() {}, end(s) { chunks.push(s); resolve(JSON.parse(chunks.join(''))) } }
  routes.get(API_PREFIX + p)({ url: API_PREFIX + p }, res)
})

const state = await call('/state')
t('/state 返回分片', () => { eq(state.ok, true); ok(state.scopes.length >= 1, '没有分片') })
const graph = await call('/graph')
t('/graph 有节点', () => { ok(graph.nodes.length >= 2, '节点太少') })
const audit = await call('/audit')
t('/audit 返回数组', () => { eq(audit.ok, true); ok(Array.isArray(audit.rows)) })
const obs = await call('/obs')
t(' /obs 返回人格/信任/分片', () => { eq(obs.ok, true); ok(obs.persona && obs.trust, '缺 persona/trust'); ok(Array.isArray(obs.vault), 'vault 不是数组') })
const refresh = await call('/refresh')
t('/refresh 能重建', () => { eq(refresh.ok, true) })

api.dispose()
t('dispose 后路由清空', () => eq(routes.size, 0))

await rm(root, { recursive: true, force: true })

console.log(`\n${pass} 通过 · ${fail} 失败`)
process.exit(fail ? 1 : 0)
