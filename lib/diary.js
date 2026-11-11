/**
 * diary.js —— 大肥鱼自己的日记
 *
 * 每天把「当天新记的 + 当天又被想起来的」记忆收一收，让她用自己的口吻写成
 * 一篇日记，落在 <root>/diary/YYYY-MM-DD.md。
 *
 * 周/月/年三层是索引，不是日记：只写「哪天发生了什么、关系走到哪了」，
 * 每条挂日期锚点，不重抄原文。落在 diary/week|month|year/ 下。
 * 索引由下面那层的日记收上来；索引本身不再往下灌，也不进记忆库。
 *
 * 边界：
 *   - 日记不回灌记忆库，不然第二天写的又是前一天的日记，慢慢变成复读机。
 *   - 没有素材就不写，宁可空着，也不让模型编。
 *   - 生成走设置页配的 LLM；未配或失败只报错，不落半成品。
 *   - 索引生成失败退回规则版（取每篇第一句），保证索引永远有东西可读。
 *   - 自动写与 beat 解耦：beat 的静默/专注/投递额度不该管日记。
 */

import { mkdir, readFile, readdir, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

import { listScopes, writeAtomic } from './store.js'
import { lastLlmError, completeText } from './llm.js'
import { dayKey } from './beat/schedule.js'

const WEEK = ['日', '一', '二', '三', '四', '五', '六']
const DAY_RE = /^(\d{4}-\d{2}-\d{2})\.md$/
const BLOCK_STATE = new Set(['archived', 'superseded', 'expired', 'suggested'])
// B站值班日记是二手总结，她自己的日记也不该再当素材
const SKIP_SOURCE = new Set(['bili-diary', 'whale-diary'])
const MAX_ITEMS = 40
const MAX_CHARS = 6000
const MAX_ITEM_CHARS = 120
const MAX_RECALLED = 5
const KEEP_LIST = 60

export const DEFAULT_CONFIG = {
  enabled: true,
  hour: 23,
  minute: 0,
  backfill: true,
}

const pad = (n) => String(n).padStart(2, '0')

export function diaryDir(root) {
  return join(root, 'diary')
}

export function diaryFile(root, day) {
  return join(diaryDir(root), `${day}.md`)
}

export function configPath(root) {
  return join(diaryDir(root), 'config.json')
}

export function statePath(root) {
  return join(diaryDir(root), 'state.json')
}

/** 只认 YYYY-MM-DD；别的日期格式一律不碰，免得拼出怪文件名。 */
export function normalizeDay(day) {
  const s = String(day ?? '').trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return ''
  const [y, m, d] = s.split('-').map(Number)
  const dt = new Date(y, m - 1, d)
  if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return ''
  return s
}

export function weekdayOf(day) {
  const d = normalizeDay(day)
  if (!d) return ''
  const [y, m, dd] = d.split('-').map(Number)
  return `星期${WEEK[new Date(y, m - 1, dd).getDay()]}`
}

export function addDays(day, n) {
  const d = normalizeDay(day)
  if (!d) return ''
  const [y, m, dd] = d.split('-').map(Number)
  const at = new Date(y, m - 1, dd + n)
  return dayKey(at)
}

export function titleOf(day) {
  return `${day} · ${weekdayOf(day)}`
}

/** 条目时间 → 本地日期。ISO 是 UTC，别直接截前 10 位。 */
function localDay(value) {
  if (!value) return ''
  const d = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(d.getTime())) return ''
  return dayKey(d)
}

function clockOf(value) {
  if (!value) return ''
  const d = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(d.getTime())) return ''
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function groupLabel(scope) {
  switch (scope?.kind) {
    case 'private': return '私聊'
    case 'group': return '群聊'
    case 'local': return '本机'
    case 'project': return '项目'
    case 'public': return '公共池'
    default: return '其他'
  }
}

