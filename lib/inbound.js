/**
 * inbound.js —— 外部记忆入库的统一接口
 *
 * 背景：记忆不该只有「对话里蒸馏」一个来源。B站值班（bili-pond）跑在 headless
 * profile 里，那个 profile 不装本插件，但它的观察值得进库；以后别的插件也会有
 * 自己的账本、日志、抓取结果。以前每接一个就改一次这里，路径/字段/目标全写死。
 *
 * 现在分成两层：
 *   引擎（本文件）：按字节水位读新增行 → 解析 → 去重 → 落分片 → 记审计。
 *   适配器（如 inbound-bili.js）：只描述「账本在哪、一行怎么翻译成条目」。
 *
 * 两种接入方式，按插件能不能 import 本包来选：
 *
 * 1) 零代码（跨进程/跨 profile 首选）——往投递箱写 JSONL：
 *      $DSH_HOME/memory-inbox/<来源>.jsonl      （DSH_MEMORY_INBOX 可改目录）
 *    一行一条，字段：
 *      text    必填，条目正文
 *      quote   可选，原文摘录/为什么记（给 sourceQuote）
 *      refs    可选，字符串或字符串数组
 *      at      可选，观测时间（"2026-11-02 13:35" 或 ISO）
 *      kind    可选，fact / pref / event / relation（缺省 fact）
 *      conf    可选，0.1–1（缺省 0.5）
 *      source  可选，来源标记（缺省用文件名）
 *    文件名就是来源标识，进库后能在审计里按来源查。
 *    投递方不需要知道插件存在，升级/换版本都不会丢同步。
 *
 * 2) 写代码（同进程、需要自定义解析）——注册 provider：
 *      import { registerInboundProvider } from 'dsh-whale-memory/inbound'
 *      const off = registerInboundProvider({ id, files(), parse(row, ctx), ... })
 *    规格见文件末尾的 registerInboundProvider 注释；dispose 可注销。
 *
 * 设计约束（都是踩过的）：
 *   - 拉，不推：对方只管写自己的账本，同步失败不影响对方。
 *   - 幂等：字节水位挡旧行；state 里另存最近 500 条正文 hash，
 *     账本被截断/替换时水位归零，靠 hash 不重复入库。
 *   - 半行不入库：最后一行没换行 = 还没写完，等下一轮。
 *   - 写入和工具/蒸馏同锁：读 → 改 → 重建索引整段在锁里，
 *     只 updateScope 再锁外 reindex 会把并发期间的新条目挪进 archive。
 */

import { createHash } from 'node:crypto'
import { readdirSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, extname, join } from 'node:path'
import { addItem, auditWrite, enforceCapacity, loadScope, withWriteLock, writeAtomic } from './store.js'
import { reindexScope } from './maintain.js'
import { biliDiaryProvider, biliProvider } from './inbound-bili.js'

export { ledgerFile, stateFile } from './inbound-bili.js'

export const KEEP_KEYS = 500
export const EVERY_MS = 5 * 60 * 1000
export const INBOX_DIR = 'memory-inbox'
export const DEFAULT_TARGET = { kind: 'local', id: 'dsh' }

const BASE_KINDS = new Set(['fact', 'pref', 'event', 'relation'])
const providers = new Map()

function dshHome() {
  return String(process.env.DSH_HOME || join(homedir(), '.dsh')).replace(/\\/g, '/').replace(/\/+$/, '')
}

/** 投递箱目录。外部插件只需要知道这一个路径。 */
export function inboxDir() {
  return String(process.env.DSH_MEMORY_INBOX || '').trim() || join(dshHome(), INBOX_DIR)
}

/** 总开关：DSH_MEMORY_INBOUND=off 会停掉所有 provider。 */
export function inboundEnabled() {
  const v = String(process.env.DSH_MEMORY_INBOUND ?? 'on').toLowerCase()
  return !(v === 'off' || v === '0' || v === 'false')
}

/** "2026-11-02 13:35" → ISO。已经是 ISO 的原样用，别二次换时区。 */
export function toIso(s) {
  const t = String(s ?? '').trim()
  if (!t) return ''
  // 带时区的 ISO 直接认：adapter 可能已经转过一次了
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/.test(t)) {
    const d = new Date(t)
    return Number.isFinite(d.getTime()) ? d.toISOString() : ''
  }
  const m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?/)
  if (!m) return ''
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] || 0), Number(m[5] || 0))
  return Number.isFinite(d.getTime()) ? d.toISOString() : ''
}

function keyOf(text) {
  return createHash('sha1').update(text).digest('hex').slice(0, 16)
}

function safeToken(s) {
  const t = String(s ?? '').replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '')
  return t.slice(0, 60) || 'default'
}

