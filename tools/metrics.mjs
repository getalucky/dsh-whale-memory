/**
 * metrics.mjs —— 真实流量指标（读有效率 / 写入准确率 / 重复写入率）
 *
 *   node tools/metrics.mjs [天数]
 *
 * 只读账本和记忆库，不写任何东西；DSH 开着也能跑。
 */
import { rootDir, ensureDirs } from '../lib/store.js'
import { computeMetrics } from '../lib/metrics.js'

const root = process.env.DSH_MEMORY_HOME || rootDir()
const days = Number(process.argv[2]) || 30
await ensureDirs(root)

const pct = (v) => (v == null ? '—' : `${Math.round(v * 100)}%`)
const m = await computeMetrics(root, { days })

console.log(`窗口：近 ${m.windowDays} 天 · ${root}`)
console.log(`读取：search ${m.reads.searches} 次 · read ${m.reads.reads} 次`)
console.log(`  有效 ${m.reads.effective} · 无效 ${m.reads.invalid}（浪费 ${m.reads.wasteTokens} tok）· 有效率 ${pct(m.reads.effectiveness)}`)
console.log(`写入：${m.writes.saves} 次 · 待确认 ${m.writes.suggested} · warn 放行 ${m.writes.warned}`)
console.log(`  重复写入 ${m.writes.duplicates}（${pct(m.writes.duplicateRate)}）`)
console.log(`  24h 后仍保留 ${m.writes.kept}/${m.writes.judged}（准确率 ${pct(m.writes.accuracy)}）`)
if (!m.writes.judged) console.log('  提示：写入满 24 小时后才有准确率，刚装或刚清库时是 —。')
