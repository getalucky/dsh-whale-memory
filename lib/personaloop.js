/**
 * personaloop.js —— 人格自动迭代的节奏控制（文档 8.6 第三、五节）
 *
 * 自动触发不是定时改人设，是一串门：
 *   · 距上次迭代 ≥24 小时
 *   · 自上次迭代累计 ≥100 条有效用户消息
 *   · 有效样本 ≥20 条
 *   · 本周还没发布过 revision
 *   · 已连续 3 次人工通过，且确认闸门处于 enforce
 * 任意一道没过就只生成提案，等人工确认；不会在对话回合里改 personamu。
 *
 * 只在批处理里跑，失败下一小时再来，幂等。
 */

import { readMeta, propose, applyProposal, autoGate, AUTO, updateMeta } from './persona.js'

/** 采集侧给「新增有效用户消息」计数；只加不减，propose 成功后清零。 */
export async function bumpMessages(root, n = 1) {
  if (!n) return 0
  const meta = await updateMeta(root, (m) => ({
    ...m,
    pendingMessages: (m.pendingMessages || 0) + n,
  }))
  return meta.pendingMessages || 0
}

function ms(value) {
  const t = Date.parse(String(value || ''))
  return Number.isFinite(t) ? t : 0
}

/**
 * 跑一轮检查。给 loop、CLI 和测试共用。
 * @returns {Promise<{ran:boolean, proposed?:boolean, applied?:number, version?:number, why?:string}>}
 */
export async function autoTick(root, { log, cfg = {}, gate = 'enforce', now = Date.now() } = {}) {
  const c = { ...AUTO, ...cfg }
  const say = log ?? (() => {})
  const meta = await readMeta(root)

  const pending = meta.pendingMessages || 0
  if (pending < c.minMessages) {
    return { ran: false, why: `新消息 ${pending}/${c.minMessages}` }
  }

  // 24 小时从「上次真正跑过」算，不是从上次应用算：
  // 提案没人审也不能每小时重写一遍，那样提案文件只会被反复覆盖。
  const last = Math.max(ms(meta.lastRunAt), ms(meta.lastPublishedAt))
  const waitMs = c.minHours * 3600 * 1000
  if (last && now - last < waitMs) {
    const hours = ((waitMs - (now - last)) / 3600 / 1000).toFixed(1)
    return { ran: false, why: `距上次迭代不足 ${c.minHours} 小时（还差 ${hours} 小时）` }
  }

  let proposal
  try {
    proposal = await propose(root)
  } catch (e) {
    const why = String(e?.message ?? e).slice(0, 160)
    say(`[whale] 人格提案失败 ${why}`)
    return { ran: false, why }
  }

  const samples = proposal.samples?.total ?? 0
  if (samples < c.minSamples) {
    say(`[whale] 人格样本不足 ${samples}/${c.minSamples}，先攒记忆`)
    return { ran: false, why: `有效样本 ${samples}/${c.minSamples}` }
  }
  if (!proposal.additions?.length) {
    say('[whale] 人格提案没有新候选')
    return { ran: true, proposed: true, applied: 0, why: '没有新候选' }
  }

  const elig = await autoGate(root, { gate })
  if (!elig.ok) {
    say(`[whale] 人格提案 ${proposal.additions.length} 条，等人工确认（${elig.why}）`)
    return { ran: true, proposed: true, applied: 0, why: elig.why }
  }

  try {
    const r = await applyProposal(root, undefined, { by: 'auto' })
    say(`[whale] 人格自动发布 v${r.version} · ${r.applied} 条 · 探针 ${r.probes.passed}/${r.probes.total}`)
    return { ran: true, proposed: true, applied: r.applied, version: r.version }
  } catch (e) {
    const why = String(e?.message ?? e).slice(0, 160)
    say(`[whale] 人格自动发布被拒 ${why}`)
    return { ran: true, proposed: true, applied: 0, why }
  }
}

/**
 * 启动自动迭代循环：每小时看一次，启动后延迟 30 秒跑第一轮，
 * 不跟宿主启动时的读盘打架。env DSH_MEMORY_PERSONA_AUTO=off 时不启动。
 */
export function startPersonaLoop({ root, log, cfg = {}, gate, everyMs = 60 * 60 * 1000 } = {}) {
  let timer = null
  let first = null
  let running = false

  const tick = async () => {
    if (running) return null
    running = true
    try {
      return await autoTick(root, { log, cfg, gate })
    } catch (e) {
      log?.(`[whale] 人格自动迭代失败 ${String(e?.message ?? e).slice(0, 160)}`)
      return null
    } finally {
      running = false
    }
  }

  first = setTimeout(() => { tick() }, 30 * 1000)
  first.unref?.()
  timer = setInterval(tick, everyMs)
  timer.unref?.()

  return {
    dispose() {
      if (first) clearTimeout(first)
      if (timer) clearInterval(timer)
      first = null
      timer = null
    },
    tick,
  }
}
