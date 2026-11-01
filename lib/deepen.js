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

import { similarity } from './store.js'
import { renderIndex, INDEX_LIMIT } from './vault.js'

export const DEEPEN = {
  tagLimit: 20,
  indexLimit: 24 * 1024,
  mergeSim: 0.9,
  coldWeight: 0.35,
  idleDays: 7,
  idleNewItems: 10,
}

const live = (x) => x && x.state !== 'archived' && x.state !== 'superseded' && x.state !== 'suggested'

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
    if (used.has(a.id)) continue
    const cluster = [a]
    for (let j = i + 1; j < items.length; j += 1) {
      const b = items[j]
      if (used.has(b.id) || b.kind !== a.kind) continue
      if (numberSig(a.text) !== numberSig(b.text)) continue
      if (similarity(a.text, b.text) >= DEEPEN.mergeSim) cluster.push(b)
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
      .filter((x) => !used.has(x.id) && (x.weight ?? 1) < DEEPEN.coldWeight)
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
    keep.hits = g.items.reduce((n, x) => n + (x.hits || 0), 0)
    keep.conf = Math.max(...g.items.map((x) => Number(x.conf) || 0.6))
    keep.lastHit = g.items.map((x) => x.lastHit || x.created || '').sort().pop() || keep.lastHit
    keep.history = [
      ...(keep.history || []),
      ...drops.map((x) => ({ id: x.id, text: x.text, at: x.created || '' })),
    ].slice(-8)
    // 保留信息量最大的那一版正文
    const longer = g.items.slice().sort((a, b) => String(b.text).length - String(a.text).length)[0]
    if (longer && longer.text.length > keep.text.length) keep.text = longer.text
    for (const d of drops) {
      d.state = 'superseded'
      d.supersededBy = keep.id
      d.mergedInto = keep.id
      d.validTo = now
    }
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
      const scopes = await listScopes(root)
      for (const sc of scopes) {
        await runDeepen(root, sc, { saveScope, auditWrite, log }).catch(() => {})
      }
    } catch (e) {
      log?.(`[whale] 深化失败 ${String(e?.message ?? e).slice(0, 160)}`)
    }
  }
  const timer = setInterval(tick, everyMs)
  timer.unref?.()
  return { tick, dispose() { clearInterval(timer) } }
}
