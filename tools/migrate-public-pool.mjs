/**
 * migrate-public-pool.mjs —— 把本机库里的 B站公开观察迁进公共池
 *
 * 背景：B站账本以前落在 local:dsh，群聊读不到。现在 public:web 是公共池，
 * 群、私聊、本机都能读，只有本机能写；存量 feed 要搬家。
 *
 * 注意不能只从 items 里删：saveVault 会把「从 items 里消失」的主库文件挪进
 * archive/full，留下可复活的副本。所以先物理移动文件，再分别保存两个分片。
 *
 * 跑法：
 *   node tools/migrate-public-pool.mjs           # dry-run，只列要搬的
 *   node tools/migrate-public-pool.mjs --apply   # 真搬
 */
import { existsSync } from 'node:fs'
import { mkdir, rename } from 'node:fs/promises'
import { join } from 'node:path'

import { rootDir, listScopes, loadScope, saveScope, auditWrite } from '../lib/store.js'
import { vaultPaths } from '../lib/vault.js'
import { buildProfile, buildMembers } from '../lib/profile.js'
import { buildGraph, saveGraph } from '../lib/graph.js'

const root = process.env.DSH_MEMORY_HOME || rootDir()
const apply = process.argv.includes('--apply')

const src = await loadScope(root, 'local', 'dsh')
const dst = await loadScope(root, 'public', 'web')
const movers = (src.items || []).filter((x) => x.source === 'bili')

if (!movers.length) {
  console.log('没有 source=bili 的条目，不用迁。')
  process.exit(0)
}

const clash = movers.filter((m) => (dst.items || []).some((x) => x.id === m.id))
if (clash.length) {
  console.error(`公共池里已有同 id 条目，先人工处理：${clash.map((x) => x.id).join(', ')}`)
  process.exit(1)
}

console.log(`local:dsh → public:web · ${movers.length} 条`)
for (const m of movers) console.log(`  ${m.id}  ${String(m.text).slice(0, 60)}`)

if (!apply) {
  console.log('\n这是 dry-run；确认无误后加 --apply。')
  process.exit(0)
}

// 1. 物理移动主库文件，避免 saveVault 把「消失」的条目录进 archive
const fromDir = vaultPaths(root, 'local', 'dsh').full
const toDir = vaultPaths(root, 'public', 'web').full
await mkdir(toDir, { recursive: true })
let movedFiles = 0
for (const m of movers) {
  const from = join(fromDir, `${m.id}.md`)
  const to = join(toDir, `${m.id}.md`)
  if (!existsSync(from)) continue
  if (existsSync(to)) throw new Error(`目标文件已存在：${to}`)
  await rename(from, to)
  movedFiles += 1
}

// 2. 两边条目重新分配，saveVault 会把 frontmatter 的 scope 重写成 public:web
src.items = (src.items || []).filter((x) => x.source !== 'bili')
dst.items = [...(dst.items || []), ...movers]
await saveScope(root, src)
await saveScope(root, dst)

// 3. 画像 / 成员 / 图谱按新库重建
const scopes = await listScopes(root)
const g = buildGraph(scopes)
for (const sc of scopes) {
  if (sc.scope !== 'local:dsh' && sc.scope !== 'public:web') continue
  sc.profile = buildProfile(sc, g)
  sc.members = buildMembers(sc)
  // 用 saveScope 而不是 saveScopeMeta：status.md 也是派生文件，要一起刷新
  await saveScope(root, sc)
}
await saveGraph(root, g)

await auditWrite(root, {
  kind: 'repair',
  scope: 'public:web',
  from: 'local:dsh',
  moved: movers.length,
  files: movedFiles,
  why: 'B站公开观察迁入公共池',
})
console.log(`\n完成：${movers.length} 条（文件 ${movedFiles} 个）；local:dsh 剩 ${src.items.length} 条，public:web 共 ${dst.items.length} 条。`)
