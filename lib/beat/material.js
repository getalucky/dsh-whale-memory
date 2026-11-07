/**
 * beat/material.js —— 素材库
 *
 * 素材不是记忆条目：它不参与画像、人格与 search_memory 的默认召回。
 * 用独立 JSON 文件（beat/material/index.json）而不是分片 vault——vault 的
 * frontmatter 只序列化记忆字段，会丢掉 refs/focus/ttlDays/deliveryIds。
 *
 * 一条素材三种来源：public（公共池近期）/ web（兴趣搜索）/ chat（会话素材）。
 * 所有写入先校验来源，再查重、限容、打分，最后原子落盘。
 */

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { appendJsonl, normalizeText, readJson, similarity, writeAtomic } from '../store.js'
import { ensureBeatDirs, materialDir } from './config.js'

const SOURCES = new Set(['public', 'web', 'chat'])
const MAX_TEXT = 200
const ACTIVE_STATES = new Set(['active'])
const USED_STATES = new Set(['used'])
const DEAD_STATES = new Set(['retired'])

// 旧版把投递包/闲逛提示词当会话素材收进来过；这类脚手架永远不该被投出去。
const SCAFFOLD_TEXT = /(你在帮「大肥鱼」找|【素材投递|material_report|可选素材[：:]|这是记忆插件的主动投递|\[mat_[a-z0-9]+\])/i

export function looksLikeScaffold(text) {
  return SCAFFOLD_TEXT.test(String(text ?? ''))
}

let seq = 0
let writeChain = Promise.resolve()

/** 素材库是小 JSON，全进程串行写；三个 distill worker 并发进来也不会互相覆盖。 */
function withMaterialLock(fn) {
  const run = writeChain.catch(() => {}).then(fn)
  writeChain = run.then(() => undefined, () => undefined)
  return run
}

export function materialIndexPath(root) {
  return join(materialDir(root), 'index.json')
}

export function materialArchivePath(root) {
  return join(materialDir(root), 'archive.jsonl')
}

export function newMaterialId() {
  seq = (seq + 1) % 10000
  return `mat_${Date.now().toString(36)}${seq.toString(36).padStart(2, '0')}`
}

export function sourceKind(source) {
  return String(source ?? '').split(':')[0].trim().toLowerCase()
}

function emptyDb() {
  return { schema: 1, updatedAt: '', items: [] }
}

export async function loadMaterial(root) {
  const db = await readJson(materialIndexPath(root), null)
  if (!db || !Array.isArray(db.items)) return emptyDb()
  return { schema: 1, updatedAt: db.updatedAt || '', items: db.items }
}

export async function saveMaterial(root, db) {
  await ensureBeatDirs(root)
  db.updatedAt = new Date().toISOString()
  await writeAtomic(materialIndexPath(root), JSON.stringify(db, null, 2))
  return db
}

function asRefs(v) {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean)
  const s = String(v ?? '').trim()
  return s ? [s] : []
}

