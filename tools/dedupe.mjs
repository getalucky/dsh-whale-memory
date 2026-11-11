#!/usr/bin/env node
/**
 * dedupe.mjs —— 手动扫一遍「同一件事存了两条」的旧重复。
 *
 * 默认只预演，不改库；加 --apply 才真的合并（source 标 superseded，主库正文不删）。
 * 判据和深化一致：同类型、数字签名一致、共享 ≥10 个内容 bigram。
 * 这个工具只做合并，不做容量归档。
 *
 *   node tools/dedupe.mjs
 *   node tools/dedupe.mjs --apply
 *   node tools/dedupe.mjs --scope local:dsh
 */
import { rootDir, ensureDirs, listScopes, saveScope, auditWrite } from '../lib/store.js'
import { planDeepen, applyDeepen } from '../lib/deepen.js'

const root = rootDir()
await ensureDirs(root)
const apply = process.argv.includes('--apply')
const scopeArg = (() => {
  const i = process.argv.indexOf('--scope')
  return i >= 0 ? String(process.argv[i + 1] || '').trim() : ''
})()

let total = 0
for (const scope of await listScopes(root)) {
  if (scopeArg && scope.scope !== scopeArg) continue
  const plan = planDeepen(scope, { indexBytes: 0 })
  const groups = plan.merges || []
  if (!groups.length) continue
  total += groups.length
  console.log(`\n${scope.scope} · ${groups.length} 组重复`)
  for (const g of groups) {
    console.log(`  - ${g.items.map((x) => `${x.id}「${String(x.text || '').slice(0, 60)}」`).join('  ×  ')}`)
  }
  if (apply) {
    const out = applyDeepen(scope, { merges: groups, archive: [] })
    await saveScope(root, scope)
    await auditWrite(root, { kind: 'dedupe', scope: scope.scope, merged: out.merged }).catch(() => {})
    console.log(`  已合并 ${out.merged} 条`)
  }
}
console.log(apply
  ? `\n完成：${total} 组重复已合并。`
  : `\n预演：${total} 组重复。加 --apply 才写入；合并前建议先备份 ${root}/scopes。`)
