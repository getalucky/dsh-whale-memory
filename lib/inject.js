/**
 * inject.js —— 把人格与记忆送进 system prompt
 *
 * 两条 section：
 *   whale:persona  order 8500  人格（会话创建时快照，见下）
 *   whale:memory   order 8550  当前会话对应分片的记忆摘要（版本化刷新）
 *
 * 为什么用 system prompt section 而不是对话注入：
 *   后者会以 user 角色留在历史里（宿主 context() 就是这种），用户能看见自己的设定；
 *   section 只在 system 角色里，面板和对话流都看不见。
 *
 * 缓存纪律（2026-10-31 重写）：
 *   system prompt 任何一个字节变了，KV 前缀缓存就从变化点失效。所以：
 *   · 人格按会话快照：mid-session 改 persona.md 只影响下一个会话，不再下一轮就抖；
 *   · 记忆段版本化：文件没变不重画；变了也要间隔 ≥5 分钟且条目数变化 ≥3 才重建；
 *   · 每轮命中的相关条目只记在内存里，供刷新时排序，不再逐条消息触发重渲染。
 *   旧实现是「每条消息 setRelevance 立刻 paint」+「30 秒轮询无条件重画」，
 *   等于每轮都改 system prompt，缓存从来没活过。
 *
 * 分片选择：agent/created 时拿 sessionId（agent.session.header.id）查
 * qq-bridge 绑定表；绑定表里没有的会话是本地会话，归到 local:dsh 一个分片。
 * 只有绑定表读坏或本地记忆关掉（DSH_MEMORY_LOCAL_SCOPE=off）时才跳过记忆段。
 */

