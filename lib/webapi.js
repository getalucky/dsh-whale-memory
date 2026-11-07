/**
 * webapi.js —— 给网页界面用的接口
 *
 * 前缀统一 /dsh-whale-memory/api。除 /forget 外全部 GET，不写库
 * （/refresh 也算只读：它只是把图谱按现有分片重建一遍，不新增内容）。
 *
 * 只开了一个写口：删一条记忆。改记忆还是得靠她自己在对话里记——
 * 但记错的、被桥接旁白污染的，总得有个地方能清掉，不然只能手改 JSON。
 */

import { readFile, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { listScopes, paths, withWriteLock, auditWrite } from './store.js'
import { confirmItem } from './confirm.js'
import { refreshGraph, loadGraph, topNodes } from './graph.js'
import { lifeState, renderMemory } from './inject.js'
import { buildMembers } from './profile.js'
import { forgetItem } from './forget.js'
import { vaultPaths } from './vault.js'
import { trustState } from './trust.js'
import { gateMode } from './gate.js'
import { computeMetrics } from './metrics.js'
import { status as personaStatus } from './persona.js'
import { loadSettings, saveSettings, maskKey, settingsPath } from './settings.js'
import { llmReady, searchReady, probeKind, listChatModels, resetSettingsCache, resetLlmCooldown } from './llm.js'
import { loadConfig, saveConfig, deliveriesPath, feedbackPath } from './beat/config.js'
import { bridgeConfig, ownerTarget, sessionKey } from './beat/delivery.js'
import { gcMaterial, materialCounts, materialList, scoreOf } from './beat/material.js'
import { loadState, saveState } from './beat/index.js'
import { loadSessions, rotateBeatSession } from './beat/session.js'
import { schedulerState } from './beat/scheduler.js'
import { summarizeFeedback } from './beat/feedback.js'
import { profileInterests, profilePath } from './person/profile.js'
import { profileStatus, rebuildAndVerify } from './person/rebuild.js'
import { listDiaries, readDiary, writeDiary, loadConfig as loadDiaryConfig, statePath as diaryStatePath } from './diary.js'

export const API_PREFIX = '/dsh-whale-memory/api'

const BODY_LIMIT = 8 * 1024

function readBody(req, limit = BODY_LIMIT) {
  return new Promise((resolve) => {
    let size = 0
    let text = ''
    let done = false
    const finish = (v) => { if (!done) { done = true; resolve(v) } }
    try {
      req.on?.('data', (c) => {
        size += c.length
        if (size > limit) { finish(''); try { req.destroy?.() } catch { /* ignore */ } return }
        text += c
      })
      req.on?.('end', () => finish(text))
      req.on?.('error', () => finish(''))
    } catch {
      finish('')
    }
  })
}

function json(res, body, code = 200) {
  const text = JSON.stringify(body)
  try {
    res.statusCode = code
    res.setHeader?.('content-type', 'application/json; charset=utf-8')
    res.setHeader?.('cache-control', 'no-store')
    res.end?.(text)
  } catch { /* 连接断了就算了 */ }
}

async function tailLines(file, n = 100) {
  try {
    const raw = await readFile(file, 'utf8')
    return raw.split('\n').filter(Boolean).slice(-n)
  } catch {
    return []
  }
}

/** 分片 → 界面需要的瘦身结构（不带整份 json 的元数据）。 */
function slimScope(sc) {
  const now = Date.now()
  const items = (sc.items || []).map((it) => {
    const life = lifeState(it, now)
    return {
      id: it.id,
      text: it.text,
      kind: it.kind,
      conf: it.conf,
      hits: it.hits,
      merged: it.merged,
      state: life.state,
      score: Number(life.score.toFixed(3)),
      lastHit: it.lastHit,
      created: it.created,
      atAbs: it.atAbs || '',
      speaker: it.speaker || '',
      trigger: it.trigger || '',
      antiPattern: it.antiPattern || '',
      goal: it.goal || '',
      progress: it.progress || '',
      lastTouched: it.lastTouched || '',
      due: it.due || '',
      toWhom: it.toWhom || '',
      validTo: it.validTo || '',
      supersededBy: it.supersededBy || '',
    }
  })
  return {
    scope: sc.scope,
    kind: sc.kind,
    id: sc.id,
    label: sc.label,
    updatedAt: sc.updatedAt,
    profile: sc.profile ?? null,
    members: Array.isArray(sc.items) && sc.items.length ? buildMembers(sc) : (Array.isArray(sc.members) ? sc.members : []),
    total: items.length,
    active: items.filter((i) => i.state === 'active' || i.state === 'warm').length,
    suggested: items.filter((i) => i.state === 'suggested').length,
    archived: items.filter((i) => i.state === 'archived').length,
    superseded: items.filter((i) => i.state === 'superseded').length,
    items: items.sort((a, b) => b.score - a.score),
    render: renderMemory(sc, { topN: 10, maxChars: 1600 }),
  }
}

/**
 * beat 设置：界面上是「11:00-15:00, 17:00-21:00」这种文本，落盘是对象数组。
 * 解析失败直接把原因回给界面，不要静默存成半截配置。
 */
const HHMM_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/

function 规范时间(v) {
  const m = HHMM_RE.exec(String(v ?? '').trim())
  if (!m) return ''
  return `${String(Number(m[1])).padStart(2, '0')}:${m[2]}`
}

function 解析时间窗(text) {
  const rows = String(text ?? '')
    .split(/[,，;；\n]+/)
    .map((x) => x.trim())
    .filter(Boolean)
  if (!rows.length) return { ok: true, value: [] }
  const out = []
  for (const row of rows) {
    const m = /^(.+?)\s*(?:-|~|—|–|至|到)\s*(.+)$/.exec(row)
    if (!m) return { ok: false, why: `时间窗要写成 11:00-15:00：${row}` }
    const start = 规范时间(m[1])
    const end = 规范时间(m[2])
    if (!start || !end) return { ok: false, why: `时间格式不对：${row}` }
    out.push({ start, end })
  }
  return { ok: true, value: out }
}

function 解析单窗(text) {
  const r = 解析时间窗(text)
  if (!r.ok) return r
  if (r.value.length > 1) return { ok: false, why: '静默时段只能填一个时间窗' }
  return { ok: true, value: r.value[0] || null }
}

function 解析兴趣(v) {
  const rows = Array.isArray(v) ? v : String(v ?? '').split(/[,，;；\n、]+/)
  const out = []
  for (const row of rows) {
    const s = String(row ?? '').replace(/\s+/g, ' ').trim()
    if (!s) continue
    if (s.length > 40) return { ok: false, why: `兴趣太长：${s.slice(0, 20)}…` }
    if (!out.includes(s)) out.push(s)
  }
  if (out.length > 20) return { ok: false, why: '兴趣最多 20 个' }
  return { ok: true, value: out }
}

function 整数(v, min, max) {
  const n = Number(v)
  if (!Number.isFinite(n)) return null
  return Math.max(min, Math.min(max, Math.round(n)))
}

function 开关(v) {
  return v === true || v === 1 || v === '1' || v === 'true' || v === 'on'
}

function beatPatchFromBody(body = {}) {
  const patch = {}
  const fail = (why) => ({ ok: false, why })
  if ('enabled' in body) patch.enabled = 开关(body.enabled)
  if ('dryRun' in body) patch.dryRun = 开关(body.dryRun)
  if ('installPreset' in body) patch.installPreset = 开关(body.installPreset)
  if ('allowGroups' in body) patch.allowGroups = 开关(body.allowGroups)
  if ('windows' in body) {
    const r = 解析时间窗(body.windows)
    if (!r.ok) return fail(r.why)
    patch.windows = r.value
  }
  if ('quietHours' in body) {
    const r = 解析单窗(body.quietHours)
    if (!r.ok) return fail(r.why)
    patch.quietHours = r.value
  }
  const nums = {
    minIntervalHours: [1, 72],
    maxWanderPerDay: [0, 20],
    refillBelow: [0, 30],
    maxDailySend: [0, 50],
    cooldownMinutes: [0, 1440],
    busyMinutes: [0, 120],
    tokenSaverIdleMinutes: [0, 240],
    maxMaterial: [1, 200],
    sessionRotateDays: [1, 90],
  }
  for (const [k, [min, max]] of Object.entries(nums)) {
    if (!(k in body)) continue
    const n = 整数(body[k], min, max)
    if (n == null) return fail(`${k} 要是 ${min}–${max} 的数字`)
    patch[k] = n
  }
  if ('interests' in body) {
    const r = 解析兴趣(body.interests)
    if (!r.ok) return fail(r.why)
    patch.interests = r.value
  }
  for (const k of ['model', 'provider']) {
    if (!(k in body)) continue
    const s = String(body[k] ?? '').trim()
    if (s.length > 80) return fail(`${k} 太长`)
    patch[k] = s
  }
  if ('engine' in body) {
    const s = String(body.engine ?? '').trim()
    if (!['agent', 'search'].includes(s)) return fail('engine 只能是 agent 或 search')
    patch.engine = s
  }
  // 投递目标：允许清空（= 不投），所以空串也照存
  for (const k of ['targetSessionId', 'targetSessionLabel', 'targetSessionKind']) {
    if (!(k in body)) continue
    const s = String(body[k] ?? '').trim()
    if (s.length > 200) return fail(`${k} 太长`)
    patch[k] = s
  }
  return { ok: true, value: patch }
}

/**
 * 可绑定的会话：宿主里的全部会话 + 当前活着的 agent。
 * 桥接只用来给 QQ 会话打标签（只读），目标解析不依赖它。
 */
function 会话候选(ctx, 排除 = new Set()) {
  const rows = []
  const 归档 = new Set()
  try {
    const 登记 = ctx?.workspaceRegistry || ctx?.get?.('workspaceRegistry')
    for (const x of (登记 && 登记.archivedSessionIds) || []) 归档.add(sessionKey(String(x)))
  } catch { /* 没有登记服务就不排除归档 */ }
  const 桥接 = bridgeConfig()
  const 桥接标签 = new Map()
  if (桥接) {
    for (const b of Array.isArray(桥接['绑定']) ? 桥接['绑定'] : []) {
      const id = String(b?.会话 ?? '').trim()
      const key = sessionKey(id)
      if (!key) continue
      const kind = String(b?.类型 ?? '').includes('群') ? 'group' : 'private'
      const who = String(b?.称呼 ?? '').trim() || (kind === 'group' ? '群聊' : '私聊')
      桥接标签.set(key, { id, kind, label: `QQ${kind === 'group' ? '群' : '私聊'} · ${who}`, source: 'bridge' })
    }
    const direct = String(桥接['私聊会话'] ?? '').trim()
    const directKey = sessionKey(direct)
    if (directKey && !桥接标签.has(directKey)) {
      桥接标签.set(directKey, { id: direct, kind: 'private', label: 'QQ私聊 · owner', source: 'bridge' })
    }
  }
  const 加 = (id, fallback) => {
    const key = sessionKey(id)
    if (!key || 归档.has(key) || 排除.has(key) || rows.some((r) => sessionKey(r.id) === key)) return
    const tag = 桥接标签.get(key)
    rows.push(tag ? { id, kind: tag.kind, label: tag.label, source: tag.source } : Object.assign({ id }, fallback))
  }
  // 1) 宿主里的全部会话（包括没开着的），有标题就用标题
  try {
    const 会话服务 = ctx?.get?.('sessions') || ctx?.sessions
    const 标题服务 = ctx?.get?.('sessionTitle') || ctx?.sessionTitle
    const 全部 = 会话服务 && typeof 会话服务.list === 'function' ? (会话服务.list() || []) : []
    for (const s of Array.isArray(全部) ? 全部 : []) {
      const id = String(s?.id ?? s?.session?.id ?? '').trim()
      if (!id) continue
      let 标题 = ''
      try {
        const 快照 = 标题服务 && typeof 标题服务.get === 'function' ? 标题服务.get(s) : undefined
        标题 = 快照 && 快照.title ? String(快照.title) : ''
      } catch { /* 没标题就用通用名 */ }
      加(id, { kind: 'local', label: 标题 ? `本机 · ${标题}` : '本机会话', source: 'host' })
    }
  } catch { /* 没有 sessions 服务就只列活着的 */ }
  // 2) 当前活着的 agent：补 preset 标签，也兜住 sessions 服务漏掉的
  let live = []
  try {
    // 界面接口的 ctx 挂在 webServer 服务下，agents 可能得走 get 取
    const agents = ctx?.agents || ctx?.get?.('agents')
    live = agents?.list?.() || []
  } catch { live = [] }
  for (const a of Array.isArray(live) ? live : []) {
    const id = String(a?.session?.id ?? a?.id ?? '').trim()
    const preset = String(a?.session?.agentPreset ?? a?.session?.metadata?.agentPreset ?? '')
    加(id, { kind: 'local', label: preset ? `本机 · ${preset}` : '本机会话', source: 'agent' })
  }
  // 3) 桥接里有、但宿主清单里没有的（比如还没打开过）也列上，仍然只是只读标签
  for (const tag of 桥接标签.values()) 加(tag.id, tag)
  return rows
}

/** 当前投递目标：只认显式绑定；没绑就是没目标。 */
function 投递目标(config = {}) {
  const pinned = String(config.targetSessionId ?? '').trim()
  const r = ownerTarget(config)
  return {
    sessionId: String(r.sessionId ?? ''),
    label: pinned ? (String(config.targetSessionLabel ?? '').trim() || '手动绑定') : '未绑定',
    kind: pinned ? (String(config.targetSessionKind ?? '').trim() || 'custom') : '',
    pinned: Boolean(pinned),
    ok: Boolean(r.ok),
    why: r.why || '',
  }
}

/**
 * 注册路由。
 * @returns {{dispose:()=>void}|null}
 */
export function registerWebApi(ctx, { root, log, version, gate = {} } = {}) {
  const gateLevel = gateMode(gate)
  const ws = ctx.webServer
  if (!ws || typeof ws.register !== 'function') {
    log?.('[whale] webServer 不可用，界面接口没挂上')
    return null
  }

  const disposers = []
  const route = (path, handler) => {
    try {
      const d = ws.register({ kind: 'exact', path, handler })
      if (typeof d === 'function') disposers.push(d)
      else if (d?.dispose) disposers.push(() => d.dispose())
    } catch (e) {
      log?.(`[whale] 路由注册失败 ${path}: ${String(e?.message ?? e).slice(0, 120)}`)
    }
  }

  // 主动行为层：设置页读这一份，写口分开（config / focus / profile / gc）
  const beatSnapshot = async () => {
    const [config, state, counts, materials, profile, pstat, sessions, deliveriesRaw, feedbackRaw] = await Promise.all([
      loadConfig(root).catch(() => ({})),
      loadState(root).catch(() => ({})),
      materialCounts(root).catch(() => ({ active: 0, total: 0, bySource: { public: 0, web: 0, chat: 0 } })),
      materialList(root, { state: 'active', limit: 12 }).catch(() => []),
      readFile(profilePath(root), 'utf8').then((s) => JSON.parse(s)).catch(() => null),
      profileStatus(root).catch(() => null),
      loadSessions(root).catch(() => ({ sessionId: '', createdAt: '', lastUsedAt: '', rotates: 0 })),
      tailLines(deliveriesPath(root), 12),
      tailLines(feedbackPath(root), 20),
    ])
    const deliveries = deliveriesRaw
      .map((l) => { try { return JSON.parse(l) } catch { return null } })
      .filter(Boolean)
      .slice(-10)
      .reverse()
    const feedback = feedbackRaw
      .map((l) => { try { return summarizeFeedback(JSON.parse(l)) } catch { return null } })
      .filter(Boolean)
      .slice(-12)
      .reverse()
    const created = Date.parse(sessions.createdAt || '')
    return {
      ok: true,
      config,
      scheduler: schedulerState({ config }),
      state: {
        focusUntil: state.focusUntil || '',
        lastWanderAt: state.lastWanderAt || '',
        lastDeliveryAt: state.lastDeliveryAt || '',
        lastTickAt: state.lastTickAt || '',
        lastGate: state.lastGate || '',
        lastGateAt: state.lastGateAt || '',
        lastGateDetail: state.lastGateDetail || {},
        daily: state.daily || { day: '', sent: 0 },
        lastUserAt: state.lastUserAt || '',
        lastEnv: state.lastEnv || null,
        pendingDelivery: state.pendingDelivery || null,
        deliveryFailed: state.deliveryFailed || null,
        deliveryBackoffUntil: state.deliveryBackoffUntil || '',
        noneStreak: state.noneStreak || 0,
      },
      counts,
      materials: (materials || []).map((it) => ({
        id: it.id,
        text: it.text,
        source: it.source,
        focus: it.focus || '',
        tags: Array.isArray(it.tags) ? it.tags : [],
        state: it.state,
        at: it.at || it.createdAt || '',
        weight: Number(scoreOf(it).toFixed(2)),
        boost: Number(it.boost) || 0,
        usedCount: Number(it.usedCount) || 0,
      })),
      profile: pstat,
      interests: profileInterests(profile),
      sessions: {
        ...sessions,
        ageDays: Number.isFinite(created) ? Math.floor((Date.now() - created) / 86400000) : 0,
      },
      target: 投递目标(config),
      deliveries,
      feedback,
    }
  }

  route(`${API_PREFIX}/beat`, async (_req, res) => {
    json(res, await beatSnapshot())
  })

  // 可绑定的会话清单：界面在「主动 → 配置 → 投递目标」里用
  route(`${API_PREFIX}/beat/targets`, async (_req, res) => {
    const config = await loadConfig(root).catch(() => ({}))
    // 不把 beat 自己的专用闲逛会话放进候选，免得绑到自己身上
    const own = await loadSessions(root).catch(() => ({}))
    const 排除 = new Set([sessionKey(own.sessionId)].filter(Boolean))
    json(res, { ok: true, current: 投递目标(config), items: 会话候选(ctx, 排除) })
  })

  route(`${API_PREFIX}/beat/config`, async (req, res) => {
    if (String(req?.method ?? 'GET').toUpperCase() !== 'POST') {
      json(res, { ok: false, why: '只接受 POST' }, 405)
      return
    }
    const raw = await readBody(req)
    let body
    try {
      body = JSON.parse(raw || '{}')
    } catch {
      json(res, { ok: false, why: 'body 不是 JSON' }, 400)
      return
    }
    const r = beatPatchFromBody(body)
    if (!r.ok) {
      json(res, r, 400)
      return
    }
    await saveConfig(root, r.value)
    log?.(`[whale] beat 设置已保存 · ${Object.keys(r.value).join(', ') || '无改动'}`)
    json(res, await beatSnapshot())
  })

  route(`${API_PREFIX}/beat/focus`, async (req, res) => {
    if (String(req?.method ?? 'GET').toUpperCase() !== 'POST') {
      json(res, { ok: false, why: '只接受 POST' }, 405)
      return
    }
    const raw = await readBody(req)
    let body
    try {
      body = JSON.parse(raw || '{}')
    } catch {
      json(res, { ok: false, why: 'body 不是 JSON' }, 400)
      return
    }
    const state = await loadState(root)
    const off = body?.off === true || body?.minutes === 0 || body?.minutes === '0'
    if (off) {
      state.focusUntil = ''
    } else {
      const min = 整数(body?.minutes, 1, 1440)
      if (min == null) {
        json(res, { ok: false, why: '专注分钟要是 1–1440 的数字' }, 400)
        return
      }
      state.focusUntil = new Date(Date.now() + min * 60000).toISOString()
    }
    await saveState(root, state)
    log?.(`[whale] beat 专注 · ${state.focusUntil || '已关'}`)
    json(res, { ok: true, focusUntil: state.focusUntil })
  })

  route(`${API_PREFIX}/beat/profile`, async (req, res) => {
    if (String(req?.method ?? 'GET').toUpperCase() !== 'POST') {
      json(res, { ok: false, why: '只接受 POST' }, 405)
      return
    }
    const r = await rebuildAndVerify(root, { log })
    const p = await profileStatus(root).catch(() => null)
    log?.(`[whale] 界面重建画像 · ${r.after || ''}`)
    json(res, { ok: true, before: r.before, after: r.after, profile: p })
  })

  route(`${API_PREFIX}/beat/gc`, async (req, res) => {
    if (String(req?.method ?? 'GET').toUpperCase() !== 'POST') {
      json(res, { ok: false, why: '只接受 POST' }, 405)
      return
    }
    const config = await loadConfig(root)
    const r = await gcMaterial(root, { config })
    const counts = await materialCounts(root)
    log?.(`[whale] 界面清理素材 · 退休 ${r.retired || 0}`)
    json(res, { ok: true, retired: r.retired || 0, total: r.total ?? counts.total, counts })
  })

  route(`${API_PREFIX}/beat/session/rotate`, async (req, res) => {
    if (String(req?.method ?? 'GET').toUpperCase() !== 'POST') {
      json(res, { ok: false, why: '只接受 POST' }, 405)
      return
    }
    await rotateBeatSession(root, log, { agents: ctx?.agents })
    json(res, { ok: true, ...(await beatSnapshot()) })
  })

  // 日记：列表 / 读某天 / 手动写。写要调模型，可能几十秒，界面按钮自己转圈。
  route(`${API_PREFIX}/diary`, async (_req, res) => {
    const [config, days] = await Promise.all([
      loadDiaryConfig(root).catch(() => ({})),
      listDiaries(root, { limit: 60 }).catch(() => []),
    ])
    let state = {}
    try { state = JSON.parse(await readFile(diaryStatePath(root), 'utf8')) } catch { /* 还没写过 */ }
    json(res, {
      ok: true,
      config,
      days,
      lastError: state.lastError || '',
      lastAt: state.lastAt || '',
    })
  })

  route(`${API_PREFIX}/diary/read`, async (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost')
    const day = url.searchParams.get('day') || ''
    const r = await readDiary(root, day)
    json(res, r, r.ok ? 200 : 404)
  })

  route(`${API_PREFIX}/diary/write`, async (req, res) => {
    if (String(req?.method ?? 'GET').toUpperCase() !== 'POST') {
      json(res, { ok: false, why: '只接受 POST' }, 405)
      return
    }
    const raw = await readBody(req)
    let body
    try {
      body = JSON.parse(raw || '{}')
    } catch {
      json(res, { ok: false, why: 'body 不是 JSON' }, 400)
      return
    }
    const r = await writeDiary(root, {
      day: String(body?.day ?? '').trim(),
      force: body?.rewrite === true,
      log,
    })
    json(res, r, r.ok ? 200 : (r.why === 'empty' ? 409 : 502))
  })

  // 总览：所有分片 + 计数
  route(`${API_PREFIX}/state`, async (_req, res) => {
    const scopes = await listScopes(root).catch(() => [])
    const p = paths(root)
    const audit = [...await tailLines(p.writes, 40), ...await tailLines(p.reads, 40)]
      .map((l) => { try { return JSON.parse(l) } catch { return null } })
      .filter(Boolean)
      .sort((a, b) => String(a.at).localeCompare(String(b.at)))
      .slice(-40)
    json(res, {
      ok: true,
      version: version ?? '?',
      root,
      scopes: scopes.map(slimScope),
      counts: {
        scopes: scopes.length,
        items: scopes.reduce((n, s) => n + (s.items?.length || 0), 0),
      },
      audit,
    })
  })

  // 运行状态：人格预算 / 信任 / 每分片容量 / 最近检索 / 跳过原因 / 读取次数
  route(`${API_PREFIX}/obs`, async (_req, res) => {
    const scopes = await listScopes(root).catch(() => [])
    const metrics = await computeMetrics(root).catch(() => null)
    const [trust, persona] = await Promise.all([
      trustState(root, { recheck: true }).catch(() => null),
      personaStatus(root).catch(() => null),
    ])
    const p = paths(root)
    const rows = (await tailLines(p.writes, 400))
      .map((l) => { try { return JSON.parse(l) } catch { return null } })
      .filter(Boolean)
    // 读账单独一份：search / read / profile。读的次数远多于写，混进 writes 会把写入账冲掉。
    const readRows = (await tailLines(p.reads, 400))
      .map((l) => { try { return JSON.parse(l) } catch { return null } })
      .filter(Boolean)
    const byKind = (k) => readRows.filter((r) => r.kind === k)
    const reads = {
      total: readRows.length,
      search: byKind('search').length,
      read: byKind('read').length,
      profile: byKind('profile').length,
      empty: readRows.filter((r) => r.empty || r.ok === false).length,
      tokens: byKind('read').reduce((n, r) => n + (r.tokens || 0), 0),
    }
    const vault = []
    for (const sc of scopes) {
      const p = vaultPaths(root, sc.kind, sc.id)
      let indexBytes = 0
      try { indexBytes = (await stat(p.index)).size } catch { indexBytes = 0 }
      const usage = (await tailLines(p.usage, 300))
        .map((l) => { try { return JSON.parse(l) } catch { return null } })
        .filter(Boolean)
      vault.push({
        scope: sc.scope,
        label: sc.label,
        live: (sc.items || []).filter((x) => x.state !== 'archived' && x.state !== 'superseded' && x.state !== 'suggested' && x.state !== 'expired').length,
        indexBytes,
        pending: existsSync(p.pending),
        lastDeepen: sc.lastDeepen || '',
        itemsSinceDeepen: sc.itemsSinceDeepen || 0,
        reads: usage.filter((x) => x.tool === 'read_memory').length,
      })
    }
    json(res, {
      ok: true,
      trust: trust ? { origin: trust.origin, usable: trust.usable, trustedAt: trust.trustedAt, drift: trust.drift } : null,
      persona,
      vault,
      reads,
      metrics,
      gate: {
        mode: gateLevel,
        // warn 放行的那几条 + enforce 下被拦进待确认的条数，先看拒绝率再切档
        warn: rows.filter((r) => r.kind === 'tool-save' && r.gate === 'warn').length,
        blocked: rows.filter((r) => r.kind === 'tool-save' && r.status === 'suggested').length,
      },
      searches: byKind('search').slice(-15).reverse(),
      skips: rows.filter((r) => r.kind === 'write_skip').slice(-10).reverse(),
      deepens: rows.filter((r) => r.kind === 'deepen').slice(-5).reverse(),
    })
  })

  // 图谱
  route(`${API_PREFIX}/graph`, async (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost')
    let g = await loadGraph(root)
    if (!g.nodes.length || url.searchParams.get('rebuild') === '1') {
      const scopes = await listScopes(root).catch(() => [])
      g = await refreshGraph(root, scopes).catch(() => g)
    }
    json(res, {
      ok: true,
      nodes: g.nodes,
      edges: g.edges,
      top: topNodes(g, 10).map((n) => ({ name: n.name, type: n.type, score: Number(n.score.toFixed(2)) })),
    })
  })

  // 审计账本：默认合并「写 + 读」两本账；?source=injects 看注入账，writes / reads 看单本
  route(`${API_PREFIX}/audit`, async (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost')
    const n = Math.min(500, Math.max(10, Number(url.searchParams.get('n')) || 100))
    const which = url.searchParams.get('source') || 'all'
    const p = paths(root)
    const read = async (file, limit) =>
      (await tailLines(file, limit)).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
    let rows
    if (which === 'writes' || which === 'reads' || which === 'injects') {
      rows = await read(p[which], n)
    } else {
      rows = [...await read(p.writes, n), ...await read(p.reads, n)]
        .sort((a, b) => String(a.at).localeCompare(String(b.at)))
        .slice(-n)
    }
    json(res, { ok: true, source: which, rows })
  })

  // 运行日志
  route(`${API_PREFIX}/logs`, async (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost')
    const n = Math.min(500, Math.max(10, Number(url.searchParams.get('n')) || 120))
    const lines = await tailLines(join(paths(root).logs, 'dsh-whale-memory.log'), n)
    json(res, { ok: true, rows: lines })
  })

  // 重建图谱
  route(`${API_PREFIX}/refresh`, async (_req, res) => {
    const scopes = await listScopes(root).catch(() => [])
    const g = await refreshGraph(root, scopes)
    log?.(`[whale] 界面触发重建 · 节点 ${g.nodes.length} · 边 ${g.edges.length}`)
    json(res, { ok: true, nodes: g.nodes.length, edges: g.edges.length })
  })

  // 删一条记忆（归档，不硬删）
  route(`${API_PREFIX}/forget`, async (req, res) => {
    if (String(req?.method ?? 'GET').toUpperCase() !== 'POST') {
      json(res, { ok: false, why: '只接受 POST' }, 405)
      return
    }
    const raw = await readBody(req)
    let body
    try {
      body = JSON.parse(raw || '{}')
    } catch {
      json(res, { ok: false, why: 'body 不是 JSON' }, 400)
      return
    }
    const scope = String(body?.scope ?? '').trim()
    const itemId = String(body?.id ?? '').trim()
    const [kind, id] = scope.split(':')
    if (!kind || !id || !itemId) {
      json(res, { ok: false, why: 'scope（kind:id）和 id 都要给' }, 400)
      return
    }
    const r = await forgetItem(root, kind, id, itemId, { reason: 'ui' })
    log?.(`[whale] 界面删除 · ${scope} · ${itemId} · ${r.ok ? 'ok' : r.why}`)
    json(res, r.ok ? { ok: true, id: itemId } : { ok: false, why: r.why }, r.ok ? 200 : 404)
  })

  // 待确认转正（界面点「确认」）
  route(`${API_PREFIX}/confirm`, async (req, res) => {
    if (String(req?.method ?? 'GET').toUpperCase() !== 'POST') {
      json(res, { ok: false, why: '只接受 POST' }, 405)
      return
    }
    const raw = await readBody(req)
    let body
    try {
      body = JSON.parse(raw || '{}')
    } catch {
      json(res, { ok: false, why: 'body 不是 JSON' }, 400)
      return
    }
    const scope = String(body?.scope ?? '').trim()
    const itemId = String(body?.id ?? '').trim()
    const [kind, id] = scope.split(':')
    if (!kind || !id || !itemId) {
      json(res, { ok: false, why: 'scope（kind:id）和 id 都要给' }, 400)
      return
    }
    const r = await withWriteLock(() => confirmItem(root, kind, id, itemId))
    if (r.ok) await auditWrite(root, { kind: 'ui-confirm', scope: r.scope, item: itemId })
    log?.(`[whale] 界面确认 · ${scope} · ${itemId} · ${r.ok ? 'ok' : r.why}`)
    json(res, r.ok ? { ok: true, id: itemId, superseded: r.superseded } : { ok: false, why: r.why }, r.ok ? 200 : 404)
  })

  // 模型设置：只回打码后的 key，完整 key 不出这个进程。
  // kind: llm=蒸馏 / search=直连搜索 / embed=向量；三套结构一样，界面分开填。
  const 环境名 = { llm: 'DSH_MEMORY_LLM', search: 'DSH_MEMORY_SEARCH', embed: 'DSH_MEMORY_EMBED' }
  const 就绪 = { llm: llmReady, search: searchReady }
  const llmStateOf = (kind = 'llm') => {
    const f = loadSettings(root)[kind] || {}
    const p = 环境名[kind] || 环境名.llm
    const envBase = String(process.env[`${p}_BASE`] ?? '').trim()
    const envModel = String(process.env[`${p}_MODEL`] ?? '').trim()
    const envKey = String(process.env[`${p}_KEY`] ?? '').trim()
    const base = String(f.base ?? '').trim() || envBase
    const model = String(f.model ?? '').trim() || envModel
    const key = String(f.key ?? '').trim() || envKey
    return {
      kind,
      base,
      model,
      keyMasked: maskKey(key),
      hasKey: Boolean(key),
      from: String(f.base ?? '').trim() ? 'file' : (envBase ? 'env' : ''),
      ready: 就绪[kind] ? 就绪[kind]() : false,
      path: settingsPath(root),
    }
  }

  const 注册模型路由 = (kind, prefix) => {
    route(`${API_PREFIX}${prefix}`, async (req, res) => {
      if (String(req?.method ?? 'GET').toUpperCase() === 'GET') {
        json(res, { ok: true, ...llmStateOf(kind) })
        return
      }
      if (String(req?.method ?? '').toUpperCase() !== 'POST') {
        json(res, { ok: false, why: '只接受 GET / POST' }, 405)
        return
      }
      const raw = await readBody(req)
      let body
      try {
        body = JSON.parse(raw || '{}')
      } catch {
        json(res, { ok: false, why: 'body 不是 JSON' }, 400)
        return
      }
      const base = String(body?.base ?? '').trim().replace(/\/+$/, '')
      const model = String(body?.model ?? '').trim()
      const key = String(body?.key ?? '').trim()
      const clearKey = body?.clearKey === true
      if (base && !/^https?:\/\/[^\s]+$/i.test(base)) {
        json(res, { ok: false, why: '端点要以 http:// 或 https:// 开头' }, 400)
        return
      }
      if (model.length > 80 || base.length > 300) {
        json(res, { ok: false, why: '端点或模型名太长' }, 400)
        return
      }
      // 空着就是「不改」：界面上看不到原 key，不能让一次保存顺手把它清掉
      const prev = loadSettings(root)[kind] || {}
      const next = loadSettings(root)
      if (!base && !model && !key && !clearKey) {
        delete next[kind]
      } else {
        next[kind] = {
          base,
          model,
          key: clearKey ? '' : (key || String(prev.key ?? '')),
        }
      }
      saveSettings(root, next)
      resetSettingsCache()
      // 之前端点挂过会进 10 分钟冷却；换了配置就该马上能试，别让人白等
      resetLlmCooldown()
      json(res, { ok: true, ...llmStateOf(kind) })
    })

    // 测试连通：真发一次最小请求，把 401 / 地址少 /v1 分清楚
    route(`${API_PREFIX}${prefix}/test`, async (req, res) => {
      if (String(req?.method ?? 'GET').toUpperCase() !== 'POST') {
        json(res, { ok: false, why: '只接受 POST' }, 405)
        return
      }
      const r = await probeKind(kind)
      log?.(`[whale] ${kind} 模型连通测试 · ${r.ok ? 'ok' : 'fail'} · ${r.why ?? ''}`)
      json(res, { ok: r.ok, ...r, config: llmStateOf(kind) })
    })

    // 探测可用模型：拉 /models，再逐个真发一次最小对话请求。
    // 只读不落盘——用户还没点保存，探测不该顺手改配置。
    route(`${API_PREFIX}${prefix}/models`, async (req, res) => {
      if (String(req?.method ?? 'GET').toUpperCase() !== 'POST') {
        json(res, { ok: false, why: '只接受 POST' }, 405)
        return
      }
      const raw = await readBody(req)
      let body
      try {
        body = JSON.parse(raw || '{}')
      } catch {
        json(res, { ok: false, why: 'body 不是 JSON' }, 400)
        return
      }
      // 端点用表单里的；key 留空沿用已保存的，和保存的规则保持一致
      const saved = loadSettings(root)[kind] || {}
      const base = String(body?.base ?? '').trim().replace(/\/+$/, '') ||
        String(saved.base ?? '').trim().replace(/\/+$/, '')
      const key = String(body?.key ?? '').trim() || String(saved.key ?? '').trim()
      if (!base) {
        json(res, { ok: false, why: '端点不能为空' }, 400)
        return
      }
      if (!/^https?:\/\/[^\s]+$/i.test(base)) {
        json(res, { ok: false, why: '端点要以 http:// 或 https:// 开头' }, 400)
        return
      }
      if (base.length > 300) {
        json(res, { ok: false, why: '端点太长' }, 400)
        return
      }
      const r = await listChatModels({ base, key })
      if (!r.ok) {
        log?.(`[whale] ${kind} 模型探测失败 · ${r.status ?? ''} ${r.why ?? ''}`.trim())
        json(res, { ...r, base }, 502)
        return
      }
      log?.(`[whale] ${kind} 模型探测 ${base} · 可用 ${r.counts.usable} / 共 ${r.models.length}`)
      json(res, { ...r, base })
    })
  }

  注册模型路由('llm', '/llm')
  注册模型路由('search', '/llm/search')

  return {
    dispose() {
      for (const d of disposers) { try { d() } catch { /* ignore */ } }
    },
  }
}
