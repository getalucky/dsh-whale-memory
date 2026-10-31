/**
 * run.mjs —— 阶段 0 评测入口
 *
 * 跑法：
 *   node test/eval/run.mjs              # 跑一遍，写 reports/run-*.json + latest.md
 *   node test/eval/run.mjs --compare    # 跟上一份报告比指标
 *   node test/eval/run.mjs --strict     # 有用例失败就退出码 1（CI 用）
 *
 * 基线口径：规则蒸馏 + 词法召回，不调 LLM。这样每次改动都能同口径对比。
 */

import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { CASES } from './cases.mjs'
import { createHarness, estimateTokens, itemsHit, textHit, readJson } from './harness.mjs'
import { runChannelChecks } from './channel.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const reportsDir = join(here, 'reports')
const args = new Set(process.argv.slice(2))

const rate = (n, d) => (d ? Number((n / d).toFixed(3)) : null)
const pct = (v) => (v == null ? '—' : `${Math.round(v * 100)}%`)

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/** 跑一条用例。 */
async function evalCase(h, c) {
  const checks = []
  const add = (kind, name, ok, detail = '') => checks.push({ kind, name, ok, detail })

  await h.feed(c)
  const d = await h.distill(c)
  const staging = await h.stagingOf(c.id)
  const items = await h.itemsOf(c.id)
  const live = items.filter((x) => x.state !== 'archived' && x.state !== 'superseded')

  if (c.stagingEmpty) {
    add('lifecycle', 'staging 为空', staging.length === 0, `剩 ${staging.length} 条`)
  } else if (!d.ok) {
    add('lifecycle', '蒸馏成功', false, String(d.why ?? '未知'))
  }

  for (const needle of c.remember || []) {
    add('remember', `记住「${needle}」`, itemsHit(live, needle), live.map((x) => x.text).join(' | ').slice(0, 160))
  }
  for (const needle of c.ignore || []) {
    add('ignore', `不记「${needle}」`, !itemsHit(live, needle), '')
  }
  if (typeof c.activeCount === 'number') {
    add('lifecycle', `active 条目 = ${c.activeCount}`, live.length === c.activeCount, `实际 ${live.length}：${live.map((x) => x.text).join(' | ').slice(0, 160)}`)
  }
  if (typeof c.minHits === 'number') {
    const max = items.reduce((m, x) => Math.max(m, x.hits || 0), 0)
    add('lifecycle', `重复命中 ≥ ${c.minHits}`, max >= c.minHits, `实际 ${max}`)
  }
  for (const pair of c.superseded || []) {
    const old = items.find((x) => textHit(x.text, pair.old))
    const fresh = items.find((x) => textHit(x.text, pair.new))
    add('lifecycle', `「${pair.old}」被取代`, old?.state === 'superseded', old ? old.state : '没找到旧条目')
    add('lifecycle', `「${pair.new}」有效`, Boolean(fresh) && fresh.state !== 'superseded', fresh ? fresh.state : '没找到新条目')
  }

  let budget = null
  let recall = null
  let multihop = null
  if (c.budget) {
    const text = await h.render(c.id)
    budget = { chars: text.length, tokens: estimateTokens(text), lines: text.split('\n').length }
    add('lifecycle', '常驻注入 ≤1200 tok', budget.tokens <= 1200, `${budget.tokens} tok / ${budget.chars} 字符`)
  }

  if (c.ask) {
    const results = await h.search(c.id, c.ask)
    const top = results.slice(0, 3)
    // 精确率：这一问只有一条标准答案，前 3 里混进来的都算噪音
    const needles = [...(c.recallAny || []), ...(c.recallTop1 ? [c.recallTop1] : [])]
    if (needles.length) {
      const hit = top.filter((r) => needles.some((n) => textHit(r.item.text, n))).length
      recall = { returned: top.length, relevant: hit }
    }
    if (c.recallAny) {
      add('recall', `召回「${c.recallAny.join(' / ')}」进前 3`, top.some((r) => itemsHit([r.item], c.recallAny[0]) || c.recallAny.some((n) => textHit(r.item.text, n))),
        top.map((r) => `${r.item.text}(${r.score})`).join(' | ').slice(0, 200))
    }
    if (c.recallTop1) {
      add('recall', `第 1 条 =「${c.recallTop1}」`, Boolean(results[0]) && textHit(results[0].item.text, c.recallTop1),
        results[0] ? `${results[0].item.text}(${results[0].score})` : '没有召回')
    }
    if (c.recallEmpty) {
      const s = results[0]?.score ?? 0
      add('recall', '无关查询不该硬凑', s < 0.2, results[0] ? `top1 ${s}：${results[0].item.text}` : '没有召回')
    }
    if (c.multihop) {
      const needles = c.recallAny || (c.recallTop1 ? [c.recallTop1] : [])
      const hitAny = (list) => list.some((r) => needles.some((n) => textHit(r.item.text, n)))
      const off = await h.search(c.id, c.ask, { hops: false })
      multihop = { on: hitAny(results), off: hitAny(off) }
    }
  }

  const failed = checks.filter((x) => !x.ok)
  return {
    id: c.id,
    group: c.group,
    note: c.note,
    needs: c.needs ?? '',
    pendingStage: c.pendingStage ?? '',
    status: c.pendingStage ? 'pending' : failed.length ? 'fail' : 'pass',
    checks,
    budget,
    recall,
    multihop,
  }
}