import { readFileSync, statSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { scopeRevFile, loadScope, decayScore, auditInject } from './store.js'
import { sourceOfSessionSync, localScopeEnabled } from './source.js'
import { renderRules, renderSkeleton, renderMemorySection } from './skeleton.js'
import { projectOf } from './namespace.js'
import { stripMarkers, estimateTokens } from './persona.js'
import { typeLabel } from './taxonomy.js'
import { describeExtra } from './kinds.js'
import { trustStateSync } from './trust.js'
import { formatAbs } from './time.js'
import { redactText } from './redact.js'
import { loadDocs, renderDocsBlock, docStamp } from './agentdoc.js'

export { decayScore }

export const PERSONA_SECTION = 'whale:persona'
export const PERSONA_ORDER = 8500
export const MEMORY_SECTION = 'whale:memory'
export const MEMORY_ORDER = 8550

/**
 * 记忆段刷新策略。调大 = 更省缓存、更滞后；调小 = 更实时、更烧缓存。
 * 阶段 5 改成「目录骨架版本化」后，这组值只影响骨架，不再影响正文。
 */
export const REFRESH_POLICY = {
  minGapMs: 5 * 60 * 1000,
  minItemDelta: 3,
}

/**
 * 宿主 system prompt 的插值只扫 `{{`：正文里出现一对就会 throw，
 * 这一轮请求直接失败，而记忆还留在库里 —— 会话永久不可用。
 * QQ 里有人粘一段带 {{ }} 的模板就会中招，所以注入出口统一拆开。
 */
export function guardPromptText(text) {
  const t = String(text ?? '')
  if (!t.includes('{{')) return t
  return t.replace(/\{\{/g, '{ {')
}

export const RENDER_OPTS = {
  halfLifeDays: 30,
  warmScore: 0.5,
  coldScore: 0.25,
  archiveDays: 90,
  topN: 8,
  maxChars: 1200,
}

/** 活着的桥接会话：`root|sid` → 渲染态。 */
const live = new Map()

/** 会话还没创建时先攒着的相关条目：`root|sid` → item id[]。 */
const pendingRelevance = new Map()

/** 每会话读过/写过哪些 id：压缩恢复包用。 */
const sessionTrace = new Map()

/** 降级提示只喊一次，别每个会话刷一行。 */
let degradedWarned = false
let untrustedWarned = false

/** 人格变更提示按 mtime 去重。 */
let lastPersonaNotice = -1

/**
 * 人格快照。会话创建时取一次，整个会话用这份 —— mid-session 改文件
 * 不会改 system prompt 前缀（改了下个会话才生效）。
 * @returns {{text:string, mtime:number, size:number}}
 */
export function personaSnapshot(root) {
  const file = join(root, 'persona.md')
  try {
    const st = statSync(file)
    return { text: stripMarkers(readFileSync(file, 'utf8')), mtime: st.mtimeMs, size: st.size }
  } catch {
    return { text: '', mtime: -1, size: -1 }
  }
}

/** 读人格正文（不缓存，调用方要稳定就自己存快照）。 */
export function personaText(root) {
  return personaSnapshot(root).text
}

/** 从 agent 上取会话 id。 */
export function sessionIdOf(agent) {
  return String(
    agent?.session?.header?.id ??
    agent?.session?.id ??
    agent?.header?.id ??
    '',
  )
}

/** 从 agent 上取 cwd。 */
export function cwdOf(agent) {
  return String(
    agent?.session?.header?.cwd ??
    agent?.header?.cwd ??
    agent?.session?.cwd ??
    '',
  )
}

/** 生命周期：按分数与状态分档。 */
export function lifeState(item, now = Date.now(), cfg = {}) {
  const warmAt = cfg.warmScore ?? 0.5
  const coldAt = cfg.coldScore ?? 0.25
  const archiveDays = cfg.archiveDays ?? 90
  const s = decayScore(item, now, cfg.halfLifeDays ?? 30)
  const last = Date.parse(item.lastHit || item.created || '') || now
  const ageDays = (now - last) / 86400000
  if (item.state === 'suggested') return { state: 'suggested', score: s, ageDays }
  if (item.state === 'archived' || item.state === 'superseded') {
    return { state: item.state, score: s, ageDays }
  }
  if (ageDays >= archiveDays && s < coldAt) return { state: 'cold', score: s, ageDays, archive: true }
  if (s < coldAt) return { state: 'cold', score: s, ageDays }
  if (s < warmAt) return { state: 'warm', score: s, ageDays }
  return { state: 'active', score: s, ageDays }
}

/** 按行截断：宁可少一条，也别把半句话塞进提示词。 */
function cutByLine(text, maxChars) {
  if (text.length <= maxChars) return text
  const head = text.slice(0, maxChars)
  const nl = head.lastIndexOf('\n')
  const body = nl > maxChars * 0.6 ? head.slice(0, nl) : head
  return body + '…'
}

/**
 * 渲染一段给人格看的记忆摘要。
 *
 * opts.relevant：这一轮用户消息命中的条目 id（ingest 里算好塞进来的）。
 * 有就排在前面 —— 每轮固定按衰减分取 topN 的话，一半内容跟当前话题无关，
 * 白白占上下文。
 */
export function renderMemory(scope, opts = {}) {
  const topN = opts.topN ?? 8
  const maxChars = opts.maxChars ?? 1200
  if (!scope) return ''
  const now = Date.now()
  const scored = (scope.items || [])
    .map((it) => ({ it, life: lifeState(it, now, opts) }))
    .filter(({ life }) => life.state === 'active' || life.state === 'warm')
    // 分数先归一到 1e-6 再比：衰减分随毫秒微动，不归一会让同分条目每次巡检
    // 换一次顺序，system prompt 字节跟着变，KV 前缀缓存整段作废。
    // 同分时新的在前（id 单调递增），跟"最近发生的事更该被想起"一致。
    .sort((a, b) => {
      const d = Math.round(b.life.score * 1e6) - Math.round(a.life.score * 1e6)
      return d || String(b.it.id).localeCompare(String(a.it.id))
    })

  let rows = scored
  const want = Array.isArray(opts.relevant) ? opts.relevant : []
  if (want.length) {
    const byId = new Map(scored.map((r) => [r.it.id, r]))
    const head = []
    for (const id of want) {
      const r = byId.get(id)
      if (r) {
        head.push(r)
        byId.delete(id)
      }
    }
    rows = [...head, ...scored.filter((r) => byId.has(r.it.id))]
  }
  rows = rows.slice(0, topN)

  const lines = []
  // 空分片就别报「记得 0 件事」了，纯占预算
  if (scope.profile?.summary && (scope.items || []).length) {
    lines.push(`【画像】${scope.profile.summary}`)
  }
  // 群里谁说过话：只给最活跃的 3 个，多了占预算
  if (scope.kind === 'group' && Array.isArray(scope.members) && scope.members.length > 1) {
    const top = scope.members.slice(0, 3)
      .map((m) => `${m.name}（${m.items} 条${m.last ? `，最近 ${m.last}` : ''}）`)
    lines.push(`【群里的人】${top.join('、')}`)
  }
  if (rows.length) {
    lines.push('【记得的事】')
    for (const { it } of rows) {
      const tag = typeLabel(it.kind)
      // 绝对时间 + 谁说的：模型才能判断这句话是不是还作数、是谁的事
      const meta = [it.atAbs ? formatAbs(it.atAbs) : '', it.speaker].filter(Boolean).join(' · ')
      const tail = meta ? `（${meta}）` : ''
      // 教训的触发条件、话题的目标、承诺的到期，比正文那句话更该出现在画像里
      const extra = describeExtra(it)
      lines.push(`- [${tag}] ${it.text}${tail}${extra ? `（${extra}）` : ''}`)
    }
  }
  if (!lines.length) return ''
  const head = `## 你记得的（${scope.label}）\n`
  return guardPromptText(redactText(head + cutByLine(lines.join('\n'), maxChars)))
}

/**
 * 当前会话这一轮命中了哪些条目（ingest 算完塞给注入层）。
 *
 * 只记在内存里，不触发重渲染 —— 每条消息都重画记忆段，等于每轮都改
 * system prompt，KV 前缀缓存会一直失效。命中的排序等到下一次版本化
 * 刷新时再生效（阶段 5 起改走工具/预览通道，不再依赖常驻段）。
 */
/** 记一条"这个会话读过/写过什么"，只留最近 12 条。 */
export function noteSessionItem(root, sid, kind, id) {
  if (!sid || !id || !kind) return
  const key = `${root}|${sid}`
  const t = sessionTrace.get(key) ?? { read: [], wrote: [] }
  const list = kind === 'write' ? t.wrote : t.read
  if (!list.includes(id)) list.push(id)
  if (list.length > 12) list.splice(0, list.length - 12)
  sessionTrace.set(key, t)
}

export function sessionTraceOf(root, sid) {
  return sessionTrace.get(`${root}|${sid}`) ?? { read: [], wrote: [] }
}

/** 压缩后挂一个恢复包；下一次刷新强制重画，过期后自动撤掉。 */
export function setResumePack(root, sid, text, { ttlMs = 10 * 60 * 1000 } = {}) {
  const key = `${root}|${sid}`
  const e = live.get(key)
  if (!e || !text) return false
  e.resume = { text, until: Date.now() + ttlMs }
  paint(root, key, undefined, { force: true }).catch(() => {})
  return true
}

export function setRelevance(root, sid, ids = []) {
  const key = `${root}|${sid}`
  const e = live.get(key)
  if (!e) {
    pendingRelevance.set(key, ids)
    return
  }
  const before = (e.relevant || []).join(',')
  if (before === ids.join(',')) return
  e.relevant = ids
}

/** 分片版本文件的 mtime；不存在当 -1。 */
async function mtimeOf(file) {
  if (!file) return -1
  try { return (await stat(file)).mtimeMs } catch { return -1 }
}

/**
 * 重渲染一个会话的记忆段。
 *
 * 刷新条件（任一）：
 *   · force（会话刚创建）
 *   · 当前段还是空的（第一次有内容，反正前缀里没东西可保）
 *   · 条目变少了（删除立即生效，不能等）
 *   · 距上次渲染 ≥ minGapMs 且条目数变化 ≥ minItemDelta
 * 其余情况只记 defer，等下一次巡检再看。
 */
async function paint(root, key, log, { force = false } = {}) {
  const e = live.get(key)
  if (!e) return
  const ns = e.ns || null
  const file = scopeRevFile(root, e.kind, e.id)
  const pRevFile = ns ? scopeRevFile(ns.root, ns.kind, ns.id) : ''
  // 两个根都要看版本：仓库库改了也要重画，否则她永远读着启动时的仓库骨架
  const mt = await mtimeOf(file)
  const pmt = pRevFile ? await mtimeOf(pRevFile) : -1
  // 经验 / 画像两份文件也进戳：手改 AGENT.md 后新会话直接读到；
  // 长会话仍受下面的 5 分钟 / 3 条阈值约束，不单独为它重画。
  const dmt = await docStamp(root)
  const stamp = `${mt}:${pmt}:${dmt}`
  // 恢复包过期要立刻撤掉，不能等版本阈值
  if (e.resume && e.resume.until <= Date.now()) {
    e.resume = null
    force = true
  }
  if (e.painted && stamp === e.mtimeMs && !force) return

  const sc = await loadScope(root, e.kind, e.id).catch(() => null)
  const psc = ns ? await loadScope(ns.root, ns.kind, ns.id).catch(() => null) : null
  const liveCount = (s) => (s?.items || []).filter((x) => x.state !== 'archived' && x.state !== 'superseded' && x.state !== 'suggested').length
  const projCount = liveCount(psc)
  const count = liveCount(sc) + projCount

  if (!force && e.painted && e.render) {
    const gap = Date.now() - (e.paintedAt || 0)
    const delta = count - (e.itemCount || 0)
    if (delta < 0 || (gap >= REFRESH_POLICY.minGapMs && Math.abs(delta) >= REFRESH_POLICY.minItemDelta)) {
      // 删除 / 到点且变化够大：放行
    } else {
      e.deferred = true
      return
    }
  }

  // 常驻段只放「规矩 + 目录骨架」；正文交给 read_memory 按需读。
  // 空分片也要注入规矩段——否则新用户第一轮模型根本不知道能记。
  const revText = (await readFile(file, 'utf8').catch(() => '')).trim()
  const pRevText = pRevFile ? (await readFile(pRevFile, 'utf8').catch(() => '')).trim() : ''

  // 经验与画像（文档 4.8）：首轮按当前分片 / 仓库的相关度挑几条，独立小预算。
  // 会话中途不再重挑 —— 换条目等于改 system prompt，前缀缓存整段作废。
  const docs = await loadDocs(root).catch(() => null)
  const keywords = [
    ...(sc?.profile?.topics || []),
    ...(sc?.profile?.traits || []),
    ...(psc?.profile?.topics || []),
    ...(psc?.profile?.traits || []),
    ns?.label || '',
  ]
  const docBlock = docs ? renderDocsBlock(docs, { keywords }) : ''
  // USER.md 有内容时就不再重复画像摘要：同一段预算不花两遍
  const hasUserDoc = Boolean(docs?.user?.entries?.some((e) => !e.review))

  const core = projCount > 0
    // 仓库库和个人库各有独立目录（文档 4.7），合并注入时分开标标题；
    // 规矩段只出一次，免得同一套规矩在 system prompt 里占两份预算。
    ? [
      renderRules(),
      renderSkeleton(psc, { version: pRevText.slice(0, 8), maxChars: 500, title: `本仓库记忆 · ${ns.label}`, showProfile: !hasUserDoc }),
      renderSkeleton(sc, { version: revText.slice(0, 8), maxChars: 700, showProfile: !hasUserDoc }),
    ].join('\n\n')
    : renderMemorySection(sc, { version: revText.slice(0, 8), maxChars: 1000, showProfile: !hasUserDoc })

  const body = [core, docBlock, e.resume && e.resume.until > Date.now() ? e.resume.text : '']
    .filter(Boolean)
    .join('\n\n')
  // section 声明了 interpolate:false，新宿主会原样保留；老宿主不认这个字段时
  // 仍会走变量插值，所以出口再拆一次 {{ —— 宁可显示成「{ {」，也别让整轮请求抛错。
  e.render = guardPromptText(redactText(body))
  e.mtimeMs = stamp
  e.itemCount = count
  e.painted = true
  e.paintedAt = Date.now()
  e.deferred = false
  // 注入账本：谁被注入了、占了多少字。别 await，巡检不能被 IO 拖住。
  // 内容没变就不写，避免 30 秒巡检把账本刷成流水。
  if (e.render && e.render !== e.lastAudited) {
    e.lastAudited = e.render
    auditInject(root, {
      kind: 'render',
      scope: `${e.kind}:${e.id}`,
      label: e.label,
      chars: e.render.length,
      tokens: estimateTokens(e.render),
      items: count,
      deferred: false,
    }).catch(() => {})
  }
  log?.(`[whale] 记忆段刷新 · ${e.label} · ${count} 条`)
}

/**
 * 注册注入。必须在任何 agent 创建之前调用。
 * @returns {() => void} 卸载
 */
export function registerInjection(ctx, { root, log, enabled = true, persona = {} } = {}) {
  if (!enabled) return () => {}
  const mine = new Set()
  // 人格作用域：默认全局（本地干活会话也挂），配 bridge 就退回只挂桥接
  const scope = String(persona.scope || process.env.DSH_MEMORY_PERSONA_SCOPE || 'all').toLowerCase()

  // ⭐ 2026-11-03：agent 预设可以在会话里随时切。宿主 recompose 时会把预设那一层整棵拆掉重挂，
  //   agent 本身不重建（agent/created 不会再触发），我们挂上去的人格/记忆段就跟着没了 ——
  //   实测切完预设后 system 提示只剩预设自带的那一行。这里记住每个会话的 agent 和段的 disposer，
  //   收到 agent-preset/selected（宿主 recompose 完才发）就在新层上重挂一次。
  const agents = new Map()   // sid -> agent
  const mounts = new Map()   // sid -> { persona, memory } 的 disposer
  const letGo = (off) => {
    try {
      if (typeof off === 'function') off()
      else if (off && typeof off.dispose === 'function') off.dispose()
    } catch { /* 旧层已经拆过，disposer 失效不算事 */ }
  }
  const dropMount = (sid) => {
    const m = mounts.get(sid)
    if (!m) return
    letGo(m.persona)
    letGo(m.memory)
    mounts.delete(sid)
  }
  const keepMount = (sid, which, off) => {
    const m = mounts.get(sid) ?? {}
    m[which] = off
    mounts.set(sid, m)
  }

  const mount = (agent) => {
    try {
      const sp = agent?.ctx?.systemPrompt
      if (!sp || typeof sp.section !== 'function') {
        // 宿主没有 section（minimal / 精简 profile）：不能静默装死。
        // 只喊一次，避免每个会话刷一行；工具还在，记忆并非完全不可用。
        if (!degradedWarned) {
          degradedWarned = true
          log?.('[whale] 降级：宿主不支持 systemPrompt.section，人格与记忆段未注入（记忆工具仍可用）')
        }
        return
      }
      const sid = sessionIdOf(agent)
      if (!sid) return
      const trust = trustStateSync(root)
      if (!trust.usable) {
        if (!untrustedWarned) {
          untrustedWarned = true
          log?.('[whale] 外部记忆库未信任：人格与记忆都不注入，先跑 node tools/memory-trust.mjs trust')
        }
        return
      }
      const pSnap = personaSnapshot(root)

      // 来源：桥接查绑定表；本地会话归 local:dsh。配置读坏时返回 null，这一轮不挂记忆段。
      const src = sourceOfSessionSync(sid)
      // 仓库命名空间：本地会话在仓库里跑时，额外读一份跟着仓库走的记忆（文档 4.7）。
      // 只认 cwd 上有仓库标记的目录；认不出来就是 null，行为跟以前完全一样。
      const ns = projectOf(cwdOf(agent))

      if (scope !== 'bridge' || src?.bridge) {
        // 人格按会话快照：mid-session 改 persona.md 只影响下个会话。
        // interpolate:false —— 人设里出现 {{ }} 也不该被宿主当变量解析后整段抛错。
        const snap = pSnap
        letGo(mounts.get(sid)?.persona)
        keepMount(sid, 'persona', sp.section({
          name: PERSONA_SECTION,
          order: PERSONA_ORDER,
          text: () => guardPromptText(snap.text),
          interpolate: false,
        }))
        log?.(`[whale] 人格段已挂 · ${src ? src.label : '本地会话'} · ${sid.slice(0, 18)}`)
      }

      if (!src) {
        // 本地会话默认也记；走到这里只有两种情况：本地记忆关掉了，或绑定表读坏了。
        log?.(`[whale] 跳过未识别会话 · ${sid.slice(0, 18)}${localScopeEnabled() ? '（桥接配置读不到）' : '（本地记忆已关闭）'}`)
        return
      }

      const key = `${root}|${sid}`
      if (!live.has(key)) {
        const pend = pendingRelevance.get(key) ?? []
        pendingRelevance.delete(key)
        live.set(key, {
          ...src,
          ns,
          render: '',
          mtimeMs: -2,
          painted: false,
          relevant: pend,
          itemCount: 0,
          paintedAt: 0,
          personaMtime: pSnap.mtime,
        })
        mine.add(key)
      }

      // 再挂记忆段：只读缓存，真渲染交给 paint()（同步函数里不能 await）。
      letGo(mounts.get(sid)?.memory)
      keepMount(sid, 'memory', sp.section({
        name: MEMORY_SECTION,
        order: MEMORY_ORDER,
        text: () => live.get(key)?.render ?? '',
        interpolate: false,
      }))

      paint(root, key, log, { force: true }).catch((e) => log?.(`[whale] 分片解析失败 ${String(e?.message ?? e).slice(0, 120)}`))
    } catch (e) {
      log?.(`[whale] 注入失败 ${String(e?.message ?? e).slice(0, 160)}`)
    }
  }

  const onCreated = ({ agent } = {}) => {
    const id = sessionIdOf(agent)
    if (id) agents.set(id, agent)
    mount(agent)
  }

  // 预设切换：宿主 recompose 完才把这个事件写进会话流，正好在新层上重挂。
  // 走 session/event（采集也是这条），跨插件树都能收到；agent-presets 自己的全局事件是兄弟 ctx 发的，不一定传得到我们这。
  const offPreset = ctx.on?.('session/event', (session, event) => {
    if (event?.type !== 'agent-preset/selected') return
    const sid = String(session?.header?.id ?? session?.id ?? '')
    const agent = agents.get(sid)
    if (!sid || !agent) return
    log?.(`[whale] 预设切换后重挂 · ${String(event?.data?.agentPreset || '?')} · ${sid.slice(0, 18)}`)
    mount(agent)
  })
  // 会话关了就把 agent 和段的引用一起放掉
  const offGone = ctx.on?.('agent/disposed', (payload) => {
    const sid = String((typeof payload === 'string' ? payload : payload?.id ?? payload?.agent?.id) || '')
    if (!sid) return
    agents.delete(sid)
    dropMount(sid)
  })

  const off = ctx.on?.('agent/created', onCreated)
  if (typeof off !== 'function') {
    log?.('[whale] ctx.on 不可用，人格段挂不上')
    return () => {}
  }
  return () => {
    try { off() } catch { /* ignore */ }
    try { if (typeof offPreset === 'function') offPreset() } catch { /* ignore */ }
    try { if (typeof offGone === 'function') offGone() } catch { /* ignore */ }
    for (const sid of [...mounts.keys()]) dropMount(sid)
    agents.clear()
    for (const k of mine) live.delete(k)
    mine.clear()
  }
}

/**
 * 启动记忆段巡检：每 30 秒看一次分片文件有没有变，变了就重渲染。
 * 这样蒸馏、遗忘、工具、界面任何一条写入路径都能被同一次巡检兜住。
 */
export function startMemoryRefresh({ root, log, everyMs = 30 * 1000 } = {}) {
  const tick = async () => {
    // 人格文件变了但会话还在用旧快照：提示一次，别让人以为改没生效
    const mt = personaSnapshot(root).mtime
    if (mt > 0 && mt !== lastPersonaNotice) {
      let stale = false
      for (const e of live.values()) if ((e.personaMtime ?? -1) < mt) stale = true
      if (stale) {
        lastPersonaNotice = mt
        log?.('[whale] persona.md 已更新：当前会话保持旧版（缓存纪律），新会话生效')
      }
    }
    for (const key of [...live.keys()]) {
      try { await paint(root, key, log) } catch { /* 单条失败不拖垮其他 */ }
    }
  }
  const timer = setInterval(() => { tick().catch(() => {}) }, everyMs)
  timer.unref?.()
  return {
    tick,
    dispose() { clearInterval(timer) },
  }
}

/** 测试用：清缓存。 */
export function resetCaches() {
  live.clear()
  pendingRelevance.clear()
  sessionTrace.clear()
  degradedWarned = false
  untrustedWarned = false
  lastPersonaNotice = -1
}
