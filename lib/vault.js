/**
 * vault.js —— 主副库双轨（阶段 2）
 *
 * 一个分片 = 一个目录：
 *   scopes/private-<id>/
 *     meta.json            分片元信息（画像、成员、来源标记）
 *     memory_full/{id}.md  主库：唯一真源，单条一段完整记录
 *     memory_index.md      副库：派生目录，可删可重建，≤32KB
 *     tag_graph.md         派生：标签计数
 *     status.md            派生：人类可读状态面
 *     archive/full/        从主库移出的条目（删/归档都保留正文）
 *     archive/index_archive.md
 *     .rev                 写入版本号（inject 靠它的 mtime 判断要不要重画）
 *
 * 铁律：
 *   1. 先写主库成功，再写副库；副库失败不影响记忆已存在。
 *   2. 副库只用于"找得到"，一句话讲不清的细节全在主库。
 *   3. 删条目 = 主库文件挪进 archive/full/，不是物理删除。
 *   4. 所有写入先临时文件再 rename。
 */

import { mkdir, readFile, rename, readdir, stat, writeFile, appendFile, unlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { typeLabel } from './taxonomy.js'
import { refreshTrustStamp } from './trust.js'
import { enrichItem } from './enrich.js'

export { typeLabel }

export const SCHEMA = 2
export const INDEX_LIMIT = 32 * 1024
const SUMMARY_MAX = 60
const SUMMARY_MIN = 40

export function scopeDir(root, kind, id) {
  return join(root, 'scopes', `${kind}-${id}`)
}

export function vaultPaths(root, kind, id) {
  const dir = scopeDir(root, kind, id)
  return {
    dir,
    meta: join(dir, 'meta.json'),
    index: join(dir, 'memory_index.md'),
    tagGraph: join(dir, 'tag_graph.md'),
    status: join(dir, 'status.md'),
    full: join(dir, 'memory_full'),
    archiveFull: join(dir, 'archive', 'full'),
    archiveIndex: join(dir, 'archive', 'index_archive.md'),
    pending: join(dir, 'pending.json'),
    usage: join(dir, 'usage.jsonl'),
    rev: join(dir, '.rev'),
  }
}

async function readText(file, fallback = '') {
  try { return await readFile(file, 'utf8') } catch { return fallback }
}

async function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmp, text, 'utf8')
  await rename(tmp, file)
}

function num(v, d) {
  const n = Number(v)
  return Number.isFinite(n) ? n : d
}

function arr(v) {
  if (Array.isArray(v)) return v.filter(Boolean).map(String)
  const s = String(v ?? '').trim()
  if (!s || s === '[]') return []
  return s.replace(/^\[|\]$/g, '').split(',').map((x) => x.trim()).filter(Boolean)
}

function oneLine(s) {
  return String(s ?? '').replace(/\r?\n/g, ' ').trim()
}

