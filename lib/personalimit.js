/**
 * personalimit.js —— 人格预算的唯一来源
 *
 * persona.md 每个会话都注入一次，调大等于每轮请求都多带这些字。
 * 两种模式：
 *   fixed：固定额度，默认 1200，可用 DSH_MEMORY_PERSONA_TOKENS 调整
 *   auto ：按「上下文窗口 × 占比」算，窗口 / 占比可用
 *          DSH_MEMORY_PERSONA_WINDOW / DSH_MEMORY_PERSONA_SHARE 配置
 * 两种模式最终都钳在 600–2400。设置页写入的 settings.json `persona_budget`
 * 优先级高于环境变量；都在调用时读取，不在模块加载时冻结。
 * 单独一个模块是为了让 persona.js / probes.js / personadistill.js 共用同一个值，
 * 不互相 import（persona.js → probes.js 已经有一条依赖，不能反过来）。
 */

export const DEFAULT_PERSONA_TOKENS = 1200
export const MIN_PERSONA_TOKENS = 600
export const MAX_PERSONA_TOKENS = 2400

/** 设置页 / 接口共用的校验范围。share 是小数，不是百分数。 */
export const PERSONA_BUDGET_LIMITS = {
  tokens: [MIN_PERSONA_TOKENS, MAX_PERSONA_TOKENS],
  window: [1000, 2000000],
  share: [0.001, 0.2],
}

/** settings.json 里的配置快照；null 表示回落到环境变量 / 默认值。 */
let 内存配置 = null

/**
 * 人格预算的 token 口径：CJK 一字算一，其余按 3.5 字折一。
 * 预算、压缩腾出的额度、审查基准必须用同一个口径，不能一处算字、一处算 tok。
 */
export function estimateTokens(text) {
  const t = String(text ?? '')
  const cjk = (t.match(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) || []).length
  return Math.ceil(cjk + (t.length - cjk) / 3.5)
}

const clamp = (n, min, max) => Math.min(max, Math.max(min, n))

function 取(k, envKey) {
  const m = 内存配置?.[k]
  if (m !== undefined && m !== null && String(m).trim() !== '') return m
  return process.env[envKey]
}

function 有env() {
  return ['DSH_MEMORY_PERSONA_MODE', 'DSH_MEMORY_PERSONA_TOKENS', 'DSH_MEMORY_PERSONA_WINDOW', 'DSH_MEMORY_PERSONA_SHARE']
    .some((k) => String(process.env[k] ?? '').trim() !== '')
}

/** 设置页保存后立即生效；传 null 清除内存配置，回落到 env / 默认。 */
export function setPersonaBudget(next) {
  内存配置 = next && typeof next === 'object' && !Array.isArray(next) ? { ...next } : null
  return personaBudget()
}

/** 解析当前生效的额度。轮内要稳定的调用方应只取一次本函数的返回值。 */
export function personaBudget() {
  const modeRaw = String(取('mode', 'DSH_MEMORY_PERSONA_MODE') ?? '').trim().toLowerCase()
  const requestedMode = modeRaw === 'auto' ? 'auto' : 'fixed'

  const t = Number(取('tokens', 'DSH_MEMORY_PERSONA_TOKENS'))
  const tokens = Number.isFinite(t) && t > 0
    ? clamp(Math.round(t), MIN_PERSONA_TOKENS, MAX_PERSONA_TOKENS)
    : DEFAULT_PERSONA_TOKENS

  const w = Number(取('window', 'DSH_MEMORY_PERSONA_WINDOW'))
  const window = Number.isFinite(w) && w > 0
    ? clamp(Math.round(w), PERSONA_BUDGET_LIMITS.window[0], PERSONA_BUDGET_LIMITS.window[1])
    : 0

  const s = Number(取('share', 'DSH_MEMORY_PERSONA_SHARE'))
  const share = Number.isFinite(s) && s > 0
    ? clamp(s, PERSONA_BUDGET_LIMITS.share[0], PERSONA_BUDGET_LIMITS.share[1])
    : 0

  const autoUsable = requestedMode === 'auto' && window > 0 && share > 0
  const mode = autoUsable ? 'auto' : 'fixed'
  const limit = mode === 'auto'
    ? clamp(Math.round(window * share), MIN_PERSONA_TOKENS, MAX_PERSONA_TOKENS)
    : tokens
  const why = requestedMode === 'auto' && !autoUsable
    ? '自动模式缺少上下文窗口或占比，已回退固定额度'
    : ''

  return {
    limit,
    mode,
    requestedMode,
    source: 内存配置 ? 'settings' : 有env() ? 'env' : 'default',
    tokens,
    window,
    share,
    min: MIN_PERSONA_TOKENS,
    max: MAX_PERSONA_TOKENS,
    why,
  }
}

/** 给设置表单回填：想用的模式 + 解析后的数值（auto 缺窗口时仍返回 auto，让用户补全）。 */
export function personaBudgetConfig() {
  const b = personaBudget()
  return { mode: b.requestedMode, tokens: b.tokens, window: b.window, share: b.share }
}

export function personaTokenLimit() {
  return personaBudget().limit
}
