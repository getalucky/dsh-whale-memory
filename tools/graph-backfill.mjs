/**
 * graph-backfill.mjs —— 给已有记忆补 LLM 三元组
 *
 * 图谱一直是规则抽取，只认几种句式，大部分记忆进不了星云。
 * 这个脚本把还没抽过的 active 条目分批丢给模型，三元组落到 graph/triples.jsonl，
 * 然后整库重建一次 nodes/edges。
 *
 * 用法：
 *   node tools/graph-backfill.mjs                  # 预演：只算待补数量，不请求
 *   node tools/graph-backfill.mjs --yes            # 真跑，花 token
 *   node tools/graph-backfill.mjs --yes --limit 50 # 只补前 50 条
 *   node tools/graph-backfill.mjs --yes --batch 12 # 每批 12 条（默认 16）
 *
 * 幂等：已抽过的条目会跳过；返回空数组的批次会记 checked 标记，下次不再重复请求。
 * 中断安全：每批落一次盘，重跑接着补。
 */
import { rootDir, listScopes } from '../lib/store.js'
import { loadTriples, mergeTriples, saveTriples, buildGraph, saveGraph } from '../lib/graph.js'
import { setConfigRoot, llmReady, extractGraphTriples, lastLlmError } from '../lib/llm.js'

const args = process.argv.slice(2)
const has = (k) => args.includes(k)
const num = (k, d) => {
  const i = args.indexOf(k)
  const n = i >= 0 ? Number(args[i + 1]) : NaN
  return Number.isFinite(n) ? n : d
}

const root = rootDir()
setConfigRoot(root)
if (!llmReady()) {
  console.error('LLM 没配置：先在设置页填好端点/模型（或配 DSH_MEMORY_LLM_* 环境变量）。')
  process.exit(2)
}

const dry = !has('--yes')
const limit = Math.max(0, num('--limit', 0))
const batchSize = Math.max(1, Math.min(24, num('--batch', 16)))

const scopes = await listScopes(root)
let rows = await loadTriples(root)
const checked = new Set(rows.map((r) => String(r?.item ?? '')).filter(Boolean))

let active = 0
let pending = []
for (const sc of scopes) {
  for (const it of sc.items || []) {
    if (['archived', 'superseded', 'suggested', 'expired'].includes(it.state)) continue
    active += 1
    if (!checked.has(it.id)) pending.push({ id: it.id, text: it.text, scope: sc.scope })
  }
}
if (limit) pending = pending.slice(0, limit)

console.log(`active ${active} 条 · 已处理 ${checked.size} 条 · 待补 ${pending.length} 条 · 预计 ${Math.ceil(pending.length / batchSize)} 批`)
if (dry) {
  console.log('预演结束：没有请求模型。加 --yes 才会真跑。')
  process.exit(0)
}
if (!pending.length) {
  const g = buildGraph(scopes, rows)
  await saveGraph(root, g)
  console.log(`没有要补的。图谱：${g.nodes.length} 节点 / ${g.edges.length} 边`)
  process.exit(0)
}

let added = 0
let failed = 0
let batches = 0
for (let i = 0; i < pending.length; i += batchSize) {
  const batch = pending.slice(i, i + batchSize)
  const triples = await extractGraphTriples(batch)
  batches += 1
  if (!triples) {
    failed += 1
    console.error(`批 ${batches} 失败：${lastLlmError() || '未知原因'}（已处理 ${i}/${pending.length}）`)
    if (failed >= 3) {
      console.error('连续 3 批失败，先停下；修好端点后重跑，已落盘的部分不会丢。')
      break
    }
    continue
  }
  failed = 0
  const got = new Set(triples.map((t) => t.item))
  const incoming = [
    ...triples,
    ...batch.filter((x) => !got.has(x.id)).map((x) => ({ item: x.id, checked: true, at: new Date().toISOString() })),
  ]
  rows = mergeTriples(rows, incoming)
  await saveTriples(root, rows)
  added += triples.length
  console.log(`批 ${batches} · ${batch.length} 条 → ${triples.length} 个关系 · 累计 ${added}`)
}

const g = buildGraph(scopes, rows)
await saveGraph(root, g)
console.log(`完成：${added} 个新关系 · 图谱 ${g.nodes.length} 节点 / ${g.edges.length} 边`)
console.log(`三元组文件：${root}\\graph\\triples.jsonl`)
