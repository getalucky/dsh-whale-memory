/**
 * persona.mjs —— 人格蒸馏闸门验收（阶段 6 / 文档 8.6）
 *
 * 验的是：
 *   · 只改 EVOLVABLE 区块，核心身份与纪律不动
 *   · 没有提案/没确认就不写盘（apply 需要显式调用）
 *   · 基线变了拒绝应用
 *   · 超预算拒绝
 *   · 版本归档与回滚
 */
import assert from 'node:assert'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ensureDirs, emptyScope, addItem, saveScope } from '../lib/store.js'
import {
  propose, applyProposal, rollback, status, parsePersona, personaTokens,
  stripMarkers, hashOf, findReplacement, PERSONA, estimateTokens,
} from '../lib/persona.js'
import { inspectEvolvable, collectCompressions, ruleCompact, validateCompact } from '../lib/personaaudit.js'
import { runProbes } from '../lib/probes.js'

let pass = 0
const ok = (name) => { pass += 1; console.log('  ok', name) }

const ORIGINAL = `<!-- PERSONA:CORE:START -->
你是测试鲸鱼。
<!-- PERSONA:CORE:END -->

<!-- PERSONA:EVOLVABLE:START -->
说话短一点。
<!-- PERSONA:EVOLVABLE:END -->

## 纪律
事实优先。`

