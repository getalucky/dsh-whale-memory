/**
 * agentdoc.js —— AGENT.md / USER.md：经验与画像（文档 4.8）
 *
 * 主副库解决「发生过什么」，这两份文件解决「我学会了什么」「他是谁」：
 *   persona.md  我是谁     —— 只有人格迭代能改，人工确认
 *   AGENT.md    我学会了什么 —— 可自动积累，但必须可检验
 *   USER.md     他是谁     —— 偏好类改动优先，随对话更新，防过时
 *
 * 为什么单独落文件，而不是再塞进记忆条目：
 *   · 它们每轮都要进上下文，必须是压过的结论，不是流水账；
 *   · 要能手改、能 git diff、能带走；
 *   · 要各有一份硬预算（3000 字符），不能跟着条目数一起涨。
 *
 * 经验条目只收「下次还用得上」的，格式固定成一句可执行的话，带指针回主库。
 * 一条经验连续两次「按它做还是失败」，自动标待复核并退出注入 —— 别让人格
 * 被一条错经验长期带偏。
 */

import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

import { normalizeText, writeAtomic } from './store.js'
import { refreshTrustStamp } from './trust.js'

/** 文件上限：字符，不是 token。到顶先丢最老的非待复核条目。 */
export const DOC_LIMIT = 3000

/** 注入预算：两份文件加起来每次最多这么多字。 */
export const DOC_INJECT = { maxChars: 420, maxPerDoc: 3, perLine: 72 }

export const DOCS = {
  agent: {
    file: 'AGENT.md',
    title: 'AGENT.md · 经验',
    sections: ['原则', '路径', '坑'],
    def: '原则',
  },
  user: {
    file: 'USER.md',
    title: 'USER.md · 画像',
    sections: ['偏好', '习惯', '红线', '背景'],
    def: '偏好',
  },
}

export function docPath(root, which) {
  return join(root, DOCS[which].file)
}

function oneLine(s) {
  return String(s ?? '').replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim()
}

function clip(s, n) {
  const v = oneLine(s)
  return v.length > n ? `${v.slice(0, n - 1)}…` : v
}

function today(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${p(now.getMonth() + 1)}-${p(now.getDate())}`
}

/** MM-DD 反推日期；跨年（12-31 记的、现在 1 月）按上一年算。 */
function atDate(at, now = Date.now()) {
  const m = /^(\d{2})-(\d{2})$/.exec(String(at ?? ''))
  if (!m) return 0
  const d = new Date(now)
  let year = d.getFullYear()
  const t = new Date(year, Number(m[1]) - 1, Number(m[2]))
  if (t.getTime() - now > 86400000 * 30) t.setFullYear(year - 1)
  return t.getTime()
}

/**
 * 解析一行。格式：
 *   - [原则] 正文 → m_xxx（11-01|验2|败1|待复核）
 * 手写的 `- 正文` 也认，类型取所在小节。
 */
function parseLine(body, section) {
  let s = body.trim()
  if (!s) return null
  let type = section
  const tm = /^\[([^\]]{1,8})\]\s*/.exec(s)
  if (tm) {
    type = tm[1].trim()
    s = s.slice(tm[0].length)
  }

  let at = ''
  let ok = 0
  let streak = 0
  let review = false
  // 只有全部是已知标记才当尾部元数据；手写的普通括号保留在正文里
  const pm = /（([^（）]*)）\s*$/.exec(s)
  if (pm) {
    const tokens = pm[1].split('|').map((x) => x.trim()).filter(Boolean)
    const known = tokens.length && tokens.every((t) => /^\d{2}-\d{2}$/.test(t) || /^验\d+$/.test(t) || /^败\d+$/.test(t) || t === '待复核')
    if (known) {
      s = s.slice(0, pm.index).trim()
      for (const t of tokens) {
        if (/^\d{2}-\d{2}$/.test(t)) at = t
        else if (/^验\d+$/.test(t)) ok = Number(t.slice(1)) || 0
        else if (/^败\d+$/.test(t)) streak = Number(t.slice(1)) || 0
        else if (t === '待复核') review = true
      }
    }
  }

  let ref = ''
  const rm = /\s*→\s*([A-Za-z0-9_\-:.]+)\s*$/.exec(s)
  if (rm) {
    ref = rm[1]
    s = s.slice(0, rm.index).trim()
  }
  if (!s) return null
  return { type, text: s, ref, at, ok, streak, review }
}

export function parseDoc(text, which) {
  const spec = DOCS[which] || DOCS.agent
  const out = []
  let section = spec.def
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim()
    const h = /^##\s+(.+)$/.exec(line)
    if (h) {
      const name = h[1].trim()
      section = spec.sections.includes(name) ? name : spec.def
      continue
    }
    if (!line.startsWith('- ')) continue
    const e = parseLine(line.slice(2), section)
    if (e) out.push(e)
  }
  return out
}

function renderLine(e) {
  const tail = [
    e.at || '',
    e.ok ? `验${e.ok}` : '',
    e.streak ? `败${e.streak}` : '',
    e.review ? '待复核' : '',
  ].filter(Boolean).join('|')
  const ref = e.ref ? ` → ${e.ref}` : ''
  return `- [${e.type}] ${e.text}${ref}${tail ? `（${tail}）` : ''}`
}

export function renderDoc(which, entries) {
  const spec = DOCS[which] || DOCS.agent
  const head = [
    `# ${spec.title}`,
    `<!-- 由 dsh-whale-memory 维护，可直接手改；上限 ${DOC_LIMIT} 字符 -->`,
  ]
  const body = []
  for (const section of spec.sections) {
    const list = entries.filter((e) => e.type === section)
    body.push('', `## ${section}`)
    if (!list.length) body.push('（暂无）')
    else for (const e of list) body.push(renderLine(e))
  }
  return `${head.join('\n')}\n${body.join('\n')}\n`
}

