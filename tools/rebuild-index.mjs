/**
 * rebuild-index.mjs —— 从主库重建副库（对应文档 8.4 / 12.3）
 *
 * 用法：
 *   node tools/rebuild-index.mjs                  # 全部 scope
 *   node tools/rebuild-index.mjs group:123456789  # 只重建一个
 *
 * 场景：memory_index.md 被删/被手改坏/标签体系改版。主库 memory_full/ 是唯一真源，
 * 这个脚本只重写派生文件，不动正文。
 */
import { rootDir, ensureDirs, listScopes } from '../lib/store.js'
import { rebuildScope, verifyScope } from '../lib/vault.js'

const root = process.env.DSH_MEMORY_HOME || rootDir()
const want = process.argv[2] || ''

await ensureDirs(root)
let scopes = await listScopes(root)
if (want) scopes = scopes.filter((s) => s.scope === want)
if (!scopes.length) {
  console.log(`没有可重建的分片${want ? `：${want}` : ''}`)
  process.exit(0)
}

let bad = 0
for (const sc of scopes) {
  const before = sc.items.length
  const out = await rebuildScope(root, sc.kind, sc.id)
  const v = await verifyScope(root, sc.kind, sc.id)
  if (!v.ok) bad += 1
  console.log(`${v.ok ? 'ok  ' : 'FAIL'} ${sc.scope} · 条目 ${before} → ${out.items.length} · 主库 ${v.files} 个文件`)
}
console.log(`\n重建 ${scopes.length} 个分片，异常 ${bad} 个。`)
if (bad) process.exitCode = 1