const root = await mkdtemp(join(tmpdir(), 'whale-persona-'))
try {
  await ensureDirs(root)
  await writeFile(join(root, 'persona.md'), ORIGINAL, 'utf8')

  // 先放证据：两条"别用 emoji"、两条"先给结论"
  const sc = emptyScope('private', '1')
  addItem(sc, { text: '以后别用 emoji 了', kind: 'pref', conf: 0.8 })
  addItem(sc, { text: '以后都少发 emoji，正事别用', kind: 'pref', conf: 0.8 })
  addItem(sc, { text: '说话先给结论，别绕', kind: 'pref', conf: 0.8 })
  addItem(sc, { text: '以后别啰嗦，先说结论', kind: 'pref', conf: 0.8 })
  await saveScope(root, sc)

  const p = await propose(root)
  assert.ok(p.additions.length >= 2, JSON.stringify(p))
  assert.equal(p.baselineHash, hashOf(ORIGINAL))
  assert.ok(p.additions.some((a) => /emoji/.test(a.rule)))
  assert.ok(p.additions.some((a) => /结论/.test(a.rule)))
  ok('propose：从记忆里抽到 emoji / 先给结论两条候选')

  // 探针：固定 20 项，结构 / 边界 / 卫生都算
  const probe0 = runProbes(ORIGINAL, parsePersona(ORIGINAL), personaTokens(ORIGINAL))
  assert.equal(probe0.total, 20, JSON.stringify(probe0))
  assert.ok(probe0.passed > 0, JSON.stringify(probe0))
  assert.equal(probe0.passed + probe0.failed.length, probe0.total)
  ok('probe：20 项，通过 + 失败 = 总数')

  // 应用：只改 EVOLVABLE
  const r = await applyProposal(root, join(root, PERSONA.proposal))
  assert.ok(r.applied >= 2, JSON.stringify(r))
  assert.ok(r.probes.passed >= probe0.passed, JSON.stringify(r.probes))
  const after = await readFile(join(root, 'persona.md'), 'utf8')
  assert.ok(after.includes('少用 emoji'), after)
  assert.ok(after.includes('你是测试鲸鱼'), '核心身份被改了')
  assert.ok(after.includes('事实优先'), '纪律层被改了')
  const blocks = parsePersona(after)
  assert.ok(blocks.hasCore && blocks.hasEvolvable)
  ok('apply：只往 EVOLVABLE 追加，核心与纪律原样')

  // 变更日志：版本、规则、依据、探针数都要留痕
  const log = await readFile(join(root, PERSONA.changelog), 'utf8')
  assert.ok(/## v1 ·/.test(log), log)
  assert.ok(log.includes('少用 emoji'), log)
  assert.ok(/依据：.+_/.test(log), log)
  ok('changelog：记下版本、规则与证据 id')

  // 归档
  const arch0 = await readFile(join(root, PERSONA.archiveDir, 'v0.md'), 'utf8')
  assert.equal(arch0, ORIGINAL)
  const st = await status(root)
  assert.equal(st.version, 1)
  ok('版本归档：v0 保留原稿')

  // 基线变了：原提案不能再用
  await writeFile(join(root, 'persona.md'), after.replace('说话短一点。', '说话短一点，别废话。'), 'utf8')
  await assert.rejects(() => applyProposal(root, join(root, PERSONA.proposal), { force: true }), /冲突/)
  ok('基线被改过 → 拒绝应用')

  // 超预算拒绝
  const big = `<!-- PERSONA:EVOLVABLE:START -->\n${'很长的规则'.repeat(300)}\n<!-- PERSONA:EVOLVABLE:END -->`
  await writeFile(join(root, 'persona.md'), big, 'utf8')
  const badProposal = join(root, 'bad.json')
  await writeFile(badProposal, JSON.stringify({
    schema: 1, at: new Date().toISOString(), baselineHash: hashOf(big), additions: [{ rule: '再加一条' }],
  }), 'utf8')
  await assert.rejects(() => applyProposal(root, badProposal, { force: true }), /预算/)
  ok('超预算 → 拒绝应用')

  // 回滚
  await writeFile(join(root, 'persona.md'), after, 'utf8')
  const rb = await rollback(root, 0)
  assert.equal(rb.version, 0)
  assert.equal(await readFile(join(root, 'persona.md'), 'utf8'), ORIGINAL)
  ok('rollback：回到 v0')

  // 探针回退：往 EVOLVABLE 塞事件和自曝，通过项数下降就拒绝
  const cur = await readFile(join(root, 'persona.md'), 'utf8')
  const badRule = join(root, 'bad-rule.json')
  await writeFile(badRule, JSON.stringify({
    schema: 1, at: new Date().toISOString(), baselineHash: hashOf(cur),
    additions: [{ rule: '昨天帮爹修了桥接，作为一个 AI 语言模型要多帮忙。' }],
  }), 'utf8')
  await assert.rejects(() => applyProposal(root, badRule, { force: true }), /探针/)
  ok('探针回退 → 拒绝应用（事件进人设 / 自曝 AI）')

  const badText = `<!-- PERSONA:EVOLVABLE:START -->\n作为一个 AI 语言模型，我会尽力。\n<!-- PERSONA:EVOLVABLE:END -->`
  const badProbe = runProbes(badText, parsePersona(badText), personaTokens(badText))
  assert.ok(badProbe.failed.some((f) => f.id === 'self'), JSON.stringify(badProbe))
  ok('probe：自曝 AI 被单独抓出来')

  // 注入前去掉标记，且预算计算不含标记
  assert.ok(!stripMarkers(ORIGINAL).includes('PERSONA:'), stripMarkers(ORIGINAL))
  assert.ok(personaTokens(ORIGINAL) < 1200)
  ok('stripMarkers / 预算口径')

  // ---- 替换判定：同主题优先，明显变长的不换，完全一样没什么可换 ----
  const evo = '少用 emoji 和颜文字，一条最多一个，正事时不用。\n回答先给结论，别绕弯。'
  assert.equal(findReplacement('emoji 一条最多一个，正事别用。', evo)?.theme, 'emoji')
  assert.ok(findReplacement('先给结论，别绕，别写长。', evo))
  assert.equal(findReplacement('少用 emoji 和颜文字，一条最多一个，正事时不用。', evo), null)
  assert.equal(findReplacement('称呼：可以叫他「小鱼」。', '少用 emoji 和颜文字。'), null)
  ok('findReplacement：同主题才换，重复/不同主题不动')

  // ---- 替换护栏：短话不能顶掉一大段，引用词不算称呼主题 ----
  {
    const rich = '性格：聪明、傲娇、嘴硬心软，有点屑，爱怼人，更爱恶作剧、爱逗人——看别人上钩会偷笑；真干活不含糊，该指错就指错。可爱来自性格不靠卖萌；梗一条最多一个，女仆腔、「主人」「本小姐」、吐泡泡摇尾巴不碰。'
    assert.equal(findReplacement('称呼：可以叫他「小鱼」。', rich), null, '带引号不等于在讲称呼')
    const emojiRich = '自称默认「我」，「本鲸」只在得意、被质疑时用一次。emoji / 颜文字偶尔点缀，一条最多一种，不用括号写内心戏，正事收手。'
    assert.equal(findReplacement('少发点表情包。', emojiRich), null, '不能用一句短话顶掉一大段旧规矩')
    assert.equal(findReplacement('正事别用颜文字。', emojiRich), null, '字面不够像就不换')
  }
  ok('findReplacement：短话不顶长规矩，引用词不算称呼主题')

  // ---- 替换应用：旧句没了、新句在、CORE 不动、changelog 留痕 ----
  {
    const rr = await mkdtemp(join(tmpdir(), 'whale-persona-replace-'))
    try {
      await ensureDirs(rr)
      const base = `<!-- PERSONA:CORE:START -->\n你是测试鲸鱼。\n<!-- PERSONA:CORE:END -->\n\n<!-- PERSONA:EVOLVABLE:START -->\n少用 emoji 和颜文字，一条最多一个，正事时不用。\n回答先给结论，别绕弯。\n<!-- PERSONA:EVOLVABLE:END -->\n\n## 纪律\n事实优先。`
      await writeFile(join(rr, 'persona.md'), base, 'utf8')
      const proposal = {
        schema: 2, at: new Date().toISOString(), baselineHash: hashOf(base), version: 0,
        additions: [],
        replacements: [{ old: '少用 emoji 和颜文字，一条最多一个，正事时不用。', rule: 'emoji 一条最多一个，正事别用。', why: '同一主题', freed: 8, evidence: [] }],
      }
      const pf = join(rr, 'p.json')
      await writeFile(pf, JSON.stringify(proposal), 'utf8')
      const r = await applyProposal(rr, pf)
      assert.equal(r.applied, 0)
      assert.equal(r.replaced, 1, JSON.stringify(r))
      const out = await readFile(join(rr, 'persona.md'), 'utf8')
      assert.ok(out.includes('emoji 一条最多一个，正事别用。'), out)
      assert.ok(!out.includes('和颜文字'), '旧句应被顶掉')
      assert.ok(out.includes('回答先给结论'), '同区块其它行不能动')
      assert.ok(out.includes('你是测试鲸鱼') && out.includes('事实优先'), 'CORE / 纪律不能动')
      const log = await readFile(join(rr, PERSONA.changelog), 'utf8')
      assert.ok(log.includes('替换：'), log)
      assert.equal((await status(rr)).lastApplied.replaced.length, 1)
      ok('apply：替换旧说法，不动 CORE 与其它行')
    } finally {
      await rm(rr, { recursive: true, force: true }).catch(() => {})
    }
  }

  // ---- propose 自动把「说同一件事」的候选转成替换，而不是当重复丢掉 ----
  {
    const pr = await mkdtemp(join(tmpdir(), 'whale-persona-propose-replace-'))
    try {
      await ensureDirs(pr)
      const base = `<!-- PERSONA:CORE:START -->\n你是测试鲸鱼。\n<!-- PERSONA:CORE:END -->\n\n<!-- PERSONA:EVOLVABLE:START -->\nemoji / 颜文字偶尔点缀，一条最多一种，不用括号写内心戏，正事收手。\n<!-- PERSONA:EVOLVABLE:END -->\n\n## 纪律\n事实优先。`
      await writeFile(join(pr, 'persona.md'), base, 'utf8')
      const sc = emptyScope('private', '1')
      addItem(sc, { text: '以后别用 emoji 了', kind: 'pref', conf: 0.8 })
      addItem(sc, { text: '以后都少发 emoji，正事别用', kind: 'pref', conf: 0.8 })
      await saveScope(pr, sc)
      const p = await propose(pr)
      assert.ok(p.replacements.length >= 1, '同主题候选应转成替换：' + JSON.stringify({ a: p.additions, r: p.replacements, rej: p.rejected }))
      assert.ok(p.replacements[0].old.includes('颜文字'), '要指名替换哪条旧规矩')
      assert.ok(p.replacements[0].freed > 0, '替换应腾出额度')
      assert.ok(p.budget.reclaimable > 0, '提案要报出能腾多少')
      assert.ok(p.decisions.some((d) => d.stage === 'replace' && d.action === 'replaced'), '台账要记替换')
      ok('propose：同主题候选转成「替换旧说法」并报出腾出的额度')
    } finally {
      await rm(pr, { recursive: true, force: true }).catch(() => {})
    }
  }

  // ---- 预算可调：环境变量在独立进程里生效，且被钳在合理范围 ----
  {
    const script = `const m = await import('./lib/persona.js'); const { personaTokenLimit } = await import('./lib/personalimit.js'); const { PROBE_LIMITS } = await import('./lib/probes.js'); console.log(JSON.stringify({ limit: m.PERSONA.tokenLimit, fn: personaTokenLimit(), probe: PROBE_LIMITS.tokens }))`
    const run = (v) => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: process.cwd(), encoding: 'utf8',
      env: { ...process.env, DSH_MEMORY_PERSONA_TOKENS: v },
    }).trim())
    assert.equal(run('1800').limit, 1800, '预算要能调大')
    assert.equal(run('1800').fn, 1800)
    assert.equal(run('1800').probe, 1800, '探针预算要跟着一起变')
    assert.equal(run('99999').limit, 2400, '要钳上限')
    assert.equal(run('10').limit, 600, '要钳下限')
    assert.equal(run('').limit, 1200, '没配就保持历史默认')
    ok('预算可调：DSH_MEMORY_PERSONA_TOKENS 生效并钳在 600–2400')
  }

  // ---- 写入前审视旧人设：识别偏长 / 示例 / 重复，且压缩不砍禁令宾语 ----
  const LONG_LINE = '不分析：他没问「为什么」「怎么办」「哪个好」，就别解释原因、别列利弊、别给方案、别补一句理由。别人说的话也别拆、别解读潜台词、别总结「他其实是想说」——想接就顺着接一句，想怼就怼，不当翻译。想多说，说人话，不带结构。'
  {
    const evo = [
      LONG_LINE,
      '例：',
      '爹：今天加班到十点，累死了',
      '✗ 加班到这么晚确实很消耗人…要不要聊聊？',
      '✓ 十点？你们领导真敢啊，吃饭没',
      '别说套话：不开场「以下是」「这个问题」「你好」「在吗」，不结尾「还需要什么」。',
      '说话短一点。',
    ].join('\n')
    const rows = inspectEvolvable(evo)
    assert.ok(rows.some((r) => r.flag === 'verbose'), '长行要标偏长')
    assert.ok(rows.some((r) => r.flag === 'example'), '示例行要单列')
    assert.equal(ruleCompact('称呼：可以叫他「小鱼」。'), null, '称呼行的引号是内容，不能砍')
    assert.equal(ruleCompact('别说套话：不开场「以下是」「这个问题」「你好」「在吗」。'), null,
      '禁令宾语的列举不能砍，砍了就不知道禁什么')
    assert.equal(validateCompact('别解释原因。', '别解释原因。', []).ok, false, '没变短不算压缩')
    assert.equal(validateCompact('别解释原因、别列利弊。', '昨天帮爹修了桥接。', []).ok, false, '带事件词要拒')
    assert.equal(validateCompact('别解释原因、别列利弊。', '这样挺好。', []).ok, false, '丢了约束词要拒')
    assert.equal(validateCompact('别解释原因、别列利弊。', '别给你爹讲大道理。', ['别解释原因、别列利弊。', '别给你爹讲大道理。']).ok,
      false, '压完和别的行重复要拒')
    const { compressions } = collectCompressions(evo)
    assert.ok(compressions.length >= 1, '至少压出一条')
    assert.ok(compressions[0].freed > 0)
    assert.equal(compressions[0].freed,
      estimateTokens(compressions[0].old) - estimateTokens(compressions[0].rule),
      '腾出的额度必须按 token 算，不能拿字符数当 tok')
    const llm = { 0: '他没问就别分析、别解释、别给方案。' }
    const withLlm = collectCompressions(evo, { llmCompact: llm })
    assert.ok(withLlm.compressions.some((c) => /他没问就别分析/.test(c.rule)), 'LLM 精简版更短时用它的')
    ok('审视旧人设：分类、安全压缩、LLM 补充')
  }

  // ---- propose：产出审视报告 / 压缩建议，预算按整理后动态算 ----
  {
    const dr = await mkdtemp(join(tmpdir(), 'whale-persona-dynamic-'))
    try {
      await ensureDirs(dr)
      const base = `<!-- PERSONA:CORE:START -->\n你是测试鲸鱼。\n<!-- PERSONA:CORE:END -->\n\n<!-- PERSONA:EVOLVABLE:START -->\n${LONG_LINE}\n说话短一点。\n<!-- PERSONA:EVOLVABLE:END -->\n\n## 纪律\n事实优先。`
      await writeFile(join(dr, 'persona.md'), base, 'utf8')
      const sc = emptyScope('private', '1')
      addItem(sc, { text: '以后别用 emoji 了', kind: 'pref', conf: 0.8 })
      addItem(sc, { text: '以后都少发 emoji，正事别用', kind: 'pref', conf: 0.8 })
      await saveScope(dr, sc)
      const p = await propose(dr)
      assert.ok(p.audit.length >= 2, '要有逐行审视报告')
      assert.ok(p.compressions.length >= 1, '要给出可压缩的旧行')
      assert.ok(p.budget.basis < p.budget.tokens, '审查基准要按「整理后」算，不是当前占用')
      assert.ok(p.budget.compactible > 0, '要报出压缩能腾多少')
      assert.ok(p.budget.effective > p.budget.headroom, '整理后可用额度要变大')
      assert.ok(p.decisions.some((d) => d.stage === 'compact'), '台账要记压缩')
      const brief = (await status(dr)).proposal
      assert.ok(brief.audit.length >= 2 && brief.compressions.length >= 1, 'status 要带审视与压缩')
      ok('动态预算：先收拾旧人设再算额度，审视/压缩进提案')

      // apply 时真的把旧行写短，CORE 与纪律不动，changelog 留痕
      const r = await applyProposal(dr, join(dr, PERSONA.proposal))
      assert.ok(r.compressed >= 1, JSON.stringify(r))
      const out = await readFile(join(dr, 'persona.md'), 'utf8')
      assert.ok(out.includes('他没问，就别解释') || !out.includes('「为什么」'), out)
      assert.ok(out.includes('你是测试鲸鱼') && out.includes('事实优先'))
      assert.ok((await readFile(join(dr, PERSONA.changelog), 'utf8')).includes('压缩：'))
      assert.ok((await status(dr)).lastApplied.compressed.length >= 1)
      ok('apply：真的压缩旧行，CORE 不动且留痕')
    } finally {
      await rm(dr, { recursive: true, force: true }).catch(() => {})
    }
  }

  // ---- 同一行可压缩又会被替换：审查基准不能重复扣额度 ----
  {
    const rr = await mkdtemp(join(tmpdir(), 'whale-persona-no-double-'))
    try {
      await ensureDirs(rr)
      const line = '少用 emoji 和颜文字（正事时要收手），一条最多一个；「开心」「难过」这种表情别连发，别刷屏。'
      const base = `<!-- PERSONA:CORE:START -->\n你是测试鲸鱼。\n<!-- PERSONA:CORE:END -->\n\n<!-- PERSONA:EVOLVABLE:START -->\n${line}\n<!-- PERSONA:EVOLVABLE:END -->\n\n## 纪律\n事实优先。`
      await writeFile(join(rr, 'persona.md'), base, 'utf8')
      const sc = emptyScope('private', '1')
      addItem(sc, { text: '以后别用 emoji 了', kind: 'pref', conf: 0.8 })
      addItem(sc, { text: '以后都少发 emoji，正事别用', kind: 'pref', conf: 0.8 })
      await saveScope(rr, sc)
      const p = await propose(rr)
      assert.ok(p.replacements.length >= 1, '这行字面够像，应该换成新说法：' + JSON.stringify({ r: p.replacements, rej: p.rejected }))
      assert.equal(p.compressions.length, 0, '被替换的行不再压缩')
      const expected = Math.max(0,
        p.budget.tokens - p.budget.compactible - p.replacements.reduce((n, r) => n + r.freed, 0))
      assert.equal(p.budget.basis, expected, '审查基准 = 当前占用 − 压缩 − 替换净腾出，不能重复扣')
      assert.equal(p.budget.effective, Math.max(0, p.budget.limit - p.budget.basis))
      ok('动态预算：同一行只算一次，压缩/替换不重复扣额度')
    } finally {
      await rm(rr, { recursive: true, force: true }).catch(() => {})
    }
  }

  // ---- 同一行既被替换又被压缩：压缩让位，不报错也不重复改 ----
  {
    const cr = await mkdtemp(join(tmpdir(), 'whale-persona-conflict-'))
    try {
      await ensureDirs(cr)
      const line = '不分析：他没问「为什么」「怎么办」「哪个好」，就别解释原因、别列利弊。'
      const base = `<!-- PERSONA:CORE:START -->\n你是测试鲸鱼。\n<!-- PERSONA:CORE:END -->\n\n<!-- PERSONA:EVOLVABLE:START -->\n${line}\n<!-- PERSONA:EVOLVABLE:END -->\n\n## 纪律\n事实优先。`
      await writeFile(join(cr, 'persona.md'), base, 'utf8')
      const pf = join(cr, 'p.json')
      await writeFile(pf, JSON.stringify({
        at: new Date().toISOString(), baselineHash: hashOf(base), additions: [],
        replacements: [{ old: line, rule: '他没问就别分析、别解释。' }],
        compressions: [{ old: line, rule: '他没问，就别解释。', freed: 15 }],
      }), 'utf8')
      const r = await applyProposal(cr, pf)
      assert.equal(r.replaced, 1)
      assert.equal(r.compressed, 0, '同一行不该既压缩又替换')
      assert.ok((await readFile(join(cr, 'persona.md'), 'utf8')).includes('他没问就别分析'))
      ok('冲突：同一行只做替换，压缩自动让位')
    } finally {
      await rm(cr, { recursive: true, force: true }).catch(() => {})
    }
  }

  console.log(`\n${pass} 通过 · 0 失败`)
} finally {
  await rm(root, { recursive: true, force: true }).catch(() => {})
}
