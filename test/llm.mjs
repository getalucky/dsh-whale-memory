/**
 * llm.mjs —— 可选 LLM 蒸馏 / 向量召回
 * 跑法：node test/llm.mjs
 *
 * 不联网：fetch 用桩函数。验证「能用」和「挂了要回退」两条路。
 */
import assert from 'node:assert'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = await mkdtemp(join(tmpdir(), 'whale-llm-'))
const cfgFile = join(root, 'qq-bridge-config.json')
await writeFile(cfgFile, JSON.stringify({ 绑定: [{ 类型: '私聊', 号码: '123456789', 会话: 'sess-llm', 称呼: '老爹' }] }), 'utf8')
process.env.DSH_QQ_BRIDGE_CONFIG = cfgFile
process.env.DSH_MEMORY_LLM_BASE = 'http://stub.local/v1'
process.env.DSH_MEMORY_LLM_MODEL = 'stub-chat'
process.env.DSH_MEMORY_EMBED_BASE = 'http://stub.local/v1'
process.env.DSH_MEMORY_EMBED_MODEL = 'stub-embed'

const {
  llmReady, embedReady, parseCandidates, distillMessages, embedTexts,
} = await import('../lib/llm.js')
const { fuseRankings } = await import('../lib/recall.js')
const { ensureDirs, loadScope, paths } = await import('../lib/store.js')
const { distillSession } = await import('../lib/distill.js')

let pass = 0
const ok = (name) => { pass += 1; console.log('  ok', name) }

const jsonRes = (obj) => ({ ok: true, json: async () => obj })
const chatStub = async () => jsonRes({
  choices: [{ message: { content: '```json\n[{"text":"老爹刚下班回家","kind":"fact","conf":0.7}]\n```' } }],
})
const embedStub = async () => jsonRes({ data: [{ embedding: [1, 0] }, { embedding: [0, 1] }] })

try {
  assert.equal(llmReady(), true)
  assert.equal(embedReady(), true)
  ok('配置齐全才算就绪')

  // 解析：围栏、坏 kind、空数组
  assert.deepEqual(parseCandidates('废话\n```json\n[{"text":"老爹喜欢冰美式","kind":"pref","conf":0.8}]\n```'), [
    { text: '老爹喜欢冰美式', kind: 'pref', conf: 0.8 },
  ])
  assert.equal(parseCandidates('没有 json'), null)
  assert.equal(parseCandidates('[]'), null)
  assert.equal(parseCandidates('[{"text":"短","kind":"x"}]'), null, '太短应丢弃')
  assert.equal(parseCandidates('[{"text":"正常长度的一句话","kind":"xx","conf":9}]')[0].kind, 'fact', '未知 kind 回落 fact')
  ok('候选解析与校验')

  const cands = await distillMessages([{ at: '2026-10-30T12:00:00', speaker: '老爹', text: '今天累死了刚到家' }], { fetchImpl: chatStub })
  assert.equal(cands[0].text, '老爹刚下班回家')
  ok('distillMessages 走 chat/completions')

  const fail = async () => ({ ok: false, json: async () => ({}) })
  assert.equal(await distillMessages([{ at: '', text: 'x' }], { fetchImpl: fail }), null)
  assert.equal(await embedTexts(['a', 'b'], { fetchImpl: fail }), null)
  ok('端点失败返回 null，不写半截结果')

  const vecs = await embedTexts(['a', 'b'], { fetchImpl: embedStub })
  assert.deepEqual(vecs, [[1, 0], [0, 1]])
  ok('embedTexts 批量向量')

  // RRF：两个通道名次不同，融合后两边都保留
  const a = { id: 'a' }
  const b = { id: 'b' }
  const fused = fuseRankings([[{ item: a, score: 1 }, { item: b, score: 0.5 }], [{ item: b, score: 1 }, { item: a, score: 0.5 }]])
  assert.equal(fused.length, 2)
  assert.ok(Math.abs(fused[0].score - fused[1].score) < 1e-9, '两条各赢一局，分数应该一样')
  ok('RRF 融合')

  // 端到端：LLM 抽到规则抽不出来的句子
  await ensureDirs(root)
  await mkdir(paths(root).staging, { recursive: true })
  await writeFile(join(paths(root).staging, 'sess-llm.jsonl'),
    JSON.stringify({ at: '2026-10-30T22:00:00', role: 'user', speaker: '老爹', text: '今天累死了刚到家' }) + '\n', 'utf8')
  const r = await distillSession(root, 'sess-llm', { log: () => {}, fetchImpl: chatStub })
  assert.equal(r.ok, true, JSON.stringify(r))
  const sc = await loadScope(root, 'private', '123456789')
  assert.ok(sc.items.some((x) => x.text === '老爹刚下班回家'), JSON.stringify(sc.items))
  assert.ok(sc.items.every((x) => !x.text.includes('累死了')), '规则不该把寒暄当事实')
  ok('LLM 蒸馏接入 distillSession')

  // LLM 挂了：规则照常兜底
  await writeFile(join(paths(root).staging, 'sess-llm.jsonl'),
    JSON.stringify({ at: '2026-10-30T22:10:00', role: 'user', speaker: '老爹', text: '记住：明天交房租' }) + '\n', 'utf8')
  const r2 = await distillSession(root, 'sess-llm', { log: () => {}, fetchImpl: fail })
  assert.equal(r2.ok, true, JSON.stringify(r2))
  const sc2 = await loadScope(root, 'private', '123456789')
  assert.ok(sc2.items.some((x) => x.text.includes('交房租')), JSON.stringify(sc2.items))
  ok('LLM 失败时规则兜底')

  console.log(`\n全部通过：${pass} 项`)
} catch (e) {
  console.error('\n失败：', e)
  process.exitCode = 1
} finally {
  delete process.env.DSH_MEMORY_LLM_BASE
  delete process.env.DSH_MEMORY_LLM_MODEL
  delete process.env.DSH_MEMORY_EMBED_BASE
  delete process.env.DSH_MEMORY_EMBED_MODEL
  await rm(root, { recursive: true, force: true }).catch(() => {})
}