function clampConf(v, fallback) {
  const n = Number(v)
  return Number.isFinite(n) ? Math.max(0.1, Math.min(1, n)) : fallback
}

function refsOf(v) {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean)
  const s = String(v ?? '').trim()
  return s ? [s] : []
}

/** 默认状态文件：一个 provider 一个文件；多账本时带上 token 区分。 */
function statePathOf(root, provider, token) {
  if (typeof provider.statePath === 'function') return provider.statePath(root, token)
  const name = token ? `inbound-${provider.id}-${safeToken(token)}` : `inbound-${provider.id}`
  return join(root, 'inbox', `${name}.json`)
}

/** 把 files() 的几种写法（字符串 / 单对象 / 数组）统一成 [{file, token}]。 */
function normalizeFiles(provider) {
  let out
  try {
    out = typeof provider.files === 'function' ? provider.files() : provider.file
  } catch {
    return []
  }
  if (!out) return []
  const list = Array.isArray(out) ? out : [out]
  return list
    .map((x) => (typeof x === 'string' ? { file: x, token: '' } : x))
    .filter((x) => x && x.file)
    .map((x) => ({ file: String(x.file), token: String(x.token ?? '') }))
}

async function loadState(file) {
  try {
    const o = JSON.parse(await readFile(file, 'utf8'))
    if (!o || typeof o !== 'object') throw new Error('bad')
    return {
      offset: Number(o.offset) || 0,
      keys: Array.isArray(o.keys) ? o.keys.map(String) : [],
      at: String(o.at || ''),
    }
  } catch {
    return { offset: 0, keys: [], at: '' }
  }
}

async function saveState(file, state) {
  const body = JSON.stringify({
    offset: state.offset,
    keys: state.keys.slice(-KEEP_KEYS),
    at: new Date().toISOString(),
  }, null, 2)
  await mkdir(dirname(file), { recursive: true }).catch(() => {})
  await writeAtomic(file, body).catch(() => {})
}

/**
 * 把 provider 返回的一行翻译成通用条目。
 * 坏行返回 null；不抛错，免得一行脏数据卡住整个账本。
 */
function canonicalOf(provider, row, fallbackSource) {
  let item
  try {
    item = provider.parse ? provider.parse(row, { toIso }) : defaultParse(row)
  } catch {
    return null
  }
  if (!item || typeof item !== 'object') return null
  const text = String(item.text ?? '').trim()
  if (!text) return null
  const d = provider.defaults ?? {}
  return {
    text,
    quote: String(item.quote ?? '').trim(),
    refs: refsOf(item.refs),
    at: toIso(item.at),
    kind: BASE_KINDS.has(item.kind) ? item.kind : (d.kind ?? 'fact'),
    conf: clampConf(item.conf, d.conf ?? 0.5),
    source: String(item.source ?? d.source ?? fallbackSource ?? provider.id),
    state: d.state ?? 'active',
  }
}

/** 投递箱的默认解析：认 text 字段，不猜别名。 */
function defaultParse(row) {
  if (!row || typeof row !== 'object') return null
  return {
    text: row.text,
    quote: row.quote,
    refs: row.refs,
    at: row.at ?? row.observedAt,
    kind: row.kind,
    conf: row.conf,
    source: row.source,
  }
}

/**
 * 扫一个文件，把水位之后的新行写进目标分片。
 * 返回 { ok, added, merged, bad, skipped?, why? }。
 */
