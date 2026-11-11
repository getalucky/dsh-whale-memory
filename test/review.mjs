/**
 * review.mjs —— 变更触发的一次性复审
 *
 * 验的是：指纹只看内容、不看权重；记忆变了才提醒；确认过之后转复核版；
 * 冷却期内不重复催；回写之后提醒消失；分片之间互不影响。
 */
import assert from 'node:assert'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  scopeFingerprint, buildReviewText, markReviewed, reviewTextFor, reviewStatus,
  MIN_ITEMS, COOLDOWN_MS, REVIEW_STATE, DEFAULT_QUESTION,
} from '../lib/review.js'
import { ensureDirs, addItem, saveScope, loadScope, emptyScope } from '../lib/store.js'
import { registerTools } from '../lib/tools.js'
import { createHarness } from './eval/harness.mjs'

delete process.env.DSH_MEMORY_REVIEW
delete process.env.DSH_MEMORY_REVIEW_QUESTION
// 隔离要两边都能触发才测得出来；默认只开私聊
process.env.DSH_MEMORY_REVIEW_SCOPES = 'private,group'

let pass = 0
const ok = (name) => { pass += 1; console.log('  ok', name) }

const 造条目 = (n, { state = 'active' } = {}) =>
  Array.from({ length: n }, (_, i) => ({
    id: `m_${i}`, text: `第 ${i} 条记忆`, kind: 'fact', state, conf: 0.6,
    observedAt: '2026-11-01T00:00:00.000Z',
  }))

// ---- 纯函数 ----
const a = { kind: 'private', id: '900', scope: 'private:900', items: 造条目(6) }
const b = structuredClone(a)
assert.equal(scopeFingerprint(a), scopeFingerprint(b), '同内容指纹一致')

const 权重变了 = structuredClone(a)
权重变了.items[0].weight = 0.99
权重变了.items[0].hits = 42
assert.equal(scopeFingerprint(a), scopeFingerprint(权重变了), '权重/命中变化不算记忆变更')

const 文本变了 = structuredClone(a)
文本变了.items[0].text = '改过的说法'
assert.notEqual(scopeFingerprint(a), scopeFingerprint(文本变了), '文本变了要算变更')

const 归档了 = structuredClone(a)
归档了.items[0].state = 'archived'
assert.notEqual(scopeFingerprint(a), scopeFingerprint(归档了), '归档也算变更（关系断了要能感知）')

assert.equal(buildReviewText({ ...a, items: 造条目(MIN_ITEMS - 1) }, null), '', '素材太少不审')
const 初判 = buildReviewText(a, null)
assert.ok(初判.includes('记忆复审'), 初判)
assert.ok(初判.includes(DEFAULT_QUESTION), 初判)
assert.ok(初判.includes('memory_review'), 初判)

const prev = {
  stamp: scopeFingerprint(a), count: a.items.length,
  at: new Date(Date.now() - COOLDOWN_MS - 1000).toISOString(),
  verdict: 'not-yet', reason: '还差点火候', relation: null,
}
assert.equal(buildReviewText(a, prev), '', '指纹一致且过了冷却也不再催')

const prevYes = {
  ...prev,
  relation: { label: '恋人', status: 'confirmed', since: Date.now() - 86400000 },
}
const 复核 = buildReviewText(文本变了, prevYes)
assert.ok(复核.includes('关系复核'), 复核)
assert.ok(复核.includes('恋人'), 复核)
assert.ok(复核.includes('断没断'), 复核)
ok('指纹与提醒文案')

// ---- 状态机 ----
const root = await mkdtemp(join(tmpdir(), 'whale-review-'))
await ensureDirs(root)
const sc = emptyScope('private', '900')
sc.items = 造条目(MIN_ITEMS + 1)
await saveScope(root, sc)

let r = await markReviewed(root, { scope: sc, verdict: 'maybe', reason: '说不清楚的事情' })
assert.equal(r.ok, false)
r = await markReviewed(root, { scope: sc, verdict: 'yes', reason: '短' })
assert.equal(r.ok, false, '理由太短要拒绝')
r = await markReviewed(root, { scope: sc, verdict: 'yes', reason: '那天她说别走了，我就确定是了', relationLabel: '恋人' })
assert.equal(r.ok, true)
assert.equal(r.relation.status, 'confirmed')
assert.equal(r.relation.label, '恋人')
const since = r.relation.since

