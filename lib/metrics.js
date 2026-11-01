/**
 * metrics.js —— 真实流量的三个指标（文档 2.2 / 7.7）
 *
 * 评测集只能测规则链路；「模型读了到底用没用、自己写的那条准不准」
 * 只能从运行账本里算。三个口径都写在这里，运行页和 CLI 共用：
 *
 *   主动读取有效率 = 有效读取 / (有效 + 无效)
 *     有效：search 有结果、read 成功且这条在窗口内第一次读
 *     无效：空检索、读失败、重复读同一条
 *   主动写入准确率 = 24 小时后仍活着（没被取代/归档/删掉）的工具写入 / 已过观察期的工具写入
 *   重复写入率   = 命中已有条目（exists / merged）的写入 / 全部工具写入
 *
 * 读账和写账分开（audit/reads.jsonl、audit/writes.jsonl），读取次数比写入多
 * 一个量级，混在一起会把写入账冲掉。
 */

import { paths, readJsonl, listScopes } from './store.js'

const DAY = 86400000

const rate = (n, d) => (d > 0 ? Number((n / d).toFixed(3)) : null)

/** 一条工具写入是不是「重复」。 */
const isDup = (row) => row.status === 'exists' || row.merged === true

export async function computeMetrics(root, { days = 30, now = Date.now() } = {}) {
  const since = now - days * DAY
  const p = paths(root)
  const readRows = (await readJsonl(p.reads, 5000)).filter((r) => Date.parse(r.at || '') >= since)
  const writeRows = (await readJsonl(p.writes, 5000)).filter((r) => Date.parse(r.at || '') >= since)

  // ---- 读 ----
  const seen = new Set()
  let effective = 0
  let invalid = 0
  let wasteTokens = 0
  let searches = 0
  let reads = 0
  for (const r of readRows) {
    if (r.kind === 'search') {
      searches += 1
      if (r.empty || !(r.count > 0)) invalid += 1
      else effective += 1
    } else if (r.kind === 'read') {
      reads += 1
      const key = String(r.id || '')
      if (!r.ok) {
        invalid += 1
        wasteTokens += r.tokens || 0
      } else if (key && seen.has(key)) {
        // 同一条在一个统计窗口里反复读：读了没用上，或者根本没读进去
        invalid += 1
        wasteTokens += r.tokens || 0
      } else {
        if (key) seen.add(key)
        effective += 1
      }
    }
  }

  // ---- 写 ----
  const saves = writeRows.filter((r) => r.kind === 'tool-save')
  const dup = saves.filter(isDup)
  const judged = saves.filter((r) => Date.parse(r.at || '') <= now - DAY)
  let kept = 0
  if (judged.length) {
    const byId = new Map()
    for (const sc of await listScopes(root).catch(() => [])) {
      for (const it of sc.items || []) byId.set(it.id, it)
    }
    for (const r of judged) {
      const it = byId.get(r.item)
      if (it && !['superseded', 'archived', 'expired', 'deleted'].includes(it.state)) kept += 1
    }
  }

  return {
    windowDays: days,
    reads: {
      searches,
      reads,
      effective,
      invalid,
      wasteTokens,
      effectiveness: rate(effective, effective + invalid),
    },
    writes: {
      saves: saves.length,
      duplicates: dup.length,
      duplicateRate: rate(dup.length, saves.length),
      judged: judged.length,
      kept,
      accuracy: rate(kept, judged.length),
      suggested: saves.filter((r) => r.status === 'suggested').length,
      warned: saves.filter((r) => r.gate === 'warn').length,
    },
  }
}