/** 摘要：一句话，超 60 字截断。 */
export function itemSummary(item, max = SUMMARY_MAX) {
  const s = oneLine(item?.summary || item?.text || '')
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

/** 时间线：事件取发生日期，事实取确认/记录日期。 */
export function itemTimeline(item) {
  const raw = String(item?.atAbs || item?.observedAt || item?.created || '')
  const m = raw.match(/^\d{4}-\d{2}-\d{2}/)
  return m ? m[0] : new Date().toISOString().slice(0, 10)
}

/** 权重 = 置信度 × 时间衰减 × 命中加成，0–1。与 store.decayScore 同口径。 */
export function itemWeight(item, now = Date.now(), halfLifeDays = 30) {
  const last = Date.parse(item?.lastHit || item?.created || '') || now
  const ageDays = Math.max(0, (now - last) / 86400000)
  const conf = num(item?.conf, 0.6)
  const hitBoost = 1 + 0.15 * Math.min(5, num(item?.hits, 0))
  const score = conf * Math.exp(-ageDays / Math.max(1, halfLifeDays)) * hitBoost
  return Number(Math.max(0, Math.min(1, score)).toFixed(3))
}

function tagsOf(item) {
  const tags = arr(item?.tags)
  return tags.length ? tags : [typeLabel(item?.kind)]
}

/** 内部条目 → 主库 Markdown。字段全写进 frontmatter，正文单独用注释包住。 */
export function itemToMarkdown(item, scope) {
  const tags = tagsOf(item)
  const parents = arr(item?.parentTags)
  const w = num(item?.weight, itemWeight(item))
  const timeline = item?.timeline || itemTimeline(item)
  const title = itemSummary(item, 30)
  const fm = [
    '---',
    `id: ${item.id}`,
    `type: ${item.kind || 'fact'}`,
    `status: ${item.state || 'active'}`,
    `scope: ${scope?.scope || ''}`,
    `summary: ${oneLine(itemSummary(item))}`,
    `summary_locked: ${item.summaryLocked ? 'true' : 'false'}`,
    `tags: [${tags.join(', ')}]`,
    `parent_tags: [${parents.join(', ')}]`,
    `weight: ${w}`,
    `importance: ${num(item.importance, item.kind === 'pref' ? 0.7 : 0.5)}`,
    `confidence: ${num(item.conf, 0.6)}`,
    `timeline: ${timeline}`,
    `created: ${item.created || ''}`,
    `last_used: ${item.lastHit || item.created || ''}`,
    `hits: ${num(item.hits, 0)}`,
    `merged: ${num(item.merged, 0)}`,
    `source: ${oneLine(item.source)}`,
    `source_quote: ${oneLine(item.sourceQuote)}`,
    `speaker: ${oneLine(item.speaker)}`,
    `observed_at: ${item.observedAt || ''}`,
    `at_abs: ${item.atAbs || ''}`,
    `valid_from: ${item.validFrom || ''}`,
    `valid_to: ${item.validTo || ''}`,
    `superseded_by: ${item.supersededBy || ''}`,
    `expires_at: ${item.expiresAt || ''}`,
    '---',
    '',
    `# ${item.id} · ${title}`,
    '',
    '## 背景',
    [item.speaker ? `${item.speaker} 提到` : '', item.observedAt ? `于 ${item.observedAt}` : '', item.source ? `（来源 ${item.source}）` : '']
      .filter(Boolean).join('') || '（无）',
    '',
    '## 完整记录',
    '<!-- whale:text -->',
    String(item.text ?? ''),
    '<!-- /whale:text -->',
    '',
    '## 提炼',
    oneLine(item.summary || item.text) || '（无）',
    '',
    ...(Array.isArray(item.history) && item.history.length
      ? ['## 曾经', '', ...item.history.map((h) => `- ${h.at || ''} ${h.text}`), '']
      : []),
    '## 来源',
    `- ${item.source || '（未记录）'}`,
    '',
  ]
  return fm.join('\n')
}

/** 解析 frontmatter（只支持本文件写出的扁平格式）。 */
export function parseFrontmatter(md) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(String(md ?? ''))
  if (!m) return [{}, String(md ?? '')]
  const fm = {}
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(':')
    if (i <= 0) continue
    const k = line.slice(0, i).trim()
    fm[k] = line.slice(i + 1).trim()
  }
  return [fm, String(md).slice(m[0].length)]
}

function sectionText(body, name) {
  const re = new RegExp(`## ${name}\\s*\\r?\\n([\\s\\S]*?)(?=\\r?\\n## |$)`)
  const m = re.exec(body)
  return m ? m[1].trim() : ''
}

/** 主库 Markdown → 内部条目。 */
export function itemFromMarkdown(md) {
  const [fm, body] = parseFrontmatter(md)
  if (!fm.id) return null
  const raw = /<!-- whale:text -->\r?\n([\s\S]*?)\r?\n<!-- \/whale:text -->/.exec(body)
  const text = raw ? raw[1] : (sectionText(body, '完整记录') || fm.summary || '')
  const conf = num(fm.confidence, 0.6)
  return {
    id: String(fm.id),
    text,
    kind: fm.type || 'fact',
    conf,
    confidence: conf,
    source: fm.source || '',
    sourceQuote: fm.source_quote || '',
    refs: [],
    atAbs: fm.at_abs || '',
    observedAt: fm.observed_at || '',
    speaker: fm.speaker || '',
    validFrom: fm.valid_from || '',
    validTo: fm.valid_to || '',
    supersededBy: fm.superseded_by || '',
    created: fm.created || '',
    lastHit: fm.last_used || fm.created || '',
    hits: num(fm.hits, 0),
    merged: num(fm.merged, 0),
    state: fm.status || 'active',
    summary: fm.summary || '',
    summaryLocked: fm.summary_locked === 'true',
    tags: arr(fm.tags),
    parentTags: arr(fm.parent_tags),
    weight: num(fm.weight, itemWeight({ conf, hits: num(fm.hits, 0), lastHit: fm.last_used || fm.created })),
    importance: num(fm.importance, 0.5),
    timeline: fm.timeline || '',
    expiresAt: fm.expires_at || '',
  }
}

