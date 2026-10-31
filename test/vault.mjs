/**
 * vault.mjs —— 主副库验收（阶段 2）
 *
 * 验的是文档第 4 章的硬约束：
 *   · 旧 JSON 能迁移成目录，旧文件不丢
 *   · 主库是唯一真源；删掉副库能重建
 *   · 删条目 = 主库文件挪进 archive，不是物理删
 *   · 副库 ≤32KB，超限有降级
 *   · 条目正文里的换行 / ## 不会破坏解析
 */
import assert from 'node:assert'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  ensureDirs, loadScope, saveScope, addItem, paths, scopeRevFile,
} from '../lib/store.js'
import {
  itemToMarkdown, itemFromMarkdown, renderIndex, rebuildScope, verifyScope, vaultPaths,
} from '../lib/vault.js'

let pass = 0
const ok = (name) => { pass += 1; console.log('  ok', name) }
const root = await mkdtemp(join(tmpdir(), 'whale-vault-'))

try {
  await ensureDirs(root)

  // 1. 旧版 JSON → 目录
  const legacy = {
    scope: 'private:123',
    kind: 'private',
    id: '123',
    label: '私聊 123',
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-02T00:00:00.000Z',
    profile: { summary: '旧画像', traits: [], updated: '' },
    members: {},
    items: [
      { id: 'm_a', text: '老爹喜欢冰美式', kind: 'pref', conf: 0.8, created: '2026-10-01T00:00:00.000Z', lastHit: '2026-10-02T00:00:00.000Z', hits: 2, merged: 0, state: 'active', source: 'session:x' },
      { id: 'm_b', text: '老爹明天8:30上班', kind: 'event', conf: 0.7, created: '2026-10-02T00:00:00.000Z', lastHit: '2026-10-02T00:00:00.000Z', hits: 0, merged: 0, state: 'superseded', supersededBy: 'm_c', source: 'session:y' },
    ],
  }
  await writeFile(join(paths(root).scopes, 'private-123.json'), JSON.stringify(legacy), 'utf8')
  await ensureDirs(root) // 再跑一次触发迁移

  const p123 = vaultPaths(root, 'private', '123')
  const fullNames = (await readdir(p123.full)).filter((n) => n.endsWith('.md'))
  assert.equal(fullNames.length, 2, `主库文件应 2 个，实际 ${fullNames.join(',')}`)
  const index = await readFile(p123.index, 'utf8')
  assert.ok(index.includes('m_a') && index.includes('冰美式'), index)
  assert.ok(!index.includes('m_b'), '被取代的条目不该进副库')
  const legacyLeft = await readdir(paths(root).scopes)
  assert.ok(!legacyLeft.includes('private-123.json'), '旧 JSON 应已迁走')
  ok('旧 JSON 迁移：主库 2 个文件，副库排除 superseded')

  // 2. 读回来字段不丢
  const sc = await loadScope(root, 'private', '123')
  assert.equal(sc.items.length, 2)
  assert.equal(sc.items.find((x) => x.id === 'm_a').hits, 2)
  assert.equal(sc.items.find((x) => x.id === 'm_b').state, 'superseded')
  assert.equal(sc.items.find((x) => x.id === 'm_b').supersededBy, 'm_c')
  assert.ok(sc.items.find((x) => x.id === 'm_a').timeline, 'timeline 要能读出来')
  ok('主库回读：状态 / 命中 / 取代关系都在')

  // 3. 更新正文 → 主库和副库同步
  const a = sc.items.find((x) => x.id === 'm_a')
  a.text = '老爹只喝冰美式，不加糖'
  a.conf = 0.9
  await saveScope(root, sc)
  const mdA = await readFile(join(p123.full, 'm_a.md'), 'utf8')
  assert.ok(mdA.includes('老爹只喝冰美式，不加糖'), mdA)
  assert.ok((await readFile(p123.index, 'utf8')).includes('只喝冰美式'), '副库摘要没更新')
  ok('改一条：主库正文 + 副库摘要同步')

  // 4. 删条目：文件进 archive/full，副库移除
  sc.items = sc.items.filter((x) => x.id !== 'm_a')
  await saveScope(root, sc)
  const archived = (await readdir(p123.archiveFull)).filter((n) => n.endsWith('.md'))
  assert.ok(archived.includes('m_a.md'), '删掉的条目应保留在 archive/full')
  assert.ok(!(await readFile(p123.index, 'utf8')).includes('m_a'), '副库不该再有它')
  ok('删条目：主库文件挪进 archive，不物理删')

  // 5. 副库可删可重建（先补一条活条目，superseded 本来就不进副库）
  sc.items.push({ id: 'm_c', text: '新建的活条目：周五交房租', kind: 'event', conf: 0.7, created: '2026-10-04T00:00:00.000Z', state: 'active', hits: 0 })
  await saveScope(root, sc)
  await rm(p123.index)
  await rebuildScope(root, 'private', '123')
  const rebuilt = await readFile(p123.index, 'utf8')
  assert.ok(rebuilt.includes('m_c'), rebuilt)
  assert.ok(rebuilt.includes('派生视图'), rebuilt)
  ok('删掉 memory_index.md 能重建')

  // 6. 一致性自检
  const v = await verifyScope(root, 'private', '123')
  assert.ok(v.ok, JSON.stringify(v))
  ok('主副库一致性：文件数 = 条目数')

  // 7. 正文里的换行和 ## 不破坏解析
  const tricky = {
    id: 'm_t', text: '第一行\n## 这行不是标题\n第三行 {{x}}', kind: 'fact', conf: 0.6,
    created: '2026-10-03T00:00:00.000Z', state: 'active', hits: 0,
  }
  const md = itemToMarkdown(tricky, { scope: 'private:123' })
  const back = itemFromMarkdown(md)
  assert.equal(back.text, tricky.text)
  ok('正文含换行 / ## / {{ 也能原样读回')

  // 8. 副库 32KB 硬上限
  const big = { ...legacy, items: Array.from({ length: 400 }, (_, i) => ({
    id: `m_big_${i}`, text: `这是第 ${i} 条比较长的记忆内容，用来把副库撑到上限以上，看看降级顺序对不对`,
    kind: 'fact', conf: 0.6, created: '2026-10-03T00:00:00.000Z', lastHit: '2026-10-03T00:00:00.000Z',
    hits: 0, state: 'active', tags: ['压力测试', '长标签'], parentTags: ['测试'],
  })) }
  const body = renderIndex(big)
  assert.ok(Buffer.byteLength(body, 'utf8') <= 32 * 1024, `副库 ${Buffer.byteLength(body, 'utf8')} 字节`)
  assert.ok(/折叠/.test(body), '超限要有折叠说明')
  ok('副库 ≤32KB，超限折叠')

  console.log(`\n${pass} 通过 · 0 失败`)
} finally {
  await rm(root, { recursive: true, force: true }).catch(() => {})
}
