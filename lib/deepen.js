/**
 * deepen.js —— 记忆深化（阶段 3，保守版）
 *
 * 触发（满足其一）：
 *   · 某个标签下活跃条目 ≥20
 *   · 副库 >24KB
 *   · 距上次深化 ≥7 天且新增条目 ≥10
 *
 * 动作只做两件安全的事：
 *   1. 合并近乎同一句的重复条目（相似度 ≥0.90，写入口 0.72 已经拦掉大部分）
 *   2. 副库超限时，把最冷、权重 <0.35 的条目归档（正文留在 archive/full，可复活）
 *
 * 不做"把 20 条不同的事压成一句"——那需要 LLM 判断，规则版硬压会丢事实。
 * 等阶段 6 的人格蒸馏/阶段 4 的摘要能力上来再扩。
 */

import { similarity, mergeExistingItems } from './store.js'
import { tokens, UNIGRAM } from './recall.js'
import { renderIndex } from './vault.js'
import { listProjectRoots } from './namespace.js'
import { isLive } from './itemstate.js'

export const DEEPEN = {
  tagLimit: 20,
  indexLimit: 24 * 1024,
  mergeSim: 0.9,
  // 0.9 只抓「几乎同一句」；同一条偏好换三种说法时 Jaccard 会低到 0.2，
  // 用共享内容 bigram 兜底，10 个以上且数字签名一致才合并。
  sharedBigrams: 10,
  coldWeight: 0.35,
  idleDays: 7,
  idleNewItems: 10,
}

const live = (x) => isLive(x, { expiredDead: false })

/** 两条文本共享多少个内容 bigram（不算单字）。 */
function sharedBigrams(a, b) {
  const A = new Set(tokens(a).filter((t) => !t.startsWith(UNIGRAM)))
  const B = new Set(tokens(b).filter((t) => !t.startsWith(UNIGRAM)))
  let n = 0
  for (const t of A) if (B.has(t)) n += 1
  return n
}

/** 数字签名：1 门课和 11 门课不是同一件事，模板句很容易撞 0.9。 */
function numberSig(text) {
  return (String(text ?? '').match(/\d+/g) || []).sort().join(',')
}

/** 是否需要深化。 */
export function needsDeepen(scope, { indexBytes = 0, now = Date.now() } = {}) {
  const reasons = []
  const items = (scope?.items || []).filter(live)
  const byTag = new Map()
  for (const it of items) for (const t of it.tags || []) byTag.set(t, (byTag.get(t) || 0) + 1)
  const hot = [...byTag.entries()].filter(([, n]) => n >= DEEPEN.tagLimit).sort((a, b) => b[1] - a[1])
  if (hot.length) reasons.push(`tag:${hot[0][0]}=${hot[0][1]}`)
  if (indexBytes > DEEPEN.indexLimit) reasons.push(`index=${(indexBytes / 1024).toFixed(1)}KB`)
  const last = Date.parse(scope?.lastDeepen || '') || 0
  const days = (now - last) / 86400000
  if (last && days >= DEEPEN.idleDays && (scope?.itemsSinceDeepen || 0) >= DEEPEN.idleNewItems) {
    reasons.push(`idle=${Math.floor(days)}d+${scope.itemsSinceDeepen}`)
  }
  return { yes: reasons.length > 0, reasons, hotTags: hot.map(([t, n]) => ({ tag: t, count: n })) }
}

/**
 * 生成深化计划（不改数据）。
 * @returns {{reasons:string[], merges:object[], archive:object[]}}
 */
export function planDeepen(scope, { indexBytes = 0, now = Date.now() } = {}) {
  const need = needsDeepen(scope, { indexBytes, now })
  const items = (scope?.items || []).filter(live)
  const merges = []
  const used = new Set()

  // 1. 近重复合并：同类型 + 相似度 ≥0.90
  for (let i = 0; i < items.length; i += 1) {
    const a = items[i]
    if (used.has(a.id) || a.kind === 'skill') continue
    const cluster = [a]
    for (let j = i + 1; j < items.length; j += 1) {
      const b = items[j]
      if (used.has(b.id) || b.kind !== a.kind) continue
      if (numberSig(a.text) !== numberSig(b.text)) continue
      if (similarity(a.text, b.text) >= DEEPEN.mergeSim
        || sharedBigrams(a.text, b.text) >= DEEPEN.sharedBigrams) cluster.push(b)
    }
    if (cluster.length >= 2) {
      for (const x of cluster) used.add(x.id)
      merges.push({ reason: 'duplicate', items: cluster })
    }
  }

  // 2. 副库超限：最冷的先归档（只动权重低的，别把正在用的事压掉）
  const archive = []
  if (indexBytes > DEEPEN.indexLimit) {
    const avg = indexBytes / Math.max(1, items.length)
    const needDrop = Math.ceil((indexBytes - DEEPEN.indexLimit) / Math.max(40, avg))
    const cold = items
      .filter((x) => !used.has(x.id) && x.kind !== 'skill' && !x.pin && Number(x.importance || 0) < 0.7 && (x.weight ?? 1) < DEEPEN.coldWeight)
      .sort((a, b) => (a.weight ?? 0) - (b.weight ?? 0))
      .slice(0, Math.max(0, needDrop))
    archive.push(...cold.map((x) => ({ item: x, reason: 'index-cap' })))
  }

  return { reasons: need.reasons, merges, archive }
}

