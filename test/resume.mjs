/**
 * resume.mjs —— 压缩后恢复包验收（阶段 8 / 文档 7.9）
 *
 *   · 恢复包内容：目标 / 画像 / 高权重条目 / 已读已写 id，≤420 字符
 *   · 监听宿主的 compaction/end，注入一次
 *   · 过期后从注入段自动撤掉
 */
import assert from 'node:assert'

import { registerInjection, resetCaches, setResumePack, PERSONA_SECTION, MEMORY_SECTION, startMemoryRefresh } from '../lib/inject.js'
import { buildResumePack } from '../lib/resume.js'
import { createHarness } from './eval/harness.mjs'

let pass = 0
const ok = (name) => { pass += 1; console.log('  ok', name) }

const h = await createHarness([{ id: 'r1', turns: ['记住，周五要交房租', '记住，我住在杭州'] }])
const c = { id: 'r1', turns: ['记住，周五要交房租', '记住，我住在杭州'] }
try {
  await h.feed(c)
  await h.distill(c)
  const sc = await h.scopeOf('r1')

  // 1. 内容与预算
  const pack = buildResumePack(sc, { goal: '把记忆插件升级完', readIds: ['m_read1'], writtenIds: ['m_write1'] })
  assert.ok(pack.includes('压缩后恢复'), pack)
  assert.ok(pack.includes('周五'), pack)
  assert.ok(pack.includes('m_read1') && pack.includes('m_write1'), pack)
  assert.ok(pack.length <= 420, String(pack.length))
  ok('恢复包：目标/画像/条目/已读已写，≤420 字符')

  // 2. 挂到一个真实会话的注入段
  resetCaches()
  const handlers = new Map()
  const sections = []
  const ctx = { on(ev, fn) { const list = handlers.get(ev) || []; list.push(fn); handlers.set(ev, list); return () => {} } }
  const systemPrompt = { section(spec) { sections.push(spec) } }
  registerInjection(ctx, { root: h.root, log: () => {} })
  for (const fn of handlers.get('agent/created') || []) {
    fn({ agent: { session: { header: { id: [...h.src.values()][0].sid } }, ctx: { systemPrompt } } })
  }
  await new Promise((r) => setTimeout(r, 80))
  const mem = sections.find((s) => s.name === MEMORY_SECTION)
  assert.ok(mem, sections.map((s) => s.name).join(','))
  const before = String(mem.text())
  assert.ok(!before.includes('压缩后恢复'), before.slice(0, 80))

  // 3. 模拟宿主压缩完成事件
  await h.emit('r1', 'compaction/end')
  await new Promise((r) => setTimeout(r, 120))
  const afterCompact = String(mem.text())
  assert.ok(afterCompact.includes('压缩后恢复'), afterCompact.slice(-200))
  ok('compaction/end：恢复包进入注入段')

  // 4. 过期自动撤掉
  setResumePack(h.root, [...h.src.values()][0].sid, '【压缩后恢复】临时', { ttlMs: 1 })
  await new Promise((r) => setTimeout(r, 20))
  const refresh = startMemoryRefresh({ root: h.root, log: () => {}, everyMs: 3600 * 1000 })
  await refresh.tick()
  const afterExpire = String(mem.text())
  assert.ok(!afterExpire.includes('【压缩后恢复】临时'), afterExpire.slice(-120))
  refresh.dispose()
  ok('恢复包过期后自动撤掉')

  console.log(`\n${pass} 通过 · 0 失败`)
} finally {
  await h.dispose()
}