/** 汇总指标。 */
function summarize(rows) {
  const m = {
    remember: { total: 0, hit: 0, ruleTotal: 0, ruleHit: 0, modelTotal: 0, modelHit: 0 },
    ignore: { total: 0, bad: 0 },
    lifecycle: { total: 0, ok: 0 },
    recall: { total: 0, hit1: 0, top1Total: 0, hit3: 0, semanticTotal: 0, semanticHit3: 0, precisionSum: 0, precisionCount: 0 },
    multihop: { on: 0, off: 0, total: 0 },
    cases: { total: rows.length, pass: 0, fail: 0, pending: 0 },
  }
  for (const row of rows) {
    if (row.multihop) {
      m.multihop.total += 1
      if (row.multihop.on) m.multihop.on += 1
      if (row.multihop.off) m.multihop.off += 1
    }
    if (row.recall?.returned) {
      m.recall.precisionSum += row.recall.relevant / row.recall.returned
      m.recall.precisionCount += 1
    }
    if (row.status === 'pass') m.cases.pass += 1
    else if (row.status === 'fail') m.cases.fail += 1
    else m.cases.pending += 1

    for (const chk of row.checks) {
      if (chk.kind === 'remember') {
        m.remember.total += 1
        if (chk.ok) m.remember.hit += 1
        if (row.needs === 'model') {
          m.remember.modelTotal += 1
          if (chk.ok) m.remember.modelHit += 1
        } else {
          m.remember.ruleTotal += 1
          if (chk.ok) m.remember.ruleHit += 1
        }
      } else if (chk.kind === 'ignore') {
        m.ignore.total += 1
        if (!chk.ok) m.ignore.bad += 1
      } else if (chk.kind === 'lifecycle') {
        m.lifecycle.total += 1
        if (chk.ok) m.lifecycle.ok += 1
      } else if (chk.kind === 'recall') {
        if (chk.name.startsWith('召回')) {
          m.recall.total += 1
          if (chk.ok) m.recall.hit3 += 1
          if (row.needs === 'semantic') {
            m.recall.semanticTotal += 1
            if (chk.ok) m.recall.semanticHit3 += 1
          }
        } else if (chk.name.startsWith('第 1 条')) {
          m.recall.total += 1
          m.recall.top1Total += 1
          if (chk.ok) { m.recall.hit1 += 1; m.recall.hit3 += 1 }
          if (row.needs === 'semantic') {
            m.recall.semanticTotal += 1
            if (chk.ok) m.recall.semanticHit3 += 1
          }
        }
      }
    }
  }
  return m
}

function metricsOf(m, rows) {
  const budget = rows.find((r) => r.budget)?.budget ?? null
  return {
    writeRecallAll: rate(m.remember.hit, m.remember.total),
    writeRecallRule: rate(m.remember.ruleHit, m.remember.ruleTotal),
    writeRecallModel: rate(m.remember.modelHit, m.remember.modelTotal),
    garbageRate: rate(m.ignore.bad, m.ignore.total),
    lifecycleRate: rate(m.lifecycle.ok, m.lifecycle.total),
    recallHit1: rate(m.recall.hit1, m.recall.top1Total),
    recallHit3: rate(m.recall.hit3, m.recall.total),
    recallSemanticHit3: rate(m.recall.semanticHit3, m.recall.semanticTotal),
    multihopOn: rate(m.multihop.on, m.multihop.total),
    multihopOff: rate(m.multihop.off, m.multihop.total),
    multihopGain: Number(((m.multihop.on - m.multihop.off) / Math.max(1, m.multihop.total)).toFixed(3)),
    recallPrecision: m.recall.precisionCount ? Number((m.recall.precisionSum / m.recall.precisionCount).toFixed(3)) : null,
    casePassRate: rate(m.cases.pass, m.cases.total),
    injectTokens: budget?.tokens ?? null,
    injectChars: budget?.chars ?? null,
  }
}

