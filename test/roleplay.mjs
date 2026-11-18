/**
 * roleplay.mjs —— 酒馆预设会话不进记忆
 * 跑法：node test/roleplay.mjs
 *
 * 验的是：
 *   · 当前预设是酒馆预设时，用户/助手消息都不落 staging
 *   · 会话里切回标准预设后，同一条链路恢复采集
 *   · 投影服务不可用时，退回 header / 收到过的切换事件
 *   · 注册表之外的酒馆目录（agent.cordis.yml 带生成标记）也认
 */
import assert from 'node:assert'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const base = await mkdtemp(join(tmpdir(), 'whale-roleplay-'))
const home = join(base, 'home')
process.env.DSH_HOME = home
process.env.DSH_MEMORY_HOME = join(home, 'dsh-memory')
process.env.DSH_QQ_BRIDGE_CONFIG = join(base, 'no-such-bridge.json')

const { ensureDirs } = await import('../lib/store.js')
const { preloadSources, resetSourceCache } = await import('../lib/source.js')
const { registerIngest, flush, readStagingLines } = await import('../lib/ingest.js')
const { isRoleplayPreset, resetRoleplayCache } = await import('../lib/roleplay.js')

let pass = 0
const ok = (name) => { pass += 1; console.log('  ok', name) }

try {
  const presets = join(home, '.agent-presets')
  await mkdir(join(presets, 'tavern-lite'), { recursive: true })
  await writeFile(join(presets, 'tavern-lite', 'agent.cordis.yml'), '# 酒馆管理面板生成\n- id: persona\n', 'utf8')
  await writeFile(join(presets, 'presets.json'), JSON.stringify({
    presets: [
      { id: 'default', dir: 'tavern-lite', mode: 'roleplay' },
      { id: 'dev', dir: 'dev', mode: 'work' },
    ],
  }), 'utf8')
  await mkdir(join(presets, 'preset-extra'), { recursive: true })
  await writeFile(join(presets, 'preset-extra', 'agent.cordis.yml'), '# 酒馆管理面板生成\n', 'utf8')

  await ensureDirs(process.env.DSH_MEMORY_HOME)
  await preloadSources()
  resetRoleplayCache()
  assert.equal(isRoleplayPreset('tavern-lite'), true, '目录名应算酒馆预设')
  assert.equal(isRoleplayPreset('default'), true, '注册表 id 应算酒馆预设')
  assert.equal(isRoleplayPreset('preset-extra'), true, '带生成标记的目录应算酒馆预设')
  assert.equal(isRoleplayPreset('dev'), false, '非 roleplay 模式不算')
  assert.equal(isRoleplayPreset('standard'), false, '标准模式不算')
  ok('酒馆预设判定')

  // 换酒馆插件：预设 id 认不出来时，用显式清单或目录名兜底
  process.env.DSH_MEMORY_ROLEPLAY_PRESETS = 'my-rp-preset, 另一个酒馆'
  resetRoleplayCache()
  assert.equal(isRoleplayPreset('my-rp-preset'), true, '环境变量清单应生效')
  assert.equal(isRoleplayPreset('另一个酒馆'), true, '环境变量中文清单应生效')
  delete process.env.DSH_MEMORY_ROLEPLAY_PRESETS

  await mkdir(join(presets, 'roleplay-garden'), { recursive: true })
  await writeFile(join(process.env.DSH_MEMORY_HOME, 'settings.json'), JSON.stringify({
    roleplay_presets: ['odd-plugin-preset'],
  }), 'utf8')
  resetRoleplayCache()
  assert.equal(isRoleplayPreset('odd-plugin-preset'), true, 'settings.json 清单应生效')
  assert.equal(isRoleplayPreset('roleplay-garden'), true, '目录名带 roleplay 也应算')
  ok('换插件时的显式清单与名字兜底')

  const handlers = new Map()
  let projection = 'tavern-lite'
  let projectionOn = true
  const ctx = {
    on(ev, fn) { if (!handlers.has(ev)) handlers.set(ev, []); handlers.get(ev).push(fn); return () => {} },
    get(name) {
      if (!projectionOn) return undefined
      if (name === 'sessionProjections') return { stateOf: () => projection }
      if (name === 'sessions') return { get: (id) => ({ header: { id } }) }
      return undefined
    },
    logger: { info() {} },
  }
  registerIngest(ctx, { root: process.env.DSH_MEMORY_HOME, log: () => {} })

  const emit = (session, type, text) => {
    for (const fn of handlers.get('session/event') || []) {
      fn(session, { type, data: { content: [{ type: 'text', text }], source: { kind: 'user' } } })
    }
  }
  const switchTo = (sid, preset) => {
    for (const fn of handlers.get('session/event') || []) {
      fn({ header: { id: sid } }, { type: 'agent-preset/selected', data: { agentPreset: preset } })
    }
  }

  const sid = 'session-tavern-1'
  const s1 = { header: { id: sid, cwd: 'C:/work/demo' } }
  emit(s1, 'user/message', '我叫苏雪叶，住在一号楼')
  emit(s1, 'assistant/message', '她点点头：“记住了。”')
  await flush()
  assert.equal((await readStagingLines(process.env.DSH_MEMORY_HOME, sid)).length, 0, '酒馆会话不该落 staging')
  ok('酒馆预设会话不落 staging')

  // 切回标准：同一个会话立刻恢复采集
  switchTo(sid, 'standard')
  projection = 'standard'
  emit(s1, 'user/message', '明天继续修插件')
  await flush()
  assert.equal((await readStagingLines(process.env.DSH_MEMORY_HOME, sid)).length, 1, '切回标准后应恢复采集')
  ok('切回标准预设后恢复采集')

  // 投影服务缺失：退回 header 出生值
  projectionOn = false
  const sid2 = 'session-tavern-2'
  const s2 = { header: { id: sid2, cwd: 'C:/work/demo', agentPreset: 'tavern-lite' } }
  emit(s2, 'user/message', '这句应该被拦')
  await flush()
  assert.equal((await readStagingLines(process.env.DSH_MEMORY_HOME, sid2)).length, 0, 'header 判定没能拦住')
  ok('没有投影服务时按 header 拦')

  // 新会话 + 直接切到酒馆：事件先到，消息后到
  const sid3 = 'session-tavern-3'
  const s3 = { header: { id: sid3, cwd: 'C:/work/demo' } }
  switchTo(sid3, 'tavern-lite')
  emit(s3, 'user/message', '新的角色扮演')
  await flush()
  assert.equal((await readStagingLines(process.env.DSH_MEMORY_HOME, sid3)).length, 0, '切换事件没生效')
  ok('预设切换事件实时生效')
} finally {
  resetSourceCache()
  await rm(base, { recursive: true, force: true })
}

console.log(`roleplay: ${pass} 项通过`)