function isHttpUrl(s) {
  try {
    const u = new URL(String(s))
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

export function normalizeUrl(s) {
  try {
    const u = new URL(String(s))
    u.hash = ''
    u.hostname = u.hostname.toLowerCase()
    let out = u.toString()
    if (out.endsWith('/')) out = out.slice(0, -1)
    return out
  } catch {
    return String(s ?? '').trim()
  }
}

// 素材不是事实，按来源封顶（文档 13.4）。
const CONF_CAP = { chat: 0.6, web: 0.5, public: 0.4 }
const CONF_DEFAULT = { chat: 0.5, web: 0.4, public: 0.4 }

function ttlFor(source, config, input) {
  const kind = sourceKind(source)
  if (kind === 'web') {
    // 新闻 3 天、话题 7 天、常青 14 天；模型/代码可显式给，但必须落在区间里。
    const asked = Number(input?.ttlDays)
    if (Number.isFinite(asked) && asked > 0) return Math.min(14, Math.max(3, asked))
  }
  const v = Number(config?.ttlDays?.[kind])
  return Number.isFinite(v) && v > 0 ? v : 7
}

function sourceFit(source) {
  const kind = sourceKind(source)
  if (kind === 'chat') return 1
  if (kind === 'web') return 0.8
  if (kind === 'public') return 0.6
  return 0.6
}

/** 0–1 的粗排分；素材永远进不了检索重排，这个分只服务投递。 */
export function scoreOf(item, now = Date.now()) {
  const at = Date.parse(item?.at || item?.created || '') || now
  const ttl = Math.max(1, Number(item?.ttlDays) || 7)
  const ageDays = Math.max(0, (now - at) / 86400000)
  const freshness = Math.max(0, Math.min(1, 1 - ageDays / ttl))
  const unused = Math.max(0, Math.min(1, 1 - (Number(item?.usedCount) || 0) / 2))
  const conf = Math.max(0, Math.min(1, Number(item?.conf) || 0.4))
  // 反馈层的加减分：范围收窄到 ±0.5，避免一次回复把一条素材顶死或踩死。
  const boost = Math.max(-0.5, Math.min(0.5, Number(item?.boost) || 0))
  const w = 0.35 * freshness + 0.25 * unused + 0.20 * conf + 0.20 * sourceFit(item?.source) + boost
  return Math.max(0, Math.min(1, w))
}

function textKey(text) {
  return normalizeText(text)
}

function hashText(text) {
  return createHash('sha1').update(String(text ?? '')).digest('hex').slice(0, 16)
}

/** 同源去重：originId / URL / 正文相似度。 */
function findDuplicate(db, input) {
  const kind = sourceKind(input.source)
  const origin = String(input.originId ?? '').trim()
  if (origin) {
    // 公共池 30 天、聊天 7 天内退休过的同一条不捡回来；web 走 URL 查重。
    const windowMs = kind === 'public' ? 30 * 86400000 : kind === 'chat' ? 7 * 86400000 : 0
    const hit = db.items.find((x) => {
      if (String(x.originId || '') !== origin) return false
      if (!DEAD_STATES.has(x.state)) return true
      const retired = Date.parse(x.retiredAt || '') || 0
      return windowMs > 0 && retired && Date.now() - retired < windowMs
    })
    if (hit) return hit
  }
  const refs = asRefs(input.refs).map(normalizeUrl)
  if (refs.length) {
    const set = new Set(refs)
    const hit = db.items.find((x) => (x.refs || []).some((r) => set.has(normalizeUrl(r))) && !DEAD_STATES.has(x.state))
    if (hit) return hit
  }
  const key = textKey(input.text)
  if (!key) return null
  const threshold = sourceKind(input.source) === 'chat' ? 0.75 : 0.85
  const hit = db.items.find((x) => !DEAD_STATES.has(x.state) && similarity(textKey(x.text), key) >= threshold)
  return hit || null
}

function activeOf(db, source = '') {
  const kind = source ? sourceKind(source) : ''
  return db.items.filter((x) => ACTIVE_STATES.has(x.state) && (!kind || sourceKind(x.source) === kind))
}

function retireItem(db, item, reason, now, { archive = [] } = {}) {
  if (!item || DEAD_STATES.has(item.state)) return false
  item.state = 'retired'
  item.retiredAt = now.toISOString()
  item.retiredReason = String(reason || '').slice(0, 120)
  archive.push({ id: item.id, at: item.retiredAt, reason: item.retiredReason, source: item.source, text: item.text })
  return true
}

function lowest(list) {
  return list.slice().sort((a, b) => scoreOf(a) - scoreOf(b))[0] || null
}

/**
 * 加一条素材。重复返回既有条目，不新建。
 * @returns {Promise<{ok:boolean, item?:object, duplicate?:boolean, why?:string}>}
 */
async function addMaterialUnlocked(root, input, { config = {}, now = new Date() } = {}) {
  const text = String(input?.text ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT)
  const source = String(input?.source ?? '').trim()
  const kind = sourceKind(source)
  if (!text) return { ok: false, why: 'empty-text' }
  if (!SOURCES.has(kind)) return { ok: false, why: `bad-source:${source || '(empty)'}` }

  const refs = asRefs(input?.refs).filter(isHttpUrl)
  if (kind === 'web' && !refs.length) return { ok: false, why: 'web-needs-url' }
  if ((kind === 'chat' || kind === 'public') && looksLikeScaffold(text)) {
    return { ok: false, why: 'scaffold-text' }
  }
  const originId = String(input?.originId ?? '').trim()
  if ((kind === 'public' || kind === 'chat') && !originId) return { ok: false, why: `${kind}-needs-origin` }

  const db = await loadMaterial(root)
  const hit = findDuplicate(db, { ...input, text, source })
  if (hit) return { ok: true, item: hit, duplicate: true }

  const archive = []
  const maxTotal = Math.max(1, Number(config.maxMaterial) || 30)
  const maxSource = Math.max(1, Number(config.maxPerSource?.[kind]) || 30)
  const maxFocus = Math.max(1, Number(config.maxPerFocus) || 4)
  const focus = String(input?.focus ?? '').trim().slice(0, 40)

  while (activeOf(db).length >= maxTotal) {
    if (!retireItem(db, lowest(activeOf(db)), 'capacity', now, { archive })) break
  }
  while (activeOf(db, kind).length >= maxSource) {
    if (!retireItem(db, lowest(activeOf(db, kind)), `capacity:${kind}`, now, { archive })) break
  }
  if (focus) {
    const sameFocus = activeOf(db).filter((x) => x.focus === focus)
    while (sameFocus.length >= maxFocus) {
      const victim = lowest(sameFocus)
      if (!retireItem(db, victim, `capacity:focus:${focus}`, now, { archive })) break
      sameFocus.splice(sameFocus.indexOf(victim), 1)
    }
  }

  const ttlDays = ttlFor(source, config, input)
  const confCap = CONF_CAP[kind] || 0.4
  const confFallback = CONF_DEFAULT[kind] || 0.4
  const item = {
    id: newMaterialId(),
    text,
    quote: String(input?.quote ?? '').trim().slice(0, 200),
    context: String(input?.context ?? '').replace(/\s+/g, ' ').trim().slice(0, 120),
    refs,
    originId,
    source,
    focus,
    at: String(input?.at || now.toISOString()),
    conf: Math.max(0.1, Math.min(confCap, Number(input?.conf) || confFallback)),
    ttlDays,
    expiresAt: new Date(Date.parse(input?.at || now.toISOString()) + ttlDays * 86400000).toISOString(),
    state: 'active',
    usedCount: 0,
    lastUsedAt: '',
    cooledAt: '',
    deliveryIds: [],
    tags: Array.isArray(input?.tags) ? input.tags.map(String).slice(0, 6) : [],
    graceUntil: '',
    boost: 0,
    lastFeedbackAt: '',
    createdAt: now.toISOString(),
  }
  item.weight = scoreOf(item, now.getTime())
  db.items.push(item)
  await saveMaterial(root, db)
  for (const e of archive) await appendJsonl(materialArchivePath(root), e).catch(() => {})
  return { ok: true, item }
}

export function addMaterial(root, input, opts) {
  return withMaterialLock(() => addMaterialUnlocked(root, input, opts))
}

export function markUsed(root, ids, deliveryId, opts) {
  return withMaterialLock(() => markUsedUnlocked(root, ids, deliveryId, opts))
}

/**
 * 反馈层给素材加减分。只改 boost，不改 conf / 来源；落盘串行，和 add/GC 共用一把锁。
 * @returns {Promise<{ok:boolean, before:number, after:number, item?:object, why?:string}>}
 */
async function adjustMaterialUnlocked(root, id, delta, { now = new Date() } = {}) {
  const db = await loadMaterial(root)
  const item = db.items.find((x) => String(x.id) === String(id))
  if (!item) return { ok: false, before: 0, after: 0, why: 'not-found' }
  const before = Math.max(-0.5, Math.min(0.5, Number(item.boost) || 0))
  const after = Math.max(-0.5, Math.min(0.5, before + Number(delta || 0)))
  item.boost = after
  item.lastFeedbackAt = now.toISOString()
  // 被接住过一次：允许从 used/cooling 回到 active，最多再投一次（文档 13.18）。
  if (after > before && (item.state === 'used' || item.state === 'cooling') && (Number(item.usedCount) || 0) < 2) {
    item.state = 'active'
    item.graceUntil = ''
    item.cooledAt = ''
  }
  await saveMaterial(root, db)
  return { ok: true, before, after, item }
}

export function adjustMaterial(root, id, delta, opts) {
  return withMaterialLock(() => adjustMaterialUnlocked(root, id, delta, opts))
}

export function retireMaterial(root, id, reason, opts) {
  return withMaterialLock(() => retireMaterialUnlocked(root, id, reason, opts))
}

export function gcMaterial(root, opts) {
  return withMaterialLock(() => gcMaterialUnlocked(root, opts))
}

export function materialList(root, { state = 'active', source = '', limit = 0 } = {}) {
  return loadMaterial(root).then((db) => {
    const kind = sourceKind(source)
    const rows = db.items
      .filter((x) => (!state || x.state === state) && (!kind || sourceKind(x.source) === kind))
      .sort((a, b) => scoreOf(b) - scoreOf(a) || String(b.id).localeCompare(String(a.id)))
    return limit > 0 ? rows.slice(0, limit) : rows
  })
}

/** 投递候选：只要 active、没过期；可按来源取。 */
export async function resurface(root, { limit = 3, source = '', now = new Date(), excludeIds = [] } = {}) {
  const db = await loadMaterial(root)
  const skip = new Set(excludeIds.map(String))
  const kind = sourceKind(source)
  return db.items
    .filter((x) => ACTIVE_STATES.has(x.state))
    .filter((x) => !x.expiresAt || Date.parse(x.expiresAt) > now.getTime())
    .filter((x) => !kind || sourceKind(x.source) === kind)
    .filter((x) => !skip.has(String(x.id)))
    .filter((x) => !looksLikeScaffold(x.text))
    .map((x) => ({ ...x, weight: scoreOf(x, now.getTime()) }))
    .sort((a, b) => b.weight - a.weight || String(b.id).localeCompare(String(a.id)))
    .slice(0, Math.max(0, limit))
}

/** 投递后记账。chat 另给 grace：至少活到下一次维护。 */
async function markUsedUnlocked(root, ids, deliveryId, { now = new Date() } = {}) {
  const want = new Set((Array.isArray(ids) ? ids : [ids]).map(String).filter(Boolean))
  if (!want.size) return { ok: true, used: 0 }
  const db = await loadMaterial(root)
  let used = 0
  for (const it of db.items) {
    if (!want.has(String(it.id))) continue
    it.state = 'used'
    it.usedCount = (Number(it.usedCount) || 0) + 1
    it.lastUsedAt = now.toISOString()
    it.cooledAt = ''
    it.deliveryIds = Array.isArray(it.deliveryIds) ? it.deliveryIds : []
    if (deliveryId && !it.deliveryIds.includes(deliveryId)) it.deliveryIds.push(deliveryId)
    if (sourceKind(it.source) === 'chat') {
      it.graceUntil = new Date(now.getTime() + 24 * 3600000).toISOString()
    }
    used += 1
  }
  if (used) await saveMaterial(root, db)
  return { ok: true, used }
}

async function retireMaterialUnlocked(root, id, reason = 'manual', { now = new Date() } = {}) {
  const db = await loadMaterial(root)
  const item = db.items.find((x) => String(x.id) === String(id))
  if (!item) return { ok: false, why: 'not-found' }
  const archive = []
  const changed = retireItem(db, item, reason, now, { archive })
  if (changed) {
    await saveMaterial(root, db)
    for (const e of archive) await appendJsonl(materialArchivePath(root), e).catch(() => {})
  }
  return { ok: changed, item }
}

/** TTL / 消费退休 / chat grace / 容量后的清理。 */
async function gcMaterialUnlocked(root, { config = {}, now = new Date() } = {}) {
  const db = await loadMaterial(root)
  const archive = []
  let retired = 0
  const retryMs = Math.max(1, Number(config.retryUsedHours) || 48) * 3600000

  for (const it of db.items) {
    if (DEAD_STATES.has(it.state)) continue
    const expired = it.expiresAt && Date.parse(it.expiresAt) <= now.getTime()
    if (expired && (it.state === 'active' || it.state === 'used' || it.state === 'cooling')) {
      if (retireItem(db, it, 'ttl', now, { archive })) retired += 1
      continue
    }
    if (it.state === 'used') {
      if ((Number(it.usedCount) || 0) >= 2) {
        if (retireItem(db, it, 'used-twice', now, { archive })) retired += 1
        continue
      }
      const grace = Date.parse(it.graceUntil || '') || 0
      if (grace && now.getTime() < grace) continue
      // 投过一次、48 小时没人接：降冷，不再主动投；正向反馈可以把它拉回 active。
      const last = Date.parse(it.lastUsedAt || '') || 0
      if (!last || now.getTime() - last >= retryMs) {
        it.state = 'cooling'
        it.cooledAt = now.toISOString()
        it.graceUntil = ''
      }
    } else if (it.state === 'cooling') {
      const cooled = Date.parse(it.cooledAt || it.lastUsedAt || '') || 0
      if (!cooled || now.getTime() - cooled >= retryMs) {
        if (retireItem(db, it, 'cooling', now, { archive })) retired += 1
      }
    }
  }

  for (const it of db.items) it.weight = scoreOf(it, now.getTime())
  await saveMaterial(root, db)
  for (const e of archive) await appendJsonl(materialArchivePath(root), e).catch(() => {})

  // 归档只留最近 N 条，文件别无限长
  const cap = Math.max(1, Number(config.archiveCap) || 50)
  try {
    const raw = await readFile(materialArchivePath(root), 'utf8')
    const lines = raw.split('\n').filter(Boolean)
    if (lines.length > cap) {
      await writeAtomic(materialArchivePath(root), lines.slice(-cap).join('\n') + '\n')
    }
  } catch { /* 没有归档就算了 */ }

  return { ok: true, retired, total: db.items.length }
}

export async function materialCounts(root) {
  const db = await loadMaterial(root)
  const bySource = { public: 0, web: 0, chat: 0 }
  let active = 0
  for (const it of db.items) {
    if (it.state !== 'active') continue
    active += 1
    const k = sourceKind(it.source)
    if (k in bySource) bySource[k] += 1
  }
  return { active, total: db.items.length, bySource }
}

/** 给投递包的短行：正文优先取完整原话，不带 refs 以外的私有字段。 */
export function materialLine(item) {
  const src = sourceKind(item?.source)
  const ref = src === 'web' ? `｜来源：${(item.refs || [])[0] || ''}` : src === 'chat' ? '｜来源：会话素材' : '｜来源：公共素材'
  const text = String(item?.text ?? '').trim()
  const quote = String(item?.quote ?? '').trim()
  // 旧素材的 text 可能是索引层截出来的半句（带省略号）；quote 里有完整那句就换掉。
  const body = quote && quote.length > text.length && /(…|\.\.\.)$/.test(text) ? quote : text
  const ctx = src === 'chat' ? String(item?.context ?? '').trim() : ''
  return `[${item.id}·${src}] ${body}${ref}${ctx ? `｜上文：${ctx}` : ''}`
}

export function hashOfText(text) {
  return hashText(text)
}
