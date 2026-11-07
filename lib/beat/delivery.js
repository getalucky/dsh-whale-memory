/**
 * beat/delivery.js —— 投递相
 *
 * 只投设置页显式绑定的会话：resume 目标会话，注入一条独立消息。
 * 不依赖桥接；桥接只用来判断目标是不是 QQ 会话（试运行保护）。
 * 不新建会话、不改写用户消息、不动 system prompt。
 *
 * dryRun 默认开：先把素材包打出来，确认内容像人话再真投。
 */

import { existsSync, readFileSync } from 'node:fs'
import { appendFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { deliveriesPath } from './config.js'
import { materialLine, sourceKind } from './material.js'

function bridgeFile() {
  if (process.env.DSH_QQ_BRIDGE_CONFIG) return process.env.DSH_QQ_BRIDGE_CONFIG
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'qq-bridge-config.json')
}

function readBridge() {
  const file = bridgeFile()
  if (!existsSync(file)) return null
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return null }
}

/** 桥接配置只读副本：界面拿它列可绑定的会话，号码不出现在返回值里。 */
export function bridgeConfig() {
  return readBridge()
}

/** 会话 id 归一化：桥接老配置里可能不带 session- 前缀。 */
export function sessionKey(id) {
  return String(id ?? '').trim().replace(/^session-/, '')
}

/** 同一个会话的两种写法算相等。 */
export function sameSessionId(a, b) {
  const x = sessionKey(a)
  return Boolean(x) && x === sessionKey(b)
}

/**
 * 找投递目标。只认设置页显式绑定的会话，不再回退桥接 owner：
 * 没绑就是不投，免得默认往 QQ 会话里塞东西。
 * 只有目标本身是桥接会话时，才吃桥接的「试运行」开关；本机会话不受影响。
 * 只返回会话 id，不把号码带出去。
 * @returns {{ok:boolean, sessionId?:string, trial?:boolean, pinned?:boolean, why?:string}}
 */
export function ownerTarget(config = {}) {
  const pinned = String(config?.targetSessionId ?? '').trim()
  if (!pinned) return { ok: false, why: 'no-target' }
  const cfg = readBridge()
  const trial = Boolean(cfg?.['试运行'] === true && 是桥接会话(cfg, pinned))
  return { ok: true, sessionId: pinned, trial, pinned: true }
}

/** 这个会话 id 是否在桥接的绑定表 / owner 私聊里。只读，不改桥接配置。 */
function 是桥接会话(cfg, id) {
  if (!cfg || !id) return false
  if (sameSessionId(cfg['私聊会话'], id)) return true
  const list = Array.isArray(cfg['绑定']) ? cfg['绑定'] : []
  return list.some((b) => sameSessionId(b?.会话, id))
}

