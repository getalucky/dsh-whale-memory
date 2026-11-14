/**
 * backupbundle.mjs —— 界面导出/导入的可移植备份包
 *
 * 验的是：导出包含分片条目和人格文件；导入到新库能合并、
 * 重复导入不重复、死状态条目不导入、文件格式校验会拒绝坏包。
 */
import assert from 'node:assert'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildBundle, importBundle } from '../lib/backupbundle.js'
import { addItem, emptyScope, ensureDirs, loadScope, saveScope } from '../lib/store.js'

let pass = 0
const ok = (name) => { pass += 1; console.log('  ok', name) }

const 家 = await mkdtemp(join(tmpdir(), 'whale-bundle-'))
const 源 = join(家, '源库')
const 目标 = join(家, '目标库')

try {
  await ensureDirs(源)
  const sc = emptyScope('private', '1', '爹')
  addItem(sc, { text: '爹喜欢吃饺子', kind: 'pref', source: 'test' })
  addItem(sc, { text: '明天八点半上班', kind: 'event', source: 'test' })
  await saveScope(源, sc)
  await writeFile(join(源, 'persona.md'), '# 人格真源\n', 'utf8')

  const bundle = await buildBundle(源)
  assert.equal(bundle.format, 'whale-memory-bundle')
  assert.equal(bundle.version, 1)
  assert.equal(bundle.scopes.length, 1)
  assert.equal(bundle.scopes[0].items.length, 2)
  assert.equal(bundle.files['persona.md'], '# 人格真源\n')
  ok('导出：分片条目和人格文件都在')

  const 预演 = await importBundle(目标, bundle, { dryRun: true })
  assert.equal(预演.dryRun, true)
  assert.equal(预演.totals.added, 2)
  assert.equal(existsSync(join(目标, 'scopes', 'private-1')), false)
  ok('预演：算出可导入条数，不写盘')

  const 导入 = await importBundle(目标, bundle, { dryRun: false })
  assert.equal(导入.totals.added, 2)
  const 目标片 = await loadScope(目标, 'private', '1')
  assert.equal(目标片.items.length, 2)
  assert.ok(目标片.items.some((x) => x.text === '爹喜欢吃饺子'))
  assert.equal(existsSync(join(目标, 'persona.md')), true)
  ok('导入：条目和缺失的人格文件合并进新库')

  const 再导入 = await importBundle(目标, bundle, { dryRun: false })
  assert.equal(再导入.totals.added, 0)
  assert.equal(再导入.totals.skipped, 2)
  ok('重复导入：同 id/同文不重复')

  const 坏包 = { ...bundle, scopes: [...bundle.scopes, {
    kind: 'private', id: '2', label: '测试', items: [
      { id: 'dead-1', text: '这条已经归档', kind: 'fact', state: 'archived' },
    ],
  }] }
  const 死条 = await importBundle(目标, 坏包, { dryRun: false })
  assert.equal(死条.totals.dead, 1)
  ok('死状态条目跳过')

  let 失败 = ''
  try { await importBundle(目标, { format: 'unknown' }, { dryRun: true }) } catch (e) { 失败 = String(e.message || e) }
  assert.ok(失败.includes('不是 whale-memory 备份文件'), 失败)
  ok('坏格式拒绝')

  console.log(`\n全部通过：${pass} 项`)
} finally {
  await rm(家, { recursive: true, force: true })
}