/** 把指标拍平，报告对比用。 */
function flat(obj, prefix = '') {
  const out = {}
  for (const [k, v] of Object.entries(obj)) {
    if (v && typeof v === 'object') Object.assign(out, flat(v, `${prefix}${k}.`))
    else out[`${prefix}${k}`] = v
  }
  return out
}

function delta(cur, prev) {
  if (prev == null || cur == null || typeof cur !== 'number' || typeof prev !== 'number') return ''
  const d = Number((cur - prev).toFixed(3))
  if (!d) return '（持平）'
  return d > 0 ? `（+${d}）` : `（${d}）`
}

async function previousReport(curFile) {
  try {
    const names = (await readdir(reportsDir)).filter((n) => n.startsWith('run-') && n.endsWith('.json')).sort()
    const prev = names.filter((n) => join(reportsDir, n) !== curFile).pop()
    return prev ? await readJson(join(reportsDir, prev)) : null
  } catch {
    return null
  }
}

function renderMarkdown({ at, rows, m, metrics, channel, prev }) {
  const line = []
  line.push(`# 记忆插件评测基线 · ${at}`)
  line.push('')
  line.push('口径：规则蒸馏 + 词法召回（不调 LLM），每个用例独立分片。')
  line.push('')
  line.push('## 指标')
  line.push('')
  line.push('| 指标 | 结果 | 目标 | 对比上一份 |')
  line.push('| --- | --- | --- | --- |')
  const p = prev?.metrics ?? {}
  line.push(`| 写入召回（全部） | ${pct(metrics.writeRecallAll)} | ≥80% | ${delta(metrics.writeRecallAll, p.writeRecallAll)} |`)
  line.push(`| 其中规则可达 | ${pct(metrics.writeRecallRule)} | — | ${delta(metrics.writeRecallRule, p.writeRecallRule)} |`)
  line.push(`| 其中需模型主动写 | ${pct(metrics.writeRecallModel)} | ≥80%（阶段 7.7） | ${delta(metrics.writeRecallModel, p.writeRecallModel)} |`)
  line.push(`| 垃圾写入率 | ${pct(metrics.garbageRate)} | 0 | ${delta(metrics.garbageRate, p.garbageRate)} |`)
  line.push(`| 生命周期正确率 | ${pct(metrics.lifecycleRate)} | ≥90% | ${delta(metrics.lifecycleRate, p.lifecycleRate)} |`)
  line.push(`| 召回 hit@1 | ${pct(metrics.recallHit1)} | — | ${delta(metrics.recallHit1, p.recallHit1)} |`)
  line.push(`| 召回 hit@3 | ${pct(metrics.recallHit3)} | ≥80% | ${delta(metrics.recallHit3, p.recallHit3)} |`)
  line.push(`| 同义召回 hit@3 | ${pct(metrics.recallSemanticHit3)} | — | ${delta(metrics.recallSemanticHit3, p.recallSemanticHit3)} |`)
  line.push(`| 召回精确率 @3 | ${pct(metrics.recallPrecision)} | ≥50% | ${delta(metrics.recallPrecision, p.recallPrecision)} |`)
  line.push(`| 多跳命中（开/关） | ${metrics.multihopOn == null ? '—' : `${pct(metrics.multihopOn)} / ${pct(metrics.multihopOff)}`} | 开 > 关 | ${delta(metrics.multihopGain, p.multihopGain)} |`)
  line.push(`| 用例通过率 | ${pct(metrics.casePassRate)} | — | ${delta(metrics.casePassRate, p.casePassRate)} |`)
  line.push(`| 25 条时常驻注入 | ${metrics.injectTokens ?? '—'} tok / ${metrics.injectChars ?? '—'} 字符 | ≤1200 tok | ${delta(metrics.injectTokens, p.injectTokens)} |`)
  line.push('')
  line.push(`用例：${m.cases.pass} 通过 / ${m.cases.fail} 失败 / ${m.cases.pending} 待后续阶段，共 ${m.cases.total}`)
  line.push('')

  const bad = rows.filter((r) => r.status === 'fail')
  if (bad.length) {
    line.push('## 失败明细')
    line.push('')
    for (const r of bad) {
      line.push(`### ${r.id} · ${r.note}`)
      for (const c of r.checks.filter((x) => !x.ok)) {
        line.push(`- [${c.kind}] ${c.name}${c.detail ? ` — ${c.detail}` : ''}`)
      }
      line.push('')
    }
  }

  const pend = rows.filter((r) => r.status === 'pending')
  if (pend.length) {
    line.push('## 待后续阶段')
    line.push('')
    for (const r of pend) line.push(`- ${r.id} · ${r.note}（${r.pendingStage}）`)
    line.push('')
  }

  line.push('## 通道体检')
  line.push('')
  for (const c of channel) {
    const mark = c.ok ? 'OK' : c.warn ? 'WARN' : 'FAIL'
    line.push(`- ${mark} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`)
  }
  line.push('')
  line.push('## 本阶段还没实现的指标')
  line.push('')
  line.push('- 副库粗筛命中率（阶段 2 主副库）')
  line.push('- 主动读取有效率 / 无效读取 token（阶段 5 工具化）')
  line.push('- 多跳增益（阶段 4 标签图谱）')
  line.push('- 主动写入准确率 / 重复写入率（阶段 7.7 写侧契约）')
  line.push('- 人设探针通过率（阶段 6 人格迭代）')
  line.push('')
  return line.join('\n')
}

