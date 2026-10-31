/**
 * harness.mjs —— 无宿主评测夹具（阶段 0）
 *
 * 目标：不启动 DSH，也能把「采集 → 蒸馏 → 落盘 → 召回 → 注入渲染」整条链路
 * 按真实入口跑一遍。所有用例共用一份临时记忆库，但每个用例一个独立分片
 * （private-900000xx），互不污染，召回指标也不会串味。
 *
 * 关键点：
 *   · 走 registerIngest + distillSession，而不是直接 addItem —— 那样测不到过滤和脱敏
 *   · 强制关掉 LLM / 向量环境变量，基线必须是可复现的规则版
 *   · 桥接绑定表写进临时目录，用 DSH_QQ_BRIDGE_CONFIG 指过去，不碰真实配置
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ensureDirs, loadScope, normalizeText, similarity } from '../../lib/store.js'
import { registerIngest, flush, readStagingLines } from '../../lib/ingest.js'
import { distillSession } from '../../lib/distill.js'
import { renderMemory, RENDER_OPTS } from '../../lib/inject.js'
import { renderMemorySection } from '../../lib/skeleton.js'
import { searchFunnel } from '../../lib/funnel.js'
import { preloadSources } from '../../lib/source.js'

/** 估算 token：中日韩字符 ≈ 1，其他字符 ≈ 1/3.5。只用于预算趋势，不当精确计费。 */
export function estimateTokens(text) {
  const t = String(text ?? '')
  const cjk = (t.match(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) || []).length
  return Math.ceil(cjk + (t.length - cjk) / 3.5)
}

/** 片段命中：归一化包含优先，再用 bigram 相似度兜底。 */
export function textHit(haystack, needle) {
  const a = normalizeText(haystack)
  const b = normalizeText(needle)
  if (!a || !b) return false
  if (a.includes(b) || b.includes(a)) return true
  return similarity(haystack, needle) >= 0.62
}

/** 条目里任意一条命中片段。 */
export function itemsHit(items, needle) {
  return (items || []).some((it) => textHit(it.text, needle))
}

export async function createHarness(cases) {
  // 评测固定跑「规则蒸馏 + 词法召回」：环境里有端点也不能让基线漂
  for (const k of [
    'DSH_MEMORY_LLM_BASE', 'DSH_MEMORY_LLM_MODEL', 'DSH_MEMORY_LLM_KEY',
    'DSH_MEMORY_EMBED_BASE', 'DSH_MEMORY_EMBED_MODEL', 'DSH_MEMORY_EMBED_KEY',
  ]) delete process.env[k]

  const base = await mkdtemp(join(tmpdir(), 'whale-eval-'))
  const root = join(base, 'memory')
  await ensureDirs(root)
  process.env.DSH_MEMORY_HOME = root

  const bindings = []
  const src = new Map()
  cases.forEach((c, i) => {
    const sid = `eval-${String(i + 1).padStart(2, '0')}-${c.id}`
    const num = String(90000000 + i)
    const kind = c.kind === 'group' ? 'group' : 'private'
    const label = kind === 'group' ? `群 ${num}` : `私聊 ${num}`
    bindings.push({
      会话: sid,
      类型: kind === 'group' ? '群聊' : '私聊',
      号码: num,
      称呼: c.label ?? label,
    })
    src.set(c.id, { sid, kind, id: num, label, addr: '' })
  })

  const cfgFile = join(base, 'qq-bridge-config.json')
  await writeFile(cfgFile, JSON.stringify({ 绑定: bindings }, null, 2), 'utf8')
  process.env.DSH_QQ_BRIDGE_CONFIG = cfgFile
  await preloadSources()

  const handlers = new Map()
  const ctx = {
    on(ev, fn) {
      if (!handlers.has(ev)) handlers.set(ev, [])
      handlers.get(ev).push(fn)
      return () => {
        const list = handlers.get(ev) || []
        const i = list.indexOf(fn)
        if (i >= 0) list.splice(i, 1)
      }
    },
    logger: { info() {} },
  }
  registerIngest(ctx, { root, log: () => {} })

  const noop = () => {}

  /** 喂一条用户消息（走真实采集链路）。 */
  async function say(caseId, text) {
    const s = src.get(caseId)
    if (!s) throw new Error(`unknown case ${caseId}`)
    const ev = { type: 'user/message', data: { content: text } }
    for (const fn of handlers.get('session/event') || []) {
      fn({ header: { id: s.sid } }, ev)
    }
    await flush()
  }

  /** 把用例的 turns 全喂进去。 */
  async function feed(c) {
    for (const t of c.turns || []) await say(c.id, t)
  }

  /** 模拟非消息类会话事件（如 compaction/end）。 */
  async function emit(caseId, type, data = {}) {
    const s = src.get(caseId)
    if (!s) throw new Error(`unknown case ${caseId}`)
    for (const fn of handlers.get('session/event') || []) fn({ header: { id: s.sid } }, { type, data })
    await flush()
  }

  /** 蒸馏这个用例的 staging。 */
  async function distill(c) {
    const s = src.get(c.id)
    return distillSession(root, s.sid, { log: noop })
  }

  async function scopeOf(caseId) {
    const s = src.get(caseId)
    return loadScope(root, s.kind, s.id)
  }

  async function itemsOf(caseId) {
    const sc = await scopeOf(caseId)
    return sc.items || []
  }

  async function stagingOf(caseId) {
    const s = src.get(caseId)
    return readStagingLines(root, s.sid)
  }

  /** 和 search_memory 同一条检索路径（副库漏斗 + 一跳标签）。 */
  async function search(caseId, query, { hops = true } = {}) {
    const sc = await scopeOf(caseId)
    const rows = searchFunnel([sc], { query, hops, topK: 8 })
    // 评测按摘要匹配就够：用例的 expect 都是短片段
    return rows.map((r) => ({ item: { ...r, text: r.summary }, score: r.score }))
  }

  /** 和 system prompt 记忆段同一条渲染路径（规矩段 + 骨架）。 */
  async function render(caseId) {
    const sc = await scopeOf(caseId)
    return renderMemorySection(sc, { version: 'eval', maxChars: 1000 })
  }

  async function dispose() {
    await rm(base, { recursive: true, force: true }).catch(() => {})
  }

  return {
    base, root, src, cfgFile,
    say, feed, emit, distill, scopeOf, itemsOf, stagingOf, search, render, dispose,
  }
}

/** 读一份 JSON（报告比较用）。 */
export async function readJson(file, fallback = null) {
  try { return JSON.parse(await readFile(file, 'utf8')) } catch { return fallback }
}
