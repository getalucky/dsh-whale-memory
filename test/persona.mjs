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
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ensureDirs, emptyScope, addItem, saveScope } from '../lib/store.js'
import {
  propose, applyProposal, rollback, status, parsePersona, personaTokens,
  stripMarkers, hashOf, PERSONA,
} from '../lib/persona.js'

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

  // 应用：只改 EVOLVABLE
  const r = await applyProposal(root, join(root, PERSONA.proposal))
  assert.ok(r.applied >= 2, JSON.stringify(r))
  const after = await readFile(join(root, 'persona.md'), 'utf8')
  assert.ok(after.includes('少用 emoji'), after)
  assert.ok(after.includes('你是测试鲸鱼'), '核心身份被改了')
  assert.ok(after.includes('事实优先'), '纪律层被改了')
  const blocks = parsePersona(after)
  assert.ok(blocks.hasCore && blocks.hasEvolvable)
  ok('apply：只往 EVOLVABLE 追加，核心与纪律原样')

  // 归档
  const arch0 = await readFile(join(root, PERSONA.archiveDir, 'v0.md'), 'utf8')
  assert.equal(arch0, ORIGINAL)
  const st = await status(root)
  assert.equal(st.version, 1)
  ok('版本归档：v0 保留原稿')

  // 基线变了：原提案不能再用
  await writeFile(join(root, 'persona.md'), after.replace('说话短一点。', '说话短一点，别废话。'), 'utf8')
  await assert.rejects(() => applyProposal(root, join(root, PERSONA.proposal)), /冲突/)
  ok('基线被改过 → 拒绝应用')

  // 超预算拒绝
  const big = `<!-- PERSONA:EVOLVABLE:START -->\n${'很长的规则'.repeat(300)}\n<!-- PERSONA:EVOLVABLE:END -->`
  await writeFile(join(root, 'persona.md'), big, 'utf8')
  const badProposal = join(root, 'bad.json')
  await writeFile(badProposal, JSON.stringify({
    schema: 1, at: new Date().toISOString(), baselineHash: hashOf(big), additions: [{ rule: '再加一条' }],
  }), 'utf8')
  await assert.rejects(() => applyProposal(root, badProposal), /预算/)
  ok('超预算 → 拒绝应用')

  // 回滚
  await writeFile(join(root, 'persona.md'), after, 'utf8')
  const rb = await rollback(root, 0)
  assert.equal(rb.version, 0)
  assert.equal(await readFile(join(root, 'persona.md'), 'utf8'), ORIGINAL)
  ok('rollback：回到 v0')

  // 注入前去掉标记，且预算计算不含标记
  assert.ok(!stripMarkers(ORIGINAL).includes('PERSONA:'), stripMarkers(ORIGINAL))
  assert.ok(personaTokens(ORIGINAL) < 1200)
  ok('stripMarkers / 预算口径')

  console.log(`\n${pass} 通过 · 0 失败`)
} finally {
  await rm(root, { recursive: true, force: true }).catch(() => {})
}
