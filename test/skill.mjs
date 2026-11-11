/**
 * test/skill.mjs —— skill / SOP 记忆
 *
 * 验的是「流程」这一类记忆的硬约束：
 *   · 缺 trigger / 步骤少于 3 / 多于 8 / 缺 verify → 拒写
 *   · 步骤落主库、重读能还原，read_memory 默认能读到步骤
 *   · 技能不进常驻骨架（只留一句按需检索的提示）
 *   · memory_update 能改进程，也能记执行结果：连续两次失败标待复核，成功清零
 *   · 每分片技能条数单独限流，超出的先归档用得最少的
 *
 *   node test/skill.mjs
 */
import assert from 'node:assert'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { registerTools } from '../lib/tools.js'
import { createHarness } from './eval/harness.mjs'
import { renderSkeleton } from '../lib/skeleton.js'
import { addItem, enforceCapacity, loadScope, overflowSkills } from '../lib/store.js'
import { vaultPaths, loadVault } from '../lib/vault.js'

let pass = 0
const ok = (name) => { pass += 1; console.log('  ok', name) }

const h = await createHarness([{ id: 's1', turns: ['我在整理部署流程'] }, { id: 's2', turns: ['占位'] }])
const tools = new Map()
try {
  registerTools({ tools: { register(spec) { tools.set(spec.name, spec); return () => {} } } }, { root: h.root, log: () => {} })
  const src = h.src.get('s1')
  const p = vaultPaths(h.root, src.kind, src.id)
  const save = (args) => tools.get('memory_save').execute(args)

  await h.feed({ id: 's1', turns: [
    '我在整理部署流程',
    '记住，以后部署记忆插件按这个流程来',
    '记住，部署脚本叫 deploy.mjs',
    '记住，部署前先关 DSH 再跑脚本',
  ] })

  // 1. 必填字段：trigger / steps / verify
  const noTrigger = await save({
    text: '部署记忆插件',
    kind: 'skill',
    steps: ['关掉 DSH', '跑 deploy.mjs', '重启并检查面板版本'],
    verify: '面板版本号变成新 commit',
    source_quote: '记住，以后部署记忆插件按这个流程来',
  })
  assert.equal(noTrigger.ok, false)
  assert.ok(/trigger/.test(noTrigger.why), noTrigger.why)

  const badTrigger = await save({
    text: '部署记忆插件',
    kind: 'skill',
    trigger: '部署之前',
    steps: ['关掉 DSH', '跑 deploy.mjs', '重启并检查面板版本'],
    verify: '面板版本号变成新 commit',
    source_quote: '记住，以后部署记忆插件按这个流程来',
  })
  assert.equal(badTrigger.ok, false)
  assert.ok(/当……时/.test(badTrigger.why), badTrigger.why)

  const few = await save({
    text: '部署记忆插件',
    kind: 'skill',
    trigger: '当要部署记忆插件时',
    steps: ['关掉 DSH', '跑 deploy.mjs'],
    verify: '面板版本号变成新 commit',
    source_quote: '记住，以后部署记忆插件按这个流程来',
  })
  assert.equal(few.ok, false)
  assert.ok(/至少 3 步/.test(few.why), few.why)

  const many = await save({
    text: '部署记忆插件',
    kind: 'skill',
    trigger: '当要部署记忆插件时',
    steps: ['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((x) => `第 ${x} 步做点事`),
    verify: '面板版本号变成新 commit',
    source_quote: '记住，以后部署记忆插件按这个流程来',
  })
  assert.equal(many.ok, false)
  assert.ok(/最多 8 步/.test(many.why), many.why)

  const noVerify = await save({
    text: '部署记忆插件',
    kind: 'skill',
    trigger: '当要部署记忆插件时',
    steps: ['关掉 DSH', '跑 deploy.mjs', '重启并检查面板版本'],
    source_quote: '记住，以后部署记忆插件按这个流程来',
  })
  assert.equal(noVerify.ok, false)
  assert.ok(/verify/.test(noVerify.why), noVerify.why)
  ok('skill：缺 trigger / 句式不对 / 步数越界 / 缺 verify 都拒写')

  // 2. 正常写入：字段进主库，重读还原，read_memory 默认带步骤
  const saved = await save({
    text: '部署记忆插件',
    kind: 'skill',
    trigger: '当要部署记忆插件时',
    steps: ['关掉 DSH', '跑 node tools/deploy.mjs', '重启 DSH 并检查面板版本'],
    verify: '面板版本号变成新 commit，且 client 校验通过',
    source_quote: '记住，以后部署记忆插件按这个流程来',
  })
  assert.ok(saved.ok && saved.status === 'active', JSON.stringify(saved))
  let sc = await h.scopeOf('s1')
  let skill = sc.items.find((x) => x.id === saved.id)
  assert.equal(skill.kind, 'skill')
  assert.equal(skill.trigger, '当要部署记忆插件时')
  assert.equal(skill.steps.length, 3)
  assert.equal(skill.skillFails, 0)
  assert.equal(skill.skillReview, false)
  assert.ok((skill.parentTags || []).includes('技能'), JSON.stringify(skill.parentTags))

  const md = await readFile(join(p.full, saved.id + '.md'), 'utf8')
  assert.ok(md.includes('steps_json:'), md.slice(0, 600))
  assert.ok(md.includes('## 步骤'), md.slice(0, 900))
  assert.ok(md.includes('验证：面板版本号变成新 commit'), md.slice(0, 900))

  const reloaded = await loadVault(h.root, src.kind, src.id, { force: true })
  const reSkill = reloaded.items.find((x) => x.id === saved.id)
  assert.equal(reSkill.trigger, '当要部署记忆插件时')
  assert.deepEqual(reSkill.steps, skill.steps)
  assert.equal(reSkill.verify, skill.verify)

  const read = await tools.get('read_memory').execute({ id: saved.id })
  assert.ok(read.ok, JSON.stringify(read))
  assert.ok(read.text.includes('跑 node tools/deploy.mjs'), read.text)
  assert.ok(read.text.includes('验证：面板版本号变成新 commit'), read.text)
  ok('skill：字段进主库和「步骤」，重读能还原，read_memory 默认带步骤')

  // 3. 不进常驻骨架：只留按需检索的提示
  await save({
    text: '部署脚本叫 deploy.mjs',
    source_quote: '记住，部署脚本叫 deploy.mjs',
  })
  sc = await h.scopeOf('s1')
  const sk = renderSkeleton(sc)
  assert.ok(sk.includes('deploy.mjs'), sk)
  assert.ok(!sk.includes('部署记忆插件'), '技能正文不该进常驻骨架：\n' + sk)
  assert.ok(!sk.includes('当要部署记忆插件时'), '技能触发条件不该进常驻骨架：\n' + sk)
  assert.ok(!sk.includes('跑 node tools/deploy.mjs'), '技能步骤不该进常驻骨架：\n' + sk)
  ok('skill 不进常驻骨架')

  // 4. 检索能搜到，带类型和触发条件
  const found = await tools.get('search_memory').execute({ query: '部署记忆插件' })
  const hit = found.results.find((x) => x.id === saved.id)
  assert.ok(hit, JSON.stringify(found))
  assert.equal(hit.kind, 'skill')
  assert.ok(found.text.includes('[技能]'), found.text)
  assert.ok(found.text.includes('当要部署记忆插件时'), found.text)
  ok('search_memory：技能带类型与触发条件')

  // 5. memory_update：只改一项也要过整体校验
  const upd = await tools.get('memory_update').execute({
    id: saved.id,
    steps: ['关掉 DSH', '跑 deploy.mjs', '重启并验证 client', '在面板确认新 commit'],
  })
  assert.ok(upd.ok, JSON.stringify(upd))
  sc = await h.scopeOf('s1')
  skill = sc.items.find((x) => x.id === saved.id)
  assert.equal(skill.steps.length, 4)
  assert.equal(skill.trigger, '当要部署记忆插件时', '只改 steps 不能把 trigger 弄丢')

  const badEdit = await tools.get('memory_update').execute({ id: saved.id, steps: ['只有一步'] })
  assert.equal(badEdit.ok, false)
  assert.ok(/至少 3 步/.test(badEdit.why), badEdit.why)
  ok('memory_update：技能可改进程，半截步骤拒写')

  // 6. 执行结果：连续两次失败标待复核，成功清零
  const f1 = await tools.get('memory_update').execute({ id: saved.id, outcome: 'fail' })
  assert.equal(f1.review, false, JSON.stringify(f1))
  const f2 = await tools.get('memory_update').execute({ id: saved.id, outcome: 'fail' })
  assert.equal(f2.review, true, JSON.stringify(f2))
  sc = await h.scopeOf('s1')
  assert.equal(sc.items.find((x) => x.id === saved.id).skillReview, true)
  const marked = await tools.get('search_memory').execute({ query: '部署记忆插件' })
  assert.ok(marked.text.includes('待复核'), marked.text)

  const good = await tools.get('memory_update').execute({ id: saved.id, outcome: 'ok' })
  assert.equal(good.review, false)
  sc = await h.scopeOf('s1')
  assert.equal(sc.items.find((x) => x.id === saved.id).skillFails, 0)
  assert.equal(sc.items.find((x) => x.id === saved.id).skillReview, false)

  const empty = await tools.get('memory_update').execute({ id: saved.id })
  assert.equal(empty.ok, false)
  ok('skill：两次失败标待复核，成功清零；空更新拒写')

  // 7. 每分片技能配额：超出先丢用得最少的
  const capSrc = h.src.get('s2')
  const capScope = await loadScope(h.root, capSrc.kind, capSrc.id)
  const pick = (i, name) => addItem(capScope, {
    text: name,
    kind: 'skill',
    trigger: `当执行${name}时`,
    steps: [`准备${name}`, `执行${name}`, `确认${name}`],
    verify: `${name}完成`,
    conf: 0.6,
  })
  const capIds = [
    pick(1, '发布插件流程'),
    pick(2, '备份记忆库流程'),
    pick(3, '检查界面流程'),
  ]
  capIds.forEach((it, i) => { it.hits = i * 10 })
  assert.equal(overflowSkills(capScope, 2).length, 1)
  const archived = await enforceCapacity(h.root, capScope, 400, 2)
  assert.equal(archived, 1, JSON.stringify({ archived }))
  assert.equal(capScope.items.filter((x) => x.kind === 'skill' && x.state !== 'archived').length, 2)
  assert.ok(!capScope.items.find((x) => x.id === capIds[0].id), '用得最少的应被归档')
  ok('skill：每分片条数单独限流，先归档用得最少的')

  console.log(`\n${pass} 通过 · 0 失败`)
} finally {
  await h.dispose()
}
