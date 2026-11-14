/**
 * inject-policy.mjs —— 注入策略补充验收
 *
 *   · 恒定量：分片容量默认 1000
 *   · 复审段：REVIEW_SECTION 恒注册，内容按分片变化
 *   · 跨天：paintedDay 变了必须重画（时间线「今天/昨天/前天」不能过夜发馊）
 *   · 阈值：同一天内 <3 条变化不重画，≥3 条且到 5 分钟才重画
 *   · 压缩恢复：重复 compaction/end 覆盖同一槽位，不叠加
 */
import assert from 'node:assert'
import { registerInjection, resetCaches, MEMORY_SECTION, REVIEW_SECTION, startMemoryRefresh } from '../lib/inject.js'
import { loadScope, saveScope, addItem, MAX_ITEMS } from '../lib/store.js'
import { createHarness } from './eval/harness.mjs'

let pass = 0
const ok = (name) => { pass += 1; console.log('  ok', name) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

process.env.DSH_MEMORY_REVIEW = 'on'
process.env.DSH_MEMORY_REVIEW_SCOPES = 'private'
delete process.env.DSH_MEMORY_MAX_ITEMS

const h = await createHarness([{ id: 'p1', turns: ['记住，我喜欢喝冰美式', '记住，我住在杭州'] }])
const c = { id: 'p1', turns: ['记住，我喜欢喝冰美式', '记住，我住在杭州'] }

try {
  assert.equal(MAX_ITEMS, 1000, `默认容量应为 1000，实际 ${MAX_ITEMS}`)
  ok('分片容量默认 1000')

  await h.feed(c)
  await h.distill(c)
  const scope = await h.scopeOf('p1')
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
  await sleep(120)

  const mem = sections.find((s) => s.name === MEMORY_SECTION)
  const rev = sections.find((s) => s.name === REVIEW_SECTION)
  assert.ok(mem, '记忆段没有注册')
  assert.ok(rev, '复审段没有注册')
  ok('REVIEW_SECTION 恒注册（无内容时为空）')

  // 从这一刻起用可控时钟，才能精确隔离「跨天」和「5 分钟 + 3 条」两条路径
  const RealDate = globalThis.Date
  let fakeNow = RealDate.now()
  class FakeDate extends RealDate {
    constructor(...args) { if (args.length === 0) super(fakeNow); else super(...args) }
    static now() { return fakeNow }
  }
  globalThis.Date = FakeDate
  let refresh = startMemoryRefresh({ root: h.root, log: () => {}, everyMs: 3600 * 1000 })
  try {
    // 攒够复审门槛：补 5 条；先过 6 分钟让这次变化正常落进骨架，把增量追平
    const sc = await loadScope(h.root, 'private', [...h.src.values()][0].id)
    for (let i = 0; i < 5; i++) addItem(sc, { text: `复审样本第 ${i} 条：用户偏好记录`, kind: 'fact', conf: 0.6 })
    await saveScope(h.root, sc)
    fakeNow += 6 * 60 * 1000
    await refresh.tick()
    assert.ok(String(rev.text()).includes('记忆复审'), `复审段应出现内容：${String(rev.text()).slice(0, 120)}`)
    ok('复审段：条目够了就出提醒')

    // ── 跨天强制重画：只多 1 条，不满足 3 条阈值 ──
    const beforeDay = String(mem.text())
    fakeNow += 24 * 3600 * 1000
    const sc2 = await loadScope(h.root, 'private', [...h.src.values()][0].id)
    addItem(sc2, { text: '跨天新增标记：昨天说的那件事', kind: 'fact', conf: 0.6 })
    await saveScope(h.root, sc2)
    await refresh.tick()
    const afterDay = String(mem.text())
    assert.notEqual(afterDay, beforeDay, '跨天后没有重画，时间线日期会过期')
    ok('跨天强制重画：paintedDay 变化即刷新')

    // ── 阈值边界：同一天 2 条不画，3 条才画 ──
    const baseline = String(mem.text())
    const sc3 = await loadScope(h.root, 'private', [...h.src.values()][0].id)
    addItem(sc3, { text: '阈值样本甲：周末去修显示器', kind: 'fact', conf: 0.6 })
    addItem(sc3, { text: '阈值样本乙：下周去看牙医', kind: 'fact', conf: 0.6 })
    await saveScope(h.root, sc3)
    fakeNow += 6 * 60 * 1000
    await refresh.tick()
    assert.equal(String(mem.text()), baseline, '2 条变化不该重画')

    const sc4 = await loadScope(h.root, 'private', [...h.src.values()][0].id)
    addItem(sc4, { text: '阈值样本丙：把发票寄出去', kind: 'fact', conf: 0.6 })
    await saveScope(h.root, sc4)
    await refresh.tick()
    assert.notEqual(String(mem.text()), baseline, '累计 3 条且过 5 分钟应重画')
    ok('刷新阈值：2 条不画、3 条才画')
  } finally {
    globalThis.Date = RealDate
  }

  // ── 压缩恢复幂等 ──
  await h.emit('p1', 'compaction/end')
  await sleep(150)
  const once = String(mem.text())
  assert.ok(once.includes('压缩后恢复'), once.slice(-200))
  await h.emit('p1', 'compaction/end')
  await sleep(150)
  const twice = String(mem.text())
  assert.equal((twice.match(/压缩后恢复/g) || []).length, (once.match(/压缩后恢复/g) || []).length,
    '重复压缩事件把恢复包叠加了')
  ok('压缩恢复：重复事件覆盖同槽位，不叠加')

  refresh.dispose()
  console.log(`\n${pass} 通过 · 0 失败`)
} finally {
  await h.dispose()
}
