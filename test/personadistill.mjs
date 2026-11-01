/**
 * test/personadistill.mjs —— 人格蒸馏的采样 / 生成 / 审查分离（文档 8.6）
 *   node test/personadistill.mjs
 *
 * 不联网：生成器和审查器都用桩 fetch。
 */

import assert from 'node:assert'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ensureDirs, emptyScope, addItem, saveScope } from '../lib/store.js'
import { samplePersona, reviewRule } from '../lib/personadistill.js'
import { propose } from '../lib/persona.js'

let pass = 0
const ok = (name) => { pass += 1; console.log('  ok', name) }

const ORIGINAL = `<!-- PERSONA:CORE:START -->
你是测试鲸鱼。
<!-- PERSONA:CORE:END -->

<!-- PERSONA:EVOLVABLE:START -->
少用 emoji 和颜文字，一条最多一个，正事时不用。
回答先给结论，别绕弯；聊天窗口别写长。
<!-- PERSONA:EVOLVABLE:END -->`

const root = await mkdtemp(join(tmpdir(), 'whale-pdistill-'))
try {
  await ensureDirs(root)
  await writeFile(join(root, 'persona.md'), ORIGINAL, 'utf8')

  const sc = emptyScope('private', '1')
  const a = addItem(sc, { text: '以后别用 emoji 了', kind: 'pref', conf: 0.8 })
  const b = addItem(sc, { text: '说话先给结论，别绕', kind: 'pref', conf: 0.8 })
  // 隐私门：命令、凭据、日志不进样本
  const cmd = addItem(sc, { text: 'node tools/deploy.mjs 跑完再说', kind: 'fact' })
  const secret = addItem(sc, { text: '我的 key 是 sk-abcdefghijklmnopqrstuvwxyz', kind: 'fact' })
  await saveScope(root, sc)

  const sample = await samplePersona(root)
  const ids = sample.samples.map((x) => x.id)
  assert.ok(ids.includes(a.id) && ids.includes(b.id), JSON.stringify(ids))
  assert.ok(!ids.includes(cmd.id), '命令不该进样本')
  assert.ok(!ids.includes(secret.id), '凭据不该进样本')
  assert.ok(sample.knownIds.has(cmd.id), 'knownIds 仍是全量，用来核对证据是否存在')
  ok('采样：命令 / 凭据被挡，画像样本保留')

  // 确定性审查：事件 / 日期 / 号码 / 假 id / 超预算
  const base = { knownIds: sample.knownIds, current: '', tokens: 0, limit: 1200 }
  assert.equal(reviewRule('以后都先说结论', { ...base, evidence: [a.id] }).ok, true)
  assert.equal(reviewRule('昨天帮爹修了桥接', { ...base, evidence: [a.id] }).ok, false)
  assert.equal(reviewRule('2026-11-01 之后都少说话', { ...base, evidence: [a.id] }).ok, false)
  assert.equal(reviewRule('QQ 123456789 说话短点', { ...base, evidence: [a.id] }).ok, false)
  assert.equal(reviewRule('以后都先说结论', { ...base, evidence: ['m_fake'] }).ok, false)
  assert.equal(reviewRule('以后都先说结论', { ...base, evidence: [] }).ok, false)
  ok('确定性审查：事件 / 日期 / 号码 / 假证据 / 空证据都拦')

  // 生成器：一条好规则 + 一条假证据 + 一条会被确定性审查拦下的
  const genStub = async (_url, init) => {
    const body = JSON.parse(init.body)
    assert.equal(body.model, 'stub-gen')
    return {
      ok: true,
      json: async () => ({
        choices: [{
          message: {
            content: JSON.stringify({
              additions: [
                { rule: '怼人可以，但不揭短，对方难受了就收手', evidence: [a.id] },
                { rule: '以后都用本鲸自称', evidence: ['m_fake'] },
                { rule: '昨天那件事以后别做', evidence: [a.id] },
              ],
            }),
          },
        }],
      }),
    }
  }
  const reviewStub = (approve, why = '') => async (_url, init) => {
    const body = JSON.parse(init.body)
    assert.equal(body.model, 'stub-rev')
    const content = String(body.messages?.[1]?.content ?? '')
    const candidates = JSON.parse(content).candidates || []
    return {
      ok: true,
      json: async () => ({
        choices: [{
          message: {
            content: JSON.stringify({ verdicts: candidates.map((c) => ({ rule: c.rule, approve, why })) }),
          },
        }],
      }),
    }
  }

  process.env.DSH_MEMORY_LLM_BASE = 'http://stub.local/v1'
  process.env.DSH_MEMORY_LLM_MODEL = 'stub-gen'
  process.env.DSH_MEMORY_REVIEW_BASE = 'http://stub.local/v1'
  // 第一轮：审查端点不可用，只走确定性审查
  process.env.DSH_MEMORY_REVIEW_MODEL = 'stub-none'
  const router = (rev) => async (url, init) => {
    const body = JSON.parse(init.body)
    if (body.model === 'stub-gen') return genStub(url, init)
    if (body.model === 'stub-rev') return rev(url, init)
    return { ok: false, json: async () => ({}) }
  }

  const p = await propose(root, { fetchImpl: router(reviewStub(true)) })
  assert.equal(p.generator, 'llm', JSON.stringify(p))
  assert.equal(p.reviewer, 'rules')
  assert.ok(p.additions.some((x) => x.rule.includes('不揭短')), JSON.stringify(p.additions))
  assert.ok(!p.additions.some((x) => x.rule.includes('本鲸')), '假证据应被丢')
  assert.ok(p.rejected.some((x) => x.rule.includes('昨天')), JSON.stringify(p.rejected))
  ok('生成：假证据被丢，事件规则被确定性审查拦下')

  // 审查模型：生成与审查分开，两次不同模型；否决的进 rejected
  process.env.DSH_MEMORY_REVIEW_MODEL = 'stub-rev'
  const p2 = await propose(root, { fetchImpl: router(reviewStub(false, '这条更像单次评价')) })
  assert.equal(p2.reviewer, 'llm(separate)', JSON.stringify(p2.reviewer))
  assert.ok(!p2.additions.some((x) => x.rule.includes('不揭短')), JSON.stringify(p2.additions))
  assert.ok(p2.rejected.some((x) => /审查模型/.test(x.why)), JSON.stringify(p2.rejected))
  ok('审查：独立模型否决后不进提案，理由留档')

  // 审查器挂了：不阻塞提案，降级为确定性审查
  const p3 = await propose(root, { fetchImpl: router(async () => ({ ok: false, json: async () => ({}) })) })
  assert.equal(p3.reviewer, 'rules')
  assert.ok(p3.additions.some((x) => x.rule.includes('不揭短')), '审查器挂了不该把候选全丢掉')
  ok('审查器失败：退回确定性审查，不写半截结果')

  console.log(`\n全部通过：${pass} 项`)
} catch (e) {
  console.error('\n失败：', e)
  process.exitCode = 1
} finally {
  delete process.env.DSH_MEMORY_LLM_BASE
  delete process.env.DSH_MEMORY_LLM_MODEL
  delete process.env.DSH_MEMORY_REVIEW_BASE
  delete process.env.DSH_MEMORY_REVIEW_MODEL
  await rm(root, { recursive: true, force: true }).catch(() => {})
}
