/**
 * diary.js —— 大肥鱼自己的日记
 *
 * 每天把「当天新记的 + 当天又被想起来的」记忆收一收，让她用自己的口吻写成
 * 一篇日记，落在 <root>/diary/YYYY-MM-DD.md。
 *
 * 边界：
 *   - 日记不回灌记忆库，不然第二天写的又是前一天的日记，慢慢变成复读机。
 *   - 没有素材就不写，宁可空着，也不让模型编。
 *   - 生成走设置页配的 LLM；未配或失败只报错，不落半成品。
 *   - 自动写与 beat 解耦：beat 的静默/专注/投递额度不该管日记。
 */

import { mkdir, readFile, readdir, stat } from 'node:fs/promises'
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
      const mins = now.getHours() * 60 + now.getMinutes()
      if (mins < cfg.hour * 60 + cfg.minute) return { ok: true, skipped: 'not-due' }
      const todayFile = await readDiary(root, today)
      if (todayFile.ok) return { ok: true, skipped: 'done' }
      return await writeDiary(root, { day: today, now, log: say })
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
