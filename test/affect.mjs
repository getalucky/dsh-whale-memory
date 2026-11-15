/**
 * test/affect.mjs —— 情绪层（文档第十四章）
 *   node test/affect.mjs
 *
 * 验的是最容易做错的几条：
 *   · 半衰期折算对得上，且幂等
 *   · 冲量不会越上限，负向事件不会把分量打成负数
 *   · 重画三关（跨档 / 冷却 / 次数）真拦得住，拦的时候不更新签名
 *   · 渲染是一行、不含数值、不改口径
 *   · 状态不落进 scopes，关掉开关就完全空转
 */

import assert from 'node:assert'
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  emptyState, valueAt, impulse, snapshot, applyMood, stanceOf, affectPaths,
} from '../lib/affect/state.js'
import { readEvents } from '../lib/affect/events.js'
import { renderLine, signature, bucketOf } from '../lib/affect/render.js'
import { parseAppraisal } from '../lib/affect/appraise.js'
import { dayLine } from '../lib/affect/journal.js'
import { createAffect, paintDecision, REWRITE } from '../lib/affect/index.js'
import { EMOTIONS } from '../lib/affect/lexicon.js'

let pass = 0
const ok = (name) => { pass += 1; console.log('  ok', name) }

// ---- 数学 ----

const H = 3600 * 1000
assert.equal(valueAt({ v: 1, at: 0 }, 3 * H, { tauHours: 3 }), 0.5)
assert.equal(valueAt({ v: 1, at: 0 }, 6 * H, { tauHours: 3 }), 0.25)
assert.equal(valueAt(null, 9 * H, { base: 0.15 }), 0.15)
// 重复折算幂等：同一 now 算两次结果一样
assert.equal(valueAt({ v: 0.8, at: 0 }, 5 * H, { tauHours: 3 }), valueAt({ v: 0.8, at: 0 }, 5 * H, { tauHours: 3 }))
// 有基线时收敛到基线，不是 0
const near = valueAt({ v: 1, at: 0 }, 100 * H, { tauHours: 3, base: 0.2 })
assert.ok(Math.abs(near - 0.2) < 1e-6)
ok('衰减：半衰期准、幂等、收敛到基线')

assert.equal(impulse(0, 0.5), 0.5)
assert.equal(impulse(0.5, 0.5), 0.75)
assert.equal(impulse(0.9, 0.5), 0.8, '0.95 也要被 cap 0.8 挡住')
assert.ok(impulse(1, 0.9) <= 0.8, 'cap 是 0.8，1 也不能越')
assert.equal(impulse(0.2, -0.1), 0.12)
ok('冲量：饱和、封顶、能减')

// ---- 规则 ----

const praise = readEvents({ text: '你今天好厉害', hour: 12 })
assert.ok(praise.some((e) => e.kind === '得意'))
const abuse = readEvents({ text: '你真笨，闭嘴', hour: 12 })
assert.ok(abuse.some((e) => e.kind === '生气'))
assert.ok(abuse.every((e) => e.i <= 0.5))
assert.equal(readEvents({ text: '', hour: 12 }).length, 0)
const gap = readEvents({ text: '在吗', hour: 12, gapMs: 13 * H })
assert.ok(gap.some((e) => e.kind === '开心'))
ok('规则快路：夸 / 骂 / 久别都认，单条强度不越 0.5')

// ---- 渲染 ----

const st = emptyState()
const snap0 = snapshot(st, Date.now())
const line0 = renderLine(snap0, 'qq:1')
assert.ok(line0.startsWith('【此刻】'))
assert.ok(line0.length <= 100, `一行不能太长：${line0.length}`)
assert.ok(!/\d\.\d/.test(line0), '注入里不许出现小数')
assert.ok(line0.includes('得意'), '底色：没情绪也带三分屑')

applyMood(st, '委屈', 0.5, Date.now())
const snap1 = snapshot(st, Date.now())
const line1 = renderLine(snap1, 'qq:1')
assert.ok(line1.includes('委屈'))
assert.ok(line1.includes('话少一点'))
assert.notEqual(signature(snap1, 'qq:1'), signature(snap0, 'qq:1'))
ok('渲染：一行、无数字、带行为指令，档位变了签名才变')

// ---- 重画三关 ----

const now = Date.now()
const prev = { sig: 'a', at: now - REWRITE.minGapMs - 1, count: 0, mood: { ...snap0.mood } }
assert.equal(paintDecision({ prev: null, snap: snap1, peer: 'qq:1', now, sig: 'b' }).reason, 'first')
assert.equal(paintDecision({ prev, snap: snap0, peer: 'qq:1', now, sig: 'a' }).reason, 'same')

