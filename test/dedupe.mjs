/**
 * dedupe.mjs —— 写入查重 / 原话与场景 / 检索重排
 *
 * 验的是 2026-11-11 的三条反馈：
 *   · 同一件事不能存两条：模型查重后给 merge_into，要并进旧条目
 *   · 每条要带原话和场景：主库、索引、检索结果都能读出来
 *   · 检索按相关重排：泛词只撞一个片段时，不能靠权重把无关条目顶上来
 */
import assert from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ensureDirs, loadScope, saveScope, addItem, findSimilarItem, mergeExistingItems } from '../lib/store.js'
import { itemToMarkdown, itemFromMarkdown, renderIndex } from '../lib/vault.js'
import { emptyScope } from '../lib/store.js'
import { enrichItem } from '../lib/enrich.js'
import { searchFunnel } from '../lib/funnel.js'
import { planDeepen, applyDeepen } from '../lib/deepen.js'

let pass = 0
const ok = (name) => { pass += 1; console.log('  ok', name) }
const root = await mkdtemp(join(tmpdir(), 'whale-dedupe-'))

try {
  await ensureDirs(root)
  const sc = emptyScope('local', 'dsh')

  // 1. 字面不像，但模型已经查过重：merge_into 必须并进旧条目
  const first = addItem(sc, {
    text: '要求菜单做成横向，子菜单不直接显示，只有点击主菜单后才显示对应下的子菜单',
    kind: 'pref',
    sourceQuote: '菜单整成横向，子菜单并不直接显示，只有点击主菜单才有选择对应下的子菜单',
    scene: '当时在调设置页的菜单布局',
    observedAt: '2026-11-11T02:19:41.779Z',
  })
  // 先确认旧的字面查重确实抓不到这对说法——这就是要 merge_into 的原因
  assert.equal(findSimilarItem(sc.items, '要求子菜单不要藏在主菜单里做成二级菜单，而是在点击主菜单后显示在主菜单内容页的顶部'), null)
  ok('字面查重抓不到的换说法，交给 merge_into')

  const before = sc.items.length
  const second = addItem(sc, {
    text: '设置页菜单要横向排列，点主菜单后把子菜单放在内容页顶部，不要藏成二级菜单',
    kind: 'pref',
    sourceQuote: '子菜单不要藏在主菜单里做二级菜单，子菜单可以当点击主菜单后，主菜单内容页中顶部显示子菜单',
    scene: '接着在说同一套菜单的交互',
    observedAt: '2026-11-11T02:32:02.709Z',
    mergeInto: first.id,
  })
  assert.equal(second.id, first.id, 'merge_into 应返回旧条目')
  assert.equal(sc.items.length, before, '不能新建第二条')
  assert.equal(second.merged, 1)
  assert.ok(second.text.includes('内容页顶部'), second.text)
  assert.ok(second.scene.includes('菜单布局') && second.scene.includes('同一套菜单'), second.scene)
  assert.equal(second.sourceQuote.includes('二级菜单'), true, second.sourceQuote)
  assert.ok((second.quoteHistory || []).some((x) => x.quote.includes('菜单整成横向')), JSON.stringify(second.quoteHistory))
  assert.ok((second.history || []).some((x) => x.text.includes('只有点击主菜单')), JSON.stringify(second.history))
  ok('同一件事合并：正文/场景/原话都保留，旧版本进 history')

  // 2. 库里已经重复的两条：合并后 source 标 superseded，target 留两边正文
  const dupScope = emptyScope('local', 'dup')
  const a = addItem(dupScope, {
    text: '要求菜单做成横向，子菜单不直接显示',
    kind: 'pref',
    sourceQuote: '菜单整成横向',
    scene: '在调设置页',
  })
  const b = addItem(dupScope, {
    text: '子菜单不要藏在主菜单里做二级菜单，点击主菜单后放在内容页顶部',
    kind: 'pref',
    sourceQuote: '子菜单不要藏在主菜单里做二级菜单',
    scene: '接着说同一套菜单',
  })
  assert.ok(a && b && a.id !== b.id)
  const kept = mergeExistingItems(dupScope, b.id, a.id)
  assert.equal(kept.id, a.id)
  assert.equal(b.state, 'superseded')
  assert.equal(b.supersededBy, a.id)
  assert.ok(a.text.includes('横向') && a.text.includes('二级菜单'), a.text)
  assert.ok(a.scene.includes('设置页') && a.scene.includes('同一套菜单'), a.scene)
  assert.ok(a.sourceQuote.includes('二级菜单'), a.sourceQuote)
  assert.ok((a.quoteHistory || []).some((x) => x.quote.includes('菜单整成横向')), JSON.stringify(a.quoteHistory))
  ok('旧库重复：memory_merge 并成一条，source 标已取代')

  // 3. 深化兜底：字面 Jaccard 只有 0.2，但共享 10 个内容 bigram，也要合并
  const deepScope = emptyScope('local', 'deep')
  addItem(deepScope, {
    text: '要求菜单做成横向，子菜单不直接显示，只有点击主菜单后才显示对应下的子菜单',
    kind: 'pref',
  })
  addItem(deepScope, {
    text: '要求子菜单不要藏在主菜单里做成二级菜单，而是在点击主菜单后显示在主菜单内容页的顶部',
    kind: 'pref',
  })
  const plan = planDeepen(deepScope, { indexBytes: 0 })
  assert.ok(plan.merges.length >= 1, JSON.stringify(plan))
  applyDeepen(deepScope, plan)
  const liveMenus = deepScope.items.filter((x) => x.state !== 'superseded')
  assert.equal(liveMenus.length, 1, JSON.stringify(deepScope.items.map((x) => [x.id, x.state])))
  assert.ok(liveMenus[0].text.includes('横向') && liveMenus[0].text.includes('二级菜单'), liveMenus[0].text)
  ok('深化兜底：共享内容 bigram 够多时也合并')

  // 2. 主库渲染带场景和原话，回读不丢
  const md = itemToMarkdown(second, sc)
  assert.ok(md.includes('## 场景') && md.includes('## 原话'), md)
  assert.ok(md.includes('子菜单不要藏在主菜单里'), md)
  const back = itemFromMarkdown(md)
  assert.equal(back.scene, second.scene)
  assert.equal(back.sourceQuote, second.sourceQuote)
  assert.ok((back.quoteHistory || []).length >= 1, JSON.stringify(back.quoteHistory))
  ok('主库：场景/原话/旧原话都能回读')

  // 3. 索引不是只有标题：场景也进目录，读不出背景的问题在这里补
  const index = renderIndex(sc)
  assert.ok(index.includes('场景：'), index)
  assert.ok(index.includes('菜单'), index)
  ok('索引：摘要后面带场景')

  // 4. 检索重排：高权重但只撞一个泛词的条目，不能挤掉真正相关的那条
  sc.items = [
    enrichItem({
      id: 'm_rel', text: '记忆插件部署后报错，因为 vendor tgz 没刷新，跑 deploy 才好',
      kind: 'fact', conf: 0.6, created: '2026-11-10T00:00:00.000Z', lastHit: '2026-11-10T00:00:00.000Z',
      state: 'active',
    }),
    enrichItem({
      id: 'm_noise', text: '每天聊完把最近的记忆记一下，别写太多',
      kind: 'pref', conf: 0.9, created: '2026-11-11T00:00:00.000Z', lastHit: '2026-11-11T00:00:00.000Z',
      state: 'active',
    }),
  ]
  sc.items[0].weight = 0.25
  sc.items[1].weight = 0.95
  const hits = searchFunnel([sc], { query: '记忆插件 报错', hops: false })
  assert.ok(hits.length >= 1, JSON.stringify(hits))
  assert.equal(hits[0].id, 'm_rel', JSON.stringify(hits.map((x) => [x.id, x.score, x.coverage])))
  assert.ok(!hits.some((x) => x.id === 'm_noise'), '只撞「记忆」一个泛词的高权重条目不该进结果')
  ok('检索重排：按内容词覆盖排序，泛词不再把无关条目带进来')

  console.log(`\n${pass} 通过 · 0 失败`)
} finally {
  await rm(root, { recursive: true, force: true }).catch(() => {})
}
