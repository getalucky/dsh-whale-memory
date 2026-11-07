/**
 * bridge-adapter.mjs —— 适配口子：换桥不动记忆层
 * 跑法：node test/bridge-adapter.mjs
 *
 * 验的是记忆层只依赖 adapter 契约：
 *   · 换个配置格式和消息头，来源/拥有者/发言人照样解析
 *   · 注销后回到 QQ 桥，默认格式不变
 */
import assert from 'node:assert'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = await mkdtemp(join(tmpdir(), 'whale-adapter-'))
process.env.DSH_QQ_BRIDGE_CONFIG = join(root, 'no-such-bridge.json')

const cfg = join(root, 'other-bridge.json')
await writeFile(cfg, JSON.stringify({
  owner: { id: 'u-1', name: '宿主' },
  links: [
    { sid: 'sess-x', room: 'r-1', group: false },
    { sid: 'sess-g', room: 'g-1', group: true },
  ],
}), 'utf8')

const { registerBridgeAdapter, bridgeAdapter, qqBridgeAdapter } = await import('../lib/bridge-adapter.js')
const { preloadSources, sourceOfSession, resetSourceCache } = await import('../lib/source.js')
const { splitSpeakers } = await import('../lib/ingest.js')

let pass = 0
const ok = (name) => { pass += 1; console.log('  ok', name) }

try {
  const unregister = registerBridgeAdapter({
    id: 'stub',
    configFile: () => cfg,
    parseConfig(j) {
      const bySession = new Map()
      for (const l of j.links) {
        bySession.set(l.sid, {
          kind: l.group ? 'group' : 'private',
          id: l.room,
          label: `${l.group ? '群' : '私聊'} ${l.room}`,
          addr: '',
          bridge: true,
        })
      }
      return { bySession, owner: { qq: j.owner.id, name: j.owner.name } }
    },
    splitSenders(text) {
      return String(text).split('\n').map((line) => {
        const m = line.match(/^\[([^\]]+)\]\(([^)]+)\):\s*(.*)$/)
        return m ? { nick: m[1], qq: m[2], text: m[3] } : { nick: '', qq: '', text: line }
      })
    },
  })

  resetSourceCache()
  await preloadSources()
  const src = await sourceOfSession('sess-x')
  assert.equal(src.kind, 'private')
  assert.equal(src.id, 'r-1')
  assert.equal(src.owner.qq, 'u-1')
  assert.equal(src.owner.name, '宿主')
  assert.equal((await sourceOfSession('sess-g')).kind, 'group')
  ok('换适配器后来源与拥有者照样解析')

  assert.deepEqual(splitSpeakers('[阿青](u-2): 在吗'), [
    { nick: '阿青', qq: 'u-2', text: '在吗' },
  ])
  ok('换适配器后发言人照样拆')

  unregister()
  assert.equal(bridgeAdapter(), qqBridgeAdapter)
  resetSourceCache()
  ok('注销后回到 QQ 桥')

  assert.deepEqual(splitSpeakers('老爹（123456789）：明天几点上班'), [
    { nick: '老爹', qq: '123456789', text: '明天几点上班' },
  ])
  // 群里多行续写仍算同一个人的话
  assert.deepEqual(splitSpeakers('老爹（123456789）：明天几点上班\n记得带伞\n阿青（987654321）：收到'), [
    { nick: '老爹', qq: '123456789', text: '明天几点上班\n记得带伞' },
    { nick: '阿青', qq: '987654321', text: '收到' },
  ])
  ok('默认 QQ 桥消息头与多行合并不变')

  console.log(`\n全部通过：${pass} 项`)
} catch (e) {
  console.error('\n失败：', e)
  process.exitCode = 1
} finally {
  await rm(root, { recursive: true, force: true }).catch(() => {})
}
