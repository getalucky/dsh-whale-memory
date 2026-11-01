/**
 * confirm.mjs —— 写入确认闸门（文档 4.6 / 7.7）
 *
 * 验的是「模型主动记」和「乱记」之间的那道闸：
 *   · 原话里没有「记住 / 纠正 / 长期偏好」的信号 → 进 suggested
 *   · suggested 不进注入、不进骨架、不进副库、检索不到
 *   · 用户点头（memory_confirm）之后才生效，才进目录
 *   · suggested 不能取代已生效的旧说法
 *   · 原话有信号 → 直接生效，不折腾用户
 */
import assert from 'node:assert'
import { readFile } from 'node:fs/promises'

import { registerTools } from '../lib/tools.js'
import { createHarness } from './eval/harness.mjs'
import { renderMemory } from '../lib/inject.js'
import { renderSkeleton } from '../lib/skeleton.js'
import { searchFunnel } from '../lib/funnel.js'
import { vaultPaths } from '../lib/vault.js'

let pass = 0
const ok = (name) => { pass += 1; console.log('  ok', name) }

const h = await createHarness([{ id: 'c1', turns: ['今天挺热的', '我把钥匙放在桌上了'] }])
const tools = new Map()
try {
  registerTools({ tools: { register(spec) { tools.set(spec.name, spec); return () => {} } } }, { root: h.root, log: () => {} })
  const src = h.src.get('c1')
  const p = vaultPaths(h.root, src.kind, src.id)
  const readIndex = () => readFile(p.index, 'utf8').catch(() => '')

  await h.feed({ id: 'c1', turns: ['今天挺热的', '我把钥匙放在桌上了'] })

  // 1. 无信号：进待确认，不算生效
  const a = await tools.get('memory_save').execute({ text: '用户把钥匙放在桌上', source_quote: '我把钥匙放在桌上了' })
  assert.ok(a.ok, JSON.stringify(a))
  assert.equal(a.status, 'suggested')
  assert.equal(a.committed, true)
  let sc = await h.scopeOf('c1')
  assert.equal(sc.items.find((x) => x.id === a.id).state, 'suggested')
  ok('没有「记住」信号：进 suggested')

  // 2. 待确认的四条出口都关着
  assert.ok(!renderMemory(sc).includes('钥匙'), '待确认不该进注入')
  assert.ok(!renderSkeleton(sc).includes('钥匙'), '待确认不该进骨架')
  assert.equal(searchFunnel([sc], { query: '钥匙' }).length, 0, '待确认不该被检索到')
  assert.ok(!(await readIndex()).includes('钥匙'), '待确认不该进副库')
  ok('suggested 不进注入 / 骨架 / 副库 / 检索')

  // 3. 看得见，才确认得了
  const pend = await tools.get('memory_pending').execute({})
  assert.equal(pend.count, 1, JSON.stringify(pend))
  assert.ok(pend.text.includes(a.id), pend.text)
  ok('memory_pending 能列出待确认')

  // 4. 点头后转正：进目录、能检索、能注入
  const cf = await tools.get('memory_confirm').execute({ id: a.id })
  assert.ok(cf.ok, JSON.stringify(cf))
  sc = await h.scopeOf('c1')
  assert.equal(sc.items.find((x) => x.id === a.id).state, 'active')
  assert.ok(renderMemory(sc).includes('钥匙'))
  assert.ok(searchFunnel([sc], { query: '钥匙' }).length > 0)
  assert.ok((await readIndex()).includes('钥匙'))
  ok('memory_confirm 转正后进目录并生效')

  // 5. 转正过的不能再转一次
  const again = await tools.get('memory_confirm').execute({ id: a.id })
  assert.equal(again.ok, false)
  ok('重复确认会被拒')

  // 6. 原话带「记住」：直接生效
  const b = await tools.get('memory_save').execute({ text: '用户喜欢冰美式', kind: 'pref', source_quote: '记住，我特别喜欢喝冰美式' })
  assert.ok(b.ok, JSON.stringify(b))
  assert.equal(b.status, 'active')
  sc = await h.scopeOf('c1')
  assert.equal(sc.items.find((x) => x.id === b.id).state, 'active')
  ok('原话带「记住」：直接生效')

  // 7. 待确认的猜测不能顶掉已经生效的事实
  const home = await tools.get('memory_save').execute({ text: '用户住在杭州', source_quote: '记住，我住在杭州' })
  assert.equal(home.status, 'active')
  const guess = await tools.get('memory_save').execute({ text: '用户住在上海', source_quote: '我好像在上海租了房子' })
  assert.equal(guess.status, 'suggested')
  sc = await h.scopeOf('c1')
  assert.equal(sc.items.find((x) => x.id === home.id).state, 'active', '旧的已确认事实被待确认顶掉了')
  ok('suggested 不参与取代')

  // 8. 库里已有同一条：不重复写，也不给旧条目白加命中
  const dup = await tools.get('memory_save').execute({ text: '用户住在杭州', source_quote: '我住在杭州这边，住挺久了' })
  assert.equal(dup.status, 'exists', JSON.stringify(dup))
  assert.equal(dup.id, home.id)
  ok('重复内容不新建（exists）')

  console.log(`\n全部通过：${pass} 项`)
} catch (e) {
  console.error('\n失败：', e)
  process.exitCode = 1
} finally {
  await h.dispose()
}