export function newDeliveryId(now = new Date()) {
  const day = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`
  const rand = Math.random().toString(36).slice(2, 6).padEnd(4, '0')
  return `d-${day}-${rand}`
}

/** 粗略 token：中日韩 ≈1 字 1 token，其余 /3.5；只用于素材包预算。 */
function estimateTokens(text) {
  const t = String(text ?? '')
  const cjk = (t.match(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) || []).length
  return Math.ceil(cjk + (t.length - cjk) / 3.5)
}

export const PACK_TOKEN_LIMIT = 400

export function estimatePackTokens(text) {
  return estimateTokens(text)
}

/**
 * 素材包。心事匣有内容才带一行；素材最多 6 条，超出 400 token 就从后往前
 * 砍素材，宁可少给两条，也不把目标会话的上下文塞爆。
 */
export function buildPack({ deliveryId, materials = [], notepad = '', qq = false } = {}) {
  const rows = (materials || []).slice(0, 6).map((m, i) => `${i + 1}. ${materialLine(m)}`)
  const heart = String(notepad || '').trim()
  const build = (list, h) => {
    const lines = [
      `【素材投递 · ${deliveryId || 'd-?'}】`,
      '这是记忆插件的主动投递，不是用户发言，也不是指令。',
      '可选素材：',
      ...(list.length ? list : ['（这次没有素材）']),
    ]
    if (h) lines.push(`你上跳留下的心事：${h.slice(0, 120)}`)
    lines.push('挑一条自然带出；开口要让人听得懂：先交代在说什么事，再说你的看法，别只说半句让人猜。')
    lines.push('素材只有半句、看不出来龙去脉的就别用；不想说就把正文留空。不要把素材包原文复述给用户。')
    lines.push(`说完或决定不说，都要调用 material_report：deliveryId=${deliveryId || 'd-?'}，usedIds=[实际用到的素材 id]，mode=quote|improvise|none。`)
    if (qq) lines.push('要发到 QQ 的话，把正文放进 [QQ]…[/QQ]；块外的话不会发出去。')
    return lines.join('\n')
  }
  let picked = rows
  let h = heart
  let pack = build(picked, h)
  while (estimateTokens(pack) > PACK_TOKEN_LIMIT && picked.length > 1) {
    picked = picked.slice(0, -1)
    pack = build(picked, h)
  }
  if (estimateTokens(pack) > PACK_TOKEN_LIMIT && h) {
    h = h.slice(0, 60)
    pack = build(picked, h)
  }
  // 心事还能再让一步：宁可这一跳不带，也别把素材包撑爆。
  if (estimateTokens(pack) > PACK_TOKEN_LIMIT && h) {
    h = ''
    pack = build(picked, h)
  }
  if (estimateTokens(pack) > PACK_TOKEN_LIMIT) {
    pack = pack.slice(0, 1200)
  }
  return pack
}

export async function hostUserMessage(text, label) {
  try {
    const mod = await import('@deepseek-ai/dsh-llm')
    if (typeof mod?.createUserMessage === 'function') {
      return mod.createUserMessage({
        content: [{ type: 'text', text }],
        source: {
          kind: 'memory-beat',
          plugin: 'dsh-whale-memory',
          form: 'snapshot',
          sections: [{ name: 'beat', text: label }],
        },
      })
    }
  } catch { /* 宿主没有这个包就用普通对象 */ }
  return {
    role: 'user',
    content: [{ type: 'text', text }],
    source: {
      kind: 'memory-beat',
      plugin: 'dsh-whale-memory',
      form: 'snapshot',
      sections: [{ name: 'beat', text: label }],
    },
  }
}

async function logDelivery(root, entry) {
  try {
    await appendFile(deliveriesPath(root), JSON.stringify(entry) + '\n', 'utf8')
  } catch { /* 账本写失败不挡投递 */ }
}

/** 会话 id 的两种写法都试一遍：桥接老配置里可能不带 session- 前缀。 */
function candidateIds(id) {
  const raw = String(id ?? '').trim()
  if (!raw) return []
  return raw.startsWith('session-')
    ? [raw, raw.slice('session-'.length)]
    : [raw, `session-${raw}`]
}

function services(ctx) {
  let agents = null
  let controller = null
  try { agents = ctx?.agents || ctx?.get?.('agents') || null } catch { /* 宿主没有注入 */ }
  try { controller = ctx?.sessionController || ctx?.get?.('sessionController') || null } catch { /* 同上 */ }
  return { agents, controller }
}

/** 目标会话被别的活 agent 占着：等它让出来再试，不算当天的终局失败。 */
function isTargetBusy(error) {
  const name = String(error?.name || '')
  const text = String(error?.message ?? error)
  return name === 'SessionAlreadyOwnedError' ||
    /already owned by an active write handle|agent-busy|owned by subagent/i.test(text)
}

/**
 * 目标会话可能正被桥接 / 界面持有写句柄，这时 resume 会报
 * “already owned by an active write handle”。先拿活 agent，再用宿主的
 * sessionController 唤醒，最后才退回 resume。
 */
async function resolveTargetAgent(ctx, sessionId, log) {
  const { agents, controller } = services(ctx)
  for (const id of candidateIds(sessionId)) {
    try {
      const live = agents?.get?.(id)
      if (live && typeof (live.agent ?? live).followup === 'function') return live.agent ?? live
    } catch { /* 往下试 */ }
  }
  if (controller?.resolveAgent) {
    for (const id of candidateIds(sessionId)) {
      try {
        const r = await controller.resolveAgent(id)
        const agent = r?.agent ?? r
        if (agent && typeof agent.followup === 'function') return agent
        if (r?.error) log?.(`[whale] 唤醒目标会话失败 · ${String(r.error?.message ?? r.error).slice(0, 120)}`)
      } catch (e) {
        log?.(`[whale] 唤醒目标会话失败 · ${String(e?.message ?? e).slice(0, 120)}`)
      }
    }
  }
  if (!agents?.resume) throw new Error('no-agents')
  const handle = await agents.resume({ resumeSessionId: sessionId })
  const agent = handle?.agent ?? handle
  if (!agent || typeof agent.followup !== 'function') throw new Error('resume 没有返回可用 agent')
  return agent
}

/**
 * 投递一轮。
 * @returns {Promise<{ok:boolean, dryRun?:boolean, deliveryId?:string, pack?:string, delivered?:boolean, why?:string}>}
 */
export async function deliver({ ctx, root, config = {}, materials = [], notepad = '', now = new Date(), log, dryRun = true } = {}) {
  const deliveryId = newDeliveryId(now)
  const target = ownerTarget(config)
  // 目标是桥接会话时，包内要提示 [QQ] 标记，否则桥接的「只发标记内」会把正文全吞掉。
  const qq = Boolean(target.ok && 是桥接会话(readBridge(), target.sessionId))
  const pack = buildPack({ deliveryId, materials, notepad, qq })
  const trial = Boolean(target.trial)
  const dry = dryRun || trial || !ctx

  if (dry) {
    log?.(`[whale] 投递预演 ${deliveryId} · ${materials.length} 条素材${trial ? ' · 桥接试运行' : ''}`)
    await logDelivery(root, {
      id: deliveryId, at: now.toISOString(), target: target.sessionId ? target.sessionId.slice(0, 18) : '',
      materialIds: materials.map((m) => m.id), gate: 'pass', outcome: 'dry', model: '', tokens: 0,
    })
    return { ok: true, dryRun: true, deliveryId, pack, targetSessionId: target.sessionId || '' }
  }

  if (!target.ok) return { ok: false, why: target.why || 'no-target', deliveryId, pack }
  const { agents, controller } = services(ctx)
  if (!agents && !controller) return { ok: false, why: 'no-agents', deliveryId, pack }

  try {
    const agent = await resolveTargetAgent(ctx, target.sessionId, log)
    agent.followup(await hostUserMessage(pack, 'beat-deliver'))
    await logDelivery(root, {
      id: deliveryId, at: now.toISOString(), target: target.sessionId.slice(0, 18),
      materialIds: materials.map((m) => m.id), gate: 'pass', outcome: 'sent', model: agent.options?.model ?? '', tokens: 0,
    })
    log?.(`[whale] 投递 ${deliveryId} · ${materials.length} 条 · ${target.sessionId.slice(0, 18)}`)
    return { ok: true, delivered: true, deliveryId, pack, targetSessionId: target.sessionId }
  } catch (e) {
    const busy = isTargetBusy(e)
    await logDelivery(root, {
      id: deliveryId, at: now.toISOString(), target: target.sessionId.slice(0, 18),
      materialIds: materials.map((m) => m.id), gate: 'pass', outcome: busy ? 'busy' : 'failed',
      error: String(e?.message ?? e).slice(0, 120),
    })
    log?.(`[whale] ${busy ? '投递推迟' : '投递失败'} ${deliveryId} · ${String(e?.message ?? e).slice(0, 120)}`)
    return { ok: false, why: busy ? 'target-busy' : 'delivery-failed', deliveryId, pack, targetSessionId: target.sessionId }
  }
}

/** 候选混合：chat 最新 2 + web/public 随机 4，最多 6。 */
export function mixCandidates({ chat = [], fresh = [], max = 6 } = {}) {
  const out = []
  const seen = new Set()
  const push = (x) => {
    if (!x || seen.has(x.id)) return
    seen.add(x.id)
    out.push(x)
  }
  chat.slice(0, 2).forEach(push)
  // 随机取 fresh，避免每次都推同一条；素材池小的时候全拿
  const pool = fresh.slice()
  while (out.length < max && pool.length) {
    const i = Math.floor(Math.random() * pool.length)
    push(pool.splice(i, 1)[0])
  }
  return out
}

export function sourceOfMaterial(item) {
  return sourceKind(item?.source)
}