async function syncFile(root, provider, file, token, log) {
  let raw
  try {
    raw = await readFile(file)
  } catch {
    return { ok: true, added: 0, skipped: provider.missing || 'no-file', file }
  }

  const stateFile = statePathOf(root, provider, token)
  const state = await loadState(stateFile)
  // 账本变短 = 被重写/截断，水位作废，从头读（靠 keys 兜住重复）
  let offset = state.offset > raw.length ? 0 : state.offset
  if (offset === raw.length) return { ok: true, added: 0, file }

  const tail = raw.subarray(offset)
  const cut = tail.lastIndexOf(0x0a)
  // 没有换行 = 最后一行的写入还没完成，等下一轮，别入库半条
  if (cut < 0) return { ok: true, added: 0, why: 'partial-line', file }

  const chunk = tail.subarray(0, cut + 1).toString('utf8')
  const nextOffset = offset + cut + 1
  const seen = new Set(state.keys)
  const rows = []
  let bad = 0
  // 投递箱用文件名当来源；自定义 provider 默认用自己的 id
  const fallbackSource = provider.sourceFromToken ? token : provider.id

  for (const line of chunk.split('\n')) {
    if (!line.trim()) continue
    let o
    try {
      o = JSON.parse(line)
    } catch {
      bad += 1
      continue
    }
    const item = canonicalOf(provider, o, fallbackSource)
    if (!item) {
      bad += 1
      continue
    }
    const key = keyOf(item.text)
    if (seen.has(key)) continue
    seen.add(key)
    rows.push(item)
  }

  if (!rows.length) {
    await saveState(stateFile, { offset: nextOffset, keys: [...seen] })
    return { ok: true, added: 0, bad, file }
  }

  // 一个文件对应一个目标分片，由 provider 决定写哪片
  const target = provider.target ?? DEFAULT_TARGET
  let added = 0
  let merged = 0
  await withWriteLock(async () => {
    const sc = await loadScope(root, target.kind, target.id)
    const before = sc.items.length
    for (const item of rows) {
      addItem(sc, {
        text: item.text,
        kind: item.kind,
        conf: item.conf,
        source: item.source,
        sourceQuote: item.quote,
        refs: item.refs,
        observedAt: item.at,
        state: item.state,
      })
    }
    added = sc.items.length - before
    merged = rows.length - added
    await enforceCapacity(root, sc).catch(() => 0)
    await reindexScope(root, sc).catch(() => {})
    return sc
  })
  await saveState(stateFile, { offset: nextOffset, keys: [...seen] })
  await auditWrite(root, {
    kind: 'inbound',
    source: provider.id,
    scope: `${target.kind}:${target.id}`,
    file: basename(file),
    added,
    merged,
    bad,
  }).catch(() => {})

  if (added || merged) {
    log(`[whale] ${provider.label ?? provider.id} 入库 +${added}${merged ? ` · 合并 ${merged}` : ''}${bad ? ` · 跳过坏行 ${bad}` : ''}`)
  }
  return { ok: true, added, merged, bad, file }
}

/** 跑一个 provider 的所有账本，汇总结果。 */
export async function syncProvider(root, provider, { log = () => {} } = {}) {
  if (typeof provider.enabled === 'function' && !provider.enabled()) {
    return { ok: true, added: 0, skipped: 'off' }
  }
  // 不是「追加行」的来源（比如一天一篇、当天覆盖写的日记）自己实现 sync()，
  // 引擎只负责调度和汇总；返回形状与 files 路线一致即可。
  if (typeof provider.sync === 'function') {
    let r
    try {
      r = await provider.sync(root, { log })
    } catch (e) {
      log?.(`[whale] ${provider.label ?? provider.id} 同步失败 ${String(e?.message ?? e).slice(0, 160)}`)
      return { ok: false, added: 0, why: String(e?.message ?? e) }
    }
    const out = r && typeof r === 'object' ? r : {}
    return {
      ok: out.ok !== false,
      added: out.added || 0,
      merged: out.merged || 0,
      bad: out.bad || 0,
      ...out,
    }
  }
  const files = normalizeFiles(provider)
  if (!files.length) return { ok: true, added: 0, skipped: provider.missing || 'no-file' }

  let added = 0
  let merged = 0
  let bad = 0
  const results = []
  for (const { file, token } of files) {
    let r
    try {
      r = await syncFile(root, provider, file, token, log)
    } catch (e) {
      log?.(`[whale] ${provider.label ?? provider.id} 同步失败 ${String(e?.message ?? e).slice(0, 160)}`)
      r = { ok: false, added: 0, why: String(e?.message ?? e), file }
    }
    results.push(r)
    added += r.added || 0
    merged += r.merged || 0
    bad += r.bad || 0
  }
  const last = results[results.length - 1] ?? {}
  return {
    ok: results.every((r) => r.ok !== false),
    added,
    merged,
    bad,
    // 单文件时把 skipped/why 透出去，兼容老的 syncBiliLedger 返回形状
    ...(files.length === 1 && last.skipped ? { skipped: last.skipped } : {}),
    ...(files.length === 1 && last.why ? { why: last.why } : {}),
    files: results,
  }
}

/**
 * 跑一轮入库。不传 id 就跑全部 provider。
 * 单个 provider 失败只记日志，不拖垮其他的。
 */
export async function syncInbound(root, { log = () => {}, id = '' } = {}) {
  if (!inboundEnabled()) return { ok: true, added: 0, skipped: 'off', providers: [] }

  const list = id
    ? [providers.get(id)].filter(Boolean)
    : [...providers.values()]

  let added = 0
  let merged = 0
  let bad = 0
  const detail = []
  for (const p of list) {
    const r = await syncProvider(root, p, { log })
    added += r.added || 0
    merged += r.merged || 0
    bad += r.bad || 0
    detail.push({ id: p.id, ...r })
  }
  return { ok: detail.every((d) => d.ok !== false), added, merged, bad, providers: detail }
}

