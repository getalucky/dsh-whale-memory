/**
 * visibility.mjs —— 分片可见性（隐私边界）
 *
 * 验的是：群是公开场合，搜不到私聊；私聊能看自己、本机和圈子池；本机能看全部；
 * 公共池所有会话可读但只有本机能改；显式 scope 也不能越过边界；
 * read / profile / pending 跟 search 同一口径。
 */
import assert from 'node:assert'

import { visibleScope, writableScope, filterScopes } from '../lib/visibility.js'
import { addItem, loadScope, saveScope } from '../lib/store.js'
import { registerTools } from '../lib/tools.js'
import { createHarness } from './eval/harness.mjs'

let pass = 0
const ok = (name) => { pass += 1; console.log('  ok', name) }

// ---- 纯函数 ----
const 群A = { kind: 'group', id: '111' }
const 群B = { kind: 'group', id: '222' }
const 私A = { kind: 'private', id: '900' }
const 私B = { kind: 'private', id: '901' }
const 本机 = { kind: 'local', id: 'dsh' }
const 仓库 = { kind: 'project', id: 'wk' }
const 公共 = { kind: 'public', id: 'web' }

assert.equal(visibleScope(群A, 群A), true)
assert.equal(visibleScope(群A, 群B), false, '群不能看别的群')
assert.equal(visibleScope(群A, 私A), false, '群不能看私聊')
assert.equal(visibleScope(群A, 本机), false, '群不能看本机记忆')
assert.equal(visibleScope(群A, 仓库), true, '仓库共识对所有场合可见')
assert.equal(visibleScope(群A, 公共), true, '公共池群聊可读')
assert.equal(visibleScope(私A, 私A), true)
assert.equal(visibleScope(私A, 私B), false, '私聊不能看别人的私聊')
assert.equal(visibleScope(私A, 本机), true, '私聊可以看自己本机的记忆')
assert.equal(visibleScope(私A, 群A), true, '私聊可以读圈子池')
assert.equal(visibleScope(私A, 公共), true, '公共池私聊可读')
assert.equal(visibleScope(本机, 私A), true, '本机是拥有者的机器，能看全部')
assert.equal(visibleScope(本机, 群A), true)
assert.equal(visibleScope(本机, 公共), true)
assert.equal(visibleScope(null, 本机), false, '来源不明时按最窄算')
assert.equal(visibleScope(null, 公共), false, '来源不明时公共池也不放开')
assert.equal(filterScopes(群A, [群A, 群B, 私A, 仓库, 公共]).length, 3)
assert.equal(writableScope(群A, 公共), false, '群里不能改公共池')
assert.equal(writableScope(私A, 公共), false, '私聊不能改公共池')
assert.equal(writableScope(本机, 公共), true, '只有本机能改公共池')
assert.equal(writableScope(群A, 群A), true)
assert.equal(writableScope(群A, 群B), false)
ok('可见性规则：群 / 私聊 / 本机 / 仓库 / 公共池')

// ---- 走真实工具 ----
const h = await createHarness([
  { id: 'pv', turns: [] },
  { id: 'gp', kind: 'group', turns: [] },
])
const tools = new Map()
registerTools({ tools: { register(spec) { tools.set(spec.name, spec); return () => {} } } }, { root: h.root, log: () => {} })

const 私聊 = { id: 'pv', turns: ['记住，我住在杭州', '记住，我特别喜欢喝冰美式'] }
const 群聊 = { id: 'gp', turns: ['记住，周五群里要交房租'] }
await h.feed(私聊); await h.distill(私聊)
await h.feed(群聊); await h.distill(群聊)

// 公共池不是会话来源，直接造一条，验证群/私聊都读得到、但都改不得
const publicScope = await loadScope(h.root, 'public', 'web')
const 公共条目 = addItem(publicScope, { text: '公共池：dsh-see-now 出了准实时视觉插件', kind: 'fact', conf: 0.5, source: 'test' })
await saveScope(h.root, publicScope)

const 私条目 = (await h.itemsOf('pv')).filter((x) => x.state === 'active')
assert.ok(私条目.length >= 1, JSON.stringify(私条目.map((x) => x.text)))

// 当前活跃会话现在是群
const 群搜私 = await tools.get('search_memory').execute({ query: '杭州' })
assert.ok(群搜私.results.every((x) => !x.scope.startsWith('private:')), JSON.stringify(群搜私.results))
assert.ok(群搜私.results.every((x) => !x.summary.includes('杭州')), JSON.stringify(群搜私.results))
ok('群会话默认搜不到私聊条目')

const 群显式 = await tools.get('search_memory').execute({ query: '杭州', scope: 'private:90000000' })
assert.equal(群显式.ok, false)
assert.ok(/群会话/.test(群显式.text), 群显式.text)
ok('群会话显式给私聊 scope 也拒绝')

const 群读 = await tools.get('read_memory').execute({ id: 私条目[0].id })
assert.equal(群读.ok, false)
assert.ok(/群会话/.test(群读.why), 群读.why)
ok('群会话读不到私聊正文')

const 群画像 = await tools.get('profile_show').execute({ scope: 'private:90000000' })
assert.equal(群画像.ok, false)
ok('群会话看不到私聊画像')

// 群自己的记忆照样能查
const 群搜群 = await tools.get('search_memory').execute({ query: '房租' })
assert.ok(群搜群.count >= 1, JSON.stringify(群搜群))
ok('群会话查本群正常')

// 公共池：群聊读得到，但改不得
const 群搜公共 = await tools.get('search_memory').execute({ query: '视觉插件' })
assert.ok(群搜公共.results.some((x) => x.scope === 'public:web'), JSON.stringify(群搜公共.results))
const 群删公共 = await tools.get('memory_forget').execute({ id: 公共条目.id })
assert.equal(群删公共.ok, false, JSON.stringify(群删公共))
assert.ok(/公共记忆池/.test(群删公共.why), 群删公共.why)
ok('群读得到公共池，改不了')

// 回到私聊：自己的 + 本机的都能看
await h.say('pv', '在吗')
const 私搜 = await tools.get('search_memory').execute({ query: '杭州' })
assert.ok(私搜.count >= 1, JSON.stringify(私搜))
assert.ok(私搜.results.every((x) => x.scope.startsWith('private:')), JSON.stringify(私搜.results))
const 私读 = await tools.get('read_memory').execute({ id: 私条目[0].id })
assert.ok(私读.ok, JSON.stringify(私读))
// 新规则：私聊能读圈子池和公共池，但读不到别的私聊
const 私搜群 = await tools.get('search_memory').execute({ query: '房租' })
assert.ok(私搜群.results.some((x) => x.scope.startsWith('group:')), JSON.stringify(私搜群.results))
const 私搜公共 = await tools.get('search_memory').execute({ query: '视觉插件' })
assert.ok(私搜公共.results.some((x) => x.scope === 'public:web'), JSON.stringify(私搜公共.results))
const 私删公共 = await tools.get('memory_forget').execute({ id: 公共条目.id })
assert.equal(私删公共.ok, false)
ok('私聊查自己正常，能带出圈子池和公共池')

await h.dispose()
console.log(`\n全部通过：${pass} 项`)
