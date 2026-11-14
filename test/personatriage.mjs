/**
 * personatriage.mjs —— 模型逐行三分类（keep / shorten / replace）验收
 *   node test/personatriage.mjs
 *
 * 不联网：triage / 生成 / 审查都用桩 fetch，按 max_tokens 和 model 分流。
 * 验的是：
 *   · triage 解析容错（中文动作、围栏、裸数组、重复 i 时 keep 优先）
 *   · keep 行这轮不压缩、不被候选替换顶掉
 *   · 有证据的候选替换压过模型替换
 *   · 模型替换带 old→new 送审，通过后能 apply
 *   · triage 失败完整回退规则压缩，不阻断提案
 */
import assert from 'node:assert'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ensureDirs, emptyScope, addItem, saveScope } from '../lib/store.js'
import { propose, applyProposal, status, parsePersona, PERSONA } from '../lib/persona.js'
import { personaTriage } from '../lib/llm.js'

let pass = 0
const ok = (name) => { pass += 1; console.log('  ok', name) }

const LONG_LINE = '不分析：他没问「为什么」「怎么办」「哪个好」，就别解释原因、别列利弊、别给方案、别补一句理由。别人说的话也别拆、别解读潜台词、别总结「他其实是想说」——想接就顺着接一句，想怼就怼，不当翻译。想多说，说人话，不带结构。'
const EMOJI_LINE = '少用 emoji 和颜文字，一条最多一个，正事时不用。'
const CONCISE_LINE = '回答先给结论，别绕弯。'
const SHORT_LINE = '说话短一点，别啰嗦。'

const personaOf = (lines) => `<!-- PERSONA:CORE:START -->
你是测试鲸鱼。
<!-- PERSONA:CORE:END -->

<!-- PERSONA:EVOLVABLE:START -->
${lines.join('\n')}
<!-- PERSONA:EVOLVABLE:END -->

## 纪律
事实优先。`

const reply = (content) => ({
  ok: true,
  json: async () => ({ choices: [{ message: { content } }] }),
})

const ENV = ['DSH_MEMORY_LLM_BASE', 'DSH_MEMORY_LLM_MODEL', 'DSH_MEMORY_LLM_KEY',
  'DSH_MEMORY_REVIEW_BASE', 'DSH_MEMORY_REVIEW_MODEL', 'DSH_MEMORY_REVIEW_KEY']
const savedEnv = {}
for (const k of ENV) { savedEnv[k] = process.env[k]; delete process.env[k] }
process.env.DSH_MEMORY_LLM_BASE = 'http://stub.local/v1'
process.env.DSH_MEMORY_LLM_MODEL = 'stub-gen'
process.env.DSH_MEMORY_REVIEW_BASE = 'http://stub.local/v1'
process.env.DSH_MEMORY_REVIEW_MODEL = 'stub-rev'

