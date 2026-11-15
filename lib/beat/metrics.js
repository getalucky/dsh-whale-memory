/**
 * beat/metrics.js —— 主动行为层的验收指标（文档 13.16）
 *
 * 只读 jsonl / 素材库 / 画像，不写盘。口径固定，方便面板和 CLI 对同一份数据
 * 说同一句话。所有比率没有分母时返回 null，不假装是 0。
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { readJsonl } from '../store.js'
import { deliveriesPath, feedbackPath, logsPath } from './config.js'
import { loadMaterial } from './material.js'
import { profileStatus } from '../person/rebuild.js'

const DAY = 86400000
const CACHE_MS = 30 * 1000
const cache = new Map()

function atOf(x) {
  return Date.parse(x?.at || x?.time || '')
}

function within(rows, now, days) {
  const since = now.getTime() - Math.max(1, days) * DAY
  return rows.filter((x) => {
    const t = atOf(x)
    return Number.isFinite(t) && t >= since
  })
}

function rate(n, d) {
  return d ? Number((n / d).toFixed(3)) : null
}

/**
 * @param {{days?:number, now?:Date}} opts
 * @returns {Promise<object>}
 */
export async function beatMetrics(root, { days = 30, now = new Date() } = {}) {
  const key = `${root}|${days}`
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value
  const [deliveriesRaw, feedbackRaw, logsRaw, db, profile] = await Promise.all([
    readJsonl(deliveriesPath(root)).catch(() => []),
    readJsonl(feedbackPath(root)).catch(() => []),
    readJsonl(logsPath(root)).catch(() => []),
    loadMaterial(root).catch(() => ({ items: [] })),
    profileStatus(root).catch(() => ({ ok: false, evidence: false })),
  ])

  const deliveries = within(deliveriesRaw, now, days)
  const feedback = within(feedbackRaw, now, days)
  const ticks = within(logsRaw.filter((x) => x?.phase === 'tick'), now, days)

  const deliveredMaterial = new Set()
  for (const d of deliveries) {
    for (const id of d.materialIds || []) deliveredMaterial.add(String(id))
  }

  const reportRows = feedback.filter((x) => x.source === 'report' && x.summary === true)
  const reportedIds = new Set(reportRows.map((x) => String(x.deliveryId || '')).filter(Boolean))
  const usedMaterial = new Set()
  for (const row of reportRows) {
    if (row.mode !== 'quote' && row.mode !== 'improvise') continue
    for (const id of row.usedIds || []) usedMaterial.add(String(id))
  }

  const negative = feedback.filter((x) => ['reply', 'ai'].includes(x.source) && Number(x.engagement) < 0)
  const gateBlocked = ticks.filter((x) => x.gate && x.gate !== 'pass')
  const gateZeroCall = gateBlocked.filter((x) => String(x.wander || '').startsWith('skip'))
  const reportMissing = deliveries.filter((d) => !reportedIds.has(String(d.id || '')))

  const items = Array.isArray(db?.items) ? db.items : []
  const retired = items.filter((x) => x?.state === 'retired')
  const duplicateRetired = retired.filter((x) => /duplicate|dup/i.test(String(x.retireReason || '')))

  const persona = await readFile(join(root, 'persona.md'), 'utf8').catch(() => '')
  const userDoc = await readFile(join(root, 'USER.md'), 'utf8').catch(() => '')
  const pollution = (persona.match(/mat_[a-z0-9]+/gi) || []).length + (userDoc.match(/mat_[a-z0-9]+/gi) || []).length

  const value = {
    days,
    deliveries: deliveries.length,
    materialsDelivered: deliveredMaterial.size,
    adoption: rate([...usedMaterial].filter((id) => deliveredMaterial.has(id)).length, deliveredMaterial.size),
    reportRate: rate(reportedIds.size, deliveries.length),
    unreported: reportMissing.length,
    negativeRate: rate(negative.length, deliveries.length),
    negative: negative.length,
    duplicateRate: rate(duplicateRetired.length, items.length),
    gateBlockRate: rate(gateBlocked.length, ticks.length),
    gateZeroCallRate: rate(gateZeroCall.length, ticks.length),
    gateTicks: ticks.length,
    profileEvidence: Boolean(profile?.evidence),
    personaPollution: pollution,
    material: {
      total: items.length,
      active: items.filter((x) => x?.state === 'active').length,
      retired: retired.length,
    },
  }
  cache.set(key, { at: Date.now(), value })
  if (cache.size > 20) cache.delete(cache.keys().next().value)
  return value
}
