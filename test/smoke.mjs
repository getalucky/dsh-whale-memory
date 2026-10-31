/**
 * smoke.mjs —— 最小自检（不依赖 DSH 宿主）
 * 跑法：node test/smoke.mjs
 */
import assert from 'node:assert'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ensureDirs, loadScope, saveScope, addItem, listScopes, paths, rootDir } from '../lib/store.js'
import { extractCandidates } from '../lib/distill.js'
import { renderMemory, decayScore, lifeState } from '../lib/inject.js'
import { runForget } from '../lib/forget.js'
import { stripBridgeNote } from '../lib/ingest.js'

const root = await mkdtemp(join(tmpdir(), 'whale-test-'))
let pass = 0
const ok = (name) => { pass += 1; console.log('  ok', name) }

try {
  await ensureDirs(root)
  await writeFile(join(root, 'persona.md'), '你是「大肥鱼」。', 'utf8')
  ok('ensureDirs')

  // 分片
  const sc = await loadScope(root, 'group', '123456789')
  assert.equal(sc.scope, 'group:123456789')
  const it1 = addItem(sc, { text: '老爹喜欢喝冰美式', kind: 'pref', conf: 0.8 })
  const it2 = addItem(sc, { text: '老爹喜欢喝冰美式', kind: 'pref', conf: 0.8 }) // 去重
  assert.equal(sc.items.length, 1)
  assert.equal(it2.hits, 1)
  await saveScope(root, sc)
  const again = await loadScope(root, 'group', '123456789')
  assert.equal(again.items.length, 1)
  ok('分片读写 + 去重')

  // 共享分片列表
  const priv = await loadScope(root, 'private', '123456789')
  addItem(priv, { text: '他叫爹', kind: 'relation', conf: 0.9 })
  await saveScope(root, priv)
  const all = await listScopes(root)
  assert.equal(all.length, 2)
  ok('listScopes')

  // 候选提取
  const c1 = extractCandidates('记住：我下周三出差，别在这天找我')
  assert.ok(c1.some((x) => x.text.includes('下周三出差')), JSON.stringify(c1))
  const c2 = extractCandidates('我叫阿鱼，住在杭州')
  assert.ok(c2.some((x) => x.text.includes('名字叫')), JSON.stringify(c2))
  assert.ok(c2.some((x) => x.text.includes('住在')), JSON.stringify(c2))
  const c3 = extractCandidates('我喜欢冰美式')
  assert.ok(c3.some((x) => x.kind === 'pref'), JSON.stringify(c3))
  const c4 = extractCandidates('今天天气不错')
  assert.equal(c4.length, 0)
  ok('候选提取')

  // 渲染
  const text = renderMemory(again, { topN: 5 })
  assert.ok(text.includes('冰美式'), text)
  assert.ok(text.includes('群 123456789'), text)
  ok('渲染')

  // 语义去重：换人称、子句包含
  const ded = await loadScope(root, 'private', '999')
  addItem(ded, { text: '老爹今天下午3点上班，明天8:30上班', kind: 'fact' })
  addItem(ded, { text: '我今天下午3点上班，明天8：30上班', kind: 'fact' })
  addItem(ded, { text: '明天8：30上班', kind: 'event' })
  assert.equal(ded.items.length, 1, JSON.stringify(ded.items.map((x) => x.text)))
  ok('语义去重（换人称 + 子句）')

  addItem(ded, { text: '明天要开周会', kind: 'event' })
  assert.equal(ded.items.length, 2, JSON.stringify(ded.items.map((x) => x.text)))
  ok('不相干不误合')

  // 遗忘：造一条 200 天前的记忆
  const old = addItem(again, { text: '很久以前的事', kind: 'fact', conf: 0.3 })
  old.created = new Date(Date.now() - 200 * 86400000).toISOString()
  old.lastHit = old.created
  await saveScope(root, again)
  const r = await runForget(root)
  assert.ok(r.archived >= 1, JSON.stringify(r))
  const after = await loadScope(root, 'group', '123456789')
  assert.ok(!after.items.some((x) => x.text === '很久以前的事'))
  ok('遗忘归档')

  // 新鲜条目保留
  assert.ok(after.items.some((x) => x.text.includes('冰美式')))
  ok('新鲜条目保留')

  // 桥接旁白必须剥掉（否则旁白会被当成事实记下来）
  const dirty = '明天几点上班\n\n（这条不是单独叫你的：顺着接话就行，不用点名道姓，也不要用 @。）'
  assert.equal(stripBridgeNote(dirty), '明天几点上班')
  ok('剥桥接旁白')

  // 正文自带的括号不能误删
  const keepParen = '我明天（大概）8:30 上班'
  assert.equal(stripBridgeNote(keepParen), keepParen)
  ok('不动正文括号')

  console.log(`\n全部通过：${pass} 项`)
} catch (e) {
  console.error('\n失败：', e)
  process.exitCode = 1
} finally {
  await rm(root, { recursive: true, force: true }).catch(() => {})
}