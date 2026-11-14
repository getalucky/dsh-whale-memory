/**
 * test/graph.mjs —— L3 图谱 + 界面接口自检
 *
 * 不连宿主，用假的 ctx.webServer 把路由抓下来直接调。
 *   node test/graph.mjs
 */

import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { extractTriples, buildGraph, saveGraph, loadGraph, neighbors, renderGraph, topNodes, mergeTriples } from '../lib/graph.js'
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

t('问句不拆成「A 是 B」', () => {
  eq(extractTriples('以后是不是还得配个产检系统'), [])
  eq(extractTriples('用户询问是否需要更换LLM蒸馏模型'), [])
})

t('「不喜欢」不被拆成「不…喜欢」', () => {
  const r = extractTriples('不列颠的鱼不喜欢别人称呼其为姐姐')
  eq(r[0].s, '不列颠的鱼')
  eq(r[0].rel, '不喜欢')
})

t('自称是单独成关系', () => {
  const r = extractTriples('云玥的汐眠自称是云玥的鱼')
  eq([r[0].s, r[0].rel, r[0].o], ['云玥的汐眠', '自称是', '云玥的鱼'])
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

t('LLM 三元组合进图谱', () => {
  const g = buildGraph(scopes, [
    { item: 'a1', s: '老爹', sType: 'person', rel: '养了', o: '小白', oType: 'thing' },
  ])
  const e = g.edges.find((x) => x.rel === '养了')
  ok(e, '没合进图谱')
  eq(e.origin, 'llm')
  ok(g.nodes.some((n) => n.name === '小白'), '宾语节点没建出来')
})

t('规则和 LLM 抽到同一条关系不重复加权', () => {
  const one = [{
    ...emptyScope('private', '9', '单条'),
    items: [{ id: 'z1', text: '老爹在D盘上班', kind: 'fact', state: 'active', created: '2026-10-30T03:00:00Z' }],
  }]
  const g = buildGraph(one, [{ item: 'z1', s: '老爹', sType: 'person', rel: '上班@', o: 'D盘', oType: 'place' }])
  eq(g.edges.find((x) => x.rel === '上班@').weight, 1)
})

t('三元组按条目去重，checked 标记可重复合并', () => {
  const a = mergeTriples([], [
    { item: 'm1', s: 'A', rel: '喜欢', o: 'B', at: 'x' },
    { item: 'm1', checked: true, at: 'x' },
  ])
  eq(a.length, 2)
  const b = mergeTriples(a, [{ item: 'm1', s: 'A', rel: '喜欢', o: 'B', at: 'y' }])
  eq(b.length, 2)
  eq(b.find((x) => x.rel === '喜欢').at, 'y')
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
t('注册了 33 条路由', () => eq(routes.size, 33))

let token = ''
const call = (p, { method = 'GET', body, headers = {}, auth = true } = {}) => new Promise((resolve) => {
  const payload = body == null ? '' : (typeof body === 'string' ? body : JSON.stringify(body))
  const req = {
    method,
    url: API_PREFIX + p,
    headers: Object.assign(
      { host: '127.0.0.1:3000' },
      auth && token ? { 'x-whale-token': token } : {},
      headers,
    ),
    on(ev, fn) {
      if (ev === 'data' && payload) fn(Buffer.from(payload))
      if (ev === 'end') fn()
      return req
    },
  }
  const chunks = []
  const res = {
    statusCode: 0,
    setHeader() {},
    end(s) {
      chunks.push(s)
      const out = JSON.parse(chunks.join('') || '{}')
      out.__status = this.statusCode
      resolve(out)
    },
  }
  routes.get(API_PREFIX + p)(req, res)
})

const boot = await call('/session', { auth: false })
token = String(boot.token || '')
t('先取会话令牌', () => { eq(boot.ok, true); ok(token.length >= 32, '令牌太短') })
const noToken = await call('/state', { auth: false })
t('不带令牌被拒', () => { eq(noToken.__status, 401) })
const crossSite = await call('/state', { headers: { origin: 'http://evil.example' } })
t('跨站 Origin 被拒', () => { eq(crossSite.__status, 403) })

const state = await call('/state')
t('/state 返回分片', () => { eq(state.ok, true); ok(state.scopes.length >= 1, '没有分片') })
const graph = await call('/graph')
t('/graph 有节点', () => { ok(graph.nodes.length >= 2, '节点太少') })
const audit = await call('/audit')
t('/audit 返回数组', () => { eq(audit.ok, true); ok(Array.isArray(audit.rows)) })
const obs = await call('/obs')
t(' /obs 返回人格/信任/分片', () => { eq(obs.ok, true); ok(obs.persona && obs.trust, '缺 persona/trust'); ok(Array.isArray(obs.vault), 'vault 不是数组') })
const formPost = await call('/refresh', { method: 'POST' })
t('POST 非 JSON 被拒', () => { eq(formPost.__status, 415) })
const refresh = await call('/refresh', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: {},
})
t('/refresh 能重建', () => { eq(refresh.ok, true) })
const diary = await call('/diary')
t('/diary 返回配置与列表', () => {
  eq(diary.ok, true)
  ok(Array.isArray(diary.days), 'days 不是数组')
  ok(diary.config && Number.isFinite(Number(diary.config.hour)), '缺 config')
})
const health = await call('/health')
t('/health 返回体检单', () => {
  eq(health.ok, true)
  ok(health.totals && Number.isFinite(health.totals.live), '缺 totals.live')
  ok(Array.isArray(health.scopes), 'scopes 不是数组')
})
const backup = await call('/backup/export')
t('/backup/export 返回 JSON 包', () => {
  eq(backup.ok, true)
  ok(backup.filename && backup.filename.endsWith('.json'), '缺 filename')
  eq(backup.data.format, 'whale-memory-bundle')
  ok(Array.isArray(backup.data.scopes), '缺 scopes')
})
const backupDry = await call('/backup/import', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: { data: backup.data, dryRun: true },
})
t('/backup/import 预演', () => {
  eq(backupDry.ok, true)
  eq(backupDry.dryRun, true)
  ok(backupDry.totals && Number.isInteger(backupDry.totals.added), '缺 totals')
})
const recallDry = await call('/import/history', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: { dir: join(root, 'no-sessions'), dryRun: true },
})
t('/import/history 预演', () => {
  eq(recallDry.ok, true)
  eq(recallDry.dryRun, true)
  eq(recallDry.totals.scanned, 0)
})

api.dispose()
t('dispose 后路由清空', () => eq(routes.size, 0))

await rm(root, { recursive: true, force: true })

console.log(`\n${pass} 通过 · ${fail} 失败`)
process.exit(fail ? 1 : 0)
