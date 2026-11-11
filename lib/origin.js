/**
 * origin.js —— 记忆的原文指针与按需追溯
 *
 * 条目里只存坐标 `{ sessionId, msgIndex, seq?, hash, at? }`，不存原文：
 *   · hash 是清洗后那句话的短指纹，原话换行/标点/全半角不影响
 *   · msgIndex 是导入时的事件下标；实时链路拿不到，就留 -1，靠 hash 找
 *   · seq 是会话事件自带的序号，能对上时优先
 *
 * 追溯时才去 `$DSH_HOME/sessions/` 找会话文件（.jsonl / .jsonl.zstd），
 * 解压后按 hash 定位，取前后几句一起返回。密钥类内容在读取时重新打码，
 * 不会因为翻旧账把当年贴的 key 又带出来。
 *
 * 可选原文缓存：DSH 会清理旧会话。打开 DSH_MEMORY_ORIGIN_CACHE=1 后，
 * 每次成功追溯会把「已经打过码的上下文」缓存到 `origin-cache/`，
 * 默认保留 30 天、总量上限 32MB（DSH_MEMORY_ORIGIN_CACHE_DAYS /
 * DSH_MEMORY_ORIGIN_CACHE_MB 可调）。缓存是副本，不是记忆本体。
 */

import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'
import { zstdDecompressSync } from 'node:zlib'

import { normalizeText, similarity } from './store.js'
import {
  textOf, stripSystemBlocks, isMetaMessage, isBridgeScaffold,
  stripBridgeNote, stripBridgeMarks, splitSpeakers, META_SOURCE_KINDS,
} from './ingest.js'
import { redactText } from './redact.js'

const MAX_SESSION_BYTES = 64 * 1024 * 1024
const CACHE_DIR = 'origin-cache'
const CACHE_DAYS = 30
const CACHE_MB = 32

/** 会话文件目录；DSH_MEMORY_SESSIONS_DIR 方便测试和迁移。 */
export function sessionsDir() {
  if (process.env.DSH_MEMORY_SESSIONS_DIR) return process.env.DSH_MEMORY_SESSIONS_DIR
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'sessions')
}

/** 短指纹：归一化后取 SHA-1 前 12 位。只用于定位，不可还原原文。 */
export function hashText(text) {
  const n = normalizeText(text)
  if (!n) return ''
  return createHash('sha1').update(n).digest('hex').slice(0, 12)
}

/** 组装并瘦身原文指针；缺会话号或指纹就算没有。 */
export function originOf(text, { sessionId = '', msgIndex = -1, seq = -1, at = '' } = {}) {
  const sid = String(sessionId ?? '').trim().slice(0, 128)
  const hash = hashText(text)
  if (!sid || !hash) return null
  const ptr = {
    sessionId: sid,
    msgIndex: Number.isInteger(msgIndex) && msgIndex >= 0 ? msgIndex : -1,
    hash,
  }
  if (Number.isInteger(seq) && seq >= 0) ptr.seq = seq
  if (at) ptr.at = String(at)
  return ptr
}

/** staging 行 / 导入消息 → 指针。 */
export function originFromMessage(m, sessionId = '') {
  if (!m?.text) return null
  return originOf(m.text, {
    sessionId,
    msgIndex: Number.isInteger(m.eventIndex) ? m.eventIndex : -1,
    seq: Number.isInteger(m.seq) ? m.seq : -1,
    at: m.at || '',
  })
}

const SESSION_FILE_RE = /^session(?:\.v4)?\.jsonl(?:\.zstd)?$/

async function pickSessionFile(dir) {
  let ents = []
  try { ents = await readdir(dir, { withFileTypes: true }) } catch { return '' }
  for (const n of ['session.v4.jsonl.zstd', 'session.v4.jsonl', 'session.jsonl.zstd', 'session.jsonl']) {
    if (ents.some((e) => e.isFile() && e.name === n)) return join(dir, n)
  }
  const any = ents.find((e) => e.isFile() && SESSION_FILE_RE.test(e.name))
  return any ? join(dir, any.name) : ''
}

/**
 * 找会话文件。目录名可能是 `<uuid>` 或 `session-<uuid>`，两种都认；
 * 先按目录名直查，找不到再有限深度扫一遍（DSH 版本之间目录层级变过）。
 */
