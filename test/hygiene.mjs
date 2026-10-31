/**
 * hygiene.mjs —— 数据卫生：元消息、孤儿 staging、手动删除、截断
 * 跑法：node test/hygiene.mjs
 *
 * 这几条都是 2026-10-30 真实踩出来的坑，别删。
 */
import assert from 'node:assert'
import { mkdtemp, mkdir, readFile, rm, writeFile, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = await mkdtemp(join(tmpdir(), 'whale-hyg-'))
const cfgFile = join(root, 'qq-bridge-config.json')
// 空绑定表：任何 sessionId 都认不出来源
await writeFile(cfgFile, JSON.stringify({ 绑定: [] }), 'utf8')
process.env.DSH_QQ_BRIDGE_CONFIG = cfgFile

const {
  ensureDirs, paths, loadScope, saveScope, addItem, readJson,
} = await import('../lib/store.js')
const {
  isMetaMessage, quarantineStaging, listStaging, lastActive,
} = await import('../lib/ingest.js')
const { distillSession } = await import('../lib/distill.js')
const { forgetItem } = await import('../lib/forget.js')
const { renderMemory } = await import('../lib/inject.js')
const { extractTriples } = await import('../lib/graph.js')
const { activeSource } = await import('../lib/tools.js')

let pass = 0
const ok = (name) => { pass += 1; console.log('  ok', name) }

try {
  await ensureDirs(root)

  // 1. 宿主注入的元消息不能当成人话收进来
  assert.equal(isMetaMessage('Time sampled while preparing turn 31, step 1: 2026-10-30'), true)
  assert.equal(isMetaMessage('Browser time zone for this request: Asia/Shanghai'), true)
  assert.equal(isMetaMessage('Elapsed since the preceding model-visible message: 1m 46s.'), true)
  assert.equal(isMetaMessage('<system-reminder>xxx</system-reminder>'), true)
  assert.equal(isMetaMessage('Current runtime context. This snapshot supersedes earlier runtime-context snapshots.'), true)
  assert.equal(isMetaMessage('Current working directory: "$DSH_HOME\\dsh-fish\\home".'), true)
  assert.equal(isMetaMessage('Current DSH file policy: workspace-write.'), true)
  assert.equal(isMetaMessage('Approval policy: ask.'), true)
  assert.equal(isMetaMessage('Current DeepSeek Harness implementation checkout: "D:\\DeepSeek_Harness\\resources\\app.asar\\dsh\\".'), true)
  assert.equal(isMetaMessage('Current DeepSeek Harness Web GUI URL: "http://127.0.0.1:55666".'), true)
  assert.equal(isMetaMessage('老爹明天上班吗'), false)
  ok('过滤 harness 元消息')

  // 2. 认不出来源的 staging 挪进 orphan/，不再被反复重试
  const sid = 'session-orphan-test'
  await writeFile(join(paths(root).staging, `${sid}.jsonl`), JSON.stringify({ at: new Date().toISOString(), role: 'user', text: '记住：我下周三出差' }) + '\n', 'utf8')
  assert.ok((await listStaging(root)).includes(sid), 'staging 没写进去')
  const r = await distillSession(root, sid, { log: () => {} })
  assert.equal(r.why, 'quarantined', JSON.stringify(r))
  assert.equal((await listStaging(root)).includes(sid), false, 'orphan 还在扫描范围里')
  assert.ok(existsSync(join(paths(root).staging, 'orphan', `${sid}.jsonl`)), 'orphan 文件没搬过去')
  assert.ok(existsSync(join(paths(root).staging, 'orphan', 'index.jsonl')), 'orphan 索引没写')
  ok('孤儿 staging 隔离')

  // 3. 绑定表读不出来时不许隔离（可能只是正在写），下轮再试
  await writeFile(cfgFile, '{坏掉的 json', 'utf8')
  const sid2 = 'session-halfwritten'
  await writeFile(join(paths(root).staging, `${sid2}.jsonl`), JSON.stringify({ role: 'user', text: '记住：别搬我' }) + '\n', 'utf8')
  const r2 = await distillSession(root, sid2, { log: () => {} })
  assert.equal(r2.why, 'source config unreadable', JSON.stringify(r2))
  assert.equal((await listStaging(root)).includes(sid2), true, '读不出配置时不该搬走')
  await writeFile(cfgFile, JSON.stringify({ 绑定: [] }), 'utf8')
  ok('配置读不出来时不误搬')

  // 4. 手动删一条：从分片摘掉、进归档、画像跟着重算
  const sc = await loadScope(root, 'private', '123456789')
  const keep = addItem(sc, { text: '老爹喜欢喝冰美式', kind: 'pref', conf: 0.8 })
  const bad = addItem(sc, { text: '明天几点上班（这条不是单独叫你的：顺着接话就行', kind: 'event', conf: 0.55 })
  await saveScope(root, sc)
  const d = await forgetItem(root, 'private', '123456789', bad.id, { reason: 'test' })
  assert.equal(d.ok, true, JSON.stringify(d))
  const after = await loadScope(root, 'private', '123456789')
  assert.equal(after.items.length, 1)
  assert.equal(after.items[0].id, keep.id)
  assert.ok(after.profile.summary.includes('冰美式') || after.profile.summary.includes('偏好'), after.profile.summary)
  const arc = await readFile(join(paths(root).archive, 'private-123456789.jsonl'), 'utf8')
  assert.ok(arc.includes('不是单独叫你'), '归档里没有原文')
  const missing = await forgetItem(root, 'private', '123456789', 'm_nope')
  assert.equal(missing.ok, false)
  ok('手动删除走归档')

  // 5. 工具写保护：活跃记录过期就拒绝
  lastActive.sessionId = 's'
  lastActive.at = Date.now() - 11 * 60 * 1000
  lastActive.scope = { kind: 'private', id: '123456789', label: '私聊 123456789' }
  assert.equal(await activeSource(), null, '过期的活跃记录不该可用')
  lastActive.at = Date.now()
  assert.ok(await activeSource(), '新鲜的活跃记录应该可用')
  ok('活跃记录时效校验')

  // 6. 空分片不注入「记得 0 件事」；超长按行截断
  const empty = { scope: 'group:1', kind: 'group', id: '1', label: '群 1', items: [], profile: { summary: '这个群：记得 0 件事。' } }
  assert.equal(renderMemory(empty), '')
  const big = { scope: 'group:2', kind: 'group', id: '2', label: '群 2', profile: { summary: 'x' }, items: [] }
  for (let i = 0; i < 60; i++) big.items.push({ id: 'm' + i, text: '第' + i + '条记忆内容有点长用来占位置', kind: 'fact', conf: 1, hits: 9, created: new Date().toISOString(), lastHit: new Date().toISOString() })
  const cut = renderMemory(big, { topN: 60, maxChars: 200 })
  assert.ok(cut.length <= 210, '没截断：' + cut.length)
  assert.ok(cut.endsWith('…'), '截断没加省略号')
  assert.ok(!/第\d+条记忆内$/.test(cut), '截断切在半句上')
  ok('空分片不注入 / 按行截断')

  // 7. 图谱：裸地点只认地名尾缀
  const g1 = extractTriples('老爹在杭州', { self: '老爹' })
  assert.ok(g1.some((x) => x.rel === '在' && x.o === '杭州'), JSON.stringify(g1))
  const g2 = extractTriples('老爹在这里', { self: '老爹' })
  assert.equal(g2.length, 0, JSON.stringify(g2))
  ok('裸地点抽取不过火')

  console.log(`\n全部通过：${pass} 项`)
} catch (e) {
  console.error('\n失败：', e)
  process.exitCode = 1
} finally {
  await rm(root, { recursive: true, force: true }).catch(() => {})
}