const rootA = await mkdtemp(join(tmpdir(), 'whale-triage-'))
const rootB = await mkdtemp(join(tmpdir(), 'whale-triage-fallback-'))
try {
  // ---- 1. triage 解析：中文动作 / 围栏 / 重复 i keep 优先 / 越界 i 丢掉 ----
  {
    const calls = []
    const stub = (content) => async (_url, init) => {
      calls.push(JSON.parse(init.body))
      return reply(content)
    }
    const fenced = '好的，结果如下：\n```json\n' + JSON.stringify({
      items: [
        { i: 0, action: '保留', why: '身份边界' },
        { i: 1, action: 'SHORTEN', why: '举例可删', text: '短一点。' },
        { i: 1, action: 'keep', why: '还是留着' },
        { i: 9, action: 'replace', why: '越界', text: '不该出现。' },
      ],
    }) + '\n```'
    const got = await personaTriage(['甲行。', '乙行。'], { fetchImpl: stub(fenced) })
    assert.ok(Array.isArray(got), JSON.stringify(got))
    assert.equal(got.length, 2, JSON.stringify(got))
    assert.equal(got.find((x) => x.i === 0).action, 'keep', '中文「保留」要归一成 keep')
    assert.equal(got.find((x) => x.i === 1).action, 'keep', '同一行重复给动作时 keep 优先')
    assert.equal(calls[0].max_tokens, 2400, 'triage 要给足输出 token')
    assert.equal(calls[0].model, 'stub-gen')

    const bare = '```json\n[{"i":0,"action":"压缩","text":"甲。"},{"i":1,"action":"REPLACE","text":"乙改。"}]\n```'
    const arr = await personaTriage(['甲行。', '乙行。'], { fetchImpl: stub(bare) })
    assert.deepEqual(arr.map((x) => x.action), ['shorten', 'replace'], '裸数组和英文大写动作也要认')

    const bad = await personaTriage(['甲行。'], { fetchImpl: stub('抱歉，我做不到') })
    assert.equal(bad, null, '解析不出来就返回 null，交给规则兜底')

    const before = calls.length
    assert.equal(await personaTriage([], { fetchImpl: stub('[]') }), null, '没有行就不该发请求')
    assert.equal(calls.length, before)
    ok('triage 解析：中文动作 / 围栏 / 裸数组 / keep 优先 / 非法 JSON')
  }

  // ---- 2. propose 集成：keep 保护、候选替换优先、模型替换送审并可 apply ----
  {
    await ensureDirs(rootA)
    await writeFile(join(rootA, 'persona.md'), personaOf([EMOJI_LINE, LONG_LINE, CONCISE_LINE, SHORT_LINE]), 'utf8')
    const sc = emptyScope('private', '1')
    const a = addItem(sc, { text: '以后别用 emoji 了', kind: 'pref', conf: 0.8 })
    const b = addItem(sc, { text: '说话先给结论，别绕', kind: 'pref', conf: 0.8 })
    await saveScope(rootA, sc)

    const triageContent = JSON.stringify({
      items: [
        { i: 0, action: 'keep', why: '身份边界' },
        { i: 1, action: 'shorten', why: '举例可删', text: '他没问就别分析、别解释、别给方案。' },
        { i: 2, action: 'replace', why: '说法更准', text: '先给结论，绕弯别写长。' },
        { i: 3, action: 'replace', why: '去啰嗦', text: '说话短一点，别刷屏。' },
      ],
    })
    let 审查输入 = null
    const router = async (url, init) => {
      const body = JSON.parse(init.body)
      if (body.model === 'stub-rev') {
        const content = String(body.messages?.[1]?.content ?? '{}')
        const candidates = JSON.parse(content).candidates || []
        审查输入 = candidates
        return reply(JSON.stringify({ verdicts: candidates.map((c) => ({ rule: c.rule, approve: true })) }))
      }
      if (body.max_tokens === 2400) return reply(triageContent)
      return reply(JSON.stringify({
        additions: [
          { rule: '先给结论，别绕弯子。', evidence: [b.id] },
          { rule: '怼人可以，但不揭短，对方难受了就收手', evidence: [a.id] },
        ],
      }))
    }

    const p = await propose(rootA, { fetchImpl: router })
    assert.equal(p.triageSummary.returned, true, JSON.stringify(p.triageSummary))
    assert.equal(p.triageSummary.lines, 4)
    assert.equal(p.triageSummary.keep, 1)
    assert.equal(p.triageSummary.shorten, 1)
    assert.equal(p.triageSummary.replace, 2)
    assert.equal(p.triageSummary.invalid, 0)
    assert.ok(p.triage.some((t) => t.i === 0 && t.action === 'keep' && t.ok), JSON.stringify(p.triage))
    assert.ok(p.decisions.some((d) => d.action === 'kept' && d.stage === 'triage'), 'keep 要进判决台账')

    // keep 行这轮不许压缩、不许被候选替换
    assert.ok(!p.compressions.some((c) => c.old === EMOJI_LINE), 'keep 行不该进压缩')
    assert.ok(!p.replacements.some((r) => r.old === EMOJI_LINE), 'keep 行不该被替换')
    assert.ok(p.compressions.some((c) => c.old === LONG_LINE && c.source === 'llm'), '模型 shorten 要进提案')

    // 候选替换（有证据）压过模型替换；模型替换去换另一行
    const 候选替换 = p.replacements.find((r) => r.old === CONCISE_LINE)
    assert.ok(候选替换, '同主题候选要变成替换：' + JSON.stringify(p.replacements))
    assert.equal(候选替换.source, 'candidate')
    const 模型替换 = p.replacements.find((r) => r.old === SHORT_LINE)
    assert.ok(模型替换, '没有候选竞争的行，模型替换要保留：' + JSON.stringify(p.replacements))
    assert.equal(模型替换.source, 'llm')
    assert.equal(模型替换.rule, '说话短一点，别刷屏。')
    assert.ok(p.decisions.some((d) => d.stage === 'triage' && /让位/.test(d.why)), '冲突要让位并留痕')

    // 审查模型看到 old→new
    assert.ok(Array.isArray(审查输入), '审查模型没收到候选')
    const 送审替换 = 审查输入.filter((c) => c.kind === 'replace')
    assert.equal(送审替换.length, 2, JSON.stringify(审查输入))
    assert.ok(送审替换.some((c) => c.old === CONCISE_LINE && c.rule === '先给结论，别绕弯子。'))
    assert.ok(送审替换.some((c) => c.old === SHORT_LINE && c.rule === '说话短一点，别刷屏。'))

    // 提案摘要也要带 triage 与来源
    const brief = (await status(rootA)).proposal
    assert.ok(brief.triage.length >= 4, 'proposalBrief 要透出逐行分类')
    assert.ok(brief.triageSummary && brief.triageSummary.keep === 1)
    assert.equal(brief.replacements.find((r) => r.old === SHORT_LINE).source, 'llm')
    assert.equal(brief.compressions.find((c) => c.old === LONG_LINE).source, 'llm')

    // apply：keep 行原样，shorten/replace 都落盘
    const r = await applyProposal(rootA, join(rootA, PERSONA.proposal))
    assert.equal(r.replaced, 2, JSON.stringify(r))
    assert.ok(r.compressed >= 1, JSON.stringify(r))
    const after = await readFile(join(rootA, 'persona.md'), 'utf8')
    const blocks = parsePersona(after)
    assert.ok(blocks.evolvable.includes(EMOJI_LINE), 'keep 行必须原样保留')
    assert.ok(!blocks.evolvable.includes(LONG_LINE), '长行应被写短')
    assert.ok(blocks.evolvable.includes('他没问就别分析'), after)
    assert.ok(blocks.evolvable.includes('先给结论，别绕弯子。'), '候选替换要写进人格')
    assert.ok(blocks.evolvable.includes('说话短一点，别刷屏。'), '模型替换要写进人格')
    assert.ok(after.includes('你是测试鲸鱼') && after.includes('事实优先'), 'CORE / 纪律不动')
    const st = await status(rootA)
    assert.deepEqual(st.lastApplied.replaced.map((x) => x.source).sort(), ['candidate', 'llm'])
    ok('propose/apply：keep 保护、候选替换优先、模型替换送审并落盘')
  }

  // ---- 3. triage 失败：完整回退规则压缩，不阻断提案 ----
  {
    await ensureDirs(rootB)
    await writeFile(join(rootB, 'persona.md'), personaOf([LONG_LINE, SHORT_LINE]), 'utf8')
    const sc = emptyScope('private', '1')
    const a = addItem(sc, { text: '怼人的时候别揭短', kind: 'pref', conf: 0.8 })
    await saveScope(rootB, sc)

    const router = async (_url, init) => {
      const body = JSON.parse(init.body)
      if (body.model === 'stub-rev') {
        const content = String(body.messages?.[1]?.content ?? '{}')
        const candidates = JSON.parse(content).candidates || []
        return reply(JSON.stringify({ verdicts: candidates.map((c) => ({ rule: c.rule, approve: true })) }))
      }
      if (body.max_tokens === 2400) return reply('模型今天不想说话')
      return reply(JSON.stringify({
        additions: [{ rule: '怼人可以，但不揭短，对方难受了就收手', evidence: [a.id] }],
      }))
    }

    const p = await propose(rootB, { fetchImpl: router })
    assert.equal(p.triageSummary.returned, false, JSON.stringify(p.triageSummary))
    assert.equal(p.triageSummary.keep, 0)
    assert.ok(p.warnings.some((w) => w.includes('逐行分类没返回')), JSON.stringify(p.warnings))
    assert.ok(p.compressions.some((c) => c.old === LONG_LINE && c.source === 'rule'), '没有模型也要规则压缩')
    assert.ok(p.additions.some((x) => x.rule.includes('不揭短')), '提案不能被 triage 失败拖垮')
    assert.equal(p.triage.length, 0)
    ok('triage 失败：回退规则压缩，提案照常生成')
  }

  console.log(`\n全部通过：${pass} 项`)
} catch (e) {
  console.error('\n失败：', e)
  process.exitCode = 1
} finally {
  for (const k of ENV) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  await rm(rootA, { recursive: true, force: true }).catch(() => {})
  await rm(rootB, { recursive: true, force: true }).catch(() => {})
}