export async function findSessionFile(sessionId, dir = sessionsDir()) {
  const sid = String(sessionId ?? '').trim()
  if (!sid) return ''
  const bare = sid.replace(/^session-/, '')
  const names = new Set([sid, bare, `session-${bare}`])
  const top = await readdir(dir, { withFileTypes: true }).catch(() => null)
  if (!top) return ''

  const direct = []
  const queue = []
  for (const ent of top) {
    if (!ent.isDirectory()) continue
    if (names.has(ent.name)) direct.push(join(dir, ent.name))
    else queue.push({ path: join(dir, ent.name), depth: 1 })
  }
  for (const d of direct) {
    const f = await pickSessionFile(d)
    if (f) return f
  }
  while (queue.length) {
    const cur = queue.shift()
    if (cur.depth > 4) continue
    let ents = []
    try { ents = await readdir(cur.path, { withFileTypes: true }) } catch { continue }
    for (const ent of ents) {
      if (!ent.isDirectory()) continue
      const p = join(cur.path, ent.name)
      if (names.has(ent.name)) {
        const f = await pickSessionFile(p)
        if (f) return f
      }
      // 只往下走看起来像会话容器的目录，别把整个 attachments 树扫穿
      if (/^(session-)?[0-9a-f-]{8,}$/i.test(ent.name) || cur.depth < 2) {
        queue.push({ path: p, depth: cur.depth + 1 })
      }
    }
  }
  return ''
}

async function readSessionEvents(file, { maxBytes = MAX_SESSION_BYTES } = {}) {
  const st = await stat(file)
  if (st.size > maxBytes) throw new Error(`会话文件超过 ${Math.round(maxBytes / 1024 / 1024)}MB`)
  const buf = await readFile(file)
  let raw = ''
  if (file.endsWith('.zstd')) {
    if (typeof zstdDecompressSync !== 'function') throw new Error('当前 Node 不支持 zstd 解压')
    raw = zstdDecompressSync(buf).toString('utf8')
  } else {
    raw = buf.toString('utf8')
  }
  const out = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try { out.push(JSON.parse(line)) } catch { /* 坏行跳过 */ }
  }
  return out
}

/** 与采集链路同一套清洗：剥脚手架、拆发言人、打码。 */
function cleanUserSegments(raw) {
  const text = String(raw ?? '')
  if (!text.trim() || isMetaMessage(text)) return []
  const body = stripSystemBlocks(text)
  if (!body.trim()) return []
  const out = []
  for (const sp of splitSpeakers(stripBridgeNote(body))) {
    if (isMetaMessage(sp.text) || isBridgeScaffold(sp.text)) continue
    const clean = redactText(stripBridgeMarks(sp.text)).trim().slice(0, 2000)
    if (clean) out.push({ text: clean, speaker: sp.nick })
  }
  return out
}

function eventText(ev) {
  if (ev?.type === 'user/message') {
    const kind = String(ev?.data?.source?.kind ?? '')
    if (kind && META_SOURCE_KINDS.has(kind)) return []
    const raw = textOf(ev?.data?.content ?? ev?.data?.message?.content ?? '')
    return cleanUserSegments(raw).map((x) => ({ ...x, role: 'user' }))
  }
  if (ev?.type === 'assistant/message') {
    const raw = textOf(ev?.data?.content ?? ev?.data?.message?.content ?? '')
    const text = redactText(raw).trim().slice(0, 2000)
    return text ? [{ text, speaker: '她', role: 'her' }] : []
  }
  return []
}

function eventTime(ev) {
  const t = Number(ev?.time)
  return Number.isFinite(t) && t > 0 ? t : 0
}

