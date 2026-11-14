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

import { createHash } from 'node:crypto'

import { rankItems, tokens, idfOf, UNIGRAM, cosineVec } from './recall.js'
import { normalizeText } from './store.js'
import { extractConcepts, parentOf, childrenOf, typeLabel } from './taxonomy.js'
import { embedReady, embedTexts } from './llm.js'
import { isLive } from './itemstate.js'

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

/**
 * 查重的「内容词」：优先 bigram，全是虚词时才退回原 token。
 * 泛词一撞就进候选，是把「无关记忆」带回来的主因；重排必须看内容词覆盖了多少。
 */
function contentTokens(text) {
  const raw = tokens(text)
  const content = raw.filter((t) => !t.startsWith(UNIGRAM) && !STOP_BIGRAMS.has(t))
  return content.length ? content : raw.filter((t) => !t.startsWith(UNIGRAM))
}

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
  return isLive(item, { mergedDead: true })
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
 * 向量通道和词法通道都看这份正文；摘要重复一次，避免长正文把抽象句的权重稀释掉。
 */
export function funnelDocText(x) {
  return `${x.summary} ${x.summary} ${x.body} ${x.tags.join(' ')} ${x.parentTags.join(' ')}`
}

/** 候选池 + 显式 tag 过滤；同步检索和异步向量检索共用，避免两边口径漂。 */
function candidateBase(scopes, opts = {}) {
  const now = opts.now ?? Date.now()
  const explicitTags = (opts.tags || []).map(String).filter(Boolean)
  const onlyPinned = opts.pinned === true
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
        scene: String(it.scene || '').slice(0, 160),
        quote: String(it.sourceQuote || '').slice(0, 200),
        tags: it.tags || [],
        parentTags: it.parentTags || [],
        weight: Number(it.weight ?? 0),
        confidence: Number(it.confidence ?? it.conf ?? 0.6),
        timeline: it.timeline || '',
        lastHit: it.lastHit || it.created || '',
        pinned: !!it.pin,
        review: it.skillReview === true,
        score: 0,
        hop: 0,
        why: [],
      })
    }
  }
  if (!pool.length) return { base: [], explicitTags, now }
  // 显式 tag 过滤：只保留命中标签/上级的条目
  const base = explicitTags.length
    ? pool.filter((x) => explicitTags.some((t) => x.tags.includes(t) || x.parentTags.includes(t)))
    : pool
  return { base, explicitTags, now }
}

/**
 * 检索一组分片。
 * @param {object[]} scopes
 * @param {{query?:string, tags?:string[], hops?:boolean, topK?:number, now?:number, vectorScores?:Map<string,number>}} opts
 * @returns {{id:string, scope:string, summary:string, tags:string[], weight:number, timeline:string, confidence:number, score:number, hop:number, why:string[]}[]}
 */
