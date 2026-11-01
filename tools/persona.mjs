/**
 * persona.mjs —— 人格蒸馏闸门的命令行入口
 *
 *   node tools/persona.mjs status
 *   node tools/persona.mjs probe
 *   node tools/persona.mjs propose [--out 文件]
 *   node tools/persona.mjs apply [提案文件] --approve
 *   node tools/persona.mjs rollback [版本号]
 *
 * 没有 --approve 不会写任何东西：提案必须先给人看，确认后才生效。
 * probe 是静态体检（20 项），apply 前后各跑一次，通过项数掉了就拒绝。
 */
import { join } from 'node:path'

import { rootDir, ensureDirs } from '../lib/store.js'
import {
  status, propose, applyProposal, rollback, probePersona, rejectProposal, PERSONA,
} from '../lib/persona.js'

const root = process.env.DSH_MEMORY_HOME || rootDir()
const [cmd = 'status', ...args] = process.argv.slice(2)
await ensureDirs(root)

const flag = (name) => args.includes(name)
const positional = args.filter((x) => !x.startsWith('--'))

try {
  if (cmd === 'status') {
    const s = await status(root)
    console.log(`人格 · v${s.version} · ${s.tokens}/${s.limit} tokens${s.overBudget ? '（超预算）' : ''}`)
    console.log(`区块：CORE ${s.hasCore ? '有' : '缺'} · EVOLVABLE ${s.hasEvolvable ? '有' : '缺'}`)
    console.log(`探针：${s.probes.passed}/${s.probes.total}${s.probes.failed.length ? `（${s.probes.failed.map((f) => f.name).join('、')}）` : ''}`)
    console.log(`归档：${s.archive.length ? s.archive.join(', ') : '（空）'}`)
    const a = s.auto
    console.log(`自动迭代：新消息 ${a.pendingMessages}/${a.minMessages} · 连续人工通过 ${a.streak}/${a.minStreak} · ` +
      (a.publishedThisWeek ? `本周已发布，下次 ${a.nextPublishAt}` : '本周未发布') +
      `${a.autoPublished ? ` · 已自动发布 ${a.autoPublished} 次` : ''}`)
    if (a.lastRunAt) console.log(`上次提案：${a.lastRunAt}`)
  } else if (cmd === 'probe') {
    const r = await probePersona(root)
    console.log(`探针 ${r.passed}/${r.total}`)
    for (const f of r.failed) console.log(`  ✗ ${f.name} — ${f.detail}`)
    if (r.failed.length) process.exitCode = 1
  } else if (cmd === 'propose') {
    // 手动蒸馏默认要 20 条有效样本；--force 只给调试/极端情况用
    const p = await propose(root, { manual: !flag('--force') })
    const outIdx = args.indexOf('--out')
    const out = outIdx >= 0 ? args[outIdx + 1] : join(root, PERSONA.proposal)
    console.log(`候选 ${p.additions.length} 条，证据 ${p.sources} 条记忆，预算 ${p.budget.tokens}/${p.budget.limit}`)
    if (p.samples) {
      console.log(`样本 ${p.samples.count} 条 / ${p.samples.scopes} 个分片（跳过 ${p.samples.skipped}）· 生成 ${p.generator} · 审查 ${p.reviewer}`)
    }
    for (const a of p.additions) {
      console.log(`\n+ ${a.rule}`)
      for (const e of a.evidence.slice(0, 3)) console.log(`    依据 ${e.id}：${e.text}`)
    }
    for (const r of p.rejected || []) console.log(`\n✗ ${r.rule}\n    ${r.why}`)
    for (const w of p.warnings) console.log(`! ${w}`)
    console.log(`\n提案：${out}\n确认无误后：node tools/persona.mjs apply ${out} --approve`)
    console.log('不想要就：node tools/persona.mjs reject --why "原因"（会清零连续通过计数）')
  } else if (cmd === 'apply') {
    const file = positional[0] ? positional[0] : join(root, PERSONA.proposal)
    if (!flag('--approve')) {
      console.log('没有 --approve，不写盘。先跑 propose 看提案，确认后再加 --approve。')
      process.exitCode = 1
    } else {
      const r = await applyProposal(root, file, { force: flag('--force') })
      console.log(`已应用 ${r.applied} 条 → v${r.version} · ${r.tokens} tokens · 探针 ${r.probes.passed}/${r.probes.total}`)
      console.log(`连续人工通过 ${r.streak}/3；新人格从下一个会话生效（当前会话用快照）。`)
    }
  } else if (cmd === 'reject') {
    const whyIdx = args.indexOf('--why')
    const why = whyIdx >= 0 ? args[whyIdx + 1] : ''
    if (!why) {
      console.log('要写原因：reject --why "太具体/证据不够/语气不对"')
      process.exitCode = 1
    } else {
      const r = await rejectProposal(root, { why })
      console.log(`已拒绝 ${r.rules.length} 条提案（${why}）；连续通过计数清零，30 天内同规则不再提。`)
    }
  } else if (cmd === 'rollback') {
    const r = await rollback(root, positional[0])
    console.log(`已回滚到 v${r.version} · ${r.tokens} tokens（连续通过计数清零）`)
  } else {
    console.log('用法：status | probe | propose [--force] | apply <文件> --approve [--force] | reject --why "原因" | rollback [版本]')
    console.log('  --force  apply 时绕过「每周最多一个 revision」，紧急才用')
    process.exitCode = 1
  }
} catch (e) {
  console.error(`失败：${String(e?.message ?? e)}`)
  process.exitCode = 1
}
