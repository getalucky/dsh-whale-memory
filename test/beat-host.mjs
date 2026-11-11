/**
 * beat-host.mjs —— 宿主服务代理的回归
 *
 * Cordis 宿主 ctx 没 inject 过的属性读取会直接抛。启动早期 tick / 探针
 * 撞上这种代理时，只能当作「暂时没有 agents」，不能整跳失败刷日志。
 */
import assert from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ensureBeatDirs, saveConfig } from '../lib/beat/config.js'
import { startBeat } from '../lib/beat/index.js'
import { getBeatAgent } from '../lib/beat/session.js'

const root = await mkdtemp(join(tmpdir(), 'whale-host-'))
const home = await mkdtemp(join(tmpdir(), 'whale-host-home-'))
const oldHome = process.env.DSH_HOME
const oldOff = process.env.DSH_MEMORY_BEAT
const logs = []
let beat = null
try {
  process.env.DSH_HOME = home
  delete process.env.DSH_MEMORY_BEAT
  await ensureBeatDirs(root)
  await saveConfig(root, { enabled: true, dryRun: true, installPreset: false })

  // 注入回调故意不来：除 inject 外，任何服务属性都按未注入处理。
  const base = { inject() {} }
  const host = new Proxy(base, {
    get(target, prop, receiver) {
      if (Reflect.has(target, prop)) return Reflect.get(target, prop, receiver)
      throw new Error(`cannot get property "${String(prop)}" without inject`)
    },
  })

  const direct = await getBeatAgent({ ctx: host, root })
  assert.equal(direct.ok, false)
  assert.equal(direct.why, 'no-agents')

  beat = startBeat(host, { root, log: (m) => logs.push(String(m)) })
  await new Promise((r) => setTimeout(r, 60))
  let r = await beat.tick()
  for (let i = 0; i < 20 && r?.why === 'busy'; i += 1) {
    await new Promise((res) => setTimeout(res, 25))
    r = await beat.tick()
  }
  assert.equal(r.ok, true)
  assert.equal(r.skipped, 'no-agents')
  assert.equal(logs.some((m) => m.includes('beat 跳失败')), false, '未注入 agents 不该算跳失败')

  console.log('beat-host ok')
} finally {
  beat?.dispose()
  if (oldHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = oldHome
  if (oldOff === undefined) delete process.env.DSH_MEMORY_BEAT
  else process.env.DSH_MEMORY_BEAT = oldOff
  await rm(root, { recursive: true, force: true }).catch(() => {})
  await rm(home, { recursive: true, force: true }).catch(() => {})
}