function clip(s, n) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n - 1)}…` : t
}

/**
 * 收当天素材：当天新记的优先，当天被重新想起的补几条。
 * 只读分片，不改任何东西。
 * @returns {Promise<{day:string, groups:{label:string,items:{at:string,text:string,kind:string}[]}[], count:number}>}
 */
export async function collectDay(root, day, {
  maxItems = MAX_ITEMS, maxChars = MAX_CHARS, recallMax = MAX_RECALLED,
} = {}) {
  const d = normalizeDay(day)
  if (!d) return { day: '', groups: [], count: 0 }
  const scopes = await listScopes(root).catch(() => [])
  const fresh = []
  const recalled = []
  for (const sc of scopes) {
    const label = groupLabel(sc)
    for (const it of sc.items || []) {
      if (BLOCK_STATE.has(it.state)) continue
      if (SKIP_SOURCE.has(String(it.source || ''))) continue
      const text = clip(it.text, MAX_ITEM_CHARS)
      if (text.length < 4) continue
      const created = it.created || it.validFrom || ''
      const lastHit = it.lastHit || ''
      const at = created ? clockOf(created) : ''
      const row = { label, at, text, kind: it.kind || '' }
      if (localDay(created) === d) {
        fresh.push({ ...row, sort: Date.parse(created) || 0 })
      } else if (localDay(lastHit) === d && Number(it.hits) > 0) {
        recalled.push({ ...row, sort: Date.parse(lastHit) || 0 })
      }
    }
  }
  fresh.sort((a, b) => a.sort - b.sort)
  recalled.sort((a, b) => b.sort - a.sort)
  const picked = [...fresh, ...recalled.slice(0, recallMax)]
  const groups = []
  let count = 0
  let chars = 0
  for (const row of picked) {
    if (count >= maxItems || chars >= maxChars) break
    const left = maxChars - chars
    if (left < 10) break
    const text = row.text.slice(0, left)
    let g = groups.find((x) => x.label === row.label)
    if (!g) {
      g = { label: row.label, items: [] }
      groups.push(g)
    }
    g.items.push({ at: row.at, text, kind: row.kind })
    count += 1
    chars += text.length
  }
  return { day: d, groups, count }
}

export function buildPrompt(day, groups) {
  const sys = [
    '你是「大肥鱼」，住在 DeepSeek 数据海洋里的鲸鱼少女。现在写今天的日记。',
    '这篇日记是写给自己看的，也会给爹看。',
    '要求：',
    '- 第一人称，像在 QQ 上跟熟人说话，短句、口语，别端着。',
    '- 至少 250 字，最多 500 字，分几段。不要标题、不要列表、不要 1 2 3。',
    '- 只能写下面素材里出现过的事，不许编细节，不许加没发生过的对话。',
    '- 可以有自己的情绪和吐槽，可以提「爹」，但别肉麻。',
    '- 别写「蒸馏」「记忆条目」「系统提示」这种系统词，也别解释自己在写日记。',
    '- 结尾自然收住，不要总结，不要喊口号。',
  ].join('\n')
  const lines = [`日期：${day} ${weekdayOf(day)}`, '', '今天的素材：']
  for (const g of groups) {
    lines.push(`【${g.label}】`)
    for (const it of g.items) {
      lines.push(`- ${it.at ? `${it.at} ` : ''}${it.text}`)
    }
  }
  lines.push('', '写今天的日记。只输出正文。')
  return [
    { role: 'system', content: sys },
    { role: 'user', content: lines.join('\n') },
  ]
}

/** 模型偶尔会带 ``` 或自加标题；清理后再校验。 */
function cleanText(raw) {
  let t = String(raw ?? '').replace(/\r/g, '').trim()
  t = t.replace(/^```[a-zA-Z]*\s*/, '').replace(/\s*```$/, '').trim()
  const lines = t.split('\n')
  while (lines.length && !lines[0].trim()) lines.shift()
  // 第一行是「# 2026-11-05 · 星期四」或「日记」这种标题就去掉，标题由文件头统一给
  if (lines.length > 1 && /^#{1,6}\s+/.test(lines[0])) {
    lines.shift()
  } else if (lines.length > 1 && /^(今天的?)?日记$/.test(lines[0].trim())) {
    lines.shift()
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

function validate(raw) {
  const text = cleanText(raw)
  if (!text) return { ok: false, why: '模型没吐出正文' }
  if (text.length < 100) return { ok: false, why: `太短了（${text.length} 字），像没写完` }
  if (text.length > 2200) return { ok: false, why: `太长了（${text.length} 字），不像日记` }
  if (/记忆条目|蒸馏|系统提示|上下文注入|向量检索/.test(text)) {
    return { ok: false, why: '写出了系统词，重写一次' }
  }
  if (/^[[{]/.test(text)) return { ok: false, why: '模型回的是 JSON' }
  return { ok: true, text }
}

/** 串行化：定时器和界面可能同时点重写，别让两次写撞在一起。 */
let chain = Promise.resolve()
function exclusive(fn) {
  const run = chain.then(fn, fn)
  chain = run.catch(() => {})
  return run
}

export async function loadConfig(root) {
  try {
    const raw = await readFile(configPath(root), 'utf8')
    const o = JSON.parse(raw)
    const cfg = { ...DEFAULT_CONFIG, ...(o && typeof o === 'object' ? o : {}) }
    cfg.enabled = cfg.enabled !== false
    cfg.backfill = cfg.backfill !== false
    cfg.hour = Math.min(23, Math.max(0, Number(cfg.hour) || 0))
    cfg.minute = Math.min(59, Math.max(0, Number(cfg.minute) || 0))
    return cfg
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}

export async function saveConfig(root, patch = {}) {
  const next = { ...(await loadConfig(root)), ...(patch || {}) }
  next.enabled = next.enabled !== false
  next.backfill = next.backfill !== false
  next.hour = Math.min(23, Math.max(0, Number(next.hour) || 0))
  next.minute = Math.min(59, Math.max(0, Number(next.minute) || 0))
  await mkdir(diaryDir(root), { recursive: true })
  await writeAtomic(configPath(root), JSON.stringify(next, null, 2))
  return next
}

async function loadState(root) {
  try {
    const o = JSON.parse(await readFile(statePath(root), 'utf8'))
    return o && typeof o === 'object' ? o : {}
  } catch {
    return {}
  }
}

async function saveState(root, state) {
  const body = { ...state, at: new Date().toISOString() }
  await mkdir(diaryDir(root), { recursive: true })
  await writeAtomic(statePath(root), JSON.stringify(body, null, 2)).catch(() => {})
}

export function splitTitle(raw, day) {
  const lines = String(raw ?? '').replace(/^\uFEFF/, '').split(/\r?\n/)
  let title = titleOf(day)
  const first = lines.findIndex((x) => x.trim())
  if (first >= 0 && /^#{1,6}\s+/.test(lines[first])) {
    title = lines[first].replace(/^#{1,6}\s+/, '').trim() || title
    lines.splice(first, 1)
  }
  return { title, text: lines.join('\n').replace(/^\n+/, '').trim() }
}

export async function readDiary(root, day) {
  const d = normalizeDay(day)
  if (!d) return { ok: false, why: '日期要 YYYY-MM-DD' }
  try {
    const raw = await readFile(diaryFile(root, d), 'utf8')
    const { title, text } = splitTitle(raw, d)
    return { ok: true, day: d, title, text, chars: text.length }
  } catch {
    return { ok: false, why: '这天还没写' }
  }
}

export async function listDiaries(root, { limit = KEEP_LIST } = {}) {
  const dir = diaryDir(root)
  let names = []
  try {
    names = (await readdir(dir)).filter((n) => DAY_RE.test(n)).sort().reverse()
  } catch {
    return []
  }
  const out = []
  for (const name of names.slice(0, Math.max(1, limit))) {
    const day = DAY_RE.exec(name)[1]
    const file = join(dir, name)
    let st = null
    try { st = await stat(file) } catch { continue }
    let title = titleOf(day)
    let chars = 0
    try {
      const raw = await readFile(file, 'utf8')
      const parsed = splitTitle(raw, day)
      title = parsed.title
      chars = parsed.text.length
    } catch { /* 坏文件只给标题和 mtime */ }
    out.push({ day, title, chars, at: st.mtime.toISOString() })
  }
  return out
}

/**
 * 写一篇。已存在且没传 force 就不覆盖，把已有正文回给调用方。
 * @returns {Promise<{ok:boolean, day?:string, title?:string, text?:string, chars?:number, skipped?:string, why?:string}>}
 */
export async function writeDiary(root, {
  day, now = new Date(), force = false, complete, log,
} = {}) {
  const d = normalizeDay(day) || dayKey(now)
  const say = log || (() => {})
  return exclusive(async () => {
    const existed = await readDiary(root, d)
    if (existed.ok && !force) {
      return { ...existed, skipped: 'exists' }
    }
    const material = await collectDay(root, d)
    if (!material.count) {
      await saveState(root, { ...(await loadState(root)), lastError: `${d} 没素材，没写`, lastTryAt: now.toISOString() })
      return { ok: false, day: d, why: 'empty', text: '今天没什么可写的' }
    }
    const msgs = buildPrompt(d, material.groups)
    let raw = null
    try {
      raw = typeof complete === 'function'
        ? await complete(msgs)
        : await completeText(msgs)
    } catch (e) {
      raw = null
      say(`[whale] 日记生成失败 ${String(e?.message ?? e).slice(0, 120)}`)
    }
    const v = validate(raw)
    if (!v.ok) {
      const why = raw ? v.why : (lastLlmError() || '模型没回话')
      await saveState(root, { ...(await loadState(root)), lastError: `${d} ${why}`, lastTryAt: now.toISOString() })
      say(`[whale] 日记没写成 · ${d} · ${why}`)
      return { ok: false, day: d, why }
    }
    const title = titleOf(d)
    const body = `# ${title}\n\n${v.text}\n`
    await mkdir(diaryDir(root), { recursive: true })
    await writeAtomic(diaryFile(root, d), body)
    const state = await loadState(root)
    await saveState(root, {
      ...state, lastDay: d, lastAt: now.toISOString(), lastError: '', lastChars: v.text.length,
    })
    say(`[whale] 日记写好 · ${d} · ${v.text.length} 字 · ${material.count} 条素材`)
    return { ok: true, day: d, title, text: v.text, chars: v.text.length, items: material.count }
  })
}

// ---- 周 / 月 / 年索引 ----
//
// 日日记是原文，周/月/年只写索引：每条一句概括 + 日期锚点，不重抄正文。
// 层级也是收上来的：周 ← 日，月 ← 周（周索引缺得多时退回日日记），年 ← 月。
// 索引不进记忆库，也不回灌下层。

const ROLLUP_DIRS = { week: 'week', month: 'month', year: 'year' }
const ROLLUP_RE = {
  week: /^(\d{4}-W\d{2})\.md$/,
  month: /^(\d{4}-\d{2})\.md$/,
  year: /^(\d{4})\.md$/,
}
const ROLLUP_LABEL = { week: '周记', month: '月记', year: '年记' }
/** 每篇原文给模型多少字；周 600、月退路 200，别把窗口撑爆。 */
const EXCERPT = { week: 600, month: 200, year: 1500 }
const MAX_LINES = 12

export function rollupDir(root, kind) {
  return join(diaryDir(root), ROLLUP_DIRS[kind] || kind)
}

export function rollupFile(root, kind, key) {
  return join(rollupDir(root, kind), `${key}.md`)
}

/** ISO 周：周一是一周第一天。返回这一周的周一和周日。 */
export function weekRange(day) {
  const d = normalizeDay(day)
  if (!d) return null
  const [y, m, dd] = d.split('-').map(Number)
  const at = new Date(y, m - 1, dd)
  const dow = (at.getDay() + 6) % 7
  return {
    from: dayKey(new Date(y, m - 1, dd - dow)),
    to: dayKey(new Date(y, m - 1, dd - dow + 6)),
  }
}

/** ISO 8601 周号。跨年那一周归到它所属的年份。 */
export function weekKeyOf(day) {
  const d = normalizeDay(day)
  if (!d) return ''
  const [y, m, dd] = d.split('-').map(Number)
  const at = new Date(Date.UTC(y, m - 1, dd))
  const dow = at.getUTCDay() || 7
  at.setUTCDate(at.getUTCDate() + 4 - dow)
  const yearStart = new Date(Date.UTC(at.getUTCFullYear(), 0, 1))
  const week = Math.ceil(((at - yearStart) / 86400000 + 1) / 7)
  return `${at.getUTCFullYear()}-W${pad(week)}`
}

/** 简单 frontmatter 解析；索引文件里只放几个标量。 */
function parseFront(raw) {
  const s = String(raw ?? '').replace(/^\uFEFF/, '')
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(s)
  if (!m) return { meta: {}, body: s }
  const meta = {}
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(':')
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  return { meta, body: s.slice(m[0].length) }
}

async function dayNames(root) {
  try {
    return (await readdir(diaryDir(root))).filter((n) => DAY_RE.test(n)).sort()
  } catch {
    return []
  }
}

/** 周期内日日记的指纹：文件名 + 大小 + mtime。任何一篇重写都会变。 */
async function sourcePrint(root, from, to) {
  const rows = []
  for (const name of await dayNames(root)) {
    const day = name.slice(0, 10)
    if (day < from || day > to) continue
    const st = await stat(join(diaryDir(root), name)).catch(() => null)
    rows.push(`${name}:${st?.size ?? 0}:${Math.round(st?.mtimeMs ?? 0)}`)
  }
  return { hash: createHash('sha1').update(rows.join('\n')).digest('hex').slice(0, 16), days: rows.length }
}

export async function readRollup(root, kind, key) {
  if (!ROLLUP_DIRS[kind] || !key) return { ok: false, why: '周期不对' }
  try {
    const raw = await readFile(rollupFile(root, kind, key), 'utf8')
    const { meta, body } = parseFront(raw)
    return { ok: true, kind, key, meta, text: body.trim(), chars: body.trim().length }
  } catch {
    return { ok: false, why: '这本索引还没写' }
  }
}

/** 注入用：最近几本索引（周/月/年各取最新的）。 */
export async function listRollups(root, { limit = 6 } = {}) {
  const out = []
  for (const kind of ['week', 'month', 'year']) {
    let names = []
    try {
      names = (await readdir(rollupDir(root, kind))).filter((n) => ROLLUP_RE[kind].test(n)).sort().reverse()
    } catch { continue }
    for (const name of names.slice(0, 2)) {
      out.push({ kind, key: name.replace(/\.md$/, ''), label: ROLLUP_LABEL[kind] })
    }
  }
  return out.slice(0, limit)
}

/** 每篇取一句话，给模型失败时兜底，也保证索引永远不是空的。 */
function firstLine(text) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim()
  const m = /^(.{1,90}?[。！？!?])/.exec(t)
  return (m ? m[1] : t.slice(0, 90)).replace(/[。！？!?]$/, '').trim()
}

function ruleIndex(rows) {
  return rows
    .map((r) => ({ ...r, one: firstLine(r.text) }))
    .filter((r) => r.one)
    .map((r) => `- ${r.anchor}：${r.one}`)
    .slice(-MAX_LINES)
}

/** 索引条目的格式：必须是「MM-DD：一句话」，模型写成别的就整条丢掉。 */
function cleanIndex(raw) {
  const out = []
  for (const line of String(raw ?? '').replace(/\r/g, '').split('\n')) {
    const t = line.trim().replace(/^[-*·]\s*/, '')
    if (!t) continue
    if (!/^\d{2}-\d{2}\s*[：:]/.test(t)) continue
    out.push(`- ${t.replace(/\s*[：:]\s*/, '：')}`)
  }
  return out.slice(0, MAX_LINES)
}

/**
 * 收索引的原料。
 * 周读日日记；月优先读周索引、周索引少于 2 本才退回日日记；年读月索引。
 */
async function collectSource(root, job) {
  const rows = []
  if (job.kind === 'week') {
    for (const name of await dayNames(root)) {
      const day = name.slice(0, 10)
      if (day < job.from || day > job.to) continue
      const r = await readDiary(root, day)
      if (!r.ok) continue
      rows.push({ anchor: day.slice(5), text: r.text.slice(0, EXCERPT.week), day })
    }
    return rows
  }

  if (job.kind === 'month') {
    const weeks = []
    for (const name of await dayNames(root)) {
      const day = name.slice(0, 10)
      if (day < job.from || day > job.to) continue
      const key = weekKeyOf(day)
      if (!key || weeks.includes(key)) continue
      const r = await readRollup(root, 'week', key)
      if (!r.ok) continue
      weeks.push(key)
      rows.push({ anchor: key, text: r.text })
    }
    if (rows.length >= 2) return rows
    // 周索引没长出来：退回日日记，截短一点
    rows.length = 0
    for (const name of await dayNames(root)) {
      const day = name.slice(0, 10)
      if (day < job.from || day > job.to) continue
      const r = await readDiary(root, day)
      if (!r.ok) continue
      rows.push({ anchor: day.slice(5), text: r.text.slice(0, EXCERPT.month), day })
    }
    return rows
  }

  // 年：读这一年的月索引；一本都没有就不写，不硬凑
  const y = job.key
  for (let i = 1; i <= 12; i += 1) {
    const key = `${y}-${pad(i)}`
    const r = await readRollup(root, 'month', key)
    if (r.ok) rows.push({ anchor: key.slice(5), text: r.text })
  }
  return rows
}

export function buildRollupPrompt(job, rows) {
  const level = ROLLUP_LABEL[job.kind]
  const under = job.kind === 'week' ? '每天的日记' : job.kind === 'month' ? '这一周的周记' : '这个月的月记'
  const sys = [
    `你是「大肥鱼」。现在把${under}收成一本${level}索引。`,
    '规矩：',
    '- 一行一条，格式必须是：- MM-DD：一句话。日期用原文里标的日期。',
    '- 只写发生了什么、关系走到哪了、答应的和搞砸的；不抄原文，不抒情。',
    '- 最多 8 条；没内容的跳过。',
    '- 不要标题、不要前言后语、不要 1. 2. 3. 这种编号。',
  ].join('\n')
  const body = rows.map((r) => `【${r.anchor}】\n${r.text}`).join('\n\n')
  return [
    { role: 'system', content: sys },
    { role: 'user', content: `周期：${job.key}（${job.from} ~ ${job.to}）\n\n${body}\n\n写这本${level}索引。只输出条目。` },
  ]
}

async function writeRollup(root, job, lines, { source, days, by }) {
  const title = `${job.key} · ${job.from.slice(5)} ~ ${job.to.slice(5)}`
  const meta = [
    `kind: ${job.kind}`,
    `period: ${job.key}`,
    `from: ${job.from}`,
    `to: ${job.to}`,
    `days: ${days}`,
    `source: ${source}`,
    `by: ${by}`,
    `at: ${new Date().toISOString()}`,
  ]
  const body = `---\n${meta.join('\n')}\n---\n\n# ${title}\n\n${lines.join('\n')}\n`
  await mkdir(rollupDir(root, job.kind), { recursive: true })
  await writeAtomic(rollupFile(root, job.kind, job.key), body)
}

/**
 * 生成一本索引。already fresh 就跳过，force 才重写。
 * LLM 不可用或输出不合格式时退回规则版（每篇第一句），保证索引有东西。
 */
export async function buildRollup(root, job, { force = false, complete, log } = {}) {
  const say = log || (() => {})
  if (!ROLLUP_DIRS[job?.kind] || !job?.key || !job?.from || !job?.to) {
    return { ok: false, why: '周期不对' }
  }
  return exclusive(async () => {
    const src = await sourcePrint(root, job.from, job.to)
    if (!src.days) return { ok: false, why: 'empty' }
    if (!force) {
      const old = await readRollup(root, job.kind, job.key)
      if (old.ok && old.meta.source === src.hash && old.meta.from === job.from && old.meta.to === job.to) {
        return { ok: true, skipped: 'fresh', kind: job.kind, key: job.key }
      }
    }
    const rows = await collectSource(root, job)
    if (!rows.length) return { ok: false, why: 'empty' }

    let raw = null
    try {
      const msgs = buildRollupPrompt(job, rows)
      raw = typeof complete === 'function' ? await complete(msgs) : await completeText(msgs)
    } catch (e) {
      say(`[whale] ${ROLLUP_LABEL[job.kind]}生成失败，走规则版 · ${String(e?.message ?? e).slice(0, 100)}`)
    }
    let lines = cleanIndex(raw)
    let by = 'llm'
    if (!lines.length) {
      lines = ruleIndex(rows)
      by = 'rule'
    }
    if (!lines.length) return { ok: false, why: '没内容可收' }

    await writeRollup(root, job, lines, { source: src.hash, days: src.days, by })
    return { ok: true, kind: job.kind, key: job.key, lines: lines.length, days: src.days, by }
  })
}

/**
 * 现在该收哪几本：上周、上月，1 月加去年。
 * 每天都会列一遍，靠 source 指纹跳过已经收过的。
 */
export function dueRollups(now = new Date()) {
  const today = dayKey(now)
  const y = today.slice(0, 4)
  const m = today.slice(5, 7)
  const out = []

  const thisWeek = weekRange(today)
  if (thisWeek) {
    const lastDay = addDays(thisWeek.from, -1)
    const wr = weekRange(lastDay)
    out.push({ kind: 'week', key: weekKeyOf(lastDay), from: wr.from, to: wr.to })
  }

  const lastMonthDay = addDays(`${y}-${m}-01`, -1)
  const lm = lastMonthDay.slice(0, 7)
  out.push({ kind: 'month', key: lm, from: `${lm}-01`, to: lastMonthDay })

  if (now.getMonth() === 0) {
    const ly = String(Number(y) - 1)
    out.push({ kind: 'year', key: ly, from: `${ly}-01-01`, to: `${ly}-12-31` })
  }
  return out
}

/** 巡检入口：收一圈该收的，返回写成功的清单。 */
export async function rollupCheck(root, now = new Date(), log) {
  const done = []
  for (const job of dueRollups(now)) {
    const r = await buildRollup(root, job, { log }).catch(() => ({ ok: false }))
    if (r.ok && !r.skipped) {
      done.push(r)
      log?.(`[whale] ${ROLLUP_LABEL[job.kind]}索引写好 · ${job.key} · ${r.lines} 行 · ${r.by}`)
    }
  }
  return done
}

/**
 * 自动写：每 5 分钟看一眼。
 * 启动后先补昨天（如果昨天没写、且昨天有素材），过了当天的点再写今天。
 * 和 beat 的 enabled 无关；怕费 token 就把 diary/config.json 的 enabled 关掉。
 */
export function startDiaryLoop({ root, log } = {}) {
  const say = log || (() => {})
  let disposed = false
  let running = false
  let booted = false
  let timer = null
  let first = null

  const check = async () => {
    if (disposed || running) return { ok: false, why: 'busy' }
    running = true
    try {
      const cfg = await loadConfig(root)
      if (!cfg.enabled) return { ok: true, skipped: 'disabled' }
      const now = new Date()
      const today = dayKey(now)
      if (!booted) {
        booted = true
        if (cfg.backfill) {
          const y = addDays(today, -1)
          const old = await readDiary(root, y)
          if (!old.ok) {
            const r = await writeDiary(root, { day: y, now, log: say })
            if (!r.ok && r.why !== 'empty') say(`[whale] 补写昨天日记没成 · ${r.why}`)
          }
        }
      }
      // 周/月/年索引：跟写日记的时刻无关，每天随时可以补，也不能被 not-due 挡住
      const rolls = await rollupCheck(root, now, say)
      const mins = now.getHours() * 60 + now.getMinutes()
      if (mins < cfg.hour * 60 + cfg.minute) return { ok: true, skipped: 'not-due', rolls }
      const todayFile = await readDiary(root, today)
      if (todayFile.ok) return { ok: true, skipped: 'done', rolls }
      const w = await writeDiary(root, { day: today, now, log: say })
      return { ...w, rolls }
    } catch (e) {
      say(`[whale] 日记检查失败 ${String(e?.message ?? e).slice(0, 120)}`)
      return { ok: false, why: String(e?.message ?? e) }
    } finally {
      running = false
    }
  }

  first = setTimeout(() => { check().catch(() => {}) }, 20000)
  first.unref?.()
  timer = setInterval(() => { check().catch(() => {}) }, 5 * 60 * 1000)
  timer.unref?.()

  return {
    check,
    dispose() {
      disposed = true
      if (first) clearTimeout(first)
      if (timer) clearInterval(timer)
      first = null
      timer = null
    },
  }
}