/** 执行计划（原地改状态，不落盘）。 */
export function applyDeepen(scope, plan, now = new Date().toISOString()) {
  let merged = 0
  let archived = 0

  for (const g of plan.merges) {
    const keep = g.items.reduce((a, b) => ((b.hits || 0) > (a.hits || 0) ? b : a))
    const drops = g.items.filter((x) => x !== keep)
    const totalHits = g.items.reduce((n, x) => n + (Number(x.hits) || 0), 0)
    const maxConf = Math.max(...g.items.map((x) => Number(x.conf) || 0.6))
    const latest = g.items.map((x) => x.lastHit || x.created || '').sort().pop() || keep.lastHit
    for (const d of drops) {
      // 走统一合并：正文用「；」接起来，场景/原话进 history/quote_history，不丢细节
      if (!mergeExistingItems(scope, d.id, keep.id, new Date(now))) {
        d.state = 'superseded'
        d.supersededBy = keep.id
        d.mergedInto = keep.id
        d.validTo = now
      }
    }
    // 命中数是「用过多少次」的累计，不能被合并时的单次 +1 冲掉
    keep.hits = totalHits
    keep.conf = maxConf
    keep.lastHit = latest
    merged += drops.length
  }

  for (const a of plan.archive) {
    a.item.state = 'archived'
    a.item.archivedAt = now
    a.item.archiveReason = a.reason
    archived += 1
  }

  scope.lastDeepen = now
  scope.itemsSinceDeepen = 0
  return { merged, archived }
}

/** 对一个分片执行深化；返回做了什么。 */
export async function runDeepen(root, scope, { saveScope, auditWrite, log } = {}) {
  if (!scope) return { merged: 0, archived: 0, reasons: [] }
  const index = renderIndex(scope)
  const plan = planDeepen(scope, { indexBytes: Buffer.byteLength(index, 'utf8') })
  if (!plan.merges.length && !plan.archive.length) {
    return { merged: 0, archived: 0, reasons: plan.reasons }
  }
  const out = applyDeepen(scope, plan)
  if (saveScope) await saveScope(root, scope)
  if (auditWrite) {
    await auditWrite(root, {
      kind: 'deepen',
      scope: scope.scope,
      merged: out.merged,
      archived: out.archived,
      reasons: plan.reasons,
    }).catch(() => {})
  }
  log?.(`[whale] 深化 ${scope.scope} · 合并 ${out.merged} · 归档 ${out.archived} · ${plan.reasons.join(',')}`)
  return { ...out, reasons: plan.reasons }
}

/** 启动深化循环（默认 6 小时扫一次）。 */
export function startDeepenLoop({ root, log, everyMs = 6 * 60 * 60 * 1000, listScopes, saveScope, auditWrite } = {}) {
  const tick = async () => {
    try {
      // 仓库库也一起深化；每个根各自重建图谱，不跨库合并
      const roots = [root, ...(await listProjectRoots(root).catch(() => []))]
      for (const r of roots) {
        const scopes = await listScopes(r)
        for (const sc of scopes) {
          // 公共池不自动合并/归档：外部情报的变化没有「同一个人的新说法」这层语义
          if (sc.kind === 'public') continue
          await runDeepen(r, sc, { saveScope, auditWrite, log }).catch(() => {})
        }
      }
    } catch (e) {
      log?.(`[whale] 深化失败 ${String(e?.message ?? e).slice(0, 160)}`)
    }
  }
  const timer = setInterval(tick, everyMs)
  timer.unref?.()
  return { tick, dispose() { clearInterval(timer) } }
}
