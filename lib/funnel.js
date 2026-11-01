/**
 * funnel.js —— 两级漏斗检索（阶段 4）
 *
 * 第一级：只在副库字段上扫（摘要 / 标签 / 时间线 / 权重），不读正文。
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
import { extractConcepts, parentOf, childrenOf } from './taxonomy.js'

export const WEIGHTS = {
  semantic: 0.35,
  tag: 0.15,
  hop: 0.1,
  weight: 0.15,
  recency: 0.15,
  confidence: 0.1,
}

export const FUNNEL = { topK: 8, maxCandidates: 16, maxHop: 2 }

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
  const queryTags = [...new Set([
    ...explicitTags,
    ...extractConcepts(query).map((c) => c.tag),
  ])]

  // 候选池：只取副库字段
  const pool = []
  for (const sc of scopes || []) {
    for (const it of sc.items || []) {
      if (!live(it) || expired(it, now)) continue
      pool.push({
        id: it.id,
        scope: sc.scope,
        summary: String(it.summary || it.text || '').slice(0, 160),
        tags: it.tags || [],
        parentTags: it.parentTags || [],
        weight: Number(it.weight ?? 0),
        confidence: Number(it.confidence ?? it.conf ?? 0.6),
        timeline: it.timeline || '',
        lastHit: it.lastHit || it.created || '',
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

  // 语义通道：词法余弦，输入只有摘要 + 标签
  const docs = base.map((x) => ({ ...x, text: `${x.summary} ${x.tags.join(' ')} ${x.parentTags.join(' ')}` }))
  const semantic = new Map()
  if (query) {
    for (const h of rankItems(query, docs, { limit: Math.max(20, base.length) })) {
      semantic.set(h.item.id, Math.min(1, h.score))
    }
  }

  for (const x of base) {
    const sem = semantic.get(x.id) ?? 0
    const tag = tagHit(x, queryTags)
    x.sem = sem
    x.tagScore = tag.score
    const rec = recencyOf(x, now)
    x.score = Number((
      WEIGHTS.semantic * sem
      + WEIGHTS.tag * tag.score
      + WEIGHTS.weight * x.weight
      + WEIGHTS.recency * rec
      + WEIGHTS.confidence * x.confidence
    ).toFixed(4))
    if (sem > 0) x.why.push(`语义 ${sem.toFixed(2)}`)
    if (tag.hit) x.why.push(`标签 ${tag.hit}`)
    x.tagHit = tag
  }

  // 有查询但语义和标签都没命中：宁可返回空，也别拿"最近的记忆"硬凑。
  // 阈值 0.08 是给"只靠单字兜底"的假命中留的：那点评分不够格进候选。
  let direct = base
  if (query && !explicitTags.length) {
    // 只靠单字（"~学"）撞上的不算命中：那点评分撑不起一条候选
    const qBigrams = new Set(tokens(query).filter((t) => !t.startsWith(UNIGRAM)))
    const overlap = (x) => tokens(`${x.summary} ${x.tags.join(' ')}`).some((t) => qBigrams.has(t))
    direct = base.filter((x) => x.tagScore > 0 || overlap(x))
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

/** 渲染成给模型看的一行。 */
export function funnelLine(x) {
  return `- ${x.id}｜${x.timeline || '—'}｜${(x.tags || []).join('/')}｜${x.summary}`
}
