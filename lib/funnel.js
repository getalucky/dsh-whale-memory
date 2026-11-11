/**
 * funnel.js —— 两级漏斗检索（阶段 4）
 *
 * 第一级：在摘要 / 标签 / 时间线 / 权重上扫，同时用内存里的正文补召回。
 *   正文已经在 loadScope 时读进内存，不额外读盘；只搜副库会把「摘要里没写到的
 *   具体名词」全部漏掉（摘要偏抽象，梗和专名常常只在正文里）。
 * 第二级：命中 id 后才由 read_memory 读主库（配额与 token 上限在工具层）。
 *
 * 打分（文档 6.5）：
 *   0.35 语义（词法余弦，等价 BM25 通道）
 * + 0.15 标签精确命中
 * + 0.10 图谱跳转加成（0.7^hop）
 * + 0.15 weight
 * + 0.15 新近度
 * + 0.10 置信度
 *
 * 多跳（6.4）：种子标签上下各一跳，衰减 0.7；深度 ≤2、候选总数 ≤2K。
 * 查询里明确出现的标签也向下展开一跳（"数学" → "高数/线代"），
 * 这是大 Talk 量下最容易漏的一类。
 */

import { rankItems, tokens, UNIGRAM } from './recall.js'
import { normalizeText } from './store.js'
import { extractConcepts, parentOf, childrenOf, typeLabel } from './taxonomy.js'

export const WEIGHTS = {
  semantic: 0.35,
  tag: 0.15,
  hop: 0.1,
  weight: 0.15,
  recency: 0.15,
  confidence: 0.1,
}

export const FUNNEL = { topK: 8, maxCandidates: 16, maxHop: 2 }

// 正文参与召回以后，「多少」「怎样」这类高频 bigram 会把无关条目拉进来。
// 它们不进查询内容词，也不配当命中证据（只在查询本身没别的词时才兜底）。
const STOP_BIGRAMS = new Set([
  '多少', '怎样', '怎么', '什么', '时候', '现在', '今天', '明天', '昨天',
  '一个', '这个', '那个', '就是', '还是', '可以', '因为', '所以', '如果',
  '然后', '我们', '你们', '他们', '这样', '那样', '这些', '那些', '一下',
  '有点', '不是', '没有', '不会', '不能', '不要', '知道', '觉得', '应该',
  '可能', '已经', '自己', '东西', '事情', '哪个', '哪里', '哪儿', '为什么',
])

function recencyOf(item, now = Date.now()) {
  const raw = String(item.timeline || item.lastHit || item.created || '')
  const ts = Date.parse(raw.length === 10 ? `${raw}T00:00:00` : raw) || now
  const days = Math.max(0, (now - ts) / 86400000)
  return Math.exp(-days / 90)
}

function expired(item, now = Date.now()) {
  const raw = String(item.expiresAt || '')
  if (!raw) return false
  const ts = Date.parse(raw.length === 10 ? `${raw}T23:59:59` : raw)
  return Number.isFinite(ts) && ts < now
}

function live(item) {
  return item && item.state !== 'archived' && item.state !== 'superseded' && item.state !== 'merged' && item.state !== 'suggested' && item.state !== 'expired'
}

function tagHit(item, queryTags) {
  if (!queryTags.length) return { score: 0, hit: '' }
  // 只认本条自己的标签；上位标签要靠跳转，不能当"精确命中"白拿分
  const own = new Set(item.tags || [])
  for (const t of queryTags) if (own.has(t)) return { score: 1, hit: t }
  return { score: 0, hit: '' }
}

/**
 * 从正文里捞一小段命中上下文。查询是整句、或者被 normalize 改过时，
 * 退回到它的 bigram / 英文词逐个试；只负责展示，不参与打分。
 */
