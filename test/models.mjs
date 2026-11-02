/**
 * models.mjs —— 模型探测（listChatModels）
 *
 * 只测纯函数，不打网络：假 fetch 按 URL 分发，
 * 覆盖可用 / 非对话模型 / 限流重试 / key 失效 / 超时 / 截断。
 */

import assert from 'node:assert'
import { listChatModels } from '../lib/llm.js'

let pass = 0
const ok = (name) => { pass += 1; console.log('  ok', name) }

const BASE = 'https://example.test/v1'
const json = (body, status = 200) => ({ status, body })

/** 带并发统计的假 fetch；handler 返回 { status, body }。 */
function stubFetch(handler, stats = { inFlight: 0, max: 0, calls: [] }) {
  const impl = async (url, opts = {}) => {
    stats.inFlight += 1
    stats.max = Math.max(stats.max, stats.inFlight)
    stats.calls.push({ url, method: opts.method, headers: opts.headers, body: opts.body ? JSON.parse(opts.body) : null })
    try {
      await new Promise((r) => setTimeout(r, 5))
      const r = await handler(url, opts)
      return {
        ok: r.status < 400,
        status: r.status,
        text: async () => (typeof r.body === 'string' ? r.body : JSON.stringify(r.body)),
      }
    } finally {
      stats.inFlight -= 1
    }
  }
  impl.stats = stats
  return impl
}

// 探测函数里的超时 timer 都 unref 了；测试进程要保持一个活跃 handle，
// 否则事件循环空转，超时根本等不到。
const keepAlive = setInterval(() => {}, 500)

