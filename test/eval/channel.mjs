/**
 * channel.mjs —— DSH 通道与契约体检（对应文档 2.3 / 12.1）
 *
 * 只验「插件有没有把东西放对地方」，不验内容质量：
 *   · 常驻内容是否走 systemPrompt.section()，而不是 context()
 *   · 没有 section 能力的宿主里是否静默失效
 *   · 工具注册契约（parameters + output.schema + output.render）
 *   · 文档要求的工具名是否存在（read_memory / search_memory）
 *   · persona.md 是否超预算
 */

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  registerInjection, resetCaches, guardPromptText, startMemoryRefresh, setRelevance,
  PERSONA_SECTION, MEMORY_SECTION, PERSONA_ORDER, MEMORY_ORDER,
} from '../../lib/inject.js'
import { registerTools } from '../../lib/tools.js'
import { addItem, loadScope, saveScope } from '../../lib/store.js'
import { vaultPaths } from '../../lib/vault.js'
import { estimateTokens } from './harness.mjs'

const 文档工具 = ['search_memory', 'read_memory', 'memory_save']

function makeHost() {
  const handlers = new Map()
  const sections = []
  const logs = []
  let contextCalls = 0
  const ctx = {
    on(ev, fn) {
      if (!handlers.has(ev)) handlers.set(ev, [])
      handlers.get(ev).push(fn)
      return () => {}
    },
    logger: { info() {} },
  }
  const systemPrompt = {
    section(spec) { sections.push(spec) },
    context() {
      contextCalls += 1
      throw new Error('不该走 context()：minimal 会话下收不到任何内容且不报错')
    },
  }
  return { ctx, handlers, sections, systemPrompt, logs, contextCalls: () => contextCalls }
}

function fire(handlers, agent) {
  for (const fn of handlers.get('agent/created') || []) fn({ agent })
}

function agentOf(sid, systemPrompt) {
  return { session: { header: { id: sid } }, ctx: { systemPrompt } }
}

