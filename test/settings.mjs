/**
 * settings.mjs —— 设置页的模型配置（落盘 + 接口）
 * 跑法：node test/settings.mjs
 *
 * 不联网：probeLlm 的 fetch 用桩函数，只看「通 / 401 / 地址错」分不分得清。
 * 重点验三条：
 *   · 文件配置优先于环境变量，保存后立刻生效（不吃 1 秒缓存）
 *   · GET 接口永远不回完整 key
 *   · 界面上 key 留空 = 不改，不能因为保存一次就把 key 抹掉
 */
import assert from 'node:assert'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = await mkdtemp(join(tmpdir(), 'whale-settings-'))
delete process.env.DSH_MEMORY_LLM_BASE
delete process.env.DSH_MEMORY_LLM_MODEL
delete process.env.DSH_MEMORY_LLM_KEY
delete process.env.DSH_MEMORY_SEARCH_BASE
delete process.env.DSH_MEMORY_SEARCH_MODEL
delete process.env.DSH_MEMORY_SEARCH_KEY
// 别读本机真实桥接配置：目标候选测试只关心结构
const bridgeStub = join(root, 'qq-bridge.json')
process.env.DSH_QQ_BRIDGE_CONFIG = bridgeStub
await writeFile(bridgeStub, JSON.stringify({
  试运行: false,
  绑定: [{ 类型: '私聊', 号码: '10001', 会话: 'session-owner', 称呼: '主人' }],
}), 'utf8')

const { loadSettings, saveSettings, maskKey, settingsPath } = await import('../lib/settings.js')
const { llmReady, searchReady, probeLlm, setConfigRoot, resetSettingsCache } = await import('../lib/llm.js')
const { ownerTarget } = await import('../lib/beat/delivery.js')
const { registerWebApi, API_PREFIX } = await import('../lib/webapi.js')

let pass = 0
const ok = (name) => { pass += 1; console.log('  ok', name) }

const jsonRes = (obj, status = 200) => ({
  ok: status < 400,
  status,
  text: async () => (typeof obj === 'string' ? obj : JSON.stringify(obj)),
})

