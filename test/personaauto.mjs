/**
 * personaauto.mjs —— 人格自动迭代验收（文档 8.6 第三、五节）
 *
 * 验的是：
 *   · 自动触发门槛：≥100 条新消息 + ≥24 小时 + ≥20 条有效样本
 *   · 每周最多一个 revision（自动发不了，人工也要 --force）
 *   · 连续 3 次人工通过才允许自动发布；warn 期不自动发
 *   · 拒绝会清零连续计数，并让同一规则 30 天内不再提
 *   · 自动发布留痕（by=auto、changelog、autoPublished）
 */
import assert from 'node:assert'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ensureDirs, emptyScope, saveScope } from '../lib/store.js'
import {
  propose, applyProposal, autoGate, rejectProposal, readMeta, updateMeta, parsePersona, PERSONA,
  status, recentDecisions, readDecisions,
} from '../lib/persona.js'
import { autoTick, bumpMessages } from '../lib/personaloop.js'

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

const seed = (n) => Array.from({ length: n }, (_, i) => ({
  id: `m_seed${String(i).padStart(3, '0')}`,
  text: `样本第 ${i} 条：关于吃鱼的第 ${i} 种说法`,
  kind: 'pref',
  conf: 0.8,
  state: 'active',
  created: new Date().toISOString(),
  lastHit: new Date().toISOString(),
  hits: 0,
}))

