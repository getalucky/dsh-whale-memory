/**
 * beat-lock.mjs —— 心跳 state.json 的读改写锁
 *
 *   · 并发 updateState 不丢写
 *   · 并发用户消息计数不丢
 *   · 收尾合并与投递打标交错时不互相覆盖
 */
import assert from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ensureBeatDirs } from '../lib/beat/config.js'
import { runOnce } from '../lib/beat/index.js'
import { loadState, saveState, updateState, withStateLock } from '../lib/beat/state.js'
import { noteDelivery, noteUserMessage } from '../lib/beat/feedback.js'

let pass = 0
const ok = (name) => { pass += 1; console.log('  ok', name) }

const root = await mkdtemp(join(tmpdir(), 'whale-lock-'))
try {
  await ensureBeatDirs(root)

  await Promise.all(Array.from({ length: 20 }, () => updateState(root, (st) => {
    st.wanderCount = (Number(st.wanderCount) || 0) + 1
  })))
  assert.equal((await loadState(root)).wanderCount, 20)
  ok('20 个并发 updateState 不丢写')

  await Promise.all(Array.from({ length: 10 }, (_, i) => noteUserMessage(root, {
    text: `第 ${i} 条消息`,
    sessionId: 's1',
  })))
  assert.equal((await loadState(root)).replyStats.count, 10)
  ok('并发用户消息计数不丢')

  await noteDelivery(root, { deliveryId: 'd1', materials: [{ id: 'm1' }] })
  await Promise.all([
    withStateLock(root, async () => {
      const st = await loadState(root)
      st.lastGate = 'pass'
      await new Promise((r) => setTimeout(r, 5))
      await saveState(root, st)
    }),
    noteDelivery(root, { deliveryId: 'd2', materials: [{ id: 'm2' }] }),
  ])
  const st = await loadState(root)
  assert.equal(st.pendingDelivery.deliveryId, 'd2')
  assert.equal(st.lastGate, 'pass')
  ok('收尾合并不冲掉投递打标')

  // vault 检查和早退发生在同一跳：检查时间和错误必须一起落盘，
  // 否则下一跳会误以为「24 小时没查」而重复跑 DPAPI 检查。
  const now = new Date()
  await updateState(root, (s) => {
    s.lastVaultCheckAt = now.toISOString()
    s.vaultError = { at: now.toISOString(), errors: [{ file: 'x', why: 'boom' }] }
  })
  const r = await runOnce({ root, config: { enabled: true, dryRun: true }, now, log: () => {} })
  assert.equal(r.skipped, 'vault-error')
  const stVault = await loadState(root)
  assert.equal(stVault.lastVaultCheckAt, now.toISOString())
  assert.equal(stVault.vaultError?.errors?.[0]?.why, 'boom')
  ok('vault 失败状态在早退时落盘')
} finally {
  await rm(root, { recursive: true, force: true }).catch(() => {})
}

console.log(`\n${pass} 通过 · 0 失败`)
