/**
 * test/metrics.mjs —— 真实流量指标口径
 *   node test/metrics.mjs
 */

import assert from 'node:assert'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ensureDirs, emptyScope, addItem, saveScope, paths } from '../lib/store.js'
import { computeMetrics } from '../lib/metrics.js'

let pass = 0
const ok = (name) => { pass += 1; console.log('  ok', name) }

const root = await mkdtemp(join(tmpdir(), 'whale-metrics-'))
const DAY = 86400000
const at = (daysAgo) => new Date(Date.now() - daysAgo * DAY).toISOString()

try {
  await ensureDirs(root)

  const sc = emptyScope('private', '1')
  const kept = addItem(sc, { text: '用户住在杭州', kind: 'fact', source: 'tool' })
  const gone = addItem(sc, { text: '用户养了一只猫', kind: 'fact', source: 'tool' })
  gone.state = 'superseded'
  await saveScope(root, sc)

  const reads = [
    { at: at(2), kind: 'search', query: '住哪儿', count: 1, empty: false },
    { at: at(2), kind: 'search', query: '无关', count: 0, empty: true },
    { at: at(1), kind: 'read', id: kept.id, ok: true, tokens: 60 },
    { at: at(1), kind: 'read', id: kept.id, ok: true, tokens: 60 },
    { at: at(1), kind: 'read', id: 'm_missing', ok: false, tokens: 0 },
  ]
  await writeFile(join(paths(root).reads), reads.map((x) => JSON.stringify(x)).join('\n') + '\n', 'utf8')

  const writes = [
    { at: at(2), kind: 'tool-save', item: kept.id, status: 'active' },
    { at: at(2), kind: 'tool-save', item: gone.id, status: 'active' },
    { at: at(1), kind: 'tool-save', item: kept.id, status: 'exists', merged: false },
    { at: at(1), kind: 'tool-save', item: kept.id, status: 'merged', merged: true },
    { at: at(0.1), kind: 'tool-save', item: 'm_fresh', status: 'suggested', gate: 'warn' },
  ]
  await writeFile(join(paths(root).writes), writes.map((x) => JSON.stringify(x)).join('\n') + '\n', 'utf8')

  const m = await computeMetrics(root, { days: 30 })
  assert.equal(m.reads.searches, 2)
  assert.equal(m.reads.reads, 3)
  // 有效：命中的 search + 第一次 read；无效：空 search + 重复 read + 失败 read
  assert.equal(m.reads.effective, 2, JSON.stringify(m.reads))
  assert.equal(m.reads.invalid, 3, JSON.stringify(m.reads))
  assert.equal(m.reads.wasteTokens, 60)
  ok('读取：空检索 / 重复读 / 读失败都算无效，浪费 token 计入')

  assert.equal(m.writes.saves, 5)
  assert.equal(m.writes.duplicates, 2)
  assert.equal(m.writes.duplicateRate, 0.4)
  assert.equal(m.writes.warned, 1)
  ok('写入：exists / merged 算重复，warn 放行单独计数')

  // 满 24h 的四条进准确率：三条指向仍活着的 kept，一条指向被取代的 gone
  assert.equal(m.writes.judged, 4, JSON.stringify(m.writes))
  assert.equal(m.writes.kept, 3)
  assert.equal(m.writes.accuracy, 0.75)
  ok('准确率：满 24h 且仍活着的才算保留')

  const fresh = await computeMetrics(root, { days: 0.5 })
  assert.ok(fresh.writes.judged === 0 || fresh.writes.judged < m.writes.judged)
  ok('窗口可按天数收窄')

  console.log(`\n全部通过：${pass} 项`)
} catch (e) {
  console.error('\n失败：', e)
  process.exitCode = 1
} finally {
  await rm(root, { recursive: true, force: true }).catch(() => {})
}