const small = { mood: { ...snap0.mood } }
small.mood['得意'] = (small.mood['得意'] || 0) + 0.1
assert.equal(paintDecision({ prev, snap: small, peer: 'qq:1', now, sig: 'b' }).reason, 'delta')

const cooledButSoon = { ...prev, at: now - 1000 }
assert.equal(paintDecision({ prev: cooledButSoon, snap: snap1, peer: 'qq:1', now, sig: 'b' }).reason, 'cooldown')

const budgetOut = { ...prev, count: REWRITE.maxPerSession }
assert.equal(paintDecision({ prev: budgetOut, snap: snap1, peer: 'qq:1', now, sig: 'b' }).reason, 'budget')

assert.equal(paintDecision({ prev, snap: snap1, peer: 'qq:1', now, sig: 'b' }).paint, true)
ok('重画三关：首次 / 同签名 / 变化不够 / 冷却 / 次数，各有各的理由')

// ---- 状态落点、日记、开关 ----

const root = await mkdtemp(join(tmpdir(), 'whale-affect-'))
try {
  process.env.DSH_MEMORY_AFFECT = ''
  const a = createAffect({ root })
  await a.ready()
  await a.noteUserMessage({ text: '你真厉害', peer: 'qq:1001', at: Date.now() })
  const s = a.status()
  assert.ok(s.mood.some((m) => m.name === '得意'))
  assert.ok(s.stance.some((x) => x.peer === 'qq:1001'))
  // 面板/status.md 的人读摘要：只有名字和档位，不出现数值
  assert.ok(typeof s.summary === 'string' && s.summary.length > 0)
  assert.ok(!/\d/.test(s.summary), s.summary)
  const moodSnap = a.mood()
  assert.ok(moodSnap && typeof moodSnap['得意'] === 'number')
  await a.flush()

  const p = affectPaths(root)
  const body = JSON.parse(await readFile(p.state, 'utf8'))
  assert.equal(body.version, 1)
  assert.ok(body.stance['qq:1001'])
  const dirs = await readdir(root)
  assert.ok(!dirs.includes('scopes'), '情绪不能建 scopes')
  assert.equal(await stat(p.state).then((x) => x.isFile()), true)

  const ev = await readFile(p.events, 'utf8')
  assert.ok(ev.includes('得意'))
  assert.ok(!ev.includes('你真厉害'), '事件流水不存原话')

  // 日记那行：同一天的事件聚成一行，没有事件就没有
  const today = new Date()
  const day = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
  const line = await dayLine(root, day)
  assert.ok(line.startsWith('> 今日心情：'))
  assert.ok(!(await dayLine(root, '2000-01-01')))

  // 同一个人第二次说话：stance.at 更新，同一个 sid 注入文本不抖
  const t1 = a.lineFor('sid-1', 'qq:1001')
  const t2 = a.lineFor('sid-1', 'qq:1001')
  assert.equal(t1, t2)

  const off = createAffect({ root, enabled: false })
  assert.equal(off.enabled, false)
  assert.equal(off.lineFor('sid-1', 'qq:1001'), '')
  assert.equal(await off.noteUserMessage({ text: '你真棒', peer: 'qq:1' }), null)

  // 环境变量关掉时，即使 config 开着也整体空转
  process.env.DSH_MEMORY_AFFECT = 'off'
  const envOff = createAffect({ root })
  assert.equal(envOff.enabled, false)
  assert.equal(envOff.mood(), null)
  process.env.DSH_MEMORY_AFFECT = ''

  await a.reset()
  const empty = JSON.parse(await readFile(p.state, 'utf8'))
  assert.deepEqual(Object.keys(empty.mood || {}), [])
  ok('面板摘要 / 闸门快照 / 环境变量与 reset')
  ok('落点与开关：state/events 在 affect/ 下、不存原话、关掉就空转')
} finally {
  await rm(root, { recursive: true, force: true })
}

// ---- 旁路解析 ----

const app = parseAppraisal('[{"text":"今天聊了配置","kind":"fact"},{"affect":[{"k":"得意","i":0.6},{"k":"胡编","i":0.9}]}]')
assert.equal(app.length, 1)
assert.equal(app[0].kind, '得意')
assert.ok(app[0].i <= 0.5)
assert.equal(parseAppraisal('不是数组').length, 0)
assert.equal(parseAppraisal('[{"affect":[{"k":"开心","i":-1}]}]').length, 0)
ok('旁路解析：词表外的丢掉、强度封顶、坏输入不崩')

// 基线值不能反客为主：她没情绪时，状态表里不该自己长出来
assert.ok(EMOTIONS['得意'].base > 0)
assert.equal(stanceOf(snapshot(emptyState(), Date.now()), 'qq:none').close, 0.55)

console.log(`\naffect: ${pass} 项通过`)