/**
 * 注册一个 provider。返回注销函数（只注销自己，不误删后来者）。
 *
 * 规格：
 *   id        必填，来源标识；写进条目 source、审计和状态文件名
 *   label    可选，日志里显示的名字
 *   enabled  可选，() => boolean；返回 false 时这一路跳过（skipped: 'off'）
 *   files    与 sync 二选一：() => 字符串 | {file, token} | 数组；token 用于区分同一 provider 的多个账本
 *   parse    可选，(row, { toIso }) => { text, quote?, refs?, at?, kind?, conf?, source? } | null
 *            缺省按投递箱格式解析（只认 text）；返回 null = 这行不要
 *   sync     与 files 二选一：(root, { log }) => { ok?, added?, merged?, bad? }
 *            不是追加行的来源（一天一篇、覆盖写）自己实现同步；给了 sync 就不走水位
 *   target   可选，{ kind, id }，缺省 local:dsh
 *   defaults 可选，{ kind, conf, source, state }
 *   statePath 可选，(root, token) => 水位文件路径；缺省 <root>/inbox/inbound-<id>.json
 *   missing  可选，账本不存在时的 skipped 值，缺省 'no-file'
 */
export function registerInboundProvider(provider) {
  if (!provider || typeof provider.id !== 'string' || !provider.id.trim()) {
    throw new Error('inbound provider 需要 id')
  }
  if (typeof provider.files !== 'function' && typeof provider.sync !== 'function') {
    throw new Error(`inbound provider ${provider.id} 需要 files() 或 sync()`)
  }
  const id = provider.id.trim()
  const prev = providers.get(id)
  const registered = { ...provider, id }
  providers.set(id, registered)
  return function unregister() {
    // 只撤销自己这一次注册；期间被别人覆盖了就别乱删
    if (providers.get(id) !== registered) return
    if (prev) providers.set(id, prev)
    else providers.delete(id)
  }
}

/** 当前注册的 provider id 列表（界面/日志用）。 */
export function listInboundProviders() {
  return [...providers.values()].map((p) => ({ id: p.id, label: p.label ?? p.id }))
}

/**
 * 投递箱：$DSH_HOME/memory-inbox/<来源>.jsonl。
 * 每次 tick 重新枚举目录，新增文件下一轮自动接上，不用重启。
 */
function inboxFiles() {
  try {
    return readdirSync(inboxDir(), { withFileTypes: true })
      .filter((d) => d.isFile() && extname(d.name).toLowerCase() === '.jsonl')
      .map((d) => ({
        file: join(inboxDir(), d.name),
        token: basename(d.name, extname(d.name)),
      }))
  } catch {
    return []
  }
}

/** 投递箱的 provider：文件名即来源，解析用默认格式。 */
function makeInboxProvider() {
  return {
    id: 'inbox',
    label: '投递箱',
    files: inboxFiles,
    sourceFromToken: true,
    defaults: { kind: 'fact', conf: 0.5 },
  }
}

// 注册内置 provider：投递箱 + B站账本 + B站值班日记（保持老行为）
registerInboundProvider(makeInboxProvider())
registerInboundProvider(biliProvider())
registerInboundProvider(biliDiaryProvider())

/**
 * 兼容旧入口：只跑 B站这一路。老代码/测试还在用这个名字。
 * 新代码用 syncInbound。
 */
export async function syncBiliLedger(root, { log = () => {}, target = undefined } = {}) {
  const p = target ? biliProvider({ target }) : biliProvider()
  return syncProvider(root, p, { log })
}

/**
 * 启动时扫一次 + 每 5 分钟一次。tick 不重入。
 */
export function startInboundLoop({ root, log, everyMs = EVERY_MS } = {}) {
  let timer = null
  let busy = false

  const tick = async () => {
    if (busy) return { ok: false, why: 'busy' }
    busy = true
    try {
      return await syncInbound(root, { log })
    } catch (e) {
      log?.(`[whale] 外部入库失败 ${String(e?.message ?? e).slice(0, 160)}`)
      return { ok: false, why: String(e?.message ?? e) }
    } finally {
      busy = false
    }
  }

  // 先跑一次：刚开机就把上次积压的补上，别等 5 分钟。
  // 延 3 秒是为了避开 boot 末尾的图谱重建（两边都会整份写 meta）。
  const first = setTimeout(tick, 3000)
  first.unref?.()
  timer = setInterval(tick, everyMs)
  timer.unref?.()

  return {
    dispose() {
      if (first) clearTimeout(first)
      if (timer) clearInterval(timer)
      timer = null
    },
    tick,
  }
}
