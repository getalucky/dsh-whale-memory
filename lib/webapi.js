/**
 * webapi.js —— 给网页界面用的接口
 *
 * 前缀统一 /dsh-whale-memory/api。默认只读，写口单独校验。
 * 鉴权：界面先 GET /session 领进程令牌，之后每个请求带 x-whale-token；
 * 同时校验 Origin / Sec-Fetch-Site / Host，挡跨站请求和 DNS rebinding。
 * POST 只收 application/json，跨站表单发不进来。
 */

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { open, readFile, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { isIP } from 'node:net'
import { join } from 'node:path'

import { listScopes, paths, withWriteLock, auditWrite } from './store.js'
import { buildBundle, importBundle } from './backupbundle.js'
import { importHistory, defaultSessionsDir, IMPORT_CAP, IMPORT_MAX_ADD, IMPORT_MAX_MESSAGES } from './importer.js'
import { confirmItem } from './confirm.js'
import { refreshGraph, loadGraph, topNodes } from './graph.js'
import { isLive } from './itemstate.js'
import { lifeState, renderMemory } from './inject.js'
import { buildMembers } from './profile.js'
import { forgetItem } from './forget.js'
import { vaultPaths } from './vault.js'
import { trustState } from './trust.js'
import { gateMode } from './gate.js'
import { computeMetrics } from './metrics.js'
import { status as personaStatus } from './persona.js'
import { loadSettings, saveSettings, maskKey, settingsPath } from './settings.js'
import { personaBudget, personaBudgetConfig, setPersonaBudget, PERSONA_BUDGET_LIMITS } from './personalimit.js'
import { llmReady, searchReady, embedReady, probeKind, probeEmbed, listChatModels, listEmbedModels, resetSettingsCache, resetLlmCooldown } from './llm.js'
import { resetVectorFallback } from './funnel.js'
import { loadConfig, saveConfig, saveFocus, deliveriesPath, feedbackPath } from './beat/config.js'
import { bridgeConfig, ownerTarget, sessionKey } from './beat/delivery.js'
import { currentAffect } from './affect/index.js'
import { gcMaterial, materialCounts, materialList, scoreOf } from './beat/material.js'
import { loadState, updateState } from './beat/index.js'
import { loadSessions, rotateBeatSession } from './beat/session.js'
import { schedulerState } from './beat/scheduler.js'
import { summarizeFeedback, pendingJudges } from './beat/feedback.js'
import { beatMetrics } from './beat/metrics.js'
import { profileInterests, profilePath } from './person/profile.js'
import { profileStatus, rebuildAndVerify } from './person/rebuild.js'
import { listDiaries, readDiary, writeDiary, loadConfig as loadDiaryConfig, statePath as diaryStatePath } from './diary.js'
import { healthReport } from './health.js'

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

/** 只读文件尾巴：审计账本能到几十 MB，整份读进来只为最后几十行太亏。 */
async function tailLines(file, n = 100, maxBytes = 256 * 1024) {
  let fh = null
  try {
    const st = await stat(file)
    const start = Math.max(0, st.size - maxBytes)
    const len = st.size - start
    if (!len) return []
    fh = await open(file, 'r')
    const buf = Buffer.alloc(len)
    await fh.read(buf, 0, len, start)
    const lines = buf.toString('utf8').split('\n').filter(Boolean)
    // 从中间切进来时第一行可能是半截 JSON，丢掉
    if (start > 0 && lines.length) lines.shift()
    return lines.slice(-n)
  } catch {
    return []
  } finally {
    await fh?.close().catch(() => {})
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
      steps: Array.isArray(it.steps) ? it.steps : [],
      verify: it.verify || '',
      skillReview: it.skillReview === true,
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
  if ('refillWebBelow' in body) {
    const n = 整数(body.refillWebBelow, 0, 10)
    if (n == null) return fail('refillWebBelow 要是 0–10 的数字')
    patch.refillBelowBySource = { ...(patch.refillBelowBySource || {}), web: n }
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

// 进程内随机令牌：界面先 GET /session 取，之后每个请求带 x-whale-token。
// 浏览器跨站拿不到响应（没有 CORS 头），也过不了 Origin / Sec-Fetch-Site 检查。
const API_TOKEN = randomBytes(24).toString('hex')
const SESSION_PATH = `${API_PREFIX}/session`
const TOKEN_HEADER = 'x-whale-token'
const API_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])
// 环境变量里显式加的才允许非本机来源；默认那几个只服务回环，不算白名单。
const EXTRA_HOSTS = new Set()
for (const h of String(process.env.DSH_MEMORY_API_HOSTS ?? '').split(',')) {
  const s = h.trim().toLowerCase()
  if (s) {
    API_HOSTS.add(s)
    EXTRA_HOSTS.add(s)
  }
}

function headerOf(req, name) {
  const h = req?.headers
  if (!h) return ''
  const v = h[name] ?? h[name.toLowerCase()] ?? h[name.toUpperCase()]
  return Array.isArray(v) ? String(v[0] ?? '') : String(v ?? '')
}

/** 只认本机名或 IP 字面量；域名必须显式加进 DSH_MEMORY_API_HOSTS，挡 DNS rebinding。 */
function hostAllowed(req) {
  const raw = headerOf(req, 'host')
  if (!raw) return true
  let hostname = ''
  try { hostname = new URL(`http://${raw}`).hostname.toLowerCase() } catch { return false }
  if (API_HOSTS.has(hostname)) return true
  return isIP(hostname.replace(/^\[|\]$/g, '')) !== 0
}

function hostnameOf(req) {
  const raw = headerOf(req, 'host')
  if (!raw) return ''
  try { return new URL(`http://${raw}`).hostname.toLowerCase() } catch { return '' }
}

const LOOPBACK = /^(::1|::ffff:127\.|127\.)/

/**
 * 来源地址也要卡：Web 服务器要是绑到 0.0.0.0，光看 Host 头等于谁都能来领 /session 的令牌。
 * 回环永远放行；非回环必须把访问用的主机名显式写进 DSH_MEMORY_API_HOSTS。
 */
function remoteAllowed(req) {
  const addr = String(req?.socket?.remoteAddress ?? '').toLowerCase()
  if (!addr) return true // 拿不到来源（自测桩/反代剥离）就沿用旧行为，别误伤
  if (LOOPBACK.test(addr)) return true
  return EXTRA_HOSTS.has(hostnameOf(req))
}

function sameOrigin(req) {
  const site = headerOf(req, 'sec-fetch-site').toLowerCase()
  if (site && site !== 'same-origin' && site !== 'none') return false
  const origin = headerOf(req, 'origin')
  if (!origin) return true
  if (origin === 'null') return false
  try {
    return new URL(origin).host === headerOf(req, 'host')
  } catch {
    return false
  }
}

function tokenMatches(req) {
  const got = headerOf(req, TOKEN_HEADER)
  if (!got || got.length !== API_TOKEN.length) return false
  try {
    return timingSafeEqual(Buffer.from(got), Buffer.from(API_TOKEN))
  } catch {
    return false
  }
}

/**
 * 注册路由。
 * @returns {{dispose:()=>void}|null}
 */
export function registerWebApi(ctx, { root, log, version, label, build, gate = {} } = {}) {
  const gateLevel = gateMode(gate)
  const ws = ctx.webServer
  if (!ws || typeof ws.register !== 'function') {
    log?.('[whale] webServer 不可用，界面接口没挂上')
    return null
  }

  const disposers = []
  const route = (path, handler) => {
    const guarded = async (req, res) => {
      try { res.setHeader?.('x-content-type-options', 'nosniff') } catch { /* ignore */ }
      try { res.setHeader?.('referrer-policy', 'no-referrer') } catch { /* ignore */ }
      if (!hostAllowed(req) || !sameOrigin(req)) {
        json(res, { ok: false, why: '跨站或非本机请求被拒绝' }, 403)
        return
      }
      if (!remoteAllowed(req)) {
        json(res, { ok: false, why: '非本机来源被拒绝：要给局域网用，请把主机名加进 DSH_MEMORY_API_HOSTS' }, 403)
        return
      }
      const method = String(req?.method ?? 'GET').toUpperCase()
      if (path === SESSION_PATH) {
        if (method !== 'GET') {
          json(res, { ok: false, why: '只接受 GET' }, 405)
          return
        }
        return handler(req, res)
      }
      if (!tokenMatches(req)) {
        json(res, { ok: false, why: '接口未鉴权：先 GET /dsh-whale-memory/api/session' }, 401)
        return
      }
      if (method === 'OPTIONS') {
        json(res, { ok: false, why: '不支持 OPTIONS' }, 405)
        return
      }
      if (method === 'POST') {
        const ct = headerOf(req, 'content-type').toLowerCase()
        if (!ct.startsWith('application/json')) {
          json(res, { ok: false, why: 'POST 只收 application/json' }, 415)
          return
        }
      }
      return handler(req, res)
    }
    try {
      const d = ws.register({ kind: 'exact', path, handler: guarded })
      if (typeof d === 'function') disposers.push(d)
      else if (d?.dispose) disposers.push(() => d.dispose())
    } catch (e) {
      log?.(`[whale] 路由注册失败 ${path}: ${String(e?.message ?? e).slice(0, 120)}`)
    }
  }

  // 界面启动先来领令牌；这个口只认同源/本机，不发 CORS 头，跨站读不到。
  route(SESSION_PATH, async (_req, res) => {
    json(res, { ok: true, token: API_TOKEN })
  })

  // 主动行为层：设置页读这一份，写口分开（config / focus / profile / gc）
  const beatSnapshot = async () => {
    const [config, state, counts, materials, profile, pstat, sessions, deliveriesRaw, feedbackRaw, metrics] = await Promise.all([
      loadConfig(root).catch(() => ({})),
      loadState(root).catch(() => ({})),
      materialCounts(root).catch(() => ({ active: 0, total: 0, bySource: { public: 0, web: 0, chat: 0 } })),
      materialList(root, { state: 'active', limit: 12 }).catch(() => []),
      readFile(profilePath(root), 'utf8').then((s) => JSON.parse(s)).catch(() => null),
      profileStatus(root).catch(() => null),
      loadSessions(root).catch(() => ({ sessionId: '', createdAt: '', lastUsedAt: '', rotates: 0 })),
      tailLines(deliveriesPath(root), 12),
      tailLines(feedbackPath(root), 20),
      beatMetrics(root).catch(() => null),
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
    let agentDefault = null
    try {
      const sel = ctx.get?.('agentDefaultModel')?.currentSelection?.()
      if (sel?.provider || sel?.model) agentDefault = { provider: sel.provider || '', model: sel.model || '' }
    } catch { /* 宿主没有模型服务 */ }
    return {
      ok: true,
      config,
      agentDefault,
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
      metrics,
      pendingJudges: pendingJudges(),
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
    const before = await loadConfig(root).catch(() => ({}))
    await saveConfig(root, r.value)
    // 改了闲逛 agent 的 provider/model 就轮换专用会话：活着的 agent 不会自己换模型，
    // 不轮换的话设置看起来保存了，下一跳还在用旧模型。
    const modelChanged = ('model' in r.value && String(r.value.model ?? '') !== String(before.model ?? ''))
      || ('provider' in r.value && String(r.value.provider ?? '') !== String(before.provider ?? ''))
    if (modelChanged) {
      let agents = null
      try { agents = ctx?.agents || ctx?.get?.('agents') || null } catch { agents = null }
      await rotateBeatSession(root, log, { agents }).catch(() => {})
      log?.('[whale] 闲逛 provider/model 变了，已轮换专用会话')
    }
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
    const off = body?.off === true || body?.minutes === 0 || body?.minutes === '0'
    let focusUntil = ''
    if (!off) {
      const min = 整数(body?.minutes, 1, 1440)
      if (min == null) {
        json(res, { ok: false, why: '专注分钟要是 1–1440 的数字' }, 400)
        return
      }
      focusUntil = new Date(Date.now() + min * 60000).toISOString()
    }
    await updateState(root, (st) => { st.focusUntil = focusUntil })
    await saveFocus(root, focusUntil).catch(() => {})
    log?.(`[whale] beat 专注 · ${focusUntil || '已关'}`)
    json(res, { ok: true, focusUntil })
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
    // 宿主服务是严格代理：没 inject 过的属性直接读会抛，必须包起来取
    let agents
    try { agents = ctx?.get?.('agents') || ctx?.agents } catch { agents = null }
    await rotateBeatSession(root, log, { agents })
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
      label: label || `v${version ?? '?'}`,
      build: build ?? null,
      root,
      scopes: scopes.map(slimScope),
      counts: {
        scopes: scopes.length,
        items: scopes.reduce((n, s) => n + (s.items?.length || 0), 0),
      },
      // 情绪顺带带上：总览页一个瓦片就够，不用再单开一次请求（文档 14.9）
      affect: currentAffect()?.status() ?? null,
      audit,
    })
  })

  // 情绪：只读。数值在 affect/state.json 里，想手改直接改文件，不开写口（文档 14.9）。
  route(`${API_PREFIX}/affect`, async (_req, res) => {
    const affect = currentAffect()
    if (!affect) {
      json(res, { ok: false, why: '情绪层未挂载' }, 404)
      return
    }
    json(res, { ok: true, ...affect.status() })
  })

  // 导出记忆：返回一个可下载的 JSON 包，设置里的密钥不包含在内。
  route(`${API_PREFIX}/backup/export`, async (_req, res) => {
    try {
      const data = await buildBundle(root)
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      json(res, { ok: true, filename: `whale-memory-${stamp}.json`, data })
    } catch (e) {
      json(res, { ok: false, why: String(e?.message ?? e) }, 500)
    }
  })

  // 导入备份：默认只预演；真正合并时按条目去重，不覆盖当前库。
  route(`${API_PREFIX}/backup/import`, async (req, res) => {
    if (String(req?.method ?? 'GET').toUpperCase() !== 'POST') {
      json(res, { ok: false, why: '只接受 POST' }, 405)
      return
    }
    const raw = await readBody(req, 32 * 1024 * 1024)
    let body
    try { body = JSON.parse(raw) } catch {
      json(res, { ok: false, why: '备份文件不是有效 JSON' }, 400)
      return
    }
    try {
      const r = await importBundle(root, body?.data, { dryRun: body?.dryRun !== false })
      json(res, r)
    } catch (e) {
      json(res, { ok: false, why: String(e?.message ?? e) }, 400)
    }
  })

  // 导入召回：扫描 DSH 旧会话，把还没进记忆库的内容补进来（默认只预演）。
  route(`${API_PREFIX}/import/history`, async (req, res) => {
    if (String(req?.method ?? 'GET').toUpperCase() !== 'POST') {
      json(res, { ok: false, why: '只接受 POST' }, 405)
      return
    }
    const raw = await readBody(req, 256 * 1024)
    let body
    try { body = JSON.parse(raw) } catch {
      json(res, { ok: false, why: '参数不是有效 JSON' }, 400)
      return
    }
    try {
      const r = await importHistory({
        root,
        dir: String(body?.dir || defaultSessionsDir()),
        since: String(body?.since || ''),
        until: String(body?.until || ''),
        scope: String(body?.scope || ''),
        maxSessions: Number(body?.maxSessions) || 0,
        maxMessages: Number(body?.maxMessages) || IMPORT_MAX_MESSAGES,
        maxAdd: Number(body?.maxAdd) || IMPORT_MAX_ADD,
        cap: Number(body?.cap) || IMPORT_CAP,
        llm: body?.llm === true,
        includePastEvents: body?.events === true,
        force: body?.force === true,
        dryRun: body?.dryRun !== false,
        log: (line) => log?.(`[whale] ${line}`),
      })
      json(res, r)
    } catch (e) {
      json(res, { ok: false, why: String(e?.message ?? e) }, 400)
    }
  })

  // 运行状态：人格预算 / 信任 / 每分片容量 / 最近检索 / 跳过原因 / 读取次数
  route(`${API_PREFIX}/obs`, async (_req, res) => {
    const scopes = await listScopes(root).catch(() => [])
    const metrics = await computeMetrics(root, { scopes }).catch(() => null)
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
        live: (sc.items || []).filter((x) => isLive(x)).length,
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

  // 体检：只读，不改任何东西。修不修由人决定。
  route(`${API_PREFIX}/health`, async (_req, res) => {
    const report = await healthReport(root).catch((e) => ({ ok: false, why: String(e?.message ?? e) }))
    json(res, report)
  })

  // 图谱
  route(`${API_PREFIX}/graph`, async (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost')
    const method = String(req?.method ?? 'GET').toUpperCase()
    const rebuild = url.searchParams.get('rebuild') === '1'
    if (rebuild && method !== 'POST') {
      json(res, { ok: false, why: '重建图谱要用 POST' }, 405)
      return
    }
    let g = await loadGraph(root)
    // 旧格式没存原句/分片列表：顺手重建一次，界面才有得看
    const 旧格式 = g.nodes.some((n) => !Array.isArray(n.texts)) ||
      g.edges.some((e) => !Array.isArray(e.texts) || !Array.isArray(e.scopes))
    if (!g.nodes.length || rebuild || 旧格式) {
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

  // 重建图谱（写盘，必须 POST）
  route(`${API_PREFIX}/refresh`, async (req, res) => {
    if (String(req?.method ?? 'GET').toUpperCase() !== 'POST') {
      json(res, { ok: false, why: '只接受 POST' }, 405)
      return
    }
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
  const 就绪 = { llm: llmReady, search: searchReady, embed: embedReady }
  const llmStateOf = (kind = 'llm') => {
    const f = loadSettings(root)[kind] || {}
    const p = 环境名[kind] || 环境名.llm
    const envBase = String(process.env[`${p}_BASE`] ?? '').trim()
    const envModel = String(process.env[`${p}_MODEL`] ?? '').trim()
    const envKey = String(process.env[`${p}_KEY`] ?? '').trim()
    let base = String(f.base ?? '').trim() || envBase
    let model = String(f.model ?? '').trim() || envModel
    let key = String(f.key ?? '').trim() || envKey
    let from = String(f.base ?? '').trim() ? 'file' : (envBase ? 'env' : '')
    // 向量没单独填端点时跟蒸馏共用 base/key；模型名仍单独填。
    if (kind === 'embed' && !base) {
      const lf = loadSettings(root).llm || {}
      const lp = 环境名.llm
      base = String(lf.base ?? '').trim() || String(process.env[`${lp}_BASE`] ?? '').trim()
      key = String(lf.key ?? '').trim() || String(process.env[`${lp}_KEY`] ?? '').trim()
      if (base) from = 'llm'
    }
    return {
      kind,
      base,
      model,
      keyMasked: maskKey(key),
      hasKey: Boolean(key),
      from,
      inherit: from === 'llm',
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
      const inherit = kind === 'embed' && body?.inherit === true
      const clearKey = body?.clearKey === true || inherit
      // 继承模式把 embed 自己的 base/key 清空，运行时自动跟蒸馏走。
      const clearBase = body?.clearBase === true || inherit
      if (base && !/^https?:\/\/[^\s]+$/i.test(base)) {
        json(res, { ok: false, why: '端点要以 http:// 或 https:// 开头' }, 400)
        return
      }
      if (model.length > 80 || base.length > 300) {
        json(res, { ok: false, why: '端点或模型名太长' }, 400)
        return
      }
      // 空着就是「不改」：界面上看不到原 key，不能让一次保存顺手把它清掉
      const next = loadSettings(root)
      const prev = next[kind] || {}
      const prevBase = String(prev.base ?? '').trim().replace(/\/+$/, '')
      const prevKey = String(prev.key ?? '').trim()
      // 换端点时必须重填 key——否则已保存的 key 会被悄悄带到新地址去
      if (base && base !== prevBase && !key && !clearKey && prevKey) {
        json(res, { ok: false, why: '换端点时必须重新填 key，不能把已保存的 key 发到新地址' }, 400)
        return
      }
      if (!base && !model && !key && !clearKey) {
        delete next[kind]
      } else {
        // 带上旧密文：key 没变时 saveSettings 直接沿用，不必每次保存都重跑 DPAPI
        const entry = {
          ...prev,
          base: clearBase ? '' : (base || prevBase),
          model,
          key: clearKey ? '' : (key || prevKey),
        }
        // 显式清除要带标记：留空代表不改，不能顺手删掉旧密文
        if (clearKey) entry.clearKey = true
        else delete entry.clearKey
        next[kind] = entry
      }
      saveSettings(root, next, { log })
      resetSettingsCache()
      // 之前端点挂过会进 10 分钟冷却；换了配置就该马上能试，别让人白等
      resetLlmCooldown()
      resetVectorFallback()
      json(res, { ok: true, ...llmStateOf(kind) })
    })

    // 测试连通：真发一次最小请求，把 401 / 地址少 /v1 分清楚
    route(`${API_PREFIX}${prefix}/test`, async (req, res) => {
      if (String(req?.method ?? 'GET').toUpperCase() !== 'POST') {
        json(res, { ok: false, why: '只接受 POST' }, 405)
        return
      }
      const r = kind === 'embed' ? await probeEmbed() : await probeKind(kind)
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
      // 端点用表单里的；key 留空沿用已保存的，但换端点时必须重新填 key——
      // 否则一次请求就能让已保存的 key 被发到任意地址。
      const saved = loadSettings(root)[kind] || {}
      const savedBase = String(saved.base ?? '').trim().replace(/\/+$/, '')
      const requestedBase = String(body?.base ?? '').trim().replace(/\/+$/, '')
      const bodyKey = String(body?.key ?? '').trim()
      const savedKey = String(saved.key ?? '').trim()
      if (!bodyKey && savedKey && requestedBase && requestedBase !== savedBase) {
        json(res, { ok: false, why: '换端点时必须重新填 key，不能把已保存的 key 发到新地址' }, 400)
        return
      }
      const base = requestedBase || savedBase
      const key = bodyKey || savedKey
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
      const r = kind === 'embed'
        ? await listEmbedModels({ base, key })
        : await listChatModels({ base, key })
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
  注册模型路由('embed', '/llm/embed')

  // 人格预算：fixed 固定额度 / auto 按上下文窗口 × 占比自动算，都钳在 600–2400。
  const budgetState = () => ({ config: personaBudgetConfig(), budget: personaBudget(), limits: PERSONA_BUDGET_LIMITS, path: settingsPath(root) })
  route(`${API_PREFIX}/persona/budget`, async (req, res) => {
    if (String(req?.method ?? 'GET').toUpperCase() === 'GET') {
      // 手改 settings.json 不重启也能生效：GET 时从磁盘重新装一次
      const saved = loadSettings(root).persona_budget || null
      setPersonaBudget(saved)
      json(res, { ok: true, ...budgetState() })
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
    const mode = String(body?.mode ?? '').trim().toLowerCase()
    if (mode !== 'fixed' && mode !== 'auto') {
      json(res, { ok: false, why: 'mode 只能是 fixed 或 auto' }, 400)
      return
    }
    const [tMin, tMax] = PERSONA_BUDGET_LIMITS.tokens
    const [wMin, wMax] = PERSONA_BUDGET_LIMITS.window
    const [sMin, sMax] = PERSONA_BUDGET_LIMITS.share
    const num = (v) => {
      if (v === undefined || v === null || String(v).trim() === '') return null
      const n = Number(v)
      return Number.isFinite(n) ? n : NaN
    }
    const tokens = num(body?.tokens)
    const window = num(body?.window)
    const share = num(body?.share)
    if ([tokens, window, share].some(Number.isNaN)) {
      json(res, { ok: false, why: '额度、窗口、占比必须是数字' }, 400)
      return
    }
    if (tokens !== null && (tokens < tMin || tokens > tMax)) {
      json(res, { ok: false, why: `固定额度要在 ${tMin}–${tMax} 之间` }, 400)
      return
    }
    if (window !== null && window > 0 && (window < wMin || window > wMax)) {
      json(res, { ok: false, why: `上下文窗口要在 ${wMin}–${wMax} 之间` }, 400)
      return
    }
    if (share !== null && share > 0 && (share < sMin || share > sMax)) {
      json(res, { ok: false, why: `占比要在 ${sMin * 100}%–${sMax * 100}% 之间` }, 400)
      return
    }
    if (mode === 'auto' && !(window > 0)) {
      json(res, { ok: false, why: '自动模式必须填上下文窗口' }, 400)
      return
    }
    if (mode === 'auto' && !(share > 0)) {
      json(res, { ok: false, why: '自动模式必须填占比' }, 400)
      return
    }
    const 当前 = personaBudget()
    const next = {
      mode,
      // 没传就沿用当前解析值，表单只改一个字段时不会把其它项清零
      tokens: tokens === null ? 当前.tokens : Math.round(tokens),
      window: window === null ? (当前.window || null) : Math.round(window),
      share: share === null ? (当前.share || null) : share,
    }
    const settings = loadSettings(root)
    settings.persona_budget = next
    saveSettings(root, settings, { log })
    setPersonaBudget(next)
    const b = personaBudget()
    log?.(`[whale] 人格预算已更新 · ${b.mode} ${b.limit} tok${b.why ? `（${b.why}）` : ''}`)
    json(res, { ok: true, ...budgetState() })
  })

  return {
    dispose() {
      for (const d of disposers) { try { d() } catch { /* ignore */ } }
    },
  }
}
