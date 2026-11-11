/**
 * beat/index.js —— 主动行为层生命周期
 *
 * 默认关闭。开启后每分钟看一次节律；真正花 token 的动作（闲逛/投递）都要
 * 先过纯代码闸门。dryRun 默认开，先看素材包像不像人话，再真投。
 */

import { readFile } from 'node:fs/promises'

import { appendJsonl, writeAtomic } from '../store.js'
import {
  ensureBeatDirs, loadConfig, logsPath, topicPath,
} from './config.js'
import { loadState, saveState, updateState, withStateLock } from './state.js'
import { checkGate } from './gate.js'
import { availableFocuses, dayKey, pickFocus, wanderDue } from './schedule.js'
import {
  materialCounts, markUsed, relevantCandidates, resurface, sourceKind,
} from './material.js'
import { pullPublic } from './sources/public.js'
import { wander } from './sources/web.js'
import {
  candidateIds, deliver, hostUserMessage, mixCandidates, ownerTarget, sameSessionId,
} from './delivery.js'
import { readStagingLines } from '../ingest.js'
import { getBeatAgent } from './session.js'
import { ensurePreset } from './preset.js'
import { maintain } from './maintain.js'
import { senseEnv } from './env.js'
import { schedulerState } from './scheduler.js'
import { noteDelivery, settleUnreported } from './feedback.js'
import { clearNotepadIf, readNotepad } from '../secure/notepad.js'
import { checkSensitiveHealth } from '../secure/vault.js'
import { loadProfile, profileInterests, rebuildProfile } from '../person/profile.js'
import { searchComplete, searchReady } from '../llm.js'

const TICK_MS = 60 * 1000
/** 目标会话被占着时的重试间隔：不算当天失败，等它让出来。 */
const TARGET_BUSY_BACKOFF_MS = 10 * 60 * 1000

// 兼容旧引用：webapi / tools 之前从 index.js 取这几个函数
export { loadState, saveState, updateState, withStateLock }