function liveItems(scope) {
  return (scope?.items || []).filter((x) => x && x.state !== 'archived' && x.state !== 'superseded' && x.state !== 'expired')
}

/** 副库渲染：入口是派生视图，删掉也能由主库重建。 */
export function renderIndex(scope, { limit = INDEX_LIMIT } = {}) {
  const live = liveItems(scope).slice()
    .sort((a, b) => itemWeight(b) - itemWeight(a) || String(a.id).localeCompare(String(b.id)))
  const header = [
    `# 记忆目录 · ${scope.scope}`,
    '',
    `> 共 ${live.length} 条 · 派生视图（可删，rebuild_index 能从 memory_full/ 重建）· 上限 ${Math.round(limit / 1024)}KB`,
    '',
  ].join('\n')

  let summaryMax = SUMMARY_MAX
  let list = live
  let body = header
  for (let guard = 0; guard < 40; guard += 1) {
    const chunks = list.map((it) => {
      const tags = tagsOf(it).join('、')
      const parents = arr(it.parentTags)
      return [
        `## ${it.id}`,
        `- 时间：${it.timeline || itemTimeline(it)} · 类型：${it.kind || 'fact'} · 权重：${itemWeight(it).toFixed(2)} · 状态：${it.state || 'active'}`,
        `- 标签：${tags}${parents.length ? `（上级：${parents.join('、')}）` : ''}`,
        `- 摘要：${itemSummary(it, summaryMax)}`,
        '',
      ].join('\n')
    })
    const dropped = live.length - list.length
    body = header + chunks.join('\n') + (dropped > 0 ? `\n…其余 ${dropped} 条已折叠（主库仍在，用搜索查）\n` : '')
    const bytes = Buffer.byteLength(body, 'utf8')
    if (bytes <= limit) break
    // 降级顺序：先压摘要到 40 字，再按比例折叠最冷的条目
    if (summaryMax > SUMMARY_MIN) { summaryMax = SUMMARY_MIN; continue }
    if (list.length <= 20) break
    const next = Math.max(20, Math.min(list.length - 1, Math.floor((list.length * limit) / bytes * 0.95)))
    list = list.slice(0, next)
  }
  return body
}

/** 标签树：由 tags/parent_tags 聚合，不手工维护。 */
export function renderTagGraph(scope) {
  const count = new Map()
  for (const it of liveItems(scope)) {
    for (const t of tagsOf(it)) count.set(t, (count.get(t) || 0) + 1)
    for (const p of arr(it.parentTags)) count.set(p, (count.get(p) || 0) + 1)
  }
  const rows = [...count.entries()].sort((a, b) => b[1] - a[1])
  const lines = [`# 标签树 · ${scope.scope}`, '', `> 派生文件，由 parent_tags 聚合，不手工维护`, '']
  if (!rows.length) lines.push('（暂无标签）')
  for (const [name, n] of rows) lines.push(`- ${name}（${n}）`)
  lines.push('')
  return lines.join('\n')
}

/** 给人看的状态面。 */
export function renderStatus(scope, { indexBytes = 0, fullFiles = 0, pending = false } = {}) {
  const items = scope?.items || []
  const by = (s) => items.filter((x) => x.state === s).length
  return [
    `# 状态 · ${scope.scope}`,
    '',
    `- 条目：${items.length}（active ${by('active')} / warm ${by('warm')} / cold ${by('cold')} / superseded ${by('superseded')} / archived ${by('archived')}）`,
    `- 主库文件：${fullFiles} · 副库：${(indexBytes / 1024).toFixed(1)} KB`,
    `- 最近写入：${scope.updatedAt || ''}`,
    pending ? '- ⚠ 副库待重建（pending.json）' : '- 副库：正常',
    `- 画像：${scope.profile?.summary || '（空）'}`,
    '',
  ].join('\n')
}

function labelOf(kind, id) {
  if (kind === 'group') return `群 ${id}`
  if (kind === 'local') return '本机会话'
  return `用户 ${id}`
}

function emptyScope(kind, id, label) {
  const now = new Date().toISOString()
  return {
    scope: `${kind}:${id}`,
    kind,
    id: String(id),
    label: label || labelOf(kind, id),
    origin: 'local',
    createdAt: now,
    updatedAt: now,
    profile: { summary: '', traits: [], updated: '' },
    members: {},
    items: [],
  }
}

