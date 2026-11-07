/**
 * inbound-bili.js —— B站鱼塘账本的适配器（inbound.js 的一个 provider）
 *
 * 历史：这套同步原来直接写在 inbound.js 里，路径、字段名、目标分片全写死。
 * 现在只留「怎么把 B站的一行翻译成通用条目」，其余的读取/水位/去重/落盘
 * 全交给 inbound.js。新插件照这个文件再写一份即可，不用碰引擎。
 *
 * bili-pond 跑在 headless profile 里，不装本插件，所以只能拉、不能推：
 * 它照旧写 $DSH_HOME/bili-duty/memory.jsonl，本插件按字节水位读新增行；
 * 日记目录 diary/<日期>.md 一天一篇、当天可被覆盖重写，走按天 upsert：
 * 同一天只留一条记忆，改一次更一次，不会攒出一串半成品。
 *
 * 关闭：DSH_MEMORY_BILI_SYNC=off / 0 / false。
 * 账本位置：BILI_DUTY_HOME（优先）→ DSH_HOME/bili-duty。
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { addItem, auditWrite, loadScope, withWriteLock, writeAtomic } from './store.js'
import { reindexScope } from './maintain.js'

export const SOURCE = 'bili-duty'
export const DIARY_SOURCE = 'bili-diary'
// B站观察是网上学到的公开内容，进公共池：群聊、私聊都能读，但只有本机能写
export const TARGET = { kind: 'public', id: 'web' }

function dshHome() {
  return String(process.env.DSH_HOME || join(homedir(), '.dsh')).replace(/\\/g, '/').replace(/\/+$/, '')
}

/** B站账本。bili-pond 用 BILI_DUTY_HOME 指向它的数据目录，优先认这个。 */
export function ledgerFile() {
  const home = String(process.env.BILI_DUTY_HOME || '').trim() || join(dshHome(), 'bili-duty')
  return join(home, 'memory.jsonl')
}

/** 水位 + 已见正文 hash。文件名保持旧值，升级后不会从头再读一遍。 */
export function stateFile(root) {
  return join(root, 'inbox', `${SOURCE}.json`)
}

/** 默认开；开关只关这一路，不影响别的 provider。 */
function enabled() {
  const v = String(process.env.DSH_MEMORY_BILI_SYNC ?? 'on').toLowerCase()
  return !(v === 'off' || v === '0' || v === 'false')
}

/**
 * provider 规格（由 inbound.js 消费）：
 *   parse 只负责「一行 JSON → 通用条目」，时间解析用引擎给的 toIso。
 *   返回 null = 这行不要（坏行/空行）。
 */
export function biliProvider({ target = TARGET } = {}) {
  return {
    id: 'bili',
    label: 'B站鱼塘',
    enabled,
    target,
    missing: 'no-ledger',
    files: () => [{ file: ledgerFile(), token: 'ledger' }],
    statePath: (root) => stateFile(root),
    defaults: {
      kind: 'fact',
      // 比模型主动记的（0.6）低一档：B站观察是外部情报，不该压过用户自己的事
      conf: 0.5,
      source: 'bili',
      state: 'active', // 外部观察不走 gate：gate 拦的是「把用户随口话当偏好」
    },
    parse(row, { toIso } = {}) {
      const text = String(row?.t ?? '').trim()
      if (!text) return null
      const bvid = String(row?.bv ?? '').trim()
      return {
        text,
        quote: String(row?.why ?? '').trim(),
        refs: bvid ? [`B站 ${bvid}`] : [],
        at: toIso?.(row?.d) ?? '',
        source: 'bili',
      }
    },
  }
}

// ---- 值班日记 ----
// 与账本不同：日记不是追加行，而是「一天一篇、当天覆盖写」。所以不进字节水位，
// 按日期取整篇正文 + 正文 hash，改写后更新同一条记忆，不新增。

const DIARY_RE = /^(\d{4}-\d{2}-\d{2})\.md$/
const MAX_DIARY_CHARS = 2000
const KEEP_DAYS = 120

/** 日记目录。和账本同一个数据目录。 */
export function diaryDir() {
  const home = String(process.env.BILI_DUTY_HOME || '').trim() || join(dshHome(), 'bili-duty')
  return join(home, 'diary')
}

/** 已入库的日期 → 正文 hash / 条目 id。 */
export function diaryStateFile(root) {
  return join(root, 'inbox', `${DIARY_SOURCE}.json`)
}

