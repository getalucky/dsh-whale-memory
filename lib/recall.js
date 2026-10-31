/**
 * recall.js —— L2 检索：字符 n-gram TF-IDF + 余弦
 *
 * 为什么不用 embedding：
 *   调 API 要联网、要管成本、每条记忆一次调用，还得处理失败重试。
 *   TF-IDF 纯 JS、零依赖、离线、毫秒级，能治「换个说法」「少打几个字」，
 *   治不了「换个同义词」——这点老老实实承认，别拿它冒充语义检索。
 *
 * 分词：中文没有空格，按字符 bigram 切（"明天上班" → 明天/天上/上班）。
 * 英文和数字按词切。单字文本退化成单字 token。
 *
 * 向量不落盘：条目量小（几百条），检索时对候选集现算 idf，
 * 避免"索引和正文不同步"这类经典坑。上万条再考虑建索引。
 */

import { normalizeText } from './store.js'

const CJK = /[\u4e00-\u9fa5]/

/**
 * 切成 token。
 * 中日韩：bigram（主）+ 单字（前缀 `~`，权重打折，见 {@link UNIGRAM_WEIGHT}）。
 * 加单字是为了「住哪儿」还能撞上「住在杭州」——只靠 bigram 这类短问句会空手而归。
 * @returns {string[]}
 */
export function tokens(text) {
  const s = normalizeText(text)
  if (!s) return []
  const out = []
  // 先把英文/数字整段切出来，剩下的按中日韩字符逐个 bigram
  const segs = s.match(/[a-z0-9]+|[\u4e00-\u9fa5]+/g) || []
  for (const seg of segs) {
    if (/^[a-z0-9]+$/.test(seg)) {
      out.push(seg)
      continue
    }
    if (seg.length === 1) {
      out.push(seg)
      continue
    }
    for (let i = 0; i < seg.length - 1; i++) out.push(seg.slice(i, i + 2))
    for (const ch of seg) out.push(UNIGRAM + ch)
  }
  return out
}

/** 单字 token 的前缀与权重：单字只做兜底召回，不该跟 bigram 一样重。 */
export const UNIGRAM = '~'
export const UNIGRAM_WEIGHT = 0.35

/** 词频：1 + log(tf)。 */
function tf(tokensList) {
  const m = new Map()
  for (const t of tokensList) m.set(t, (m.get(t) || 0) + 1)
  const out = new Map()
  for (const [k, v] of m) out.set(k, 1 + Math.log(v))
  return out
}

/** 语料 idf：log((N+1)/(df+1)) + 1，永不小于 1。 */
export function idfOf(docs) {
  const df = new Map()
  for (const d of docs) {
    for (const t of new Set(d)) df.set(t, (df.get(t) || 0) + 1)
  }
  const N = docs.length || 1
  const idf = new Map()
  for (const [t, c] of df) idf.set(t, Math.log((N + 1) / (c + 1)) + 1)
  return idf
}

/** 生成 L2 归一化向量（Map<token, weight>）。 */
export function vectorOf(tokensList, idf) {
  const v = new Map()
  let norm = 0
  for (const [t, f] of tf(tokensList)) {
    const scale = t.startsWith(UNIGRAM) && t.length > 1 ? UNIGRAM_WEIGHT : 1
    const w = f * (idf.get(t) ?? 1) * scale
    v.set(t, w)
    norm += w * w
  }
  norm = Math.sqrt(norm)
  if (norm > 0) for (const [k, w] of v) v.set(k, w / norm)
  return v
}

/** 余弦相似度，0–1。 */
export function cosine(a, b) {
  if (!a.size || !b.size) return 0
  const [small, big] = a.size <= b.size ? [a, b] : [b, a]
  let dot = 0
  for (const [k, w] of small) {
    const o = big.get(k)
    if (o !== undefined) dot += w * o
  }
  return dot
}

/**
 * 在一组条目里找最像的。
 *
 * 打分 = 余弦 + 字面加成：
 *   · query 是原文子串（≥2 字）→ +0.35，保证精确命中的排最前
 *   · 字面覆盖率（query 的 token 有多少出现在原文里）→ 占 20% 权重，
 *     避免长句子因为 idf 平滑而压过短句
 *
 * @param {string} query
 * @param {{id?:string,text:string}[]} items
 * @returns {{item:object, score:number}[]} 按分数降序，已过滤 0 分
 */
export function rankItems(query, items, opts = {}) {
  const limit = opts.limit ?? 8
  const min = opts.min ?? 0.01
  const q = String(query ?? '').trim()
  const list = (items || []).filter((x) => x && typeof x.text === 'string' && x.text)
  if (!q || !list.length) return []

  const qTokens = tokens(q)
  if (!qTokens.length) return []
  const docs = list.map((x) => tokens(x.text))
  const idf = idfOf([...docs, qTokens])
  const qv = vectorOf(qTokens, idf)
  const qSet = new Set(qTokens)
  const qNorm = normalizeText(q)

  const scored = list.map((it, i) => {
    const dv = vectorOf(docs[i], idf)
    const cos = cosine(qv, dv)
    const hit = docs[i].filter((t) => qSet.has(t)).length / qSet.size
    let score = cos * 0.8 + hit * 0.2
    if (qNorm.length >= 2 && normalizeText(it.text).includes(qNorm)) score += 0.35
    return { item: it, score: Number(score.toFixed(4)) }
  })

  return scored.filter((x) => x.score >= min).sort((a, b) => b.score - a.score).slice(0, limit)
}

/** 向量余弦（不是 Map，是普通数字数组；给 embedding 用）。 */
export function cosineVec(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || !a.length) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (!na || !nb) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

/**
 * RRF 融合：词法排名 + 向量排名，各自按名次给分，不比较两种分数量纲。
 * 某个通道没有命中就自然贡献 0，不用特殊处理。
 * @param {{item:object,score:number}[][]} lists
 */
export function fuseRankings(lists, { k = 60, limit = 8 } = {}) {
  const acc = new Map()
  for (const list of lists) {
    ;(list || []).forEach((r, i) => {
      if (!r?.item) return
      acc.set(r.item, (acc.get(r.item) || 0) + 1 / (k + i + 1))
    })
  }
  return [...acc.entries()]
    .map(([item, score]) => ({ item, score: Number(score.toFixed(6)) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
}

/** 两段文本的向量相似度（测试/调试用，语料只有这两条）。 */
export function similarity(a, b) {
  const ta = tokens(a)
  const tb = tokens(b)
  const idf = idfOf([ta, tb])
  return cosine(vectorOf(ta, idf), vectorOf(tb, idf))
}

export { CJK }