function metaOf(scope) {
  return {
    schema: SCHEMA,
    scope: scope.scope,
    kind: scope.kind,
    id: String(scope.id),
    label: scope.label,
    origin: scope.origin || 'local',
    createdAt: scope.createdAt || '',
    updatedAt: scope.updatedAt || '',
    migratedAt: scope.migratedAt || '',
    profile: scope.profile || { summary: '', traits: [], updated: '' },
    members: scope.members || {},
    lastDeepen: scope.lastDeepen || '',
    itemsSinceDeepen: scope.itemsSinceDeepen || 0,
  }
}

/** 进程内读缓存：key = 目录，用 .rev 判断能不能复用。 */
const cache = new Map()
let revSeq = 0

/**
 * 读一个分片。
 * @param {{force?: boolean}} [opts] force 跳过缓存（rebuild / 外部改动后）
 */
export async function loadVault(root, kind, id, { force = false } = {}) {
  const p = vaultPaths(root, kind, id)
  const rev = (await readText(p.rev, '')).trim()
  const hit = cache.get(p.dir)
  if (!force && rev && hit && hit.rev === rev) return hit.scope

  if (!existsSync(p.meta) && !existsSync(p.full)) return emptyScope(kind, id)

  let meta = {}
  try { meta = JSON.parse(await readText(p.meta, '{}')) } catch { meta = {} }

  const items = []
  const files = new Map()
  let names = []
  try { names = await readdir(p.full) } catch { names = [] }
  for (const n of names) {
    if (!n.endsWith('.md')) continue
    const md = await readText(join(p.full, n), '')
    const it = itemFromMarkdown(md)
    if (!it) continue
    items.push(it)
    files.set(it.id, md)
  }

  const scope = {
    ...emptyScope(kind, id, meta.label),
    ...meta,
    scope: `${kind}:${id}`,
    kind,
    id: String(id),
    profile: meta.profile || { summary: '', traits: [], updated: '' },
    members: meta.members || {},
    items,
  }
  cache.set(p.dir, { rev, scope, files })
  return scope
}

/**
 * 写一个分片：先主库，再副库。
 * @returns {Promise<{written:number, moved:number, indexBytes:number}>}
 */
export async function saveVault(root, scope) {
  const p = vaultPaths(root, scope.kind, scope.id)
  try {
    return await saveVaultInner(root, scope, p)
  } catch (e) {
    // 写失败就把缓存丢掉：内存里已经改过的条目不能继续冒充"已落盘"
    cache.delete(p.dir)
    throw e
  }
}

async function saveVaultInner(root, scope, p) {
  await mkdir(p.full, { recursive: true })

  // 内存条目补齐派生字段：写盘和缓存必须是同一份数据，否则读回来就少字段。
  // 降维在这里统一做，写入口只管正文和类型，标签/摘要/权重不会各写一套。
  const now = Date.now()
  for (const it of scope.items || []) {
    if (!it?.id) continue
    enrichItem(it, now)
    if (!Array.isArray(it.parentTags)) it.parentTags = []
  }

  const hit = cache.get(p.dir)
  const files = hit?.files ?? new Map()

  // 1. 主库：只写内容真的变了的条目
  let written = 0
  for (const it of scope.items || []) {
    if (!it?.id) continue
    const md = itemToMarkdown(it, scope)
    if (files.get(it.id) === md) continue
    await writeAtomic(join(p.full, `${it.id}.md`), md)
    files.set(it.id, md)
    written += 1
  }

  // 2. 从 items 里消失的条目：主库文件挪进 archive/full/，不物理删
  const alive = new Set((scope.items || []).map((x) => x.id))
  let moved = 0
  let existing = []
  try { existing = await readdir(p.full) } catch { existing = [] }
  for (const n of existing) {
    if (!n.endsWith('.md')) continue
    const id = n.slice(0, -3)
    if (alive.has(id)) continue
    await mkdir(p.archiveFull, { recursive: true })
    await rename(join(p.full, n), join(p.archiveFull, n))
    files.delete(id)
    moved += 1
    await appendFile(p.archiveIndex, `- ${id} ｜ ${new Date().toISOString()} ｜ 从主库移出\n`, 'utf8').catch(() => {})
  }

  // 3. 元信息 + 副库（派生）
  scope.updatedAt = new Date().toISOString()
  await writeAtomic(p.meta, JSON.stringify(metaOf(scope), null, 2))

  // 3. 副库是派生层：写失败不能让整次写入失败（主库已经成功了），
  //    留 pending 标记，下一次保存或 rebuild_index 会补。
  let index = ''
  let pending = false
  try {
    index = renderIndex(scope)
    await writeAtomic(p.index, index)
    await writeAtomic(p.tagGraph, renderTagGraph(scope))
    const live = liveItems(scope).length
    await writeAtomic(p.status, renderStatus(scope, { indexBytes: Buffer.byteLength(index, 'utf8'), fullFiles: live, pending: false }))
    await unlink(p.pending).catch(() => {})
  } catch (e) {
    pending = true
    await writeAtomic(p.pending, JSON.stringify({ at: new Date().toISOString(), reason: String(e?.message ?? e) }, null, 2)).catch(() => {})
  }

  // 4. 版本号最后写：前面任何一步失败，下一轮还能从主库重建
  revSeq += 1
  const rev = `${Date.now().toString(36)}-${revSeq}`
  await writeAtomic(p.rev, rev)
  cache.set(p.dir, { rev, scope, files })

  return { written, moved, indexBytes: Buffer.byteLength(index, 'utf8'), pending }
}

