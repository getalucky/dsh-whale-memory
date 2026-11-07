/**
 * beat/session.js —— 专用会话
 *
 * 闲逛 agent 不每次新建：先复用，再 resume，最后才 create；每 7 天或连续
 * 失败时轮转。投递目标会话不复用这个会话，走 agents.resume。
 */

import { randomUUID } from 'node:crypto'
import { readJson, writeAtomic } from '../store.js'
import { ensureBeatDirs, sessionsPath } from './config.js'

function sessionId() {
  return `session-${randomUUID()}`
}

export async function loadSessions(root) {
  const db = await readJson(sessionsPath(root), null)
  if (!db || typeof db !== 'object') return { sessionId: '', createdAt: '', lastUsedAt: '', rotates: 0 }
  return {
    sessionId: String(db.sessionId || ''),
    createdAt: String(db.createdAt || ''),
    lastUsedAt: String(db.lastUsedAt || ''),
    rotates: Number(db.rotates) || 0,
  }
}

export async function saveSessions(root, db) {
  await ensureBeatDirs(root)
  await writeAtomic(sessionsPath(root), JSON.stringify(db, null, 2))
  return db
}

function usable(agent) {
  return Boolean(agent && (typeof agent.followup === 'function' || agent.session?.id))
}

function unwrap(handle) {
  return handle?.agent ?? handle
}

/** 释放旧会话：宿主有 dispose 就调，没有就让它自然过期。 */
export function releaseAgent(agents, sessionId) {
  const sid = String(sessionId || '')
  if (!sid || !agents) return false
  try {
    const live = agents.get?.(sid)
    const agent = unwrap(live)
    if (agent && typeof agent.dispose === 'function') {
      agent.dispose()
      return true
    }
    if (live && typeof live.dispose === 'function') {
      live.dispose()
      return true
    }
    if (typeof agents.dispose === 'function') {
      agents.dispose(sid)
      return true
    }
  } catch { /* 释放失败不影响下一轮 */ }
  return false
}

function defaultAgentOptions(ctx, config = {}) {
  let sel = null
  try {
    sel = ctx?.get?.('agentDefaultModel')?.currentSelection?.() || null
  } catch { /* 宿主没有模型服务 */ }
  if (config.model) {
    return {
      provider: config.provider || sel?.provider || '',
      model: config.model,
      ...(config.reasoningEffort === undefined
        ? (sel?.reasoningEffort === undefined ? {} : { reasoningEffort: sel.reasoningEffort })
        : { reasoningEffort: config.reasoningEffort }),
    }
  }
  if (sel?.provider && sel?.model) {
    return {
      provider: sel.provider,
      model: sel.model,
      ...(sel.reasoningEffort === undefined ? {} : { reasoningEffort: sel.reasoningEffort }),
    }
  }
  return {}
}

function makeSetup(preset) {
  return async (agentCtx) => {
    try {
      const presets = agentCtx.get?.('agentPresets') || agentCtx.get?.('agentPreset')
      if (presets?.mount) await presets.mount(agentCtx, preset)
    } catch { /* 预设缺失时保持裸 agent，启动自检会报 */ }
    try {
      const tools = agentCtx.get?.('tools')
      if (tools?.restrict) tools.restrict({ allow: ['web_search'] })
    } catch { /* 工具面收窄失败不挡创建 */ }
  }
}

async function createAgent({ agents, ctx, root, config, preset, log }) {
  const sid = sessionId()
  const agentOptions = defaultAgentOptions(ctx, config)
  if (config.model && !agentOptions.model) {
    log?.('[whale] beat 配了 model，但宿主没给 provider；这一轮回退默认模型')
  }
  const handle = await agents.create({
    sessionId: sid,
    meta: { cwd: root },
    ...(agentOptions && Object.keys(agentOptions).length ? { agentOptions } : {}),
    setup: makeSetup(preset),
  })
  const agent = unwrap(handle)
  if (!usable(agent)) throw new Error('agents.create 没有返回可用 agent')
  return agent
}

/**
 * 取专用闲逛会话。没有 agents 服务时返回 ok:false，不抛。
 * @returns {Promise<{ok:boolean, agent?:object, sessionId?:string, why?:string, fresh?:boolean}>}
 */
export async function getBeatAgent({ ctx, root, config = {}, preset = 'beat', log } = {}) {
  const agents = ctx?.agents
  if (!agents?.create) return { ok: false, why: 'no-agents' }
  await ensureBeatDirs(root)
  const state = await loadSessions(root)
  const rotateDays = Math.max(1, Number(config.sessionRotateDays) || 7)
  const tooOld = state.createdAt && Date.now() - Date.parse(state.createdAt) > rotateDays * 86400000

  if (state.sessionId && !tooOld) {
    try {
      const live = agents.get?.(state.sessionId)
      const agent = unwrap(live)
      if (usable(agent)) {
        state.lastUsedAt = new Date().toISOString()
        await saveSessions(root, state)
        return { ok: true, agent, sessionId: state.sessionId }
      }
    } catch { /* 往下 resume */ }
    try {
      const resumed = await agents.resume({
        resumeSessionId: state.sessionId,
        ...(Object.keys(defaultAgentOptions(ctx, config)).length
          ? { agentOptions: defaultAgentOptions(ctx, config) }
          : {}),
      })
      const agent = unwrap(resumed)
      if (usable(agent)) {
        state.lastUsedAt = new Date().toISOString()
        await saveSessions(root, state)
        return { ok: true, agent, sessionId: state.sessionId }
      }
    } catch { /* 往下新建 */ }
  }

  try {
    const agent = await createAgent({ agents, ctx, root, config, preset, log })
    const now = new Date().toISOString()
    const oldId = state.sessionId
    await saveSessions(root, {
      sessionId: agent.session?.id || '',
      createdAt: now,
      lastUsedAt: now,
      rotates: (state.rotates || 0) + (state.sessionId ? 1 : 0),
    })
    // 轮转后释放旧会话；不释放会把空闲 agent 一直挂在宿主里。
    if (oldId && oldId !== agent.session?.id) releaseAgent(agents, oldId)
    return { ok: true, agent, sessionId: agent.session?.id || '', fresh: true }
  } catch (e) {
    log?.(`[whale] beat 会话创建失败 ${String(e?.message ?? e).slice(0, 160)}`)
    return { ok: false, why: 'create-failed' }
  }
}

/** 明确轮转：下次 getBeatAgent 会新建；有 agents 时顺手释放旧的。 */
export async function rotateBeatSession(root, log, { agents } = {}) {
  const state = await loadSessions(root)
  if (state.sessionId) releaseAgent(agents, state.sessionId)
  await saveSessions(root, {
    sessionId: '',
    createdAt: '',
    lastUsedAt: new Date().toISOString(),
    rotates: (state.rotates || 0) + 1,
  })
  log?.('[whale] beat 会话已轮转')
}

