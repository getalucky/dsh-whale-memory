/**
 * lifecycle.mjs —— 生命周期验收（阶段 6 / 文档 8.1-8.4）
 *
 *   · TTL 到期：条目变 expired，主库保留，副库/骨架/检索都剔除
 *   · 删除：文件挪进 archive/full，可复活
 *   · 复活：状态回到 active，副库重新出现
 */
import assert from 'node:assert'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ensureDirs, addItem, loadScope, saveScope, emptyScope } from '../lib/store.js'
import { runForget, forgetItem, reviveItem } from '../lib/forget.js'
import { renderSkeleton } from '../lib/skeleton.js'
import { searchFunnel } from '../lib/funnel.js'
import { vaultPaths } from '../lib/vault.js'

let pass = 0
const ok = (name) => { pass += 1; console.log('  ok', name) }

const root = await mkdtemp(join(tmpdir(), 'whale-life-'))
try {
  await ensureDirs(root)
  const sc = emptyScope('private', '77', '私聊 77')
  const exp = addItem(sc, { text: '记住，这张优惠券月底过期', kind: 'event', conf: 0.7 })
  const del = addItem(sc, { text: '记住，周五要交房租', kind: 'event', conf: 0.7 })
  exp.expiresAt = '2020-01-01'
  await saveScope(root, sc)

  // 1. 过期
  const r = await runForget(root, {})
  assert.ok(r.changed >= 1, JSON.stringify(r))
  const after = await loadScope(root, 'private', '77')
  assert.equal(after.items.find((x) => x.id === exp.id).state, 'expired')
  assert.equal(after.items.find((x) => x.id === del.id).state, 'active')

  const idx = await readFile(vaultPaths(root, 'private', '77').index, 'utf8')
  assert.ok(!idx.includes(exp.id), '过期的条目不该在副库')
  assert.ok(idx.includes(del.id), '正常条目应还在副库')
  assert.ok(!renderSkeleton(after).includes('优惠券'), '过期的条目不该进骨架')
  assert.equal(searchFunnel([after], { query: '优惠券' }).length, 0)
  ok('TTL：expired 不进副库/骨架/检索，主库文件保留')

  // 2. 删除 → 文件进归档
  const f = await forgetItem(root, 'private', '77', del.id, { reason: 'test' })
  assert.ok(f.ok, JSON.stringify(f))
  const p = vaultPaths(root, 'private', '77')
  const archived = await readFile(join(p.archiveFull, `${del.id}.md`), 'utf8')
  assert.ok(archived.includes('交房租'), archived.slice(0, 80))
  ok('删除：主库文件挪进 archive/full')

  // 3. 复活
  const rv = await reviveItem(root, '', '', del.id)
  assert.ok(rv.ok, JSON.stringify(rv))
  const revived = await loadScope(root, 'private', '77')
  const back = revived.items.find((x) => x.id === del.id)
  assert.ok(back && back.state === 'active', JSON.stringify(back))
  assert.ok((await readFile(p.index, 'utf8')).includes(del.id), '复活后副库应重新出现')
  ok('复活：归档条目回到 active，副库恢复')

  // 4. 过期条目也能复活（清掉 expiresAt）
  const rv2 = await reviveItem(root, 'private', '77', exp.id)
  assert.ok(rv2.ok, JSON.stringify(rv2))
  const e2 = (await loadScope(root, 'private', '77')).items.find((x) => x.id === exp.id)
  assert.equal(e2.state, 'active')
  assert.equal(e2.expiresAt, '')
  ok('过期条目可复活并清掉 TTL')

  // 5. 待确认没人点头：3 天自动归档，3 天内留着
  const sc2 = emptyScope('private', '88', '私聊 88')
  const stale = addItem(sc2, { text: '用户说下个月想去大理', kind: 'fact', conf: 0.5, state: 'suggested' })
  const fresh = addItem(sc2, { text: '用户说周末要修显示器', kind: 'fact', conf: 0.5, state: 'suggested' })
  stale.created = new Date(Date.now() - 4 * 86400000).toISOString()
  fresh.created = new Date(Date.now() - 1 * 86400000).toISOString()
  await saveScope(root, sc2)
  const rf = await runForget(root, {})
  assert.ok(rf.archived >= 1, JSON.stringify(rf))
  const sc2After = await loadScope(root, 'private', '88')
  assert.ok(!sc2After.items.some((x) => x.id === stale.id), '超过 3 天的待确认应被清出分片')
  assert.equal(sc2After.items.find((x) => x.id === fresh.id)?.state, 'suggested', '3 天内的待确认要留着')
  const p2 = vaultPaths(root, 'private', '88')
  const kept = await readFile(join(p2.archiveFull, `${stale.id}.md`), 'utf8')
  assert.ok(kept.includes('大理'), '清掉的待确认要进 archive/full，不能物理删')
  ok('待确认 3 天没回应：自动归档，pending 不再挂着')

  console.log(`\n${pass} 通过 · 0 失败`)
} finally {
  await rm(root, { recursive: true, force: true }).catch(() => {})
}
