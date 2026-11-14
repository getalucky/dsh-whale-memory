/**
 * extras-off.mjs —— 附加功能全关，主链路还在
 *
 * 对应 12.2 / 13.7「关闭全部附加功能后，主链路指标与阶段 1-8 基线一致」。
 * 附加功能（beat / 日记 / 复审 / 人格自动迭代 / inbound / 素材投递 / notepad / 向量）
 * 全关时，规矩段、人格段、记忆段和三个核心工具必须照常注册，复审段为空。
 * 指标那一半靠同口径评测（附加功能本来就不在 test/eval 链路里），这里验的是引导与门面。
 *
 * 跑法：node test/extras-off.mjs
 */
import assert from 'node:assert'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { createHarness } from './eval/harness.mjs'
import { MEMORY_SECTION, PERSONA_SECTION, REVIEW_SECTION, registerInjection, resetCaches } from '../lib/inject.js'
import { registerTools } from '../lib/tools.js'

let pass = 0
const ok = (name) => { pass += 1; console.log('  ok', name) }

// 附加功能全关：环境变量先压一遍，配置里也不给底座
process.env.DSH_MEMORY_REVIEW = 'off'
process.env.DSH_MEMORY_PERSONA_AUTO = 'off'
process.env.DSH_MEMORY_BEAT = 'off'
process.env.DSH_MEMORY_DIARY = 'off'
process.env.DSH_MEMORY_INBOUND = 'off'
process.env.DSH_MEMORY_EMBED = 'off'

const h = await createHarness([{ id: 'x1', turns: ['记住，我喜欢喝冰美式', '记住，我住在杭州'] }])
const c = { id: 'x1', turns: ['记住，我喜欢喝冰美式', '记住，我住在杭州'] }

try {
  await h.feed(c)
  await h.distill(c)
  // 人格是文件快照：挂载前落一份，验的是「人格段照挂」，不是模板内容
  await writeFile(join(h.root, 'persona.md'), '你是「大肥鱼」，说话短。\n', 'utf8')
  const sid = [...h.src.values()][0].sid

  resetCaches()
  const handlers = new Map()
  const sections = []
  const ctx = {
    on(ev, fn) { const list = handlers.get(ev) || []; list.push(fn); handlers.set(ev, list); return () => {} },
    logger: { info() {} },
  }
  const systemPrompt = { section(spec) { sections.push(spec); return () => {} } }
  registerInjection(ctx, { root: h.root, log: () => {} })
  for (const fn of handlers.get('agent/created') || []) {
    fn({ agent: { session: { header: { id: sid } }, ctx: { systemPrompt } } })
  }
  // 段落文本是懒渲染 + 异步读库，等一拍再读
  await new Promise((r) => setTimeout(r, 150))

  const persona = sections.find((s) => s.name === PERSONA_SECTION)
  const mem = sections.find((s) => s.name === MEMORY_SECTION)
  const review = sections.find((s) => s.name === REVIEW_SECTION)
  assert.ok(persona, '人格段没有注册')
  assert.ok(mem, '记忆段没有注册')
  assert.ok(review, '复审段没有注册')
  ok('三段落位：人格 / 记忆 / 复审')

  assert.ok(String(persona.text()).length > 0, '人格段是空的')
  const memText = String(mem.text())
  assert.ok(memText.includes('冰美式'), `记忆段没读到条目：${memText.slice(0, 120)}`)
  assert.ok(memText.includes('search_memory'), '规矩段没提核心工具')
  ok('记忆段含条目与工具规矩')

  assert.equal(String(review.text()).trim(), '', '复审关掉了却还有内容')
  ok('附加功能全关：复审段为空')

  const names = []
  const t = registerTools({
    tools: { register(def) { names.push(def?.name); return () => {} } },
  }, { root: h.root, log: () => {} })
  for (const core of ['search_memory', 'read_memory', 'memory_save']) {
    assert.ok(names.includes(core), `核心工具没注册：${core}`)
  }
  assert.deepEqual(t?.failed ?? [], [], `工具注册失败：${JSON.stringify(t?.failed)}`)
  ok(`核心工具注册（共 ${names.length} 个，0 失败）`)
} finally {
  await h.dispose()
}

console.log(`\n全部通过：${pass} 项`)