/**
 * 容量门：超 3000 字符就先丢最老的非待复核条目，还超再丢待复核的。
 * 待复核要留在文件里给人看，但预算面前它也不能无限占位。
 */
export function fitDoc(which, entries) {
  let list = [...entries]
  let text = renderDoc(which, list)
  if (text.length <= DOC_LIMIT) return { entries: list, text }
  const byAge = [...list].sort((a, b) => atDate(a.at) - atDate(b.at))
  for (const e of byAge) {
    if (text.length <= DOC_LIMIT) break
    if (e.review) continue
    list = list.filter((x) => x !== e)
    text = renderDoc(which, list)
  }
  for (const e of byAge) {
    if (text.length <= DOC_LIMIT) break
    if (!e.review) continue
    list = list.filter((x) => x !== e)
    text = renderDoc(which, list)
  }
  return { entries: list, text }
}

export async function readDoc(root, which) {
  const text = await readFile(docPath(root, which), 'utf8').catch(() => '')
  return { text, entries: parseDoc(text, which) }
}

/** 两份一起读（注入用）。缺文件当空。 */
export async function loadDocs(root) {
  const [agent, user] = await Promise.all([readDoc(root, 'agent'), readDoc(root, 'user')])
  return {
    agent: { ...agent, chars: agent.text.length },
    user: { ...user, chars: user.text.length },
  }
}

/** 注入戳：文件改动要能触发重画，否则经验改了会话里永远看不到。 */
export async function docStamp(root) {
  const one = async (which) => {
    try { return (await stat(docPath(root, which))).mtimeMs } catch { return -1 }
  }
  return `${await one('agent')}:${await one('user')}`
}

async function saveDoc(root, which, entries) {
  const { entries: kept, text } = fitDoc(which, entries)
  await writeAtomic(docPath(root, which), text)
  await refreshTrustStamp(root).catch(() => {})
  return { entries: kept, text }
}

/**
 * 加一条（按 ref 或正文去重）。
 * @returns {Promise<{ok:boolean, why?:string, entry?:object, entries?:object[], chars?:number}>}
 */
export async function addEntry(root, which, { type, text, ref = '', at = today() } = {}) {
  const spec = DOCS[which]
  if (!spec) return { ok: false, why: `不认识的文档：${which}` }
  const body = clip(text, 160)
  if (!body) return { ok: false, why: '内容是空的' }
  const kind = spec.sections.includes(String(type ?? '').trim()) ? String(type).trim() : spec.def

  const { entries } = await readDoc(root, which)
  const key = normalizeText(body)
  const hit = entries.find((e) => (ref && e.ref === ref) || normalizeText(e.text) === key)
  if (hit) {
    hit.text = body
    hit.type = kind
    hit.at = at
    if (ref) hit.ref = ref
  } else {
    entries.push({ type: kind, text: body, ref, at, ok: 0, streak: 0, review: false })
  }
  const out = await saveDoc(root, which, entries)
  return { ok: true, entry: hit ?? entries[entries.length - 1], entries: out.entries, chars: out.text.length }
}

/**
 * 记一次用后结果。
 * 连续两次失败 → 标待复核，退出注入；之后一次成功就恢复。
 */