/** 只更新元信息（画像/成员变化），不动主库正文。 */
export async function saveVaultMeta(root, scope) {
  const p = vaultPaths(root, scope.kind, scope.id)
  await mkdir(p.dir, { recursive: true })
  scope.updatedAt = new Date().toISOString()
  await writeAtomic(p.meta, JSON.stringify(metaOf(scope), null, 2))
  revSeq += 1
  const rev = `${Date.now().toString(36)}-${revSeq}`
  await writeAtomic(p.rev, rev)
  const hit = cache.get(p.dir)
  if (hit) hit.rev = rev
  return true
}

/** 从主库重建副库（索引坏了/删了都能跑）。 */
export async function rebuildScope(root, kind, id) {
  const scope = await loadVault(root, kind, id, { force: true })
  await saveVault(root, scope)
  await refreshTrustStamp(root).catch(() => {})
  return scope
}

/** 主副库一致性：主库文件数 vs 内存条目数。 */
export async function verifyScope(root, kind, id, known = null) {
  const p = vaultPaths(root, kind, id)
  let files = 0
  try { files = (await readdir(p.full)).filter((n) => n.endsWith('.md')).length } catch { files = 0 }
  const scope = known || await loadVault(root, kind, id, { force: true })
  return { files, items: (scope.items || []).length, ok: files === (scope.items || []).length }
}

/**
 * 旧版 scopes/<kind>-<id>.json → 目录。跑完把旧文件挪进 archive/legacy-<日期>/。
 * 幂等：已经有 .rev 的目录直接跳过。
 */
export async function migrateLegacy(root) {
  const dir = join(root, 'scopes')
  let names = []
  try { names = await readdir(dir) } catch { return { migrated: 0 } }
  let migrated = 0
  for (const n of names) {
    if (!n.endsWith('.json')) continue
    const m = /^(private|group)-(.+)\.json$/.exec(n)
    if (!m) continue
    const [, kind, id] = m
    const p = vaultPaths(root, kind, id)
    if (existsSync(p.rev)) continue
    let old
    try { old = JSON.parse(await readText(join(dir, n), '')) } catch { continue }
    if (!old || !Array.isArray(old.items)) continue
    old.kind = kind
    old.id = id
    old.scope = `${kind}:${id}`
    old.migratedAt = new Date().toISOString()
    await saveVault(root, old)
    const bak = join(root, 'archive', `legacy-${new Date().toISOString().slice(0, 10)}`)
    await mkdir(bak, { recursive: true })
    await rename(join(dir, n), join(bak, n)).catch(() => {})
    migrated += 1
  }
  return { migrated }
}

/** 目录 mtime（诊断用）。 */
export async function scopeMtime(root, kind, id) {
  try { return (await stat(vaultPaths(root, kind, id).rev)).mtimeMs } catch { return -1 }
}

/** 追加一条检索/读取事件（usage.jsonl）。 */
export async function appendUsage(root, kind, id, row) {
  const p = vaultPaths(root, kind, id)
  await mkdir(p.dir, { recursive: true })
  await appendFile(p.usage, JSON.stringify({ at: new Date().toISOString(), ...row }) + '\n', 'utf8')
}

/** 测试用：清缓存。 */
export function resetVaultCache() {
  cache.clear()
  revSeq = 0
}
