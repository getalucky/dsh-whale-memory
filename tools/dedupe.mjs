/**
 * dedupe.mjs —— 合并历史里已经写进去的重复记忆
 * 跑法：node tools/dedupe.mjs
 *
 * 规则：bigram 相似度 ≥ 0.72 的合并到最早那条，
 * 保留更长的说法，命中数相加，置信度取高。
 */
const root = process.env.DSH_MEMORY_HOME || '$DSH_HOME/dsh-memory'
process.env.DSH_MEMORY_HOME = root

const { listScopes, saveScope, findSimilarItem, auditWrite } = await import('../lib/store.js')

const scopes = await listScopes(root)
let totalMerged = 0

for (const sc of scopes) {
  const items = sc.items.filter((x) => x.state !== 'archived')
  const keep = []
  let merged = 0
  const log = []

  for (const it of items) {
    const found = findSimilarItem(keep, it.text)
    const hit = found?.item ?? null
    if (hit) {
      hit.hits += (it.hits ?? 0) + 1
      hit.merged = (hit.merged ?? 0) + 1 + (it.merged ?? 0)
      if (it.conf > (hit.conf ?? 0)) hit.conf = it.conf
      if ((it.lastHit ?? '') > (hit.lastHit ?? '')) hit.lastHit = it.lastHit
      if (it.text.length > hit.text.length) {
        log.push(`  「${hit.text}」 → 「${it.text}」`)
        hit.text = it.text
      } else {
        log.push(`  合并：「${it.text}」`)
      }
      merged += 1
    } else {
      keep.push({ ...it })
    }
  }

  if (merged) {
    sc.items = [...keep, ...sc.items.filter((x) => x.state === 'archived')]
    await saveScope(root, sc)
    await auditWrite(root, { kind: 'dedupe', scope: sc.scope, merged })
    console.log(`${sc.scope}：合并 ${merged} 条`)
    for (const l of log) console.log(l)
    totalMerged += merged
  } else {
    console.log(`${sc.scope}：无重复`)
  }
}

console.log(`\n共合并 ${totalMerged} 条`)
for (const sc of await listScopes(root)) {
  console.log(`${sc.scope} · ${sc.items.length} 条`)
  for (const it of sc.items) console.log(`  [${it.kind}] ${it.text}  (hits=${it.hits})`)
}