const root = await mkdtemp(join(tmpdir(), 'whale-persona-auto-'))
try {
  await ensureDirs(root)
  await writeFile(join(root, 'persona.md'), ORIGINAL, 'utf8')

  const sc = emptyScope('private', '1')
  sc.items = seed(22)
  sc.items.push({
    id: 'm_emoji1', text: '以后别用 emoji 了', kind: 'pref', conf: 0.8, state: 'active',
    created: new Date().toISOString(), lastHit: new Date().toISOString(), hits: 0,
  })
  sc.items.push({
    id: 'm_emoji2', text: '以后都少发 emoji，正事别用', kind: 'pref', conf: 0.8, state: 'active',
    created: new Date().toISOString(), lastHit: new Date().toISOString(), hits: 0,
  })
  await saveScope(root, sc)

  // ---- 计数 ----
  await bumpMessages(root, 40)
  assert.equal((await readMeta(root)).pendingMessages, 40)
  ok('bumpMessages：累计有效用户消息')

  // ---- 门槛：消息不够 ----
  const a1 = await autoTick(root, { gate: 'enforce' })
  assert.equal(a1.ran, false)
  assert.match(a1.why, /新消息 40\/100/, a1.why)
  ok('门槛：消息不足不跑')

  // ---- 门槛：24 小时内跑过 ----
  await updateMeta(root, (m) => ({ ...m, pendingMessages: 120, lastRunAt: new Date().toISOString() }))
  const a2 = await autoTick(root, { gate: 'enforce' })
  assert.equal(a2.ran, false)
  assert.match(a2.why, /不足 24 小时/, a2.why)
  ok('门槛：24 小时内不重复跑')

  // ---- 满足门槛：只出提案 ----
  await updateMeta(root, (m) => ({ ...m, pendingMessages: 120, lastRunAt: new Date(Date.now() - 25 * 3600e3).toISOString() }))
  const a3 = await autoTick(root, { gate: 'enforce' })
  assert.equal(a3.ran, true, JSON.stringify(a3))
  assert.equal(a3.applied, 0)
  assert.match(a3.why, /连续人工通过 0\/3/, a3.why)
  const p1 = JSON.parse(await readFile(join(root, PERSONA.proposal), 'utf8'))
  assert.ok(p1.additions.length >= 1, JSON.stringify(p1))
  assert.ok(p1.samples.total >= 20, JSON.stringify(p1.samples))
  assert.equal((await readMeta(root)).pendingMessages, 0)
  ok('满足门槛：生成提案但不自动发布')

  // ---- 透明度：每条候选的判决都留痕，含依据与理由 ----
  assert.ok(p1.decisions?.length >= 1, '提案里要有判决明细')
  assert.ok(p1.decisions.some((d) => d.action === 'accepted' && d.stage === 'review' && d.why), JSON.stringify(p1.decisions))
  assert.ok(p1.decisions.find((d) => d.action === 'accepted').evidence.length >= 1, '通过的候选要带依据记忆')
  assert.equal(typeof p1.samples.skipReasons, 'object', '采样跳过要分原因')
  assert.equal(typeof p1.budget.headroom, 'number', '预算要给出剩余空间')
  const st1 = await status(root)
  assert.ok(st1.decisions?.length >= 1, 'status 要能翻判决台账')
  assert.ok(st1.auto.waitReason, 'status 要说明当前为什么没迭代')
  assert.ok(st1.proposal.additions[0].refs?.length >= 1, 'status 要带依据 id')
  const ledger = await readDecisions(root, 5)
  assert.ok(ledger[0].rows.some((d) => d.action === 'accepted'), '台账落盘后能读回')
  ok('透明度：判决台账 / 采样原因 / 依据 / 预算余量都可查')

  // ---- 人工通过：连续计数 +1 ----
  const r1 = await applyProposal(root, join(root, PERSONA.proposal))
  assert.equal(r1.streak, 1)
  assert.ok((await readFile(join(root, 'persona.md'), 'utf8')).includes('少用 emoji'))
  ok('人工通过：连续计数 +1')

  // ---- 每周最多一个 revision ----
  await assert.rejects(() => applyProposal(root, join(root, PERSONA.proposal)), /每周最多一个 revision/)
  await propose(root) // 基于新人格重新出提案，否则先撞基线冲突
  const forced = await applyProposal(root, join(root, PERSONA.proposal), { force: true })
  assert.equal(forced.applied, 0, '同一提案重放不该重复追加')
  ok('每周最多一个 revision（--force 只放行写入，不放行重复规则）')

  // ---- 拒绝：清零 + 记原因 ----
  sc.items.push({
    id: 'm_con1', text: '以后都先给结论，别绕', kind: 'pref', conf: 0.8, state: 'active',
    created: new Date().toISOString(), lastHit: new Date().toISOString(), hits: 0,
  }, {
    id: 'm_con2', text: '说话先给结论，别啰嗦', kind: 'pref', conf: 0.8, state: 'active',
    created: new Date().toISOString(), lastHit: new Date().toISOString(), hits: 0,
  })
  await saveScope(root, sc)
  const p2 = await propose(root)
  assert.ok(p2.additions.some((a) => /结论/.test(a.rule)), JSON.stringify(p2.additions))
  const rj = await rejectProposal(root, { why: '太笼统，先观察' })
  assert.equal(rj.rules.length, p2.additions.length)
  assert.equal((await readMeta(root)).approvals.streak, 0)
  ok('拒绝：连续计数清零并记原因')

  const p3 = await propose(root)
  assert.ok(!p3.additions.some((a) => /结论/.test(a.rule)), '被拒规则 30 天内不该再提')
  assert.ok(p3.decisions.some((d) => d.stage === 'blacklist' && /30 天内/.test(d.why)),
    '被黑名单拦掉的候选必须写明原因，不能静默丢弃：' + JSON.stringify(p3.decisions))
  ok('拒绝：同一规则 30 天内不再提（且留痕）')

  // ---- 拒绝时替换候选也进 30 天黑名单 ----
  {
    const rp = await mkdtemp(join(tmpdir(), 'whale-persona-reject-replace-'))
    try {
      await ensureDirs(rp)
      await writeFile(join(rp, 'persona.md'), ORIGINAL, 'utf8')
      await writeFile(join(rp, PERSONA.proposal), JSON.stringify({
        at: new Date().toISOString(), baselineHash: '', additions: [],
        replacements: [{ old: '说话短一点。', rule: '说话别绕弯。' }],
      }), 'utf8')
      const r = await rejectProposal(rp, { why: '换得不好' })
      assert.ok(r.rules.includes('说话别绕弯。'), '替换候选也要进黑名单：' + JSON.stringify(r.rules))
      ok('拒绝：替换候选同样记入 30 天黑名单')
    } finally {
      await rm(rp, { recursive: true, force: true }).catch(() => {})
    }
  }

  // ---- warn 期不自动发 ----
  await updateMeta(root, (m) => ({ ...m, lastPublishedWeek: '2000-01-03' }))
  const g = await autoGate(root, { gate: 'warn' })
  assert.equal(g.ok, false)
  assert.match(g.why, /enforce/)
  ok('warn 观察期不自动发布')

  // ---- 连续 3 次人工通过 + 跨周 → 自动发布 ----
  // 直接改 meta 模拟「已连续通过 3 次、上周发布过」，不必真跑三次人工
  await updateMeta(root, (m) => ({
    ...m,
    pendingMessages: 120,
    lastRunAt: new Date(Date.now() - 25 * 3600e3).toISOString(),
    lastPublishedAt: new Date(Date.now() - 25 * 3600e3).toISOString(),
    lastPublishedWeek: '2000-01-03',
    approvals: { streak: 3, history: [] },
  }))
  sc.items = sc.items.filter((x) => !String(x.id).startsWith('m_emoji'))
  sc.items.push({
    id: 'm_con3', text: '以后别道歉了，不用道歉', kind: 'pref', conf: 0.8, state: 'active',
    created: new Date().toISOString(), lastHit: new Date().toISOString(), hits: 0,
  }, {
    id: 'm_con4', text: '别解释那么多，别加免责声明', kind: 'pref', conf: 0.8, state: 'active',
    created: new Date().toISOString(), lastHit: new Date().toISOString(), hits: 0,
  })
  // 结论规则刚被拒过，propose 会跳过；这一批只剩「别像免责声明」
  await saveScope(root, sc)

  const a4 = await autoTick(root, { gate: 'enforce' })
  assert.ok(a4.applied >= 1, JSON.stringify(a4))
  const meta4 = await readMeta(root)
  assert.equal(meta4.approvals.streak, 3, '自动发布不该增加连续人工通过')
  assert.equal(meta4.autoPublished, 1)
  const log4 = await readFile(join(root, PERSONA.changelog), 'utf8')
  assert.ok(/自动发布（连续人工通过 3 次）/.test(log4), log4)
  const persona4 = await readFile(join(root, 'persona.md'), 'utf8')
  assert.ok(persona4.includes('免责声明'), persona4)
  assert.ok(persona4.includes('你是测试鲸鱼'), '核心身份被改')
  ok('连续 3 次人工通过：跨周自动发布并留痕')

  // ---- 自动发布之后本周不能再发 ----
  const g2 = await autoGate(root, { gate: 'enforce' })
  assert.equal(g2.ok, false)
  assert.match(g2.why, /本周已发布/)
  ok('自动发布后本周封版')

  // ---- 拼过一条：手动样本门 ----
  const small = await mkdtemp(join(tmpdir(), 'whale-persona-small-'))
  try {
    await ensureDirs(small)
    await writeFile(join(small, 'persona.md'), ORIGINAL, 'utf8')
    const s = emptyScope('private', '2')
    s.items = seed(3)
    await saveScope(small, s)
    await assert.rejects(() => propose(small, { manual: true }), /还差 17 条/)
    const noGate = await propose(small, { manual: false })
    assert.equal(noGate.samples.total, 3)
    ok('手动样本门：不足 20 条明确说差多少')
  } finally {
    await rm(small, { recursive: true, force: true }).catch(() => {})
  }

  // ---- 只有整理、没有新规矩时，自动迭代也要能发布 ----
  {
    const cleanRoot = await mkdtemp(join(tmpdir(), 'whale-persona-cleanup-'))
    try {
      await ensureDirs(cleanRoot)
      const dirty = `<!-- PERSONA:CORE:START -->\n你是测试鲸鱼。\n<!-- PERSONA:CORE:END -->\n\n<!-- PERSONA:EVOLVABLE:START -->\n不分析：他没问「为什么」「怎么办」「哪个好」，就别解释原因、别列利弊。\n<!-- PERSONA:EVOLVABLE:END -->\n\n## 纪律\n事实优先。`
      await writeFile(join(cleanRoot, 'persona.md'), dirty, 'utf8')
      const s = emptyScope('private', '3')
      s.items = seed(22)
      await saveScope(cleanRoot, s)
      await updateMeta(cleanRoot, (m) => ({
        ...m,
        pendingMessages: 120,
        lastRunAt: new Date(Date.now() - 25 * 3600e3).toISOString(),
        lastPublishedAt: new Date(Date.now() - 25 * 3600e3).toISOString(),
        lastPublishedWeek: '2000-01-03',
        approvals: { streak: 3, history: [] },
      }))
      const a = await autoTick(cleanRoot, { gate: 'enforce' })
      assert.equal(a.applied, 0, JSON.stringify(a))
      assert.ok(a.compressed >= 1, '没有新规矩时也要能压缩旧人设：' + JSON.stringify(a))
      const out = await readFile(join(cleanRoot, 'persona.md'), 'utf8')
      assert.ok(out.includes('他没问，就别解释'), out)
      assert.ok(out.includes('你是测试鲸鱼'), 'CORE 不能动')
      ok('只有整理没有新增：自动迭代同样发布压缩')
    } finally {
      await rm(cleanRoot, { recursive: true, force: true }).catch(() => {})
    }
  }

  // ---- 老提案（没有 decisions 字段）也要能反推出判决 ----
  {
    const legacyRoot = await mkdtemp(join(tmpdir(), 'whale-persona-legacy-'))
    try {
      await ensureDirs(legacyRoot)
      await writeFile(join(legacyRoot, 'persona.md'), ORIGINAL, 'utf8')
      await writeFile(join(legacyRoot, PERSONA.proposal), JSON.stringify({
        at: '2026-11-12T00:59:25.575Z', generator: 'rules(fallback)', reviewer: 'rules',
        samples: { count: 12, skipped: 167, total: 324 },
        budget: { tokens: 1182, limit: 1200 },
        additions: [], rejected: [], warnings: ['没有新的候选；现有区块已覆盖，或证据不足'],
      }), 'utf8')
      const runs = await recentDecisions(legacyRoot, 3)
      assert.equal(runs.length, 1)
      assert.equal(runs[0].legacy, true)
      assert.ok(runs[0].rows.some((d) => d.stage === 'sample' && /采样跳过 167/.test(d.rule)))
      assert.ok(runs[0].rows.some((d) => d.stage === 'generator' && /蒸馏模型/.test(d.why)))
      assert.ok(runs[0].rows.some((d) => /没有新候选/.test(d.rule)), '要说明「为什么 0 条」')
      const st = await status(legacyRoot)
      assert.equal(st.proposal.budget.headroom, 18, '老提案也要算出预算余量')
      ok('老提案反推：升级后不用等下一轮就能看到理由')
    } finally {
      await rm(legacyRoot, { recursive: true, force: true }).catch(() => {})
    }
  }

  // ---- 结构没被写坏 ----
  const blocks = parsePersona(await readFile(join(root, 'persona.md'), 'utf8'))
  assert.ok(blocks.hasCore && blocks.hasEvolvable)
  ok('自动发布只动 EVOLVABLE 区块')

  console.log(`\n${pass} 通过 · 0 失败`)
} finally {
  await rm(root, { recursive: true, force: true }).catch(() => {})
}