const 已存 = JSON.parse(await readFile(join(root, REVIEW_STATE), 'utf8'))
assert.equal(已存.scopes['private:900'].verdict, 'yes')

// 同一份内容不再提醒
assert.equal(await reviewTextFor(root, sc), '', '回写后本轮提醒消失')

// 又有新记忆：还在冷却里，先不催
const sc2 = structuredClone(sc)
sc2.items.push({ id: 'm_new', text: '她今天提了一次搬家', kind: 'event', state: 'active' })
await saveScope(root, sc2)
assert.equal(await reviewTextFor(root, sc2), '', '冷却期内不重复催')

// 把上次复审时间往前挪，模拟过了一阵子
const stFile = join(root, REVIEW_STATE)
const st0 = JSON.parse(await readFile(stFile, 'utf8'))
st0.scopes['private:900'].at = new Date(Date.now() - COOLDOWN_MS - 1000).toISOString()
await writeFile(stFile, JSON.stringify(st0, null, 2) + '\n', 'utf8')
const 再催 = await reviewTextFor(root, sc2)
assert.ok(再催.includes('关系复核'), 再催)

// 断了的判定保留 label 和第一次确认时间
r = await markReviewed(root, { scope: sc2, verdict: 'broken', reason: '那天吵完之后再也没找过我' })
assert.equal(r.relation.status, 'broken')
assert.equal(r.relation.label, '恋人')
assert.equal(r.relation.since, since, '断的时间不该覆盖确认时间')
ok('回写与关系状态机')

// ---- 走真实工具链路 ----
const 私聊用例 = { id: 'pv', turns: [
  '记住，我在杭州上班',
  '记住，我一般晚上十点以后才回消息',
  '记住，我不吃香菜',
  '记住，我养了只猫叫年糕',
  '记住，我最近在准备换工作',
  '记住，我最烦别人催我做决定',
] }
const 群聊用例 = { id: 'gp', kind: 'group', turns: [
  '记住，群里周六要交房租',
  '记住，群里下周三团建',
  '记住，群主叫老张',
  '记住，群里十点以后不许刷屏',
  '记住，群文件都在置顶里',
] }
const h = await createHarness([私聊用例, 群聊用例])
await h.feed(私聊用例)
await h.distill(私聊用例)
await h.feed(群聊用例)
await h.distill(群聊用例)

await h.say('pv', '在吗')
const 私片 = await h.scopeOf('pv')
const 私文本 = await reviewTextFor(h.root, 私片)
assert.ok(私文本.includes('记忆复审'), 私文本)
ok('私聊分片有变更时出现复审提醒')

// 群和私聊各有各的复审状态：私聊那边回写，群这边不能被带安静
await h.say('gp', '群里说句话')
const 群片 = await h.scopeOf('gp')
const 群文本 = await reviewTextFor(h.root, 群片)
assert.ok(群文本.includes('记忆复审'), 群文本)
assert.notEqual(scopeFingerprint(群片), scopeFingerprint(私片))
ok('分片隔离：群和私聊各自算变更')

const tools = new Map()
registerTools({ tools: { register(spec) { tools.set(spec.name, spec); return () => {} } } }, { root: h.root, log: () => {} })
assert.ok(tools.has('memory_review'), '工具要注册上')

// 宿主会给 execute 传 agent，这里照着补一个，免得落到「最近活跃」（此刻是群）
const execOf = (caseId) => ({ agent: { session: { header: { id: h.src.get(caseId).sid } } } })
const 回写 = await tools.get('memory_review').execute({
  verdict: 'not-yet',
  reason: '还没有到那一步，最近都在聊工作',
}, execOf('pv'))
assert.equal(回写.ok, true, JSON.stringify(回写))
assert.equal(await reviewTextFor(h.root, 私片), '', '工具回写后提醒消失')
assert.ok((await reviewTextFor(h.root, 群片)).includes('记忆复审'), '私聊回写不该把群也带安静')

const 乱写 = await tools.get('memory_review').execute({ verdict: 'yes', reason: '好' }, execOf('pv'))
assert.equal(乱写.ok, false)

const st = await reviewStatus(h.root, 私片)
assert.equal(st.due, false)
assert.equal(st.last.verdict, 'not-yet')
ok('memory_review 工具闭环')

await h.dispose()
await rm(root, { recursive: true, force: true })
console.log(`\n全部通过：${pass} 项`)