/** 标题行去掉、折成一行：记忆条目不需要 Markdown 结构。 */
function diaryText(raw) {
  const lines = String(raw ?? '')
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((line) => line
      .replace(/^\s*#{1,6}\s+/, '')
      .replace(/^\s*[-*•]\s+/, '') // 列表符号不进正文，折成一句时只会添乱
      .trim())
  // 首行是「2026-11-06 · 值班日记」这种标题就不进正文，日期由 ref 带上
  const first = lines.findIndex(Boolean)
  if (first >= 0 && /^\d{4}-\d{2}-\d{2}\s*[·\-—]?\s*(值班)?日记$/.test(lines[first])) {
    lines.splice(first, 1)
  }
  const text = lines.join(' ').replace(/\s+/g, ' ').trim()
  return text.length > MAX_DIARY_CHARS ? `${text.slice(0, MAX_DIARY_CHARS - 1)}…` : text
}

/** 日记只有日期没有时刻：直接存 YYYY-MM-DD，别用零点换算成 UTC 倒退一天。 */
function dayAt(day) {
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : ''
}

async function loadDiaryState(file) {
  try {
    const o = JSON.parse(await readFile(file, 'utf8'))
    return { days: o?.days && typeof o.days === 'object' ? o.days : {} }
  } catch {
    return { days: {} }
  }
}

async function saveDiaryState(file, state) {
  // 只留最近 KEEP_DAYS 天：旧日期不会再改写，留着只是占状态文件
  const days = Object.fromEntries(
    Object.entries(state.days).sort(([a], [b]) => a.localeCompare(b)).slice(-KEEP_DAYS),
  )
  const body = JSON.stringify({ days, at: new Date().toISOString() }, null, 2)
  await mkdir(dirname(file), { recursive: true }).catch(() => {})
  await writeAtomic(file, body).catch(() => {})
}

/**
 * 扫一遍日记目录，把新增/改写过的日记 upsert 进目标分片。
 * 返回 { ok, added, updated, bad }：added 是新的一天，updated 是当天改写。
 */
export async function syncBiliDiaries(root, { target = TARGET, log = () => {}, dir } = {}) {
  const folder = dir || diaryDir()
  let names = []
  try {
    names = (await readdir(folder)).filter((n) => DIARY_RE.test(n)).sort()
  } catch {
    return { ok: true, added: 0, skipped: 'no-diary' }
  }
  if (!names.length) return { ok: true, added: 0, skipped: 'no-diary' }

  const stFile = diaryStateFile(root)
  const state = await loadDiaryState(stFile)
  const pending = []
  for (const name of names) {
    const day = DIARY_RE.exec(name)[1]
    let raw
    try {
      raw = await readFile(join(folder, name), 'utf8')
    } catch {
      continue
    }
    const text = diaryText(raw)
    if (!text) continue
    const hash = createHash('sha1').update(text).digest('hex')
    if (state.days[day]?.hash === hash) continue
    pending.push({ day, text, hash })
  }
  if (!pending.length) return { ok: true, added: 0, updated: 0 }

  let added = 0
  let updated = 0
  await withWriteLock(async () => {
    const sc = await loadScope(root, target.kind, target.id)
    for (const p of pending) {
      const ref = `B站值班日记 ${p.day}`
      const existing = (sc.items || []).find((x) => Array.isArray(x.refs) && x.refs.includes(ref))
      if (existing) {
        existing.text = `值班日记 ${p.day}：${p.text}`
        existing.sourceQuote = `B站值班日记 · ${p.day}`
        existing.observedAt = dayAt(p.day)
        existing.lastHit = new Date().toISOString()
        p.id = existing.id
        updated += 1
        continue
      }
      const item = addItem(sc, {
        text: `值班日记 ${p.day}：${p.text}`,
        kind: 'event',
        conf: 0.5,
        source: DIARY_SOURCE,
        sourceQuote: `B站值班日记 · ${p.day}`,
        refs: [ref],
        observedAt: dayAt(p.day),
        state: 'active',
      })
      if (!item) continue
      // addItem 可能并进一条相近的旧条目：补上 ref，下一轮才认得出这一天
      if (!Array.isArray(item.refs)) item.refs = []
      if (!item.refs.includes(ref)) item.refs.push(ref)
      p.id = item.id
      added += 1
    }
    await reindexScope(root, sc).catch(() => {})
  })

  for (const p of pending) {
    if (!p.id) continue
    state.days[p.day] = { hash: p.hash, id: p.id, at: new Date().toISOString() }
  }
  await saveDiaryState(stFile, state)
  await auditWrite(root, {
    kind: 'inbound',
    source: DIARY_SOURCE,
    scope: `${target.kind}:${target.id}`,
    file: 'diary',
    added,
    merged: updated,
    bad: 0,
  }).catch(() => {})

  if (added || updated) {
    log(`[whale] B站值班日记 入库 +${added}${updated ? ` · 更新 ${updated}` : ''}`)
  }
  return { ok: true, added, updated, merged: updated, bad: 0 }
}

/**
 * 日记 provider：交给引擎调度，但自己管「按天 upsert」。
 * 引擎见 sync() 就不再走字节水位/JSONL 那一套。
 */
export function biliDiaryProvider({ target = TARGET } = {}) {
  return {
    id: DIARY_SOURCE,
    label: 'B站值班日记',
    enabled,
    target,
    missing: 'no-diary',
    sync: (root, { log } = {}) => syncBiliDiaries(root, { target, log }),
  }
}