export function searchFunnel(scopes, opts = {}) {
  const now = opts.now ?? Date.now()
  const query = String(opts.query ?? '').trim()
  const hops = opts.hops !== false
  const topK = opts.topK ?? FUNNEL.topK
  const vectorScores = opts.vectorScores instanceof Map ? opts.vectorScores : null
  const { base, explicitTags } = candidateBase(scopes, opts)
  if (!base.length) return []
  const queryTags = [...new Set([
    ...explicitTags,
    ...extractConcepts(query).map((c) => c.tag),
  ])]

  // 语义通道：词法余弦。摘要重复一次，避免长正文把抽象句的权重稀释掉。
  const docs = base.map((x) => ({ ...x, text: funnelDocText(x) }))
  const qNorm = normalizeText(query)
  const qContent = contentTokens(query)
  // 覆盖只看正文/摘要/自己的标签；parent_tags 是跳转用的上位词，
  // 不能拿它当「这条记忆真的提到了查询」——问「数学」时，高数/线代要靠跳转，不是直接命中。
  const docTokens = new Map(docs.map((d) => [d.id, new Set(tokens(`${d.summary} ${d.body} ${d.tags.join(' ')}`))]))
  const idf = idfOf([...docTokens.values()].map((s) => [...s]))
  const qMass = qContent.reduce((n, t) => n + (idf.get(t) || 1), 0)
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
    // 相关性：查询里的内容词覆盖了多少（按 idf 加权），不是撞上一个泛词就算命中
    const own = docTokens.get(x.id) || new Set()
    const matched = qContent.filter((t) => own.has(t))
    const mass = matched.reduce((n, t) => n + (idf.get(t) || 1), 0)
    const coverage = qMass > 0 ? mass / qMass : 0
    const vec = vectorScores ? Math.max(0, Math.min(1, Number(vectorScores.get(x.id)) || 0)) : 0
    // 有向量时，词面覆盖和语义各占一半；没配向量端点就完全走原来的词法分。
    const rel = vectorScores
      ? 0.45 * coverage + 0.45 * vec + 0.05 * tag.score + 0.05 * (lit ? 1 : 0)
      : 0.55 * coverage + 0.25 * sem + 0.12 * tag.score + 0.08 * (lit ? 1 : 0)
    const semBest = Math.max(sem, vec)
    const rec = recencyOf(x, now)
    x.sem = semBest
    x.vec = Number(vec.toFixed(3))
    x.tagScore = tag.score
    x.lit = lit
    x.coverage = Number(coverage.toFixed(3))
    x.rel = Number(rel.toFixed(3))
    x.qMatched = matched.length
    x.score = query
      // 有查询时相关性是主排序；权重/新近度只当同等相关时的次序，不能把不搭的顶上来
      ? Number((
        0.72 * rel
        + 0.08 * x.weight
        + 0.10 * rec
        + 0.05 * x.confidence
        + 0.05 * (x.pinned ? 1 : 0)
      ).toFixed(4))
      : Number((
        WEIGHTS.semantic * semBest
        + WEIGHTS.tag * tag.score
        + WEIGHTS.weight * x.weight
        + WEIGHTS.recency * rec
        + WEIGHTS.confidence * x.confidence
        + (lit ? 0.12 : 0)
      ).toFixed(4))
    if (query && qContent.length) {
      const vecBit = vec > 0.01 ? ` · 向量 ${vec.toFixed(2)}` : ''
      x.why.push(`相关 ${rel.toFixed(2)}（覆盖 ${matched.length}/${qContent.length} 词${vecBit}）`)
    } else if (semBest > 0) x.why.push(`语义 ${semBest.toFixed(2)}`)
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
  // 只撞一个内容词不够：那可能是「记忆」「插件」这种满库都有的泛词。
  let direct = base
  if (query && !explicitTags.length) {
    direct = base.filter((x) => x.tagScore > 0 || x.lit || (qContent.length > 0 && x.coverage >= 0.34) || (x.vec || 0) >= 0.55)
    if (!direct.length && !hops) return []
  }

  base.sort((a, b) => b.score - a.score || String(b.id).localeCompare(String(a.id)))
  direct.sort((a, b) => b.score - a.score || String(b.id).localeCompare(String(a.id)))
  let picked = direct.slice(0, topK)
  // 相关性断层之后的长尾不要：同一页里不搭的条目，比少给几条更伤
  if (query && picked.length > 2) {
    const top = picked[0].score
    const kept = picked.filter((x) => x.score >= top * 0.55 || x.lit || x.tagScore > 0 || (x.vec || 0) >= 0.55)
    if (kept.length) picked = kept
  }
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

/**
 * 异步混合检索：配了向量端点就先算查询/候选向量，再交给 searchFunnel 融合。
 * 没配、失败、超时都静默回退词法，调用方拿到的仍是同一套结构。
 */
const VEC_CACHE = new Map()
const VEC_CACHE_MAX = 4000
let vecDownUntil = 0

/** 设置页换端点/模型后清缓存和冷却，别拿旧模型的向量硬算。 */
export function resetVectorFallback() {
  vecDownUntil = 0
  VEC_CACHE.clear()
}

function vecKey(text) {
  return createHash('sha1').update(String(text ?? '')).digest('hex')
}

function cacheGet(text) {
  return VEC_CACHE.get(vecKey(text)) || null
}

function cacheSet(text, vec) {
  if (!Array.isArray(vec) || !vec.length) return
  // 缓存几条千维向量很占内存；Float32 够算余弦，别留 JS number 数组。
  VEC_CACHE.set(vecKey(text), Float32Array.from(vec))
  while (VEC_CACHE.size > VEC_CACHE_MAX) VEC_CACHE.delete(VEC_CACHE.keys().next().value)
}

async function embedInChunks(texts, embedImpl) {
  const out = []
  for (let i = 0; i < texts.length; i += 64) {
    const part = texts.slice(i, i + 64)
    const got = await embedImpl(part)
    if (!Array.isArray(got) || got.length !== part.length) return null
    out.push(...got)
  }
  return out
}

export async function searchFunnelHybrid(scopes, opts = {}) {
  const query = String(opts.query ?? '').trim()
  if (!query || opts.vectors === false) return searchFunnel(scopes, opts)
  if (Date.now() < vecDownUntil || !embedReady()) return searchFunnel(scopes, opts)
  const { embedImpl = embedTexts, ...rest } = opts
  if (typeof embedImpl !== 'function') return searchFunnel(scopes, rest)
  const { base } = candidateBase(scopes, rest)
  if (!base.length) return []

  const docs = base.map((x) => ({ id: x.id, text: funnelDocText(x) }))
  const need = []
  const vecById = new Map()
  for (const d of docs) {
    const hit = cacheGet(d.text)
    if (hit) vecById.set(d.id, hit)
    else need.push(d)
  }
  const inputs = [query, ...need.map((d) => d.text)]
  const out = await embedInChunks(inputs, embedImpl).catch(() => null)
  if (!out || !Array.isArray(out[0])) {
    // 端点挂了别每次检索都等一轮超时，冷十分钟再试。
    vecDownUntil = Date.now() + 10 * 60 * 1000
    return searchFunnel(scopes, rest)
  }
  const qv = out[0]
  need.forEach((d, i) => {
    const v = out[i + 1]
    if (!Array.isArray(v) || !v.length) return
    cacheSet(d.text, v)
    vecById.set(d.id, v)
  })
  const vectorScores = new Map()
  for (const d of docs) {
    const v = vecById.get(d.id)
    if (Array.isArray(v)) vectorScores.set(d.id, cosineVec(qv, v))
  }
  return searchFunnel(scopes, { ...rest, vectorScores })
}

/** 渲染成给模型看的一行。类型放前面：教训和承诺要一眼看出来，别当成普通事实。 */
export function funnelLine(x) {
  return `- ${x.id}｜${x.timeline || '—'}｜[${typeLabel(x.kind)}]${x.review ? '（待复核）' : ''}｜${(x.tags || []).join('/')}｜${x.summary}${x.scene ? `｜场景：${x.scene}` : ''}${x.match ? `｜正文：${x.match}` : ''}`
}
