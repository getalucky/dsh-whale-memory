/**
 * apply.mjs —— 用假 ctx 跑一遍插件入口，验证不会抛
 * 跑法：node test/apply.mjs
 */
import assert from 'node:assert'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = await mkdtemp(join(tmpdir(), 'whale-apply-'))
await writeFile(join(root, 'persona.md'), '你是「大肥鱼」。', 'utf8')

const { apply, name, VERSION } = await import('../lib/index.js')

const handlers = {}
const tools = []
const sections = []

const ctx = {
  on(ev, fn) {
    ;(handlers[ev] ||= []).push(fn)
    return () => {}
  },
  tools: {
    register(spec) {
      tools.push(spec)
      return () => {}
    },
  },
  logger: { info() {}, warn() {}, error() {} },
}

const app = apply(ctx, { root })
await new Promise((r) => setTimeout(r, 800))

console.log('name:', name, VERSION)
console.log('tools:', tools.map((t) => t.name).join(', '))
assert.ok(tools.length >= 6, `应注册至少 6 个工具，实际 ${tools.length}`)
for (const name of ['search_memory', 'read_memory', 'memory_save', 'memory_recall']) {
  assert.ok(tools.some((t) => t.name === name), `缺工具 ${name}`)
}
for (const t of tools) {
  assert.ok(t.output?.schema, `${t.name} 缺 output.schema`)
  assert.equal(typeof t.output?.render, 'function', `${t.name} 缺 output.render`)
}

// 模拟一次 agent 创建（桥接会话）——有真实绑定就用真实 sessionId
import { readFileSync, readdirSync } from 'node:fs'
const neutralCwd = join(tmpdir(), 'whale-apply-cwd')
let realSid = 'session-fake-bridge'
const cfgPath = process.env.DSH_QQ_BRIDGE_CONFIG
  || (process.env.DSH_HOME ? join(process.env.DSH_HOME, 'qq-bridge-config.json') : '')
try {
  if (!cfgPath) throw new Error('no config')
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'))
  const first = (cfg.绑定 || [])[0]
  if (first?.会话) realSid = String(first.会话)
} catch { /* 用假 id，下面会跳过 */ }

handlers['agent/created']?.[0]?.({
  agent: {
    session: { header: { id: realSid, cwd: neutralCwd } },
    ctx: { systemPrompt: { section(s) { sections.push(s) } } },
  },
})
await new Promise((r) => setTimeout(r, 400))
console.log('sections:', sections.map((s) => `${s.name}@${s.order}`).join(', '))

// 非桥接会话：人格 + 记忆都挂（本地会话归 local:dsh）
const before = sections.length
handlers['agent/created']?.[0]?.({
  agent: {
    session: { header: { id: 'session-not-bound-xyz', cwd: neutralCwd } },
    ctx: { systemPrompt: { section(s) { sections.push(s) } } },
  },
})
await new Promise((r) => setTimeout(r, 200))
const local = sections.slice(before)
assert.equal(local.length, 2, `非桥接会话应该挂人格 + 记忆两段，实际 ${local.length}`)
assert.equal(local[0].name, 'whale:persona', '非桥接会话第一段不是人格段')
assert.equal(local[1].name, 'whale:memory', '非桥接会话第二段不是记忆段')
assert.ok(String(local[1].text()).includes('记忆使用规矩'), '本地记忆段没注入规矩段')

assert.ok(sections.some((s) => s.name === 'whale:persona'), '人格段没挂上')
assert.ok(sections.some((s) => s.name === 'whale:memory'), '记忆段没挂上')

// section text 要能同步求值
for (const s of sections) {
  const v = s.text()
  assert.equal(typeof v, 'string', `${s.name} 的 text() 没返回字符串`)
}

// 模拟一条消息进来（session/event：两个参数，session 与 event）
// 宿主会挨个通知所有监听器；这里也只喂采集那一个会漏（注入先注册）。
for (const fn of handlers['session/event'] ?? []) {
  fn(
    { header: { id: realSid } },
    { type: 'user/message', data: { content: [{ type: 'text', text: '小鱼（123456）：记住，我下周三出差' }] } },
  )
}
await new Promise((r) => setTimeout(r, 300))

// staging 应该出现这个会话的文件
const stDir = join(root, 'staging')
const stFiles = readdirSync(stDir).filter((n) => n.endsWith('.jsonl'))
console.log('staging:', stFiles.join(', ') || '(空)')
assert.ok(stFiles.length >= 1, '消息没有落进 staging')
const stText = readFileSync(join(stDir, stFiles[0]), 'utf8')
assert.ok(stText.includes('下周三出差'), 'staging 内容不对')
console.log('staging 内容 ok')

app.dispose()
await rm(root, { recursive: true, force: true }).catch(() => {})
console.log('\napply 自检通过')