/**
 * persona.mjs —— 人格蒸馏闸门的命令行入口
 *
 *   node tools/persona.mjs status
 *   node tools/persona.mjs decisions [轮数]   # 每条候选在哪一关被留下/丢掉
 *   node tools/persona.mjs probe
 *   node tools/persona.mjs propose [--out 文件]
 *   node tools/persona.mjs apply [提案文件] --approve
 *   node tools/persona.mjs rollback [版本号]
 *
 * 没有 --approve 不会写任何东西：提案必须先给人看，确认后才生效。
 * probe 是静态体检（20 项），apply 前后各跑一次，通过项数掉了就拒绝。
 * 生成 / 采样 / 审查 / 黑名单 / 去重的每一条判决都写进 persona_decisions.jsonl，
 * 提案文件会被下一轮覆盖，这份台账不会。
 */
import { join } from 'node:path'

import { rootDir, ensureDirs } from '../lib/store.js'
import {
  status, propose, applyProposal, rollback, probePersona, rejectProposal, recentDecisions,
  readPersona, parsePersona, PERSONA,
} from '../lib/persona.js'
import { inspectEvolvable } from '../lib/personaaudit.js'
import { loadSettings } from '../lib/settings.js'
import { setPersonaBudget } from '../lib/personalimit.js'