function timeout(p, ms) {
  let timer
  return Promise.race([
    Promise.resolve(p),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timeout ${ms}ms`)), ms)
    }),
  ]).finally(() => clearTimeout(timer))
}

/**
 * 宿主 ctx 是服务代理：没 inject 过的属性读取会直接抛，不能拿它当普通对象试探。
 * inject 回调还没回来时按「暂时没有 agents」处理，等下一跳或探针再试。
 */
function agentsOf(host) {
  try {
    const a = host?.agents
    if (a) return a
  } catch { /* 没注入 */ }
  try { return host?.get?.('agents') || null } catch { return null }
}

/** 宿主不同版本把事件挂在 session.events 或 snapshotEvents()，两边都认。 */
export function sessionEvents(session) {
  if (!session) return []
  if (typeof session.snapshotEvents === 'function') {
    try {
      const snap = session.snapshotEvents()
      if (Array.isArray(snap)) return snap
    } catch { /* 旧宿主没有这个接口 */ }
  }
  return Array.isArray(session.events) ? session.events : []
}

export function sessionEventCount(session) {
  if (session && typeof session.seq === 'number') return session.seq
  return sessionEvents(session).length
}

/**
 * 事件正文的位置随宿主版本变过：data.content / data.message.content /
 * message.content 都有。reasoning 不算正文。
 */
export function textOfEvent(e) {
  const c = e?.data?.content ?? e?.data?.message?.content ?? e?.content ?? e?.message?.content
  if (Array.isArray(c)) {
    return c
      .filter((x) => x && x.type !== 'reasoning' && typeof x.text === 'string')
      .map((x) => x.text)
      .join('\n')
      .trim()
  }
  if (typeof c === 'string') return c.trim()
  if (typeof e?.data?.text === 'string') return e.data.text.trim()
  return ''
}

/** 从这一轮之后倒着找最后一条有正文的 assistant 事件。 */
export function lastAssistantText(events, { seq, index } = {}) {
  const list = Array.isArray(events) ? events : []
  const useSeq = Number.isFinite(seq) && list.some((e) => Number.isFinite(e?.seq))
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const e = list[i]
    if (useSeq && Number.isFinite(e?.seq)) {
      if (e.seq < seq) break
    } else if (Number.isFinite(index) && i < index) {
      break
    }
    if (!String(e?.type || '').includes('assistant')) continue
    const t = textOfEvent(e)
    if (t) return t
  }
  return ''
}

/** 这一轮以 turn/end error 结束就把真实错误带出来，别让调用方当成空回复。 */
export function turnErrorText(events, { seq, index } = {}) {
  const list = Array.isArray(events) ? events : []
  const useSeq = Number.isFinite(seq) && list.some((e) => Number.isFinite(e?.seq))
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const e = list[i]
    if (useSeq && Number.isFinite(e?.seq)) {
      if (e.seq < seq) break
    } else if (Number.isFinite(index) && i < index) {
      break
    }
    if (e?.type !== 'turn/end') continue
    const reason = e?.data?.reason ?? e?.reason
    if (reason?.kind !== 'error') return ''
    const msg = String(reason?.error?.message ?? reason?.message ?? 'turn error')
    const code = String(reason?.error?.code ?? reason?.code ?? '')
    return code && !msg.includes(code) ? `${msg} (${code})` : msg
  }
  return ''
}

/** 宿主 agent 的一轮：followup → whenIdle → 取最后一条 assistant 文本。 */
function makeAgentTurn(host, root, config, log) {
  return async (prompt, label, timeoutMs = 240000) => {
    const r = await getBeatAgent({ ctx: host, root, config, log })
    if (!r.ok) throw new Error(r.why || 'no-agent')
    const agent = r.agent
    const session = agent?.session
    const beforeSeq = Number.isFinite(session?.seq) ? session.seq : undefined
    const beforeIndex = sessionEvents(session).length
    agent.followup(await hostUserMessage(prompt, label))
    try {
      if (typeof agent.whenIdle === 'function') await timeout(agent.whenIdle(), timeoutMs)
    } catch (e) {
      // 超时后这一轮还在宿主里跑，会继续烧 token；能取消就取消。
      try { agent.cancel?.() } catch { /* 宿主没有 cancel */ }
      throw e
    }
    const events = sessionEvents(session)
    const turnError = turnErrorText(events, { seq: beforeSeq, index: beforeIndex })
    if (turnError) throw new Error(`turn: ${turnError}`)
    return lastAssistantText(events, { seq: beforeSeq, index: beforeIndex })
  }
}

/**
 * 搜索模型直连：设置页「找素材 → 直连搜索模型」时走这条。
 * 模型要自带联网能力；结果照样过 parseWanderResponse 的 URL 校验。
 */
function makeSearchTurn(log) {
  return async (prompt) => {
    const text = await searchComplete(prompt, { timeoutMs: 240000 })
    if (!text) throw new Error('search-model-empty')
    return text
  }
}

const TOPIC_MESSAGES = 6
const TOPIC_MAX_CHARS = 600
/** 「当下」只认最近一天：7 天前的快照早就不是现在在聊的事了，不能拿来给投递背书。 */
const TOPIC_TTL_MS = 24 * 3600000

/** 只留最后几条，且总长不超预算；超了从最老的开始丢。 */
function fitTopicMessages(messages, maxChars = TOPIC_MAX_CHARS) {
  const out = []
  let total = 0
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i]
    if (!m?.text) continue
    if (out.length && total + m.text.length > maxChars) break
    out.push(m)
    total += m.text.length
  }
  return out.reverse()
}

/** 目标会话 id 来自设置页，落进文件名之前先挡住路径分隔符。 */
function safeStagingId(id) {
  return /^[A-Za-z0-9._-]{1,128}$/.test(id) && !id.includes('..')
}

/** 从 staging 里捞目标会话最近几句人话；名字两种写法都试。 */
async function stagingTopic(root, sessionId) {
  for (const id of candidateIds(sessionId)) {
    if (!safeStagingId(id)) continue
    const lines = await readStagingLines(root, id).catch(() => [])
    if (!lines.length) continue
    const msgs = []
    for (let i = lines.length - 1; i >= 0 && msgs.length < TOPIC_MESSAGES; i -= 1) {
      try {
        const r = JSON.parse(lines[i])
        if (r?.role !== 'user' && r?.role !== 'her') continue
        const text = String(r.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 300)
        if (!text) continue
        msgs.push({ role: r.role, text, at: String(r.at || '') })
      } catch { /* 坏行跳过 */ }
    }
    if (!msgs.length) continue
    const messages = fitTopicMessages(msgs.reverse())
    return { sessionId: id, at: String(messages[messages.length - 1]?.at || ''), messages }
  }
  return null
}

/** staging 被蒸馏清掉以后，用上一跳存下的快照对话题。太旧就不算“当下”。 */
async function readTopicSnapshot(root, sessionId, now) {
  try {
    const snap = JSON.parse(await readFile(topicPath(root), 'utf8'))
    if (!sameSessionId(snap?.sessionId, sessionId)) return null
    const at = Date.parse(snap.at || '')
    if (!Number.isFinite(at) || now.getTime() - at > TOPIC_TTL_MS) return null
    const messages = (Array.isArray(snap.messages) ? snap.messages : [])
      .filter((m) => m && (m.role === 'user' || m.role === 'her') && m.text)
      .map((m) => ({ role: m.role, text: String(m.text).slice(0, 300), at: String(m.at || '') }))
    return messages.length ? { sessionId: snap.sessionId, at: snap.at, messages } : null
  } catch { return null }
}

async function rememberTopic(root, topic) {
  if (!topic?.messages?.length) return
  const next = { sessionId: topic.sessionId, at: topic.at, messages: topic.messages }
  try {
    if (await readFile(topicPath(root), 'utf8') === JSON.stringify(next)) return
  } catch { /* 还没有旧快照 */ }
  await writeAtomic(topicPath(root), JSON.stringify(next)).catch(() => {})
}

async function readRecentTopic(root, sessionId, now) {
  const fresh = await stagingTopic(root, sessionId)
  if (fresh) {
    const at = Date.parse(fresh.at || '') || now.getTime()
    if (now.getTime() - at > TOPIC_TTL_MS) return null
    const topic = { sessionId: fresh.sessionId, at: new Date(at).toISOString(), messages: fresh.messages }
    await rememberTopic(root, topic)
    return { ...topic, from: 'staging' }
  }
  const snap = await readTopicSnapshot(root, sessionId, now)
  return snap ? { ...snap, from: 'snapshot' } : null
}

/**
 * 投递候选。绑了目标会话时先对话题：搭不上就返回空列表，闸门记
 * no-topic / off-topic，这一跳不投也不为了凑数随机补位。
 */
async function pickCandidates(root, now, config = {}) {
  const chat = await resurface(root, { limit: 100, source: 'chat', now })
  const fresh = await resurface(root, { limit: 100, now })
  const others = fresh.filter((x) => sourceKind(x.source) !== 'chat')
  const pool = chat.length + others.length
  const target = ownerTarget(config)

  // 没绑目标时只能预演：没有「当下话题」可比，候选照旧给全，真投由闸门拦。
  if (!target.ok) {
    return {
      list: mixCandidates({ chat: chat.slice(0, 2), fresh: others.slice(0, 8), max: 6 }),
      reason: '', pool, matched: 0, topicMessages: 0,
    }
  }

  const topic = await readRecentTopic(root, target.sessionId, now).catch(() => null)
  if (!topic) {
    return { list: [], reason: 'no-topic', pool, matched: 0, topicMessages: 0 }
  }

  const texts = topic.messages.map((m) => m.text)
  const list = mixCandidates({
    chat: relevantCandidates(texts, chat, { limit: 2 }),
    fresh: relevantCandidates(texts, others, { limit: 8 }),
    max: 6,
  })
  return {
    list,
    // 池子本来就空是 no_material（该去闲逛补货）；有素材但一条都对不上才是 off-topic。
    reason: list.length ? '' : (pool ? 'off-topic' : ''),
    pool,
    matched: list.length,
    topicMessages: texts.length,
    topicFrom: topic.from,
    topicAt: topic.at,
  }
}

/** 有素材但没一条搭得上：闸门换成话题原因，别再让它去闲逛烧模型。 */
function applyTopicGate(gate, picked) {
  if (!picked?.reason) return gate
  // 没有候选时闸门常报 no_material / duplicate；但真正原因是没目标或对不上话题，
  // 要显示成后者，否则会被 gateAllowsWander 放去闲逛补货。
  const covers = gate?.ok || gate?.reason === 'no_material' || gate?.reason === 'duplicate'
  if (!covers) return gate
  return {
    ok: false,
    reason: picked.reason,
    detail: {
      ...(gate.detail || {}),
      pool: picked.pool,
      matched: picked.matched,
      topicMessages: picked.topicMessages,
    },
  }
}

/**
 * 闲逛是否允许越过这道闸门。
 * no_material / duplicate 是“投什么”的问题，正好由闲逛补货解决；
 * no-topic / off-topic 不算：对不上话题时补回来的素材照样不知道搭不搭。
 * 其余拦截（专注、静默、token-saver、忙、离开、日限、冷却、失败/降频）
 * 都必须在模型调用之前生效。
 */
export function gateAllowsWander(gate) {
  return Boolean(gate?.ok) || gate?.reason === 'no_material' || gate?.reason === 'duplicate'
}

/**
 * 跑一跳。ctx 可以为空（CLI dry-run）：只拉公共池、过闸门、预演投递。
 * 顺序严格是：本地信号 → 闸门 → 闲逛 → 投递；闸门拦截时不调模型。
 */
export async function runOnce({ ctx, root, config, now = new Date(), dryRun, log, turn } = {}) {
  await ensureBeatDirs(root)
  const cfg = { ...(config || await loadConfig(root)) }
  let state = await loadState(root)
  // 一跳可能跑 240 秒；期间界面/CLI 改过专注模式，别在收尾时把它盖回去。
  const focusAtStart = state.focusUntil
  const say = log || (() => {})
  // 定时跳不传 dryRun，以配置为准；手动入口传了布尔就以入口为准。
  // 以前这里只在投递处算 `cfg.dryRun !== false || dryRun`，定时跳拿到 undefined
  // 会落进 deliver 的默认参数 true —— 配置写了 dryRun:false 也永远预演。
  const preset = typeof dryRun === 'boolean' ? dryRun : cfg.dryRun !== false

  // 上一跳投出去、24 小时没回音：记未报账，轻微降权。
  // settle 自己会写盘，重新加载一次，别让本跳收尾把 pendingDelivery 写回旧值。
  await settleUnreported(root, { now, log: say }).catch(() => {})
  state = await loadState(root)
  // 收尾合并时只回写本跳真正改过的退避值，别把 feedback 刚清掉的值按旧快照抬回来。
  const backoffAtStart = state.deliveryBackoffUntil

  // 失败记录只在当天有效：跨天就该清，不能等下一次投递成功才清。
  if (state.deliveryFailed && state.deliveryFailed.day !== dayKey(now)) state.deliveryFailed = null

  // 画像每天重建一次；没重建过就先建。wander 的焦点 = 手编兴趣 + 派生兴趣。
  const lastProfile = Date.parse(state.lastProfileAt || '') || 0
  if (!lastProfile || now.getTime() - lastProfile > 24 * 3600000) {
    await rebuildProfile(root, { now, log: say }).catch(() => {})
    state.lastProfileAt = now.toISOString()
  }
  const profile = await loadProfile(root).catch(() => null)
  cfg.interests = [...new Set([...(Array.isArray(cfg.interests) ? cfg.interests : []), ...profileInterests(profile)])]

  // 敏感文件每天验一次：解不开就停跳，别静默把坏数据当空的继续用。
  const lastVault = Date.parse(state.lastVaultCheckAt || '') || 0
  if (!lastVault || now.getTime() - lastVault > 24 * 3600000) {
    const v = await checkSensitiveHealth(root).catch((e) => ({
      ok: false, errors: [{ file: '', why: String(e?.message ?? e) }],
    }))
    state.lastVaultCheckAt = now.toISOString()
    state.vaultError = v.ok ? null : { at: now.toISOString(), errors: v.errors }
    if (!v.ok) say(`[whale] 敏感文件检查失败，beat 停跳：${v.errors.map((x) => x.why).join('；').slice(0, 160)}`)
  }
  if (state.vaultError) {
    const errors = state.vaultError.errors || []
    await updateState(root, (s) => {
      s.lastTickAt = now.toISOString()
      s.lastGate = 'vault_error'
      s.lastGateAt = now.toISOString()
      s.lastGateDetail = { errors }
      // 这次检查的结果必须落盘：否则下一跳仍按「24 小时没查」再跑一遍
      // checkSensitiveHealth（每个敏感文件 spawn 一次 PowerShell），并反复刷日志。
      s.lastVaultCheckAt = state.lastVaultCheckAt
      s.vaultError = state.vaultError
    }).catch(() => {})
    return {
      ok: false,
      skipped: 'vault-error',
      gate: { ok: false, reason: 'vault_error' },
      material: await materialCounts(root).catch(() => ({ active: 0 })),
    }
  }

  // 心事匣每跳只读一次；真正投出后清，没投就留到下一跳。
  const np = await readNotepad(root).catch(() => ({ text: '', at: '' }))

  let counts = await materialCounts(root)
  if (counts.active < Math.max(1, Number(cfg.refillBelow) || 6)) {
    await pullPublic(root, { config: cfg, now, limit: cfg.publicLimit || 4, log: say }).catch((e) => {
      say(`[whale] 公共池拉取失败 ${String(e?.message ?? e).slice(0, 120)}`)
    })
    counts = await materialCounts(root)
  }

  // 先拿现成素材对话题、过闸门，再决定要不要去闲逛补货。
  let picked = await pickCandidates(root, now, cfg)
  let candidates = picked.list
  const env = await senseEnv({ ctx, state, config: cfg, now }).catch(() => ({
    busy: false, idleMinutes: 0, locked: false, away: false, source: 'unknown',
  }))
  state.lastEnv = { ...env, at: now.toISOString() }

  let gate = checkGate({
    now, config: cfg, state, counts, env, candidates: candidates.map((x) => x.id),
  })
  // 没绑投递目标就别硬试：没有宿主的预演照旧，真投直接卡在闸门。
  if (gate.ok && candidates.length && ctx && preset === false && !ownerTarget(cfg).ok) {
    gate = { ok: false, reason: 'no-target', detail: { target: '' } }
  }
  // 有素材但一条都对不上目标会话当下在聊的：宁可不投，也不算“没素材”去闲逛。
  gate = applyTopicGate(gate, picked)

  const wd = wanderDue({ now, config: cfg, state, materialCount: counts.active })
  let wanderResult = { ok: true, skipped: wd.reason, ran: false }
  if (wd.due) {
    if (!gateAllowsWander(gate)) {
      wanderResult.skipped = `gate:${gate.reason}`
    } else {
      // 引擎在设置页选：agent = 宿主里带 web_search 的那一路；search = 直连联网模型。
      // search 没配好就回退 agent，别让一个开关把这一跳空掉。
      const useSearchModel = cfg.engine === 'search' && searchReady()
      if (cfg.engine === 'search' && !useSearchModel) {
        say('[whale] 直连搜索模型没配好，这一跳回退闲逛 agent')
      }
      const hasTurn = typeof turn === 'function'
      if (!ctx && !useSearchModel && !hasTurn) {
        wanderResult.skipped = 'no-ctx'
      } else {
        const focuses = availableFocuses(cfg.interests, { focusLastUsed: state.focusLastUsed, now })
        const focus = pickFocus(focuses, state.lastFocus)
        // 兴趣全在 3 天冷却里就等，别硬换一个。
        if (!focus && Array.isArray(cfg.interests) && cfg.interests.length) {
          wanderResult.skipped = 'focus_cooldown'
        } else {
          const agentTurn = hasTurn
            ? turn
            : useSearchModel ? makeSearchTurn(say) : makeAgentTurn(ctx, root, cfg, say)
          wanderResult = await wander({
            root, config: cfg, agentTurn, direct: useSearchModel, focus, now, log: say,
          }).catch((e) => ({ ok: false, why: String(e?.message ?? e) }))
          wanderResult.ran = true
          const day = dayKey(now)
          if (wanderResult.ok && !wanderResult.skipped) {
            state.wanderCount = (state.wanderDay === day ? Number(state.wanderCount) || 0 : 0) + 1
            state.wanderDay = day
            state.lastWanderAt = now.toISOString()
            state.lastRefillAt = now.toISOString()
            state.lastFocus = wanderResult.focus || ''
            if (wanderResult.focus) {
              state.focusLastUsed = { ...(state.focusLastUsed || {}), [wanderResult.focus]: now.toISOString() }
            }
            const prevEmpty = state.wanderEmptyDay === day ? Number(state.wanderEmptyCount) || 0 : 0
            state.wanderEmptyDay = day
            state.wanderEmptyCount = Number(wanderResult.items) > 0 ? 0 : prevEmpty + 1
          } else if (wanderResult.why === 'turn-failed' || wanderResult.why === 'empty' || wanderResult.why === 'bad-json') {
            // 失败也要记时间：否则每一跳都重试，240 秒超时会一直循环烧模型。
            state.lastWanderAt = now.toISOString()
            if (wanderResult.why === 'empty' || wanderResult.why === 'bad-json') {
              const prevEmpty = state.wanderEmptyDay === day ? Number(state.wanderEmptyCount) || 0 : 0
              state.wanderEmptyDay = day
              state.wanderEmptyCount = prevEmpty + 1
            }
            say(`[whale] 闲逛未出结果（${wanderResult.why}），${Number(cfg.minIntervalHours) || 4} 小时内不再试`)
          }
        }
      }
    }
  }

  // 闲逛可能补了新素材；重新取候选、重算投递闸门。
  counts = await materialCounts(root)
  picked = await pickCandidates(root, now, cfg)
  candidates = picked.list
  if (wanderResult.ran) {
    gate = checkGate({
      now, config: cfg, state, counts, env, candidates: candidates.map((x) => x.id),
    })
    if (gate.ok && candidates.length && ctx && preset === false && !ownerTarget(cfg).ok) {
      gate = { ok: false, reason: 'no-target', detail: { target: '' } }
    }
  }
  gate = applyTopicGate(gate, picked)
  state.lastTickAt = now.toISOString()
  state.lastGate = gate.ok ? 'pass' : gate.reason
  state.lastGateAt = now.toISOString()
  state.lastGateDetail = gate.detail || {}

  let delivery = { ok: true, skipped: gate.reason }
  if (gate.ok && candidates.length) {
    delivery = await deliver({
      ctx, root, config: cfg, materials: candidates, now, log: say, dryRun: preset, notepad: np.text || '',
    }).catch((e) => ({ ok: false, why: String(e?.message ?? e) }))
    if (delivery.ok && !delivery.dryRun) {
      await markUsed(root, candidates.map((x) => x.id), delivery.deliveryId, { now }).catch(() => {})
      await noteDelivery(root, {
        deliveryId: delivery.deliveryId,
        at: now,
        sessionId: delivery.targetSessionId || '',
        materials: candidates,
      }).catch((e) => say(`[whale] 投递打标失败 ${String(e?.message ?? e).slice(0, 120)}`))
      const day = dayKey(now)
      state.daily = {
        day,
        sent: (state.daily?.day === day ? state.daily.sent : 0) + 1,
      }
      state.lastDeliveryAt = now.toISOString()
      state.deliveryFailed = null
      state.deliveryBackoffUntil = ''
      state.noneStreak = 0
      const recent = new Map(state.recentMaterialIds.map((x) => [String(x.id), x]))
      for (const c of candidates) recent.set(String(c.id), { id: c.id, at: now.toISOString() })
      state.recentMaterialIds = [...recent.values()].slice(-20)
    } else if (!delivery.ok && !delivery.dryRun && delivery.why === 'delivery-failed') {
      state.deliveryFailed = {
        day: dayKey(now),
        at: now.toISOString(),
        why: String(delivery.why || 'delivery-failed').slice(0, 120),
      }
    } else if (!delivery.ok && !delivery.dryRun && delivery.why === 'target-busy') {
      // 会话被占着不是内容/配置问题：十分钟后再试，别按“今天失败”封到零点。
      state.deliveryBackoffUntil = new Date(now.getTime() + TARGET_BUSY_BACKOFF_MS).toISOString()
    }
  }

  // 心事匣是一格便签：真正走过投递（成功或失败）就清；dry-run 和闸门拦截保留。
  if (gate.ok && candidates.length && !preset && delivery && delivery.dryRun !== true && np.text) {
    await clearNotepadIf(root, np).catch(() => {})
  }

  state.lastGate = gate.ok
    ? (delivery.delivered ? 'delivered' : delivery.dryRun ? 'dry'
      : (delivery.ok ? 'pass' : delivery.why === 'target-busy' ? 'target_busy' : 'delivery_failed'))
    : gate.reason
  state.lastGateDetail = { ...(gate.detail || {}), delivery: delivery.why || delivery.skipped || '' }
  const entry = {
    at: now.toISOString(),
    phase: 'tick',
    gate: gate.ok ? 'pass' : gate.reason,
    wander: wanderResult.skipped || wanderResult.why || 'run',
    wanderAdded: Number(wanderResult.added) || 0,
    delivery: delivery.dryRun ? 'dry' : delivery.delivered ? 'sent' : delivery.why || delivery.skipped || 'none',
    dryRun: Boolean(preset),
    material: counts,
    candidates: candidates.length,
    pool: picked.pool || 0,
  }
  await appendJsonl(logsPath(root), entry).catch(() => {})
  const lastMaintain = Date.parse(state.lastMaintainAt || '') || 0
  if (!lastMaintain || now.getTime() - lastMaintain > 60 * 60000) {
    state.lastMaintainAt = now.toISOString()
    await maintain(root, { config: cfg, now, log: say, ctx, state }).catch(() => {})
  }
  // 收尾合并：本跳只覆盖自己拥有的字段，别把 feedback / 界面并发写的
  // pendingDelivery、lastUserAt、replyStats 冲掉。读改写整段进锁，
  // 否则「加载 → 合并 → 写回」之间插进来的反馈照样会被覆盖。
  await withStateLock(root, async () => {
    const latest = await loadState(root).catch(() => null)
    if (!latest) {
      await saveState(root, state)
      return
    }
    const own = [
      'lastWanderAt', 'wanderDay', 'wanderCount', 'lastRefillAt', 'lastFocus',
      'focusLastUsed', 'wanderEmptyDay', 'wanderEmptyCount',
      'lastDeliveryAt', 'daily', 'recentMaterialIds', 'lastGate', 'lastGateAt',
      'lastGateDetail', 'lastTickAt', 'lastMaintainAt', 'lastProfileAt', 'lastEnv',
      'lastVaultCheckAt', 'vaultError',
      'deliveryFailed',
    ]
    for (const k of own) latest[k] = state[k]
    // 这几项反馈闭环也会在跳中途写：投递成功才清零；否则 latest 是锁内最新值，
    // 不能再用跳开始时的旧 state 取 max，否则 feedback 刚清零的连击会被抬回来。
    if (delivery?.delivered) {
      latest.noneStreak = 0
      latest.deliveryBackoffUntil = ''
    } else if (state.deliveryBackoffUntil !== backoffAtStart) {
      // 只有本跳写入的退避（目前是 target-busy）才覆盖最新值。
      latest.deliveryBackoffUntil = state.deliveryBackoffUntil
    }
    // 界面在跳中途改的专注模式优先
    latest.focusUntil = state.focusUntil === focusAtStart ? latest.focusUntil : state.focusUntil
    await saveState(root, latest)
  })
  return { ok: true, gate, wander: wanderResult, delivery, material: counts, dryRun: Boolean(preset) }
}

/**
 * 启动定时器；只有环境变量关闭或 heartbeat 已挂载时才不起表。
 * config.enabled=false 时定时器空转（每分钟只读配置），界面打开开关后一分钟内接管。
 */
export function startBeat(ctx, { root, log } = {}) {
  const say = log || (() => {})
  let host = ctx
  let injected = false
  let injectTimer = null
  const takeHost = (scoped) => {
    injected = true
    if (injectTimer) {
      clearTimeout(injectTimer)
      injectTimer = null
    }
    host = scoped
  }
  try {
    if (typeof ctx?.inject === 'function') {
      // sessionController 也要一起注入：不注入的话 ctx.get 拿不到，
      // 投递就会跳过「复用活 agent」直接 resume，撞上写句柄。
      ctx.inject(['agents', 'sessionController'], takeHost)
      // 老宿主没有 sessionController：等不到回调就退回只注入 agents，别把 beat 卡死。
      injectTimer = setTimeout(() => {
        injectTimer = null
        if (!injected) {
          try { ctx.inject(['agents'], takeHost) } catch { /* 保持原 ctx */ }
        }
      }, 5000)
      injectTimer.unref?.()
    }
  } catch { /* 宿主没有 agents 时保持原 ctx */ }

  let disposed = false
  let timer = null
  let probeTimer = null
  let running = false
  let last = null
  let disabled = ''
  let presetReady = false

  const tick = async ({ manual = false, dryRun } = {}) => {
    if (disposed) return { ok: false, why: 'disposed' }
    if (running) return { ok: false, why: 'busy' }
    if (disabled) return { ok: true, skipped: disabled }
    running = true
    try {
      const config = await loadConfig(root)
      if (!manual && !config.enabled) return { ok: true, skipped: 'disabled' }
      // 界面刚打开开关也要能跑：这里补装预设，不要求重启宿主。
      if (config.enabled && config.installPreset !== false && !presetReady) {
        const p = await ensurePreset({ log: say })
        if (!p.ok) return { ok: true, skipped: 'preset-missing' }
        presetReady = true
      }
      if (!agentsOf(host)) return { ok: true, skipped: 'no-agents' }
      last = await runOnce({ ctx: host, root, config, dryRun, log: say })
      return last
    } catch (e) {
      say(`[whale] beat 跳失败 ${String(e?.message ?? e).slice(0, 160)}`)
      return { ok: false, why: String(e?.message ?? e) }
    } finally {
      running = false
    }
  }

  const start = async () => {
    const config = await loadConfig(root)
    const sched = schedulerState({ config })
    if (sched.envOff) {
      disabled = 'env-off'
      say('[whale] beat 已停 · DSH_MEMORY_BEAT=off')
      return
    }
    if (sched.heartbeat) {
      disabled = 'heartbeat-mounted'
      say('[whale] 调度器：heartbeat；检测到 dsh-heartbeat 已挂载，beat 保持关闭（二选一）')
      return
    }
    if (config.installPreset !== false && config.enabled) {
      const p = await ensurePreset({ log: say })
      presetReady = p.ok
      if (!p.ok) say('[whale] beat 预设不可用，闲逛会看不见 web_search；保持待机，修好后自动重试')
    } else {
      presetReady = config.installPreset === false
    }
    // 配置关着也起表：tick 只读配置、不调模型；界面打开 enabled 后一分钟内接管。
    timer = setInterval(() => { tick().catch(() => {}) }, TICK_MS)
    timer.unref?.()
    if (!config.enabled) {
      say('[whale] beat 未启用（beat/config.json 里 enabled=false）；打开后自动接管')
    } else {
      // 宿主没有 agents 服务时只提示，不永久停表（延迟注入后还能恢复）。
      const probe = setTimeout(() => {
        const agents = agentsOf(host)
        if (agents?.create || agents?.resume) return
        say('[whale] beat 暂时没有 agents 服务，等宿主注入后继续')
      }, 20000)
      probe.unref?.()
      probeTimer = probe
      say(`[whale] 调度器：beat · 已启动 · 窗口 ${(config.windows || []).map((w) => `${w.start}-${w.end}`).join(' / ')} · ${config.dryRun ? '预演' : '可投递'}`)
    }
    tick().catch(() => {})
  }
  start().catch(() => {})

  return {
    tick,
    status: async () => {
      const config = await loadConfig(root)
      const state = await loadState(root)
      const counts = await materialCounts(root)
      return { config, state, counts, last, disabled, scheduler: schedulerState({ config }) }
    },
    dispose() {
      disposed = true
      if (timer) clearInterval(timer)
      if (probeTimer) clearTimeout(probeTimer)
      if (injectTimer) clearTimeout(injectTimer)
      timer = null
      probeTimer = null
      injectTimer = null
    },
  }
}