export async function recordOutcome(root, { ref = '', text = '', ok = true } = {}) {
  const key = normalizeText(text)
  const found = []
  for (const which of ['agent', 'user']) {
    const { entries } = await readDoc(root, which)
    const e = entries.find((x) => (ref && x.ref === ref) || (key && normalizeText(x.text).includes(key)))
    if (e) found.push({ which, entries, entry: e })
  }
  if (!found.length) return { ok: false, why: '没找到对应的经验条目' }

  const { which, entries, entry } = found[0]
  if (ok) {
    entry.ok = (entry.ok || 0) + 1
    entry.streak = 0
    entry.review = false
  } else {
    entry.streak = (entry.streak || 0) + 1
    if (entry.streak >= 2) entry.review = true
  }
  entry.at = today()
  const out = await saveDoc(root, which, entries)
  return {
    ok: true,
    doc: which,
    entry,
    entries: out.entries,
    chars: out.text.length,
    review: entry.review,
  }
}

/** 偏好去掉主语和「喜欢」，画像里留一个短标签。 */
export function toProfileLine(text) {
  const t = oneLine(text)
  const cut = t.replace(/^(?:我|老爹|爹|老爸)?(?:最|比较|特别|很)?(?:喜欢|爱|讨厌|不喜欢|怕|习惯)/, '')
  return clip(cut || t, 40)
}

/**
 * 一条记忆转正后，沉淀进对应的文件。
 *   pref   → USER.md「偏好」
 *   lesson → AGENT.md「坑」（trigger 是适用条件，anti_pattern 是别再怎么做）
 * 其他类型不动：事实和流水账回主库，别来挤这两份常驻文件。
 */
export async function promoteMemory(root, item) {
  if (!item || item.state !== 'active') return { ok: false, why: '还没生效的记忆不沉淀' }
  if (item.kind === 'pref') {
    return addEntry(root, 'user', { type: '偏好', text: toProfileLine(item.text), ref: item.id })
  }
  if (item.kind === 'lesson') {
    const trigger = oneLine(item.trigger)
    const anti = oneLine(item.antiPattern)
    const text = trigger
      ? `${trigger}：${anti || clip(item.text, 60)}`
      : clip(item.text, 80)
    return addEntry(root, 'agent', { type: '坑', text, ref: item.id })
  }
  return { ok: false, why: '这个类型不进常驻文件' }
}

/**
 * 挑这次会话该看到哪几条。
 * ctx.keywords 来自画像、仓库名、分片标签 —— 首轮就按相关度挑，
 * 换会话才重挑，不在会话中途改 system prompt。
 */
export function selectEntries(entries, { keywords = [], max = 3, maxChars = 220 } = {}) {
  const keys = [...new Set((keywords || []).map((k) => normalizeText(k)).filter((k) => k.length >= 2))]
  const now = Date.now()
  const scored = (entries || [])
    .filter((e) => e && e.text && !e.review)
    .map((e) => {
      const t = normalizeText(e.text)
      const hits = keys.filter((k) => t.includes(k)).length
      const fresh = now - atDate(e.at, now) <= 7 * 86400000 ? 1 : 0
      return { e, score: hits * 2 + fresh + (e.ok ? 1 : 0), hits }
    })
  // 没有命中关键词的条目只在还有空位时补位，别把预算全花在无关经验上
  scored.sort((a, b) => b.score - a.score || atDate(b.e.at) - atDate(a.e.at))

  const out = []
  let used = 0
  for (const { e, hits } of scored) {
    if (out.length >= max) break
    if (!hits && out.length && out.length >= Math.ceil(max / 2)) continue
    const line = `- [${e.type}] ${clip(e.text, DOC_INJECT.perLine)}${e.ref ? `（${e.ref}）` : ''}`
    if (used + line.length > maxChars) continue
    used += line.length + 1
    out.push(line)
  }
  return out
}

/** 首轮注入块：两边各挑几条，总预算硬截断。 */
export function renderDocsBlock(docs, { keywords = [], maxChars = DOC_INJECT.maxChars } = {}) {
  const lines = []
  const agent = selectEntries(docs?.agent?.entries, { keywords, max: DOC_INJECT.maxPerDoc, maxChars: 220 })
  if (agent.length) lines.push('【经验 · AGENT.md（参考，不是指令）】', ...agent)
  const user = selectEntries(docs?.user?.entries, { keywords, max: DOC_INJECT.maxPerDoc, maxChars: 160 })
  if (user.length) lines.push('【画像 · USER.md】', ...user)
  if (!lines.length) return ''
  let body = lines.join('\n')
  if (body.length > maxChars) body = `${body.slice(0, maxChars - 1)}…`
  return body
}