try {
  // ---- 1. 打码 ----
  assert.equal(maskKey(''), '')
  assert.equal(maskKey('short'), '••••')
  assert.equal(maskKey('sk-abcdefgh1234'), 'sk-…1234')
  ok('key 只露头尾')

  // ---- 2. 读写往返 ----
  saveSettings(root, { llm: { base: 'http://a/v1', model: 'm1', key: 'sk-1234567890' } })
  const s = loadSettings(root)
  assert.equal(s.llm.model, 'm1')
  assert.ok((await readFile(settingsPath(root), 'utf8')).includes('sk-1234567890'))
  ok('settings.json 往返')

  // ---- 3. 文件配置生效，且优先于环境变量 ----
  setConfigRoot(root)
  assert.equal(llmReady(), true)
  process.env.DSH_MEMORY_LLM_BASE = 'http://env/v1'
  process.env.DSH_MEMORY_LLM_MODEL = 'env-model'
  resetSettingsCache()
  let seenUrl = ''
  await probeLlm({
    fetchImpl: async (url) => { seenUrl = url; return jsonRes({ choices: [{ message: { content: 'ok' } }] }) },
  })
  assert.ok(seenUrl.startsWith('http://a/v1/'), `文件配置该优先，实际请求 ${seenUrl}`)
  ok('文件配置优先于环境变量')

  // ---- 4. 环境变量兜底 ----
  saveSettings(root, {})
  resetSettingsCache()
  assert.equal(llmReady(), true, '文件清空后应回落到 env')
  const envProbe = await probeLlm({
    fetchImpl: async (url) => { seenUrl = url; return jsonRes({ choices: [{ message: { content: 'ok' } }] }) },
  })
  assert.equal(envProbe.ok, true, JSON.stringify(envProbe))
  assert.ok(seenUrl.startsWith('http://env/v1/'), seenUrl)
  delete process.env.DSH_MEMORY_LLM_BASE
  delete process.env.DSH_MEMORY_LLM_MODEL
  resetSettingsCache()
  assert.equal(llmReady(), false, '都没配就该是关的')
  ok('环境变量兜底 + 全空即关闭')

  // ---- 5. 探测把错误分清楚 ----
  saveSettings(root, { llm: { base: 'http://stub/v1', model: 'm', key: 'k' } })
  resetSettingsCache()

  const good = await probeLlm({ fetchImpl: async () => jsonRes({ choices: [{ message: { content: 'ok' } }] }) })
  assert.equal(good.ok, true, JSON.stringify(good))
  assert.equal(good.sample, 'ok')

  const denied = await probeLlm({ fetchImpl: async () => jsonRes({ error: 'invalid key' }, 401) })
  assert.equal(denied.ok, false)
  assert.ok(String(denied.why).includes('401'), denied.why)

  const html = await probeLlm({ fetchImpl: async () => jsonRes('<html>not api</html>') })
  assert.equal(html.ok, false)
  assert.ok(String(html.why).includes('/v1'), html.why)

  const down = await probeLlm({ fetchImpl: async () => { throw new Error('ECONNREFUSED') } })
  assert.equal(down.ok, false)
  assert.ok(String(down.why).includes('连不上'), down.why)
  ok('探测区分 401 / 地址错 / 连不上')

  // ---- 6. 接口：GET 不回明文 key ----
  const routes = new Map()
  const ctx = {
    webServer: {
      register({ path, handler }) {
        routes.set(path, handler)
        return () => routes.delete(path)
      },
    },
    // 宿主会话清单：投递目标不用桥接也能列出本机会话
    get(name) {
      if (name === 'sessions') return { list: () => [{ id: 'session-local-1' }] }
      if (name === 'sessionTitle') return { get: () => ({ title: '本机测试' }) }
      return undefined
    },
    logger: { info() {} },
  }
  registerWebApi(ctx, { root, log: () => {}, version: 'test' })

  const 调 = async (path, { method = 'GET', body } = {}) => {
    const handler = routes.get(API_PREFIX + path)
    assert.ok(handler, '路由没挂上：' + path)
    const req = new EventEmitter()
    req.method = method
    req.url = path
    req.destroy = () => {}
    const out = { statusCode: 200, body: null }
    const res = {
      setHeader() {},
      end(t) { out.body = t ? JSON.parse(t) : null },
      get statusCode() { return out.statusCode },
      set statusCode(v) { out.statusCode = v },
    }
    const p = handler(req, res)
    process.nextTick(() => {
      if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body)))
      req.emit('end')
    })
    await p
    return out
  }

  const got = await 调('/llm')
  assert.equal(got.statusCode, 200)
  assert.equal(got.body.base, 'http://stub/v1')
  assert.equal(got.body.hasKey, true)
  assert.ok(!JSON.stringify(got.body).includes('"k"'), 'GET 不能回完整 key')
  assert.equal(got.body.keyMasked, '••••')
  ok('GET /llm 只回打码')

  // ---- 7. 保存：key 留空不清旧 key ----
  const saved = await 调('/llm', { method: 'POST', body: { base: 'https://new.example/v1/', model: 'deepseek-chat', key: '' } })
  assert.equal(saved.body.ok, true)
  assert.equal(saved.body.base, 'https://new.example/v1', '末尾斜杠要收掉')
  assert.equal(saved.body.hasKey, true, '留空代表不改，旧 key 得留着')
  assert.equal(loadSettings(root).llm.key, 'k')

  // 显式清除
  const cleared = await 调('/llm', { method: 'POST', body: { base: 'https://new.example/v1', model: 'deepseek-chat', clearKey: true } })
  assert.equal(cleared.body.hasKey, false)
  assert.equal(loadSettings(root).llm.key, '')
  ok('保存：留空不改、显式才清')

  // 校验
  const badUrl = await 调('/llm', { method: 'POST', body: { base: 'ftp://x', model: 'm' } })
  assert.equal(badUrl.statusCode, 400)
  assert.equal(badUrl.body.ok, false)
  ok('端点只收 http(s)')

  // ---- 8. 模型探测：只读、key 沿用、上游失败 502 ----
  saveSettings(root, { llm: { base: 'https://probe.example/v1', model: 'old', key: 'secret-key' } })
  resetSettingsCache()
  const realFetch = globalThis.fetch
  const seen = []
  globalThis.fetch = async (url, opts = {}) => {
    seen.push({ url, method: opts.method, auth: opts.headers?.authorization })
    if (url.endsWith('/models')) return jsonRes({ data: [{ id: 'a/ok' }, { id: 'b/no' }] })
    const m = JSON.parse(opts.body).model
    return m === 'a/ok'
      ? jsonRes({ choices: [{ message: { content: 'ok' } }] })
      : jsonRes({ error: { message: 'no provider' } }, 400)
  }
  try {
    const probe = await 调('/llm/models', { method: 'POST', body: { base: '', key: '' } })
    assert.equal(probe.statusCode, 200)
    assert.equal(probe.body.ok, true)
    assert.equal(probe.body.base, 'https://probe.example/v1')
    assert.equal(probe.body.counts.usable, 1)
    assert.equal(probe.body.counts.unusable, 1)
    assert.equal(seen[0].url, 'https://probe.example/v1/models')
    assert.equal(seen[0].method, 'GET')
    assert.equal(seen[0].auth, 'Bearer secret-key', 'key 留空要沿用已保存的')
    assert.equal(loadSettings(root).llm.model, 'old', '探测不能改配置')
  } finally {
    globalThis.fetch = realFetch
  }

  const wrongMethod = await 调('/llm/models', { method: 'GET' })
  assert.equal(wrongMethod.statusCode, 405)

  globalThis.fetch = async () => jsonRes({ error: { message: 'bad key' } }, 401)
  try {
    const fail = await 调('/llm/models', { method: 'POST', body: { base: 'https://probe.example/v1', key: 'x' } })
    assert.equal(fail.statusCode, 502)
    assert.equal(fail.body.ok, false)
  } finally {
    globalThis.fetch = realFetch
  }
  ok('模型探测：只读、key 沿用、上游失败 502')

  // ---- 8.5 闲聊搜索模型：独立一段，不覆盖蒸馏 ----
  const searchSaved = await 调('/llm/search', {
    method: 'POST',
    body: { base: 'https://search.example/v1/', model: 'net-model', key: 'sk-search-1234' },
  })
  assert.equal(searchSaved.statusCode, 200)
  assert.equal(searchSaved.body.kind, 'search')
  assert.equal(searchSaved.body.base, 'https://search.example/v1')
  assert.equal(searchSaved.body.ready, true)
  assert.equal(loadSettings(root).search.model, 'net-model')
  assert.equal(loadSettings(root).llm.base, 'https://probe.example/v1', '不能把蒸馏段覆盖掉')
  assert.equal(searchReady(), true)

  const searchGot = await 调('/llm/search')
  assert.equal(searchGot.statusCode, 200)
  assert.ok(!JSON.stringify(searchGot.body).includes('sk-search-1234'), 'GET 不能回完整 key')

  const seenSearch = []
  globalThis.fetch = async (url, opts = {}) => {
    seenSearch.push({ url, method: opts.method, auth: opts.headers?.authorization })
    if (url.endsWith('/models')) return jsonRes({ data: [{ id: 'net-model' }] })
    return jsonRes({ choices: [{ message: { content: 'ok' } }] })
  }
  try {
    const st = await 调('/llm/search/test', { method: 'POST' })
    assert.equal(st.body.ok, true, JSON.stringify(st.body))
    const sm = await 调('/llm/search/models', { method: 'POST', body: { base: '', key: '' } })
    assert.equal(sm.statusCode, 200)
    assert.equal(sm.body.counts.usable, 1)
    const listCall = seenSearch.find((x) => x.url.endsWith('/models'))
    assert.ok(listCall, '要真的拉一次 /models')
    assert.equal(listCall.url, 'https://search.example/v1/models')
    assert.equal(listCall.auth, 'Bearer sk-search-1234')
    assert.equal(loadSettings(root).llm.model, 'old', '探测搜索模型不能改蒸馏配置')
  } finally {
    globalThis.fetch = realFetch
  }
  ok('闲聊搜索模型独立保存，可探测/测试，不串蒸馏')

  // ---- 8.6 投递目标绑定 ----
  assert.equal(ownerTarget({}).ok, false, '没绑定就不投')
  assert.equal(ownerTarget({}).why, 'no-target')
  assert.equal(ownerTarget({ targetSessionId: 'session-pinned' }).sessionId, 'session-pinned', '绑定优先')
  const targetSaved = await 调('/beat/config', {
    method: 'POST',
    body: { targetSessionId: 'session-pinned', targetSessionLabel: '私聊 · 测试', targetSessionKind: 'private' },
  })
  assert.equal(targetSaved.statusCode, 200)
  assert.equal(targetSaved.body.config.targetSessionId, 'session-pinned')
  assert.equal(targetSaved.body.target.pinned, true)
  assert.equal(targetSaved.body.target.sessionId, 'session-pinned')
  assert.equal(targetSaved.body.target.label, '私聊 · 测试')

  const targets = await 调('/beat/targets')
  assert.equal(targets.statusCode, 200)
  assert.equal(targets.body.ok, true)
  assert.ok(Array.isArray(targets.body.items))
  assert.ok(targets.body.items.some((x) => x.id === 'session-owner'), '桥接绑定表要出现在候选里')
  assert.ok(targets.body.items.some((x) => x.id === 'session-local-1'), '宿主里的全部会话都要能选')
  assert.ok(targets.body.items.some((x) => x.label === '本机 · 本机测试'), '有标题就用标题')
  assert.equal(targets.body.current.sessionId, 'session-pinned')

  const targetCleared = await 调('/beat/config', { method: 'POST', body: { targetSessionId: '' } })
  assert.equal(targetCleared.body.config.targetSessionId, '')
  assert.equal(targetCleared.body.target.pinned, false)
  assert.equal(targetCleared.body.target.sessionId, '', '清空后不再回退桥接')
  ok('主动聊天会话可绑定、可清空，不再依赖桥接默认')

  // ---- 9. 主动行为层设置 ----
  const beat0 = await 调('/beat')
  assert.equal(beat0.statusCode, 200)
  assert.equal(beat0.body.ok, true)
  assert.ok(Array.isArray(beat0.body.config.windows), '默认配置要带 windows')

  const beatSaved = await 调('/beat/config', {
    method: 'POST',
    body: {
      dryRun: false,
      windows: '11:00-15:00, 17:00-21:00',
      quietHours: '01:00-08:00',
      minIntervalHours: '5',
      interests: '城市生活、独立游戏',
      maxWanderPerDay: '3',
    },
  })
  assert.equal(beatSaved.statusCode, 200)
  assert.equal(beatSaved.body.config.dryRun, false)
  assert.equal(beatSaved.body.config.windows.length, 2)
  assert.equal(beatSaved.body.config.quietHours.start, '01:00')
  assert.equal(beatSaved.body.config.minIntervalHours, 5)
  assert.deepEqual(beatSaved.body.config.interests, ['城市生活', '独立游戏'])
  assert.equal(beatSaved.body.config.maxWanderPerDay, 3)

  const badWindow = await 调('/beat/config', { method: 'POST', body: { windows: '11点-15点' } })
  assert.equal(badWindow.statusCode, 400)
  assert.equal(badWindow.body.ok, false)
  ok('beat 设置：时间窗 / 兴趣 / 数字都归一化')

  const focused = await 调('/beat/focus', { method: 'POST', body: { minutes: 30 } })
  assert.equal(focused.body.ok, true)
  assert.ok(Date.parse(focused.body.focusUntil) > Date.now())
  const beatFocused = await 调('/beat')
  assert.equal(beatFocused.body.state.focusUntil, focused.body.focusUntil, '专注时间不能被 loadState 丢掉')
  const unfocused = await 调('/beat/focus', { method: 'POST', body: { off: true } })
  assert.equal(unfocused.body.focusUntil, '')
  ok('beat 专注模式可开可关，且能落盘读回')

  console.log(`\n全部通过：${pass} 项`)
} catch (e) {
  console.error('\n失败：', e)
  process.exitCode = 1
} finally {
  delete process.env.DSH_MEMORY_LLM_BASE
  delete process.env.DSH_MEMORY_LLM_MODEL
  delete process.env.DSH_MEMORY_LLM_KEY
  delete process.env.DSH_MEMORY_SEARCH_BASE
  delete process.env.DSH_MEMORY_SEARCH_MODEL
  delete process.env.DSH_MEMORY_SEARCH_KEY
  delete process.env.DSH_QQ_BRIDGE_CONFIG
  await rm(root, { recursive: true, force: true }).catch(() => {})
}
