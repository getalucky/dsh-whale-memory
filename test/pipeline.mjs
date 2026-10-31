/**
 * pipeline.mjs —— 写入管线验收（阶段 3）
 *
 * 覆盖：
 *   · 降维：摘要 / 受控标签 / 上位标签 / 时间线 / 权重
 *   · 预筛：寒暄、问句不跑抽取；有信号才抽
 *   · 拒绝原因进审计
 *   · 合并保留「曾经」版本
 *   · 深化：近重复合并、容量超限归档最冷条目
 */
import assert from 'node:assert'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ensureDirs, addItem, loadScope, saveScope, emptyScope, readJsonl, paths, similarity } from '../lib/store.js'
import { enrichItem, summarize, weightOf } from '../lib/enrich.js'
import { extractConcepts } from '../lib/taxonomy.js'
import { skipReason, hasSignal } from '../lib/distill.js'
import { createHarness } from './eval/harness.mjs'
import { planDeepen, applyDeepen } from '../lib/deepen.js'

let pass = 0
const ok = (name) => { pass += 1; console.log('  ok', name) }
const root = await mkdtemp(join(tmpdir(), 'whale-pipe-'))

try {
  await ensureDirs(root)

  // 1. 受控标签：高数 → 数学 → 学习，不给「高等数学」单独开标签
  const cs = extractConcepts('明天要交高数作业')
  const tags = cs.map((c) => c.tag)
  assert.ok(tags.includes('高数') && tags.includes('作业'), JSON.stringify(cs))
  assert.ok(cs.find((c) => c.tag === '高数').parents.includes('数学'), JSON.stringify(cs))
  assert.ok(!tags.includes('数学'), '高数命中后不该再拆出一个数学标签')
  ok('受控标签：高数带上级 数学/学习，不重复分词')

  // 2. 降维字段
  const it = enrichItem({
    id: 'm_1', text: '老爹明天8:30上班，别忘提醒他带伞。后面还有一句不该进摘要',
    kind: 'event', conf: 0.7, atAbs: '2026-11-01T08:30:00', hits: 2,
    created: '2026-10-31T00:00:00.000Z', lastHit: '2026-10-31T00:00:00.000Z',
  })
  assert.equal(it.timeline, '2026-11-01')
  assert.ok(it.summary.length <= 60 && !it.summary.includes('后面还有一句'), it.summary)
  assert.ok(it.weight > 0 && it.weight <= 1)
  assert.equal(it.confidence, 0.7)
  ok('降维：timeline/summary/weight/confidence')

  // 3. 未知词不硬造标签
  const unknown = enrichItem({ id: 'm_2', text: '我买了个滑板', kind: 'pref', conf: 0.6 })
  assert.deepEqual(unknown.tags, ['偏好'])
  assert.deepEqual(unknown.parentTags, [])
  ok('未知词退回类型标签')

  // 4. 预筛
  assert.equal(skipReason('在吗'), 'too-short')
  assert.equal(skipReason('哈哈哈哈今天好热'), 'no-signal')
  assert.equal(skipReason('今天几号？'), 'question')
  assert.equal(skipReason('记住，我用 Windows 11'), '')
  assert.ok(hasSignal('我的 DSH 装在 D 盘'))
  ok('预筛：寒暄/问句跳过，信号句放行')

  // 5. 拒绝原因进审计
  {
    const h = await createHarness([{ id: 'skip', turns: ['在吗', '今天几号？', '记住，我用 Windows 11'] }])
    try {
      const c = { id: 'skip', turns: ['在吗', '今天几号？', '记住，我用 Windows 11'] }
      await h.feed(c)
      await h.distill(c)
      const rows = await readJsonl(join(h.root, 'audit', 'writes.jsonl'))
      const skip = rows.filter((r) => r.kind === 'write_skip').pop()
      assert.ok(skip, JSON.stringify(rows))
      assert.equal(skip.skipped, 2)
      assert.equal(skip.reasons['too-short'], 1)
      assert.equal(skip.reasons.question, 1)
      ok('跳过原因写审计（过短 1 / 问句 1）')
    } finally {
      await h.dispose()
    }
  }

  // 6. 合并保留曾经
  {
    const sc = emptyScope('private', '9')
    addItem(sc, { text: '我特别喜欢喝冰美式', kind: 'pref', conf: 0.7 })
    const merged = addItem(sc, { text: '我特别喜欢喝冰美式，不加糖也不加奶', kind: 'pref', conf: 0.7 })
    assert.equal(sc.items.length, 1)
    assert.ok(merged.text.includes('不加糖'), merged.text)
    assert.ok(Array.isArray(merged.history) && merged.history[0].text.includes('冰美式'), JSON.stringify(merged.history))
    ok('合并：新说法替换正文，旧说法进 history')
  }

  // 7. 深化：同标签近重复合并 + 命中累加
  {
    const sc = emptyScope('private', '10')
    sc.items = [
      { id: 'm_a', text: '期末考试安排在周三上午', kind: 'event', conf: 0.6, hits: 1, created: '2026-10-01T00:00:00.000Z', lastHit: '2026-10-01T00:00:00.000Z', state: 'active' },
      { id: 'm_b', text: '期末考试安排在周三上午。', kind: 'event', conf: 0.7, hits: 3, created: '2026-10-02T00:00:00.000Z', lastHit: '2026-10-02T00:00:00.000Z', state: 'active' },
    ]
    for (let i = 0; i < 18; i += 1) {
      sc.items.push({
        id: `m_x${i}`, text: `第${i + 1}门课的考试范围不一样`, kind: 'fact', conf: 0.6, hits: 0,
        created: '2026-10-03T00:00:00.000Z', lastHit: '2026-10-03T00:00:00.000Z', state: 'active',
      })
    }
    for (const x of sc.items) enrichItem(x)
    assert.ok(similarity(sc.items[0].text, sc.items[1].text) >= 0.9, String(similarity(sc.items[0].text, sc.items[1].text)))

    const plan = planDeepen(sc, { indexBytes: 0 })
    assert.ok(plan.merges.length >= 1, JSON.stringify(plan.reasons))
    const out = applyDeepen(sc, plan)
    assert.equal(out.merged, 1)
    const keep = sc.items.find((x) => x.id === 'm_b')
    assert.equal(keep.hits, 4, JSON.stringify({ hits: keep.hits }))
    assert.equal(sc.items.find((x) => x.id === 'm_a').state, 'superseded')
    assert.ok(sc.lastDeepen)
    ok('深化：近重复合并、命中累加、旧条目标 superseded')
  }

  // 8. 副库超限：归档最冷条目，正文不删
  {
    const sc = emptyScope('private', '11')
    for (let i = 0; i < 40; i += 1) {
      sc.items.push({
        id: `m_c${i}`, text: `冷条目 ${i}`, kind: 'fact', conf: 0.3, hits: 0,
        created: '2025-01-01T00:00:00.000Z', lastHit: '2025-01-01T00:00:00.000Z', state: 'active', weight: 0.1,
      })
    }
    const plan = planDeepen(sc, { indexBytes: 40 * 1024 })
    assert.ok(plan.archive.length > 0, JSON.stringify(plan.reasons))
    const out = applyDeepen(sc, plan)
    assert.equal(out.archived, plan.archive.length)
    assert.equal(sc.items.filter((x) => x.state === 'archived').length, plan.archive.length)
    ok('副库超限：最冷条目归档')
  }

  // 9. 副库落盘带标签
  {
    const sc = emptyScope('private', '12')
    addItem(sc, { text: '记住，明天要交高数作业', kind: 'event', conf: 0.7 })
    await saveScope(root, sc)
    const idx = await readFile(join(paths(root).scopes, 'private-12', 'memory_index.md'), 'utf8')
    assert.ok(idx.includes('高数') && idx.includes('数学'), idx)
    const loaded = await loadScope(root, 'private', '12')
    assert.ok(loaded.items[0].tags.includes('高数'), JSON.stringify(loaded.items[0].tags))
    ok('副库写盘：标签与上级标签可回读')
  }

  console.log(`\n${pass} 通过 · 0 失败`)
} finally {
  await rm(root, { recursive: true, force: true }).catch(() => {})
}