export async function runChannelChecks({ root, bridgeSid, scope, nonBridgeSid = 'local-web-session' }) {
  const out = []
  const add = (name, ok, detail = '', opts = {}) => out.push({ name, ok, detail, ...opts })
  const logOf = (h) => (...a) => h.logs.push(a.join(' '))

  // ── 1. 两个 section 都走 section()，并且 order 对 ──
  resetCaches()
  {
    const h = makeHost()
    const off = registerInjection(h.ctx, { root, log: logOf(h) })
    fire(h.handlers, agentOf(bridgeSid, h.systemPrompt))
    // 记忆段是异步渲染的（text() 只读缓存），等一次巡检周期再取值
    await new Promise((r) => setTimeout(r, 80))
    const names = h.sections.map((s) => s.name)
    add(
      '常驻内容走 section()',
      names.includes(PERSONA_SECTION) && names.includes(MEMORY_SECTION) && h.contextCalls() === 0,
      `sections=${names.join(',')} context 调用=${h.contextCalls()}`,
    )
    const persona = h.sections.find((s) => s.name === PERSONA_SECTION)
    const memory = h.sections.find((s) => s.name === MEMORY_SECTION)
    add(
      'section order = 8500/8550',
      persona?.order === PERSONA_ORDER && memory?.order === MEMORY_ORDER,
      `${persona?.order}/${memory?.order}`,
    )
    add(
      'order 落在工具说明之后、交付物之前',
      PERSONA_ORDER > 5000 && MEMORY_ORDER < 9000,
      `TOOLS_SDK=5000 < ${PERSONA_ORDER}/${MEMORY_ORDER} < DELIVERABLE=9000`,
    )
    add(
      'section 声明 interpolate:false（正文里的 {{ 不炸提示词）',
      persona?.interpolate === false && memory?.interpolate === false,
      `${persona?.interpolate}/${memory?.interpolate}`,
    )
    add(
      'section text 是函数（可刷新）',
      typeof persona?.text === 'function' && typeof memory?.text === 'function',
      `${typeof persona?.text}/${typeof memory?.text}`,
    )
    const a = String(memory?.text?.() ?? '')
    const b = String(memory?.text?.() ?? '')
    add('记忆段两次取值稳定（不抖动）', a === b, `${a.length} vs ${b.length} 字符`)
    off()
  }

  // ── 2. 非桥接会话：人格挂、记忆进本地分片 ──
  {
    const h = makeHost()
    const off = registerInjection(h.ctx, { root, log: logOf(h) })
    fire(h.handlers, agentOf(nonBridgeSid, h.systemPrompt))
    const names = h.sections.map((s) => s.name)
    add(
      '非桥接会话进本地分片',
      names.includes(MEMORY_SECTION) && names.includes(PERSONA_SECTION),
      `sections=${names.join(',') || '（空）'}`,
    )
    off()
  }

  // ── 3. persona.scope=bridge 时，本地会话不挂人格（记忆仍按本地开关） ──
  {
    const h = makeHost()
    const off = registerInjection(h.ctx, { root, log: logOf(h), persona: { scope: 'bridge' } })
    fire(h.handlers, agentOf(nonBridgeSid, h.systemPrompt))
    add(
      'persona.scope=bridge 只挂桥接',
      !h.sections.some((s) => s.name === PERSONA_SECTION),
      `sections=${h.sections.map((s) => s.name).join(',') || '（空）'}`,
    )
    fire(h.handlers, agentOf(bridgeSid, h.systemPrompt))
    add(
      '同上：桥接会话仍挂人格',
      h.sections.some((s) => s.name === PERSONA_SECTION),
      `sections=${h.sections.map((s) => s.name).join(',') || '（空）'}`,
    )
    off()
  }

  // ── 4. 宿主没有 systemPrompt.section 时，是否静默失效 ──
  {
    const h = makeHost()
    const off = registerInjection(h.ctx, { root, log: logOf(h) })
    fire(h.handlers, agentOf(bridgeSid, {}))
    const spoke = h.logs.join('\n')
    add(
      '宿主不支持 section 时有降级提示',
      /失败|降级|不可用/.test(spoke),
      spoke ? spoke.slice(-120) : '没有任何日志（静默失效）',
      { warn: true },
    )
    off()
  }

  // ── 5. 工具注册契约 + 文档要求的工具名 ──
  {
    const registered = []
    const ctx = {
      tools: { register(spec) { registered.push(spec); return () => {} } },
    }
    registerTools(ctx, { root, log: () => {} })
    const names = registered.map((t) => t.name)
    const bad = registered.filter(
      (t) => !t.parameters || !t.output?.schema || typeof t.output?.render !== 'function',
    )
    add(
      '工具注册契约（parameters + output.schema/render）',
      registered.length > 0 && bad.length === 0,
      bad.length ? `不合格：${bad.map((t) => t.name).join(',')}` : `${registered.length} 个工具`,
    )
    const missing = 文档工具.filter((n) => !names.includes(n))
    add(
      '文档要求的工具名齐备',
      missing.length === 0,
      missing.length ? `缺：${missing.join(',')}` : names.join(','),
      { pendingStage: 'stage5' },
    )
    add('工具名清单（记录）', true, names.join(','), { info: true })
  }

  // ── 6. 提示词插值护栏 ──
  {
    const raw = '你好 {{user}}，还有 {{ 空格 }}'
    const safe = guardPromptText(raw)
    add('guardPromptText 拆开 {{', !safe.includes('{{'), safe.slice(0, 60))
  }

  // ── 8. 人格按会话快照：mid-session 改文件不抖前缀 ──
  {
    const pr = join(root, '_channel_persona')
    await mkdir(pr, { recursive: true })
    const file = join(pr, 'persona.md')
    await writeFile(file, '人格A', 'utf8')
    resetCaches()
    const h1 = makeHost()
    const off1 = registerInjection(h1.ctx, { root: pr, log: logOf(h1) })
    fire(h1.handlers, agentOf(bridgeSid, h1.systemPrompt))
    const before = String(h1.sections.find((s) => s.name === PERSONA_SECTION)?.text?.() ?? '')

    await writeFile(file, '人格B', 'utf8')
    const same = String(h1.sections.find((s) => s.name === PERSONA_SECTION)?.text?.() ?? '')
    add('会话中途改 persona 不重算（缓存纪律）', before === '人格A' && same === '人格A', `${before} → ${same}`)
    off1()

    resetCaches()
    const h2 = makeHost()
    const off2 = registerInjection(h2.ctx, { root: pr, log: logOf(h2) })
    fire(h2.handlers, agentOf(bridgeSid, h2.systemPrompt))
    const next = String(h2.sections.find((s) => s.name === PERSONA_SECTION)?.text?.() ?? '')
    add('新会话读到新版 persona', next === '人格B', next)
    off2()
  }

  // ── 9. 记忆段：相关条目变化 / 30 秒巡检都不该立刻重画 ──
  if (scope) {
    resetCaches()
    const h = makeHost()
    const off = registerInjection(h.ctx, { root, log: logOf(h) })
    fire(h.handlers, agentOf(bridgeSid, h.systemPrompt))
    await new Promise((r) => setTimeout(r, 100))
    const mem = h.sections.find((s) => s.name === MEMORY_SECTION)
    const before = String(mem?.text?.() ?? '')

    add('L1 规矩段在注入里', before.includes('记忆使用规矩') && before.includes('search_memory') && before.includes('read_memory'), before.slice(0, 40))
    add('L2 骨架不塞正文', (before.match(/备忘/g) || []).length <= 10, `出现「备忘」${(before.match(/备忘/g) || []).length} 次（25 条里只露少量摘要）`)
    add('注入段 ≤1600 tok（L1 400 + L2 1200）', estimateTokens(before) <= 1600, `${estimateTokens(before)} tok / ${before.length} 字符`)

    const sc = await loadScope(root, scope.kind, scope.id)
    const ids = (sc.items || []).map((x) => x.id).reverse()
    setRelevance(root, bridgeSid, ids)
    await new Promise((r) => setTimeout(r, 100))
    add('命中条目变化不触发重画', String(mem?.text?.() ?? '') === before, `改写前后同为 ${before.length} 字符`)

    const refresh = startMemoryRefresh({ root, log: logOf(h), everyMs: 3600 * 1000 })
    await refresh.tick()
    add('缓存窗口内巡检不重画', String(mem?.text?.() ?? '') === before, `${String(mem?.text?.() ?? '').length} 字符`)

    // 删除必须立即生效，不能等窗口。挑最新一条：它一定在 topN 里，删了文本才会变。
    const liveItems = (sc.items || []).filter((x) => x.state !== 'archived' && x.state !== 'superseded')
    const victim = liveItems.at(-1)
    sc.items = (sc.items || []).filter((x) => x !== victim)
    await new Promise((r) => setTimeout(r, 20)) // 让 mtime 至少走一格
    await saveScope(root, sc)
    await refresh.tick()
    add('删除条目立即从注入里消失', String(mem?.text?.() ?? '') !== before, `删除 ${victim?.id ?? '—'}`)

    refresh.dispose()
    off()
  }

  // ── 9.5 主副库结构落在盘上 ──
  if (scope) {
    const p = vaultPaths(root, scope.kind, scope.id)
    const full = (await readdir(p.full).catch(() => [])).filter((n) => n.endsWith('.md'))
    const idx = await readFile(p.index, 'utf8').catch(() => '')
    const bytes = Buffer.byteLength(idx, 'utf8')
    add('分片目录：主库文件 + 派生副库', full.length > 0 && idx.includes('派生视图'), `${full.length} 个 md / 副库 ${bytes} 字节`)
    add('副库 ≤32KB', bytes > 0 && bytes <= 32 * 1024, `${bytes} 字节`)
    add('旧 JSON 不再作为运行时真源', !(await readdir(join(root, 'scopes')).catch(() => [])).includes(`${scope.kind}-${scope.id}.json`), `scopes/${scope.kind}-${scope.id}/`)
  }

  // ── 10. persona 预算 ──
  {
    let text = ''
    try { text = await readFile(join(root, 'persona.md'), 'utf8') } catch { /* 空库 */ }
    if (!text) {
      try { text = await readFile(new URL('../../persona.md', import.meta.url), 'utf8') } catch { /* ignore */ }
    }
    const tokens = estimateTokens(text)
    add(
      'persona ≤1200 tokens',
      tokens <= 1200,
      `${text.length} 字符 ≈ ${tokens} tokens`,
      { warn: true, pendingStage: 'stage6' },
    )
  }

  return out
}
