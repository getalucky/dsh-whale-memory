/**
 * beat/maintain.js —— 维护相
 *
 * 每跳轻量、每天完整：素材 GC、投递/反馈/日志保留、归档上限。
 * 不碰记忆分片；记忆的遗忘归 forget.js。
 */

import { readFile, rename, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { writeAtomic } from '../store.js'
import { deliveriesPath, feedbackPath, logsPath } from './config.js'
import { gcMaterial } from './material.js'
import { auditPath, profilePath, rebuildProfile } from '../person/profile.js'
import { loadSessions, rotateBeatSession } from './session.js'
import { settleUnreported } from './feedback.js'
import { checkSensitiveHealth } from '../secure/vault.js'

async function trimJsonl(file, days, now) {
  const keepMs = Math.max(1, Number(days) || 30) * 86400000
  let raw = ''
  try { raw = await readFile(file, 'utf8') } catch { return 0 }
  const lines = raw.split('\n').filter(Boolean)
  if (!lines.length) return 0
  const out = []
  for (const line of lines) {
    try {
      const o = JSON.parse(line)
      const at = Date.parse(o?.at || o?.time || '')
      if (!Number.isFinite(at) || now.getTime() - at <= keepMs) out.push(line)
    } catch {
      // 坏行不保留，别让一行脏数据把文件永远撑大
    }
  }
  if (out.length === lines.length) return 0
  await writeAtomic(file, out.length ? out.join('\n') + '\n' : '')
  return lines.length - out.length
}

export async function maintain(root, { config = {}, now = new Date(), log, ctx } = {}) {
  const material = await gcMaterial(root, { config, now }).catch((e) => {
    log?.(`[whale] 素材维护失败 ${String(e?.message ?? e).slice(0, 120)}`)
    return { ok: false, retired: 0 }
  })
  const unreported = await settleUnreported(root, { now, log }).catch(() => ({ settled: 0 }))
  const sensitive = await checkSensitiveHealth(root).catch((e) => ({
    ok: false, checked: 0, errors: [{ file: '', why: String(e?.message ?? e).slice(0, 160) }],
  }))
  if (!sensitive.ok) log?.(`[whale] 敏感文件体检失败 ${sensitive.errors.map((x) => x.why).join('；').slice(0, 160)}`)

  // 专用会话 7 天轮转：释放旧的，下一跳新建。
  let sessionRotated = false
  const days = Math.max(1, Number(config.sessionRotateDays) || 7)
  const sessions = await loadSessions(root).catch(() => ({ createdAt: '', sessionId: '' }))
  const created = Date.parse(sessions.createdAt || '')
  if (Number.isFinite(created) && now.getTime() - created > days * 86400000) {
    await rotateBeatSession(root, log, { agents: ctx?.agents }).catch(() => {})
    sessionRotated = true
  }

  // 派生画像每天重建一次；没有文件也建。
  let profile = 'kept'
  try {
    const st = await stat(profilePath(root))
    if (now.getTime() - st.mtimeMs > 86400000) {
      await rebuildProfile(root, { now, log })
      profile = 'rebuilt'
    }
  } catch {
    await rebuildProfile(root, { now, log }).catch(() => {})
    profile = 'rebuilt'
  }

  const daysCfg = config.logRetentionDays || {}
  const removed = {
    deliveries: await trimJsonl(deliveriesPath(root), daysCfg.deliveries ?? 90, now).catch(() => 0),
    feedback: await trimJsonl(feedbackPath(root), daysCfg.feedback ?? 90, now).catch(() => 0),
    logs: await trimJsonl(logsPath(root), daysCfg.logs ?? 30, now).catch(() => 0),
  }
  // 画像审计按 1MB 轮转；不删旧档，只改名
  let auditRotated = false
  try {
    const file = auditPath(root)
    const st = await stat(file)
    if (st.size > 1024 * 1024) {
      const tag = now.toISOString().slice(0, 10)
      await rename(file, join(dirname(file), `audit-${tag}.jsonl`))
      auditRotated = true
    }
  } catch { /* 没有审计文件 */ }
  const total = removed.deliveries + removed.feedback + removed.logs
  if (total) log?.(`[whale] 维护清理 ${total} 行（投递/反馈/日志）`)
  if (auditRotated) log?.('[whale] 画像审计已轮转')
  if (sessionRotated) log?.('[whale] 专用会话已到 7 天，下一跳重建')
  return { ok: true, material, unreported, sensitive, sessionRotated, profile, removed, auditRotated }
}