async function main() {
  await mkdir(reportsDir, { recursive: true })
  const at = new Date().toISOString()
  const h = await createHarness(CASES)
  const rows = []
  try {
    for (const c of CASES) {
      const row = await evalCase(h, c)
      rows.push(row)
      const mark = row.status === 'pass' ? 'ok  ' : row.status === 'pending' ? 'pend' : 'FAIL'
      const failed = row.checks.filter((x) => !x.ok)
      console.log(`${mark} ${row.id} ${row.note}${failed.length ? `  ×${failed.length}` : ''}`)
    }

    const first = [...h.src.values()][0]
    const budgetSrc = h.src.get('f01') || first
    const channel = await runChannelChecks({
      root: h.root,
      // 用有 25 条记忆的分片做注入体检，空分片验不出重画/删除
      bridgeSid: budgetSrc.sid,
      scope: { kind: budgetSrc.kind, id: budgetSrc.id },
    })
    const m = summarize(rows)
    const metrics = metricsOf(m, rows)

    const file = join(reportsDir, `run-${stamp()}.json`)
    const forFile = await previousReport(file)
    const report = { version: 'eval-1', at, mode: 'rule+lexical', metrics, cases: rows, channel }
    await writeFile(file, JSON.stringify(report, null, 2), 'utf8')
    await writeFile(join(reportsDir, 'latest.md'), renderMarkdown({ at, rows, m, metrics, channel, prev: forFile }), 'utf8')

    console.log('\n—— 指标 ——')
    console.log(`写入召回 ${pct(metrics.writeRecallAll)}（规则 ${pct(metrics.writeRecallRule)} / 需模型 ${pct(metrics.writeRecallModel)}）`)
    console.log(`垃圾写入 ${pct(metrics.garbageRate)} · 生命周期 ${pct(metrics.lifecycleRate)}`)
    console.log(`召回 hit@1 ${pct(metrics.recallHit1)} · hit@3 ${pct(metrics.recallHit3)} · 同义 ${pct(metrics.recallSemanticHit3)}`)
    console.log(`用例 ${m.cases.pass}/${m.cases.total} 通过，${m.cases.pending} 条待后续阶段`)
    console.log(`常驻注入（25 条）${metrics.injectTokens} tok`)
    const chFail = channel.filter((c) => !c.ok)
    if (chFail.length) console.log(`通道体检未过：${chFail.map((c) => c.name).join('、')}`)
    console.log(`报告：${file}`)

    if (args.has('--compare') && forFile) {
      console.log('\n—— 对比上一份 ——')
      const a = flat(metrics)
      const b = flat(forFile.metrics)
      for (const k of Object.keys(a)) {
        const d = delta(a[k], b[k])
        if (d && d !== '（持平）') console.log(`${k}: ${b[k]} → ${a[k]} ${d}`)
      }
    }
    if (args.has('--strict') && m.cases.fail > 0) process.exitCode = 1
  } finally {
    await h.dispose()
  }
}

main().catch((e) => {
  console.error('[eval] 失败', e)
  process.exitCode = 2
})
