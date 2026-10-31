/**
 * enrich.js —— 降维：把正文压成可检索的坐标（阶段 3）
 *
 * 输出五个字段：summary / tags / parent_tags / timeline / weight。
 * 纯规则、零 LLM，断网也能跑；以后接入小模型时只替换 summarize/tags 两个函数，
 * 其余（时间锚定、权重公式）不走模型。
 *
 * 约定：
 *   · summaryLocked = true 的条目不重算摘要（模型/用户显式写过）
 *   · tags 只收受控词表里的词；认不出来退回类型标签，不自由生长
 *   · weight 是派生值，每次落盘重算
 */

import { extractConcepts, parentOf, typeLabel, TYPE_LABEL } from './taxonomy.js'

const TYPE_LABELS = new Set(Object.values(TYPE_LABEL))

function oneLine(s) {
  return String(s ?? '').replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim()
}

function uniq(list) {
  const seen = new Set()
  const out = []
  for (const x of list) {
    const k = oneLine(x)
    if (!k || seen.has(k)) continue
    seen.add(k)
    out.push(k)
  }
  return out
}

/** 一句话摘要：取第一个句号/分号前的内容，超长截断。 */
export function summarize(text, max = 60) {
  const t = oneLine(text)
  if (!t) return ''
  const first = t.split(/[。！？!?；;]/)[0].trim()
  const s = first.length >= 6 ? first : t
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

/** 事件取发生日期，事实取确认/记录日期。 */
export function timelineOf(item, now = new Date()) {
  const raw = String(item?.atAbs || item?.observedAt || item?.created || '')
  const m = raw.match(/^\d{4}-\d{2}-\d{2}/)
  return m ? m[0] : now.toISOString().slice(0, 10)
}

/** 权重 = 置信度 × 时间衰减 × 命中加成，0–1。 */
export function weightOf(item, now = Date.now(), halfLifeDays = 30) {
  const last = Date.parse(item?.lastHit || item?.created || '') || now
  const ageDays = Math.max(0, (now - last) / 86400000)
  const conf = Number.isFinite(Number(item?.conf)) ? Number(item.conf) : 0.6
  const hits = Number.isFinite(Number(item?.hits)) ? Number(item.hits) : 0
  const hitBoost = 1 + 0.15 * Math.min(5, hits)
  const score = conf * Math.exp(-ageDays / Math.max(1, halfLifeDays)) * hitBoost
  return Number(Math.max(0, Math.min(1, score)).toFixed(3))
}

const IMPORTANCE = {
  pref: 0.7,
  relation: 0.7,
  commitment: 0.8,
  lesson: 0.8,
  event: 0.55,
  fact: 0.5,
}

/** 重要度：类型基线 + 明确信号（记住/约定/以后/别忘）。 */
export function importanceOf(item) {
  const base = IMPORTANCE[item?.kind] ?? 0.5
  const boost = /记住|记一下|别忘|约定|说好|以后都|一定/.test(String(item?.text ?? '')) ? 0.1 : 0
  return Number(Math.min(1, base + boost).toFixed(2))
}

/** 原地降维一条记忆。幂等：重复调用不会把标签越加越多。 */
export function enrichItem(item, now = Date.now()) {
  if (!item) return item
  if (!item.timeline) item.timeline = timelineOf(item)
  if (!item.summaryLocked) item.summary = summarize(item.text)

  const concepts = extractConcepts(item.text)
  const existing = (Array.isArray(item.tags) ? item.tags : [])
    .map(oneLine)
    .filter((t) => t && !TYPE_LABELS.has(t))

  const tags = uniq([...concepts.map((c) => c.tag), ...existing]).slice(0, 5)
  if (!tags.length) tags.push(typeLabel(item.kind))
  item.tags = tags

  const parents = uniq([
    ...concepts.flatMap((c) => c.parents || []),
    ...existing.map(parentOf).filter(Boolean),
  ]).slice(0, 4)
  // 词表里没有的新标签也要有上级，统一挂「其他」，防止 parent_tags 出现孤节点
  if (!parents.length && tags.length && !TYPE_LABELS.has(tags[0])) parents.push('其他')
  item.parentTags = parents

  item.weight = weightOf(item, now)
  if (typeof item.importance !== 'number') item.importance = importanceOf(item)
  item.confidence = Number.isFinite(Number(item.conf)) ? Number(item.conf) : 0.6
  return item
}

/** 整个分片降维；迁移/重建时用。 */
export function enrichScope(scope, now = Date.now()) {
  for (const it of scope?.items || []) enrichItem(it, now)
  return scope
}