const root = process.env.DSH_MEMORY_HOME || rootDir()
const [cmd = 'status', ...args] = process.argv.slice(2)
await ensureDirs(root)
// CLI 也认设置页存的额度；没存就回落到环境变量 / 默认值
setPersonaBudget(loadSettings(root).persona_budget || null)

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
    if (a.waitReason) console.log(`当前状态：${a.waitReason}`)
    if (s.budget) {
      const b = s.budget
      const 来源 = { settings: '设置页', env: '环境变量', default: '默认值' }[b.source] || b.source
      const 模式 = b.mode === 'auto' ? `自动 ${b.window} × ${(b.share * 100).toFixed(2)}%` : `固定 ${b.tokens}`
      console.log(`人格预算：${b.tokens}/${b.limit} tok（${模式} · 来源 ${来源}），当前剩 ${b.headroom} tok`)
      if (b.why) console.log(`  注意：${b.why}`)
      console.log(`  整理后可用：${b.effective} tok（现在就能压缩出 +${b.compactible}；下一轮提案还可能再靠替换腾出更多）`)
      console.log(`  写入新规矩时按「先收拾旧人设」后的 ${b.basis} tok 做审查，不是一味按当前占用追加`)
      if (b.headroom < 30) console.log('  当前额度见底；优先采纳压缩/替换，或到设置页 / DSH_MEMORY_PERSONA_TOKENS 调大额度')
    }
    if (s.audit?.length) {
      const a = s.audit
      const n = (f) => a.filter((r) => r.flag === f).length
      console.log(`旧人设审视（实时）：${a.length} 行 · 偏长 ${n('verbose')} · 示例 ${n('example')} · 疑似重复 ${n('redundant')} · 精简 ${n('keep')} · 现在能压 ${s.compressible?.length || 0} 行`)
    }
    console.log(`预算在设置页「人格预算」改，或配 DSH_MEMORY_PERSONA_MODE/TOKENS/WINDOW/SHARE（600–2400；每轮会话都会注入，调大更费上下文）`)
    if (a.lastRunAt) console.log(`上次提案：${a.lastRunAt}`)
    const last = (s.recentRuns || [])[0]
    if (last) {
      const 结论 = (last.applied || last.replaced || last.compressed) > 0
        ? `发布 v${last.version} · 新增 ${last.applied || 0} · 替换 ${last.replaced || 0} · 压缩 ${last.compressed || 0}`
        : last.proposed ? `只出提案（新增 ${last.additions || 0} 条）` : '没跑成'
      console.log(`上次结果：${结论}${last.why ? ` · ${last.why}` : ''}`)
    }
    if (s.proposal) {
      const n = (s.proposal.additions || []).length
      const x = (s.proposal.replacements || []).length
      const c = (s.proposal.compressions || []).length
      console.log(`待确认提案：新增 ${n} · 替换 ${x} · 压缩 ${c}${s.proposal.at ? `（生成于 ${s.proposal.at}）` : ''}`)
    }
    for (const [label, list] of [['替换', s.lastApplied?.replaced], ['压缩', s.lastApplied?.compressed]]) {
      if (list?.length) {
        console.log(`上次发布${label}了 ${list.length} 条旧规矩：`)
        for (const r of list) console.log(`  ${r.old} → ${r.rule}`)
      }
    }
    console.log('每条候选怎么判的：node tools/persona.mjs decisions')
    console.log('逐行审视旧人设：node tools/persona.mjs audit')
  } else if (cmd === 'audit') {
    // 就地审视当前 persona.md，不生成提案、不写任何东西
    const parts = parsePersona(await readPersona(root))
    const rows = inspectEvolvable(parts.evolvable)
    const name = { verbose: '偏长', example: '示例', redundant: '疑似重复', keep: '精简' }
    console.log(`EVOLVABLE 共 ${rows.length} 行：`)
    for (const r of rows) {
      console.log(`\n  ${String(r.i + 1).padStart(2)} [${name[r.flag] || r.flag}] ${r.chars} 字`)
      console.log(`     ${r.text.slice(0, 100)}`)
      console.log(`     → ${r.why}${r.suggestion ? `；建议：${r.suggestion}` : ''}`)
    }
  } else if (cmd === 'decisions') {
    // 提案会被下一轮覆盖；这份台账按轮次留着，能翻「为什么这条没进人格」
    const runs = await recentDecisions(root, Number(positional[0]) || 5)
    if (!runs.length) console.log('还没有判决记录；跑一次 propose 后就会有。')
    for (const run of runs) {
      console.log(`\n── ${run.at}${run.legacy ? '（由旧提案反推）' : ''}（${run.rows.length} 条）`)
      for (const d of run.rows) {
        const mark = d.action === 'accepted' ? '+' : d.action === 'replaced' ? '~' : d.action === 'compressed' ? '<' : d.action === 'kept' ? '=' : '✗'
        console.log(`  ${mark} [${d.stage}] ${d.rule}`)
        console.log(`      ${d.why}`)
        if (d.evidence?.length) console.log(`      依据：${d.evidence.map((e) => `${e.id}${e.text ? `「${e.text}」` : ''}`).join('、')}`)
      }
    }
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
    console.log(`候选：新增 ${p.additions.length} · 替换 ${(p.replacements || []).length} · 压缩 ${(p.compressions || []).length} 条，证据 ${p.sources} 条记忆`)
    console.log(`预算 ${p.budget.tokens}/${p.budget.limit} tok（${p.budget.mode === 'auto' ? `自动 ${p.budget.window}×${p.budget.share}` : '固定'} · ${p.budget.source}）· 当前剩 ${p.budget.headroom} · 整理后可用 ${p.budget.effective} tok（审查基准 ${p.budget.basis}）`)
    const ts = p.triageSummary
    if (ts) {
      console.log(`模型逐行分类：${ts.returned ? `保留 ${ts.keep} · 缩短 ${ts.shorten} · 替换 ${ts.replace}` : '没有返回'}${ts.invalid ? ` · 校验未过 ${ts.invalid}` : ''} / 共 ${ts.lines} 行`)
      for (const t of (p.triage || []).filter((x) => !x.ok)) {
        console.log(`  ✗ [${t.action}] ${t.text.slice(0, 60)} — ${t.whyDropped}`)
      }
    }
    if (p.audit?.length) {
      const n = (f) => p.audit.filter((r) => r.flag === f).length
      console.log(`旧人设审视 ${p.audit.length} 行：偏长 ${n('verbose')} · 示例 ${n('example')} · 疑似重复 ${n('redundant')} · 精简 ${n('keep')}`)
    }
    if (p.samples) {
      console.log(`样本 ${p.samples.count} 条 / ${p.samples.scopes} 个分片（跳过 ${p.samples.skipped}）· 生成 ${p.generator} · 审查 ${p.reviewer}`)
      const why = Object.entries(p.samples.skipReasons || {}).filter(([, n]) => n > 0)
      if (why.length) console.log(`  跳过原因：${why.map(([k, n]) => `${k} ${n}`).join(' · ')}`)
    }
    for (const r of p.compressions || []) {
      console.log(`\n< 压缩旧规矩（腾出 ${r.freed} tok）[${r.flag}]${r.source === 'llm' ? ' · 模型' : ''}`)
      console.log(`    旧：${r.old}`)
      console.log(`    新：${r.rule}`)
      console.log(`    ${r.why}`)
    }
    for (const a of p.additions) {
      console.log(`\n+ ${a.rule}`)
      for (const e of a.evidence.slice(0, 3)) console.log(`    依据 ${e.id}：${e.text}`)
    }
    for (const r of p.replacements || []) {
      console.log(`\n~ 替换（腾出 ${r.freed} tok）${r.source === 'llm' ? ' · 模型' : ' · 候选'}：`)
      console.log(`    旧：${r.old}`)
      console.log(`    新：${r.rule}`)
      console.log(`    ${r.why}`)
    }
    for (const r of p.rejected || []) console.log(`\n✗ ${r.rule}\n    ${r.why}`)
    // 被 30 天黑名单、去重、生成空结果拦掉的候选不在 rejected 里，单独列出来
    const silent = (p.decisions || []).filter((d) => d.action !== 'accepted' && !['review', 'review-llm'].includes(d.stage))
    for (const d of silent) console.log(`\n✗ [${d.stage}] ${d.rule}\n    ${d.why}`)
    for (const w of p.warnings) console.log(`! ${w}`)
    console.log(`\n提案：${out}\n确认无误后：node tools/persona.mjs apply ${out} --approve`)
    console.log('不想要就：node tools/persona.mjs reject --why "原因"（会清零连续通过计数）')
    console.log('想翻每一轮怎么判的：node tools/persona.mjs decisions')
  } else if (cmd === 'apply') {
    const file = positional[0] ? positional[0] : join(root, PERSONA.proposal)
    if (!flag('--approve')) {
      console.log('没有 --approve，不写盘。先跑 propose 看提案，确认后再加 --approve。')
      process.exitCode = 1
    } else {
      const r = await applyProposal(root, file, { force: flag('--force') })
      console.log(`已应用：新增 ${r.applied} · 替换 ${r.replaced} · 压缩 ${r.compressed} → v${r.version} · ${r.tokens} tokens · 探针 ${r.probes.passed}/${r.probes.total}`)
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
    console.log('用法：status | audit | decisions [轮数] | probe | propose [--force] | apply <文件> --approve [--force] | reject --why "原因" | rollback [版本]')
    console.log('  --force  apply 时绕过「每周最多一个 revision」，紧急才用')
    console.log('  audit    逐行审视旧人设：哪些偏长、哪些只是示例、哪些疑似重复（只读）')
    console.log('  decisions 看每条候选在哪一关被留下/丢掉（含理由与依据）')
    process.exitCode = 1
  }
} catch (e) {
  console.error(`失败：${String(e?.message ?? e)}`)
  process.exitCode = 1
}