try {
  // 1. 正常：一个可用、一个非对话、一个 429 后重试成功
  {
    let hit = 0
    const fetchImpl = stubFetch((url, opts) => {
      if (url.endsWith('/models')) return json({ data: [{ id: 'a/ok' }, { id: 'b/image' }, { id: 'c/retry' }] })
      const model = JSON.parse(opts.body).model
      if (model === 'a/ok') return json({ choices: [{ message: { content: 'ok' } }] })
      if (model === 'b/image') return json({ error: { message: 'not a chat model' } }, 400)
      hit += 1
      return hit === 1 ? json({ error: { message: 'busy' } }, 429) : json({ choices: [{ message: { content: 'ok' } }] })
    })
    const r = await listChatModels({ base: BASE + '/', key: 'k', fetchImpl, timeoutMs: 200 })
    assert.equal(r.ok, true)
    assert.deepEqual(r.models.map((m) => m.state), ['ok', 'unusable', 'ok'])
    assert.equal(r.counts.usable, 2)
    assert.equal(r.counts.unusable, 1)
    assert.equal(r.truncated, false)
    const modelsCall = fetchImpl.stats.calls.find((c) => c.url.endsWith('/models'))
    assert.equal(modelsCall.method, 'GET')
    assert.equal(modelsCall.headers.authorization, 'Bearer k')
    assert.equal(fetchImpl.stats.calls[1].url, BASE + '/chat/completions')
    ok('可用 / 非对话 / 429 重试成功 归类正确')
  }

  // 2. 两次 429 → limited，不判死
  {
    const fetchImpl = stubFetch((url, opts) => {
      if (url.endsWith('/models')) return json({ models: [{ id: 'busy/one' }] })
      return json({ error: { message: 'busy' } }, 429)
    })
    const r = await listChatModels({ base: BASE, fetchImpl, timeoutMs: 200 })
    assert.equal(r.models[0].state, 'limited')
    assert.equal(r.counts.limited, 1)
    ok('连续 429 归为限流')
  }

  // 3. 401 只标单条，不影响后面的模型
  {
    const fetchImpl = stubFetch((url) => {
      if (url.endsWith('/models')) return json({ data: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] })
      return json({ error: { message: 'bad key' } }, 401)
    })
    const r = await listChatModels({ base: BASE, key: 'bad', fetchImpl, timeoutMs: 200, concurrency: 1 })
    assert.equal(r.models[0].state, 'auth')
    assert.equal(r.counts.auth, 3)
    assert.equal(fetchImpl.stats.calls.filter((c) => c.url.endsWith('/chat/completions')).length, 3)
    ok('401 不连累其它模型')
  }

  // 3b. 403 只影响单个模型（ModelScope 常见：单个模型没开通）
  {
    const fetchImpl = stubFetch((url, opts) => {
      if (url.endsWith('/models')) return json({ data: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] })
      const model = JSON.parse(opts.body).model
      if (model === 'a') return json({ error: { message: 'no access' } }, 403)
      return json({ choices: [{ message: { content: 'ok' } }] })
    })
    const r = await listChatModels({ base: BASE, fetchImpl, timeoutMs: 200, concurrency: 1 })
    assert.equal(r.models[0].state, 'denied')
    assert.equal(r.counts.denied, 1)
    assert.equal(r.counts.usable, 2)
    assert.equal(fetchImpl.stats.calls.filter((c) => c.url.endsWith('/chat/completions')).length, 3)
    ok('403 只影响单个模型')
  }

  // 4. 超时（两次都超时）
  {
    const fetchImpl = async (url, opts = {}) => {
      if (url.endsWith('/models')) return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ id: 'slow' }] }) }
      return new Promise((resolve, reject) => {
        opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
      })
    }
    const r = await listChatModels({ base: BASE, fetchImpl, timeoutMs: 30 })
    assert.equal(r.models[0].state, 'timeout')
    ok('超时归为 timeout（含一次重试）')
  }

  // 5. 网络错误
  {
    const fetchImpl = async (url) => {
      if (url.endsWith('/models')) return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ id: 'x' }] }) }
      throw new Error('ECONNREFUSED')
    }
    const r = await listChatModels({ base: BASE, fetchImpl, timeoutMs: 100 })
    assert.equal(r.models[0].state, 'error')
    assert.match(r.models[0].why, /ECONNREFUSED/)
    ok('网络错误归为 error')
  }

  // 6. /models 不支持 → 整批失败，提示手填
  {
    const fetchImpl = stubFetch(() => json({ error: { message: 'not found' } }, 404))
    const r = await listChatModels({ base: BASE, fetchImpl, timeoutMs: 100 })
    assert.equal(r.ok, false)
    assert.equal(r.status, 404)
    assert.match(r.why, /手填/)
    ok('/models 不可用时给出手填退路')
  }

  // 7. 并发上限
  {
    const ids = Array.from({ length: 30 }, (_, i) => ({ id: `m/${i}` }))
    const fetchImpl = stubFetch((url) => {
      if (url.endsWith('/models')) return json({ data: ids })
      return json({ choices: [{ message: { content: 'ok' } }] })
    })
    const r = await listChatModels({ base: BASE, fetchImpl, timeoutMs: 200, concurrency: 6 })
    assert.equal(r.counts.usable, 30)
    assert.ok(fetchImpl.stats.max <= 6, `并发峰值 ${fetchImpl.stats.max} 超过 6`)
    ok('并发池不超上限')
  }

  // 8. 超过 40 个截断
  {
    const ids = Array.from({ length: 45 }, (_, i) => ({ id: `m/${i}` }))
    const fetchImpl = stubFetch((url) => {
      if (url.endsWith('/models')) return json({ data: ids })
      return json({ choices: [{ message: { content: 'ok' } }] })
    })
    const r = await listChatModels({ base: BASE, fetchImpl, timeoutMs: 200, concurrency: 6 })
    assert.equal(r.models.length, 40)
    assert.equal(r.truncated, true)
    ok('超过 40 个截断并标记')
  }

  // 9. 空端点直接拒绝，不发请求
  {
    let called = false
    const r = await listChatModels({ base: '  ', fetchImpl: async () => { called = true } })
    assert.equal(r.ok, false)
    assert.equal(called, false)
    ok('空端点不请求')
  }

  console.log(`\n全部通过：${pass} 项`)
} catch (e) {
  console.error('\n失败：', e)
  process.exitCode = 1
} finally {
  clearInterval(keepAlive)
}
