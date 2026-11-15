/**
 * test/gate.mjs —— 确认闸门灰度三态（文档 4.6）
 *   node test/gate.mjs
 *
 * off / warn 都放行，只有 enforce 真拦；warn 要在条目和审计里留下
 * 「这条 enforce 会拦」的记号，先看拒绝率再切档。
 */

import assert from 'node:assert'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { gateMode, gateDecision } from '../lib/gate.js'
import { moodLoad, moodCooldownMinutes, preferKnowledge, checkGate } from '../lib/beat/gate.js'
import { parseJudge, judgePrompt } from '../lib/beat/feedback.js'
import { registerTools } from '../lib/tools.js'
import { createHarness } from './eval/harness.mjs'

let pass = 0
const ok = (name) => { pass += 1; console.log('  ok', name) }

assert.equal(gateMode({ mode: 'warn' }), 'warn')
assert.equal(gateMode({ mode: '乱填' }), 'enforce')
process.env.DSH_MEMORY_GATE = 'off'
assert.equal(gateMode(), 'off')
delete process.env.DSH_MEMORY_GATE
ok('模式解析：配置优先，认不出来回 enforce')

const dec = gateDecision('warn', false)
assert.equal(dec.state, 'active')
assert.equal(dec.gate, 'warn')
assert.equal(gateDecision('enforce', false).state, 'suggested')
assert.equal(gateDecision('off', false).gate, 'off')
ok('三态判定：只有 enforce 会拦')

// 情绪只调阈值（文档 14.8）：心情低 → 冷却变长；好奇高 → 知识素材优先
assert.equal(moodLoad(null), 0)
assert.ok(moodLoad({ 委屈: 0.5, 烦躁: 0.5 }) > 0.4)
assert.equal(moodCooldownMinutes(null, 30), 30)
assert.ok(moodCooldownMinutes({ 委屈: 0.8, 生气: 0.6 }, 30) > 30)
assert.equal(preferKnowledge({ 好奇: 0.6 }), true)
assert.equal(preferKnowledge({ 好奇: 0.2 }), false)
const blocked = checkGate({
  now: new Date('2026-11-15T12:00:00'),
  config: { cooldownMinutes: 30 },
  state: { lastDeliveryAt: '2026-11-15T11:50:00', daily: { day: '2026-11-15', sent: 1 } },
  counts: { active: 3 },
  mood: { 生气: 0.9 },
})
assert.equal(blocked.reason, 'cooldown')
assert.ok(blocked.detail.cooldown > 30, JSON.stringify(blocked.detail))
ok('情绪只改开口阈值：冷却加长、好奇优先知识素材')

// 第四层只收三种标签；坏 JSON 不崩，理由截断
assert.equal(parseJudge('{"label":"engaged","confidence":0.8,"reason":"接话了"}').label, 'engaged')
assert.equal(parseJudge('{"label":"乱写"}'), null)
assert.equal(parseJudge('不是 JSON'), null)
assert.ok(judgePrompt('哈哈').includes('annoyed'))
ok('反馈第四层：窄 rubric，只认三种标签')

const h = await createHarness([
  { id: 'enf', turns: ['今天挺热的'] },
  { id: 'warn', turns: ['今天挺热的'] },
  { id: 'off', turns: ['今天挺热的'] },
])

const toolsFor = (mode) => {
  const tools = new Map()
  registerTools(
    { tools: { register(spec) { tools.set(spec.name, spec); return () => {} } } },
    { root: h.root, log: () => {}, gate: { mode } },
  )
  return tools
}

try {
  // 写入按「最近活跃会话」落分片，每个用例执行前都要先喂一条，别串到别人头上
  await h.feed({ id: 'enf', turns: ['今天挺热的', '我把钥匙放在鞋柜上了'] })
  const enf = await toolsFor('enforce').get('memory_save').execute({
    text: '用户把钥匙放在鞋柜上', source_quote: '我把钥匙放在鞋柜上了',
  })
  assert.equal(enf.status, 'suggested', JSON.stringify(enf))
  ok('enforce：没信号进待确认')

  await h.feed({ id: 'warn', turns: ['今天挺热的', '我把钥匙放在餐桌上了'] })
  const warn = await toolsFor('warn').get('memory_save').execute({
    text: '用户把钥匙放在餐桌上', source_quote: '我把钥匙放在餐桌上了',
  })
  assert.equal(warn.status, 'active', JSON.stringify(warn))
  assert.equal(warn.gate, 'warn')
  let sc = await h.scopeOf('warn')
  assert.equal(sc.items.find((x) => x.id === warn.id).gate, 'warn', '条目上要留记号')
  const audit = await readFile(join(h.root, 'audit', 'writes.jsonl'), 'utf8')
  assert.ok(audit.includes('"gate":"warn"'), audit.slice(-400))
  ok('warn：放行但条目 / 审计都留记号')

  await h.feed({ id: 'off', turns: ['今天挺热的', '我把钥匙放在书架上了'] })
  const off = await toolsFor('off').get('memory_save').execute({
    text: '用户把钥匙放在书架上', source_quote: '我把钥匙放在书架上了',
  })
  assert.equal(off.status, 'active', JSON.stringify(off))
  assert.equal(off.gate, 'off')
  ok('off：只记录、不拦')

  await h.feed({ id: 'warn', turns: ['今天挺热的', '记住，我喜欢喝乌龙茶'] })
  const direct = await toolsFor('warn').get('memory_save').execute({
    text: '用户喜欢喝乌龙茶', kind: 'pref', source_quote: '记住，我喜欢喝乌龙茶',
  })
  assert.equal(direct.status, 'active')
  assert.ok(!direct.gate || direct.gate === '', JSON.stringify(direct))
  sc = await h.scopeOf('warn')
  assert.ok(!sc.items.find((x) => x.id === direct.id).gate, '带信号的条目不该标 warn')
  ok('warn：原话有信号的不算「会拦」')

  console.log(`\n全部通过：${pass} 项`)
} catch (e) {
  console.error('\n失败：', e)
  process.exitCode = 1
} finally {
  await h.dispose()
}
