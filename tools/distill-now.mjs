/**
 * distill-now.mjs —— 立刻蒸馏所有 staging（不等 10 分钟空闲）
 * 跑法：node tools/distill-now.mjs
 */
const root = process.env.DSH_MEMORY_HOME || '$DSH_HOME/dsh-memory'
process.env.DSH_MEMORY_HOME = root

const { listStaging } = await import('../lib/ingest.js')
const { distillSession } = await import('../lib/distill.js')
const { listScopes } = await import('../lib/store.js')

const sids = await listStaging(root)
if (!sids.length) {
  console.log('staging 是空的：还没有消息被采集到。')
  console.log('先确认 DSH 跑的是修好的版本（日志里应有「桥接绑定预热 · 3 条」），再去 QQ 发一句。')
  process.exit(0)
}

for (const sid of sids) {
  const r = await distillSession(root, sid, { log: console.log })
  console.log(`${sid.slice(0, 22)} → ${JSON.stringify(r)}`)
}

console.log('\n--- 分片 ---')
const scopes = await listScopes(root)
if (!scopes.length) console.log('（还是空的：可能这几句里没有可提取的事实）')
for (const sc of scopes) {
  console.log(`${sc.scope} · ${sc.items.length} 条`)
  for (const it of sc.items.slice(-8)) console.log(`  [${it.kind}] ${it.text}`)
}