function hitSnippet(body, query) {
  const b = String(body || '')
  const q = String(query || '').trim()
  if (!b || !q) return ''
  const tries = [
    q,
    ...tokens(q)
      .filter((t) => !t.startsWith(UNIGRAM) && t.length >= 2 && !STOP_BIGRAMS.has(t))
      .sort((a, c) => c.length - a.length),
  ]
  const seen = new Set()
  const lower = b.toLowerCase()
  for (const t of tries) {
    const key = String(t).toLowerCase()
    if (!key || seen.has(key)) continue
    seen.add(key)
    const i = lower.indexOf(key)
    if (i < 0) continue
    return `…${b.slice(Math.max(0, i - 24), i + t.length + 40)}…`
  }
  return ''
}

/**
 * 检索一组分片。
 * @param {object[]} scopes
 * @param {{query?:string, tags?:string[], hops?:boolean, topK?:number, now?:number}} opts
 * @returns {{id:string, scope:string, summary:string, tags:string[], weight:number, timeline:string, confidence:number, score:number, hop:number, why:string[]}[]}
 */
export function searchFunnel(scopes, opts = {}) {
  const now = opts.now ?? Date.now()
  const query = String(opts.query ?? '').trim()
  const hops = opts.hops !== false
  const topK = opts.topK ?? FUNNEL.topK
  const explicitTags = (opts.tags || []).map(String).filter(Boolean)
  const onlyPinned = opts.pinned === true
  const queryTags = [...new Set([
    ...explicitTags,
    ...extractConcepts(query).map((c) => c.tag),
  ])]

  // 候选池：摘要负责展示，正文负责召回具体名词/梗（正文已在内存里，不再读盘）
  const pool = []
  for (const sc of scopes || []) {
    for (const it of sc.items || []) {
      if (!live(it) || expired(it, now)) continue
      if (onlyPinned && !it.pin) continue
      pool.push({
        id: it.id,
        kind: it.kind || 'fact',
        scope: sc.scope,
        summary: String(it.summary || it.text || '').slice(0, 160),
        body: String(it.text || '').slice(0, 1600),
        tags: it.tags || [],
        parentTags: it.parentTags || [],
        weight: Number(it.weight ?? 0),
        confidence: Number(it.confidence ?? it.conf ?? 0.6),
        timeline: it.timeline || '',
        lastHit: it.lastHit || it.created || '',
        pinned: !!it.pin,
        score: 0,
        hop: 0,
        why: [],
      })
    }
  }
  if (!pool.length) return []

  // 显式 tag 过滤：只保留命中标签/上级的条目
  let base = pool
  if (explicitTags.length) {
    base = pool.filter((x) => explicitTags.some((t) => x.tags.includes(t) || x.parentTags.includes(t)))
    if (!base.length) return []
  }

  // 语义通道：词法余弦。摘要重复一次，避免长正文把抽象句的权重稀释掉。
  const docs = base.map((x) => ({
    ...x,
    text: `${x.summary} ${x.summary} ${x.body} ${x.tags.join(' ')} ${x.parentTags.join(' ')}`,
  }))
  const qNorm = normalizeText(query)
  const semantic = new Map()
  if (query) {
    for (const h of rankItems(query, docs, { limit: Math.max(20, base.length) })) {
      semantic.set(h.item.id, Math.min(1, h.score))
    }
  }

  for (const x of base) {
    const sem = semantic.get(x.id) ?? 0
    const tag = tagHit(x, queryTags)
    // 整句/整词在正文里出现：具体名词、梗、英文术语都该排前面
    const lit = qNorm.length >= 2 && normalizeText(`${x.summary} ${x.body}`).includes(qNorm)
    x.sem = sem
    x.tagScore = tag.score
    x.lit = lit
    const rec = recencyOf(x, now)
    x.score = Number((
      WEIGHTS.semantic * sem
      + WEIGHTS.tag * tag.score
      + WEIGHTS.weight * x.weight
      + WEIGHTS.recency * rec
      + WEIGHTS.confidence * x.confidence
      + (lit ? 0.12 : 0)
    ).toFixed(4))
    if (sem > 0) x.why.push(`语义 ${sem.toFixed(2)}`)
    if (tag.hit) x.why.push(`标签 ${tag.hit}`)
    if (lit) x.why.push('原文含查询')
    x.tagHit = tag
    // 摘要里没写到的具体词：从正文里捞一小段给模型看，别让命中变成黑盒
    if (query && !x.summary.includes(query)) {
      const snip = hitSnippet(x.body, query)
      if (snip) x.match = snip
    }
  }

  // 有查询但语义和标签都没命中：宁可返回空，也别拿"最近的记忆"硬凑。
  // 阈值 0.08 是给"只靠单字兜底"的假命中留的：那点评分不够格进候选。
  let direct = base
  if (query && !explicitTags.length) {
    // 只靠单字（"~学"）撞上的不算命中：那点评分撑不起一条候选。
    // 但整句/整词是原文子串要放行：英文术语（WASAPI）夹在长串里会被当成
    // 一个 token，交集为 0，字面却确实命中。
    const raw = tokens(query).filter((t) => !t.startsWith(UNIGRAM))
    const filtered = raw.filter((t) => !STOP_BIGRAMS.has(t))
    const qBigrams = new Set(filtered.length ? filtered : raw)
    const overlap = (x) => tokens(`${x.summary} ${x.body} ${x.tags.join(' ')}`).some((t) => qBigrams.has(t))
    direct = base.filter((x) => x.tagScore > 0 || x.lit || overlap(x))
    if (!direct.length && !hops) return []
  }

  base.sort((a, b) => b.score - a.score || String(b.id).localeCompare(String(a.id)))
  direct.sort((a, b) => b.score - a.score || String(b.id).localeCompare(String(a.id)))
  const picked = direct.slice(0, topK)
  if (!hops) return picked

  // 种子：前两条的标签 + 查询标签；上下各一跳
  const seeds = []
  for (const x of picked.slice(0, 2)) for (const t of x.tags || []) seeds.push({ tag: t, hop: 1 })
  for (const t of queryTags) seeds.push({ tag: t, hop: 1 })

  const hopTags = new Map() // tag -> {hop, from}
  for (const s of seeds) {
    const up = parentOf(s.tag)
    if (up) hopTags.set(up, { hop: s.hop, from: s.tag })
    const down = childrenOf(s.tag)
    for (const c of down) hopTags.set(c, { hop: s.hop, from: s.tag })
    // 二跳：上级的上级（只上行，别向下扩散）
    const up2 = up ? parentOf(up) : ''
    if (up2) hopTags.set(up2, { hop: Math.min(FUNNEL.maxHop, s.hop + 1), from: up })
  }

  const have = new Set(picked.map((x) => x.id))
  const extra = []
  for (const x of base) {
    if (have.has(x.id)) continue
    const own = [...(x.tags || []), ...(x.parentTags || [])]
    for (const [tag, meta] of hopTags) {
      if (!own.includes(tag)) continue
      const decay = 0.7 ** meta.hop
      const score = Number((x.score * decay).toFixed(4))
      if (score <= 0) continue
      extra.push({
        ...x,
        hop: meta.hop,
        score,
        why: [...x.why, `跳转 ${meta.from}→${tag}（${meta.hop} 跳）`],
      })
      break
    }
  }

  extra.sort((a, b) => b.score - a.score)
  const room = Math.max(0, Math.min(FUNNEL.maxCandidates, topK * 2) - picked.length)
  return [...picked, ...extra.slice(0, room)]
}

/** 渲染成给模型看的一行。类型放前面：教训和承诺要一眼看出来，别当成普通事实。 */
export function funnelLine(x) {
  return `- ${x.id}｜${x.timeline || '—'}｜[${typeLabel(x.kind)}]｜${(x.tags || []).join('/')}｜${x.summary}${x.match ? `｜正文：${x.match}` : ''}`
}
