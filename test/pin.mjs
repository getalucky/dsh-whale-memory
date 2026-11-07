/**
 * pin.mjs —— 公共池衰减 + 知识库钉住
 *
 *   · 公共池不再豁免遗忘：旧情报会变冷并归档
 *   · pin / kind=knowledge 不吃时间衰减，不归档
 *   · 自动钉住的三条阈值：知识类型 / 反复写入 / 反复被查
 *   · pin 字段能落主库再读回来
 */
import assert from 'node:assert'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ensureDirs, emptyScope, addItem, saveScope, loadScope, autoPinWhy, setPin, decayScore, appendSearchHits } from '../lib/store.js'
import { runForget } from '../lib/forget.js'
import { searchFunnel } from '../lib/funnel.js'
import { vaultPaths } from '../lib/vault.js'

let pass = 0
const ok = (name) => { pass += 1; console.log('  ok', name) }

const root = await mkdtemp(join(tmpdir(), 'whale-pin-'))
try {
  await ensureDirs(root)
  const old = new Date(Date.now() - 400 * 86400000).toISOString()

  // 1. 公共池旧情报该沉下去，钉住的知识留下
  const pub = emptyScope('public', 'web', '公共记忆池')
  const stale = addItem(pub, { text: '很久以前的一条外部情报', kind: 'fact', conf: 0.55 })
  const known = addItem(pub, { text: '长期有效的知识：改 lib 后必须 deploy', kind: 'knowledge', conf: 0.55 })
  for (const it of [stale, known]) { it.created = old; it.lastHit = old }
  await saveScope(root, pub)

  const r = await runForget(root, {})
  assert.ok(r.archived >= 1, JSON.stringify(r))
  const after = await loadScope(root, 'public', 'web')
  assert.ok(!after.items.some((x) => x.id === stale.id), '没钉的旧情报应归档')
  const kept = after.items.find((x) => x.id === known.id)
  assert.ok(kept, '知识条目不该被归档')
  assert.equal(kept.state, 'active')
  assert.ok(kept.pin)
  assert.equal(kept.pinWhy, 'knowledge')
  const archivedMd = await readFile(join(vaultPaths(root, 'public', 'web').archiveFull, `${stale.id}.md`), 'utf8').catch(() => '')
  assert.ok(archivedMd.includes('外部情报'), '归档文件要保留正文')
  ok('公共池：旧情报归档，pin/knowledge 不衰减')

  // 2. 钉住后权重不吃时间衰减
  const fresh = { text: 'x', conf: 0.8, created: old, lastHit: old, hits: 0 }
  assert.ok(decayScore(fresh) < 0.05, '不钉的条目 400 天后应接近 0')
  assert.equal(decayScore({ ...fresh, pin: true }), 0.8)
  ok('decayScore：pin 免疫时间衰减')

  // 3. 自动判定
  assert.equal(autoPinWhy({ kind: 'knowledge' }), 'knowledge')
  assert.equal(autoPinWhy({ kind: 'fact', hits: 1, merged: 2 }), 'reused')
  assert.equal(autoPinWhy({ kind: 'fact', searchHits: 8 }), 'used')
  assert.equal(autoPinWhy({ kind: 'fact', pin: true }), '')
  ok('autoPinWhy：知识 / 反复写入 / 反复被查')

  // 4. pin 落主库再读回
  const it2 = addItem(pub, { text: '手动钉住的一条', kind: 'fact', conf: 0.6 })
  setPin(it2, true, 'manual')
  await saveScope(root, pub)
  const md = await readFile(join(vaultPaths(root, 'public', 'web').full, `${it2.id}.md`), 'utf8')
  assert.ok(/^pin: true$/m.test(md), md.slice(0, 300))
  const back = (await loadScope(root, 'public', 'web')).items.find((x) => x.id === it2.id)
  assert.ok(back.pin)
  assert.equal(back.pinWhy, 'manual')
  ok('pin 字段：主库往返不丢')

  // 5. 知识库检索只回钉住的
  const hits = searchFunnel([await loadScope(root, 'public', 'web')], { query: '知识', pinned: true })
  assert.ok(hits.length >= 1)
  assert.ok(hits.every((x) => x.pinned))
  ok('searchFunnel(pinned)：只回知识库条目')

  // 6. 反复被搜到的公共条目，在 forget 批处理里自动钉住
  //    搜索侧只追加 search_hits.jsonl（不重写副库），批处理 drain 后折算
  const hot = addItem(pub, { text: '被搜到很多次的公开情报', kind: 'fact', conf: 0.55 })
  await saveScope(root, pub)
  for (let i = 0; i < 8; i += 1) await appendSearchHits(root, 'public', 'web', [hot.id])
  const afterHits = (await loadScope(root, 'public', 'web')).items.find((x) => x.id === hot.id)
  assert.equal(afterHits.searchHits, 0, '搜索不应该直接改主库')
  await runForget(root, {})
  const hotBack = (await loadScope(root, 'public', 'web')).items.find((x) => x.id === hot.id)
  assert.ok(hotBack?.pin, JSON.stringify(hotBack))
  assert.equal(hotBack.pinWhy, 'used')
  assert.equal(hotBack.searchHits, 8)
  ok('forget 批处理：search_hits 账本达标自动钉住')

  console.log(`\n${pass} 通过 · 0 失败`)
} finally {
  await rm(root, { recursive: true, force: true }).catch(() => {})
}