function fmtTime(ms) {
  const t = Number(ms)
  if (!Number.isFinite(t) || t <= 0) return ''
  const d = new Date(t)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function pickClosest(list, at) {
  if (list.length <= 1) return list[0] || null
  const t = Date.parse(String(at || ''))
  if (!Number.isFinite(t)) return list[0]
  let best = list[0]
  let gap = Infinity
  for (const x of list) {
    const d = Math.abs(eventTime(x.ev) - t)
    if (d < gap) { gap = d; best = x }
  }
  return best
}

/** 在会话事件里定位原句。hash 优先，其次 seq / 事件下标，最后才用原话模糊匹配。 */
export function locateOrigin(events, item) {
  const ptr = item?.origin || {}
  const quote = String(item?.sourceQuote || '').trim()
  const want = String(ptr.hash || '')
  const all = []
  for (let i = 0; i < (events || []).length; i += 1) {
    for (const seg of eventText(events[i])) {
      if (seg.role !== 'user') continue
      all.push({ i, ev: events[i], ...seg })
    }
  }
  if (!all.length) return null

  if (want) {
    const hits = all.filter((x) => hashText(x.text) === want)
    if (hits.length) return { ...pickClosest(hits, ptr.at), how: 'hash' }
  }
  if (Number.isInteger(ptr.seq) && ptr.seq >= 0) {
    const hit = all.find((x) => Number(x.ev?.seq) === ptr.seq)
    if (hit) return { ...hit, how: 'seq' }
  }
  if (Number.isInteger(ptr.msgIndex) && ptr.msgIndex >= 0) {
    const hit = all.find((x) => x.i === ptr.msgIndex)
    if (hit) return { ...hit, how: 'index' }
  }
  if (quote) {
    // memory_save 的原话经常只是用户那句里的片段：归一化后整段包含就算找到
    const nq = normalizeText(quote)
    if (nq.length >= 4) {
      const hits = all.filter((x) => normalizeText(x.text).includes(nq))
      if (hits.length) return { ...pickClosest(hits, ptr.at), how: 'quote-contains' }
    }
    let best = null
    let score = 0
    for (const x of all) {
      const s = similarity(x.text, quote)
      if (s > score) { score = s; best = x }
    }
    if (best && score >= 0.55) return { ...best, how: 'quote' }
  }
  return null
}

/** 取命中事件前后几句，命中那句打 ★。 */
export function renderOriginContext(events, hit, { maxChars = 2400, sessionId = '' } = {}) {
  const lines = []
  const before = []
  for (let i = hit.i - 1; i >= 0 && before.length < 4; i -= 1) {
    const segs = eventText(events[i])
    if (!segs.length) continue
    before.unshift({ i, segs })
  }
  const after = []
  for (let i = hit.i + 1; i < events.length && after.length < 3; i += 1) {
    const segs = eventText(events[i])
    if (!segs.length) continue
    after.push({ i, segs })
  }
  const rows = [...before, { i: hit.i, segs: eventText(events[hit.i]) }, ...after]
  for (const row of rows) {
    for (const seg of row.segs) {
      const mark = row.i === hit.i && seg.text === hit.text ? '★ ' : '  '
      const who = seg.role === 'her' ? '她' : (seg.speaker || '对方')
      const at = fmtTime(eventTime(events[row.i]))
      const text = seg.text.length > 240 ? `${seg.text.slice(0, 240)}…` : seg.text
      lines.push(`${mark}${at ? `[${at}] ` : ''}${who}：${text}`)
    }
  }
  const body = lines.join('\n')
  const time = fmtTime(eventTime(hit.ev))
  const header = [
    `原文${time ? ` · ${time}` : ''}${sessionId ? ` · 会话 ${sessionId}` : ''}`,
    '按原话指纹定位，密钥类内容已重新打码',
    '',
  ].join('\n')
  const full = header + body
  return full.length > maxChars ? `${full.slice(0, maxChars)}\n…（已截断）` : full
}

// ---- 可选原文缓存 ----

export function originCacheOptions() {
  const enabled = /^(?:1|true|on|yes)$/i.test(String(process.env.DSH_MEMORY_ORIGIN_CACHE || ''))
  const days = Number(process.env.DSH_MEMORY_ORIGIN_CACHE_DAYS)
  const mb = Number(process.env.DSH_MEMORY_ORIGIN_CACHE_MB)
  return {
    enabled,
    days: Number.isFinite(days) && days > 0 ? days : CACHE_DAYS,
    bytes: (Number.isFinite(mb) && mb > 0 ? mb : CACHE_MB) * 1024 * 1024,
  }
}

function cacheDir(root) {
  return join(root || '.', CACHE_DIR)
}

function cacheFile(root, ptr) {
  const key = String(ptr?.hash || '').replace(/[^a-z0-9]/gi, '')
  return key ? join(cacheDir(root), `${key}.json`) : ''
}

/** 成功追溯后把打码上下文存一份；只留最近 N 天，超总量按最旧删。 */
export async function writeOriginCache(root, ptr, excerpt, { now = Date.now() } = {}) {
  const opt = originCacheOptions()
  if (!opt.enabled || !ptr?.hash || !excerpt) return false
  const file = cacheFile(root, ptr)
  if (!file) return false
  await mkdir(cacheDir(root), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify({
    hash: ptr.hash,
    sessionId: ptr.sessionId || '',
    at: ptr.at || '',
    savedAt: new Date(now).toISOString(),
    excerpt,
  }), 'utf8')
  await rename(tmp, file)
  await pruneOriginCache(root, { ...opt, now }).catch(() => {})
  return true
}

export async function readOriginCache(root, ptr, { now = Date.now() } = {}) {
  const opt = originCacheOptions()
  if (!opt.enabled || !ptr?.hash) return ''
  const file = cacheFile(root, ptr)
  if (!file) return ''
  try {
    const o = JSON.parse(await readFile(file, 'utf8'))
    const saved = Date.parse(o?.savedAt || '') || 0
    if (!saved || now - saved > opt.days * 86400000) return ''
    return String(o.excerpt || '')
  } catch {
    return ''
  }
}

export async function pruneOriginCache(root, opt = originCacheOptions(), { now = Date.now() } = {}) {
  const dir = cacheDir(root)
  let ents = []
  try { ents = await readdir(dir, { withFileTypes: true }) } catch { return 0 }
  const rows = []
  for (const e of ents) {
    if (!e.isFile() || !e.name.endsWith('.json')) continue
    const file = join(dir, e.name)
    try {
      const st = await stat(file)
      if (now - st.mtimeMs > opt.days * 86400000) {
        await unlink(file).catch(() => {})
        continue
      }
      rows.push({ file, size: st.size, mtime: st.mtimeMs })
    } catch { /* 并发删除 */ }
  }
  let total = rows.reduce((n, x) => n + x.size, 0)
  if (total <= opt.bytes) return 0
  rows.sort((a, b) => a.mtime - b.mtime)
  let removed = 0
  for (const row of rows) {
    if (total <= opt.bytes) break
    await unlink(row.file).catch(() => {})
    total -= row.size
    removed += 1
  }
  return removed
}

function fallbackText(item, note) {
  const quote = String(item?.sourceQuote || '').trim()
  if (quote) return `${note}\n\n写入这条时保存的原话：\n${quote}`
  return `${note}\n记忆本身还在，只是原始会话找不回来了。`
}

/**
 * 读一条记忆的原文上下文。
 * @returns {Promise<{found:boolean, cached?:boolean, text:string}>}
 */
export async function readOrigin(root, item, {
  sessionsDir: dir = sessionsDir(), maxChars = 2400, maxBytes = MAX_SESSION_BYTES,
} = {}) {
  const ptr = item?.origin
  if (!ptr?.sessionId) {
    return { found: false, text: fallbackText(item, '这条记忆没有原文指针（旧版本写入的）。') }
  }
  let file = ''
  try { file = await findSessionFile(ptr.sessionId, dir) } catch { /* 找不到按缺失处理 */ }
  if (file) {
    try {
      const events = await readSessionEvents(file, { maxBytes })
      const hit = locateOrigin(events, item)
      if (hit) {
        const text = renderOriginContext(events, hit, { maxChars, sessionId: ptr.sessionId })
        await writeOriginCache(root, ptr, text).catch(() => {})
        return { found: true, cached: false, text }
      }
      const cached = await readOriginCache(root, ptr).catch(() => '')
      if (cached) return { found: true, cached: true, text: `原会话里没对上这句，以下来自原文缓存。\n\n${cached}` }
      return { found: false, text: fallbackText(item, `原会话（${ptr.sessionId}）还在，但里面没找到这句话；可能被宿主压缩/改写过了。`) }
    } catch (err) {
      const cached = await readOriginCache(root, ptr).catch(() => '')
      if (cached) return { found: true, cached: true, text: `原会话读不了（${String(err?.message ?? err).slice(0, 60)}），以下来自原文缓存。\n\n${cached}` }
      return { found: false, text: fallbackText(item, `原会话读不了：${String(err?.message ?? err).slice(0, 80)}`) }
    }
  }

  const cached = await readOriginCache(root, ptr).catch(() => '')
  if (cached) {
    return { found: true, cached: true, text: `原会话已不在，以下来自 ${originCacheOptions().days} 天内的原文缓存。\n\n${cached}` }
  }
  return { found: false, text: fallbackText(item, `原会话（${ptr.sessionId}）已经不在了，可能被 DSH 清理或还没落盘完。`) }
}
