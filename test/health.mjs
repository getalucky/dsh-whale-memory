/**
 * health.mjs —— 记忆库体检
 *
 * 验的是：干净库判健康；画像漂移、重复说法、待确认堆积、容量到顶能认出来；
 * 体检只读，不修东西。
 */
import assert from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ensureDirs, emptyScope, addItem, saveScope, MAX_ITEMS } from '../lib/store.js'
import { healthReport, healthLine, findDuplicates } from '../lib/health.js'

let pass = 0
const ok = (name) => { pass += 1; console.log('  ok', name) }

const root = await mkdtemp(join(tmpdir(), 'whale-health-'))
await ensureDirs(root)

try {
  // ---- 干净的库 ----
  const clean = emptyScope('private', '100')
  addItem(clean, { text: '爹喜欢喝冰美式', kind: 'pref', conf: 0.8 })
  addItem(clean, { text: '爹在杭州上班', kind: 'fact', conf: 0.8 })
  clean.profile.total = 2
  await saveScope(root, clean)

  const r1 = await healthReport(root)
  assert.equal(r1.ok, true)
  assert.equal(r1.healthy, true, JSON.stringify(r1.scopes))
  assert.equal(r1.totals.errors, 0)
  assert.ok(r1.totals.live >= 2)
  assert.ok(/体检正常/.test(healthLine(r1)))
  ok('干净库判健康')

  // ---- 画像漂了 + 重复说法 + 待确认堆积 ----
  const dirty = emptyScope('private', '200')
  for (let i = 0; i < 12; i += 1) {
    addItem(dirty, { text: `第 ${i} 条不太一样的偏好，编号 ${i}`, kind: 'pref', conf: 0.6 })
  }
  // 两条几乎一模一样：addItem 自己会归并，这里直接塞进 items，模拟导入/手改留下的重复
  dirty.items.push(
    { id: 'm_dup_a', text: '爹说他最喜欢喝的是冰美式咖啡', kind: 'pref', state: 'active', conf: 0.8, created: new Date().toISOString() },
    { id: 'm_dup_b', text: '爹说他最喜欢喝的是冰美式咖啡。', kind: 'pref', state: 'active', conf: 0.8, created: new Date().toISOString() },
  )
  // 待确认
  for (let i = 0; i < 10; i += 1) {
    const it = addItem(dirty, { text: `待确认的候选 ${i} 号`, kind: 'fact', conf: 0.3 })
    it.state = 'suggested'
  }
  dirty.profile.total = 3
  await saveScope(root, dirty)

  const r2 = await healthReport(root)
  assert.equal(r2.healthy, false)
  const row = r2.scopes.find((x) => x.scope === 'private:200')
  assert.ok(row, JSON.stringify(r2.scopes.map((x) => x.scope)))
  const ids = row.issues.map((x) => x.id)
  assert.ok(ids.includes('profile'), '画像漂移要报')
  assert.ok(ids.includes('pending'), '待确认堆积要报')
  assert.ok(ids.includes('duplicate'), `重复要报：${JSON.stringify(row.issues)}`)
  assert.ok(r2.totals.duplicates >= 1)
  assert.ok(r2.advice.length >= 1)
  ok('画像、待确认、重复都认得出')

  // ---- 容量 ----
  const full = emptyScope('local', 'dsh')
  // 直接塞，addItem 会把结构相似的句子当重复合并掉
  for (let i = 0; i < Math.ceil(MAX_ITEMS * 0.92); i += 1) {
    full.items.push({
      id: `m_cap_${i}`,
      text: `样本 ${(i * 7919).toString(36)}-${'甲乙丙丁戊己庚辛壬癸'[i % 10]}-${i}`,
      kind: 'fact',
      state: 'active',
      conf: 0.5,
      hits: 1,
      created: new Date().toISOString(),
    })
  }
  full.profile.total = full.items.length
  await saveScope(root, full)

  const r3 = await healthReport(root)
  const frow = r3.scopes.find((x) => x.scope === 'local:dsh')
  assert.ok(frow?.issues.some((x) => x.id === 'capacity'), JSON.stringify(frow?.issues))
  ok('容量到九成会提醒')

  // ---- 重复分组本身 ----
  const groups = findDuplicates([
    { id: 'a', text: '明天上午九点在公司楼下集合' },
    { id: 'b', text: '明天上午九点在公司楼下集合。' },
    { id: 'c', text: '完全无关的另一句话' },
  ])
  assert.equal(groups.length, 1)
  assert.deepEqual(groups[0].map((x) => x.id).sort(), ['a', 'b'])
  ok('重复分组按组返回')

  // ---- 只读：体检不改库 ----
  const before = JSON.stringify((await healthReport(root)).totals)
  await healthReport(root)
  const after = JSON.stringify((await healthReport(root)).totals)
  assert.equal(before, after, '体检重复跑结果要稳定')
  ok('体检幂等、只读')

  console.log(`\n全部通过：${pass} 项`)
} finally {
  await rm(root, { recursive: true, force: true })
}
