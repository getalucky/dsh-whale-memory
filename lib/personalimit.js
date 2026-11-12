/**
 * personalimit.js —— 人格预算的唯一来源
 *
 * persona.md 每个会话都注入一次，调大等于每轮请求都多带这些字。
 * 默认 1200（历史值），可用 DSH_MEMORY_PERSONA_TOKENS 调整，钳在 600–2400。
 * 单独一个模块是为了让 persona.js / probes.js / personadistill.js 共用同一个值，
 * 不互相 import（persona.js → probes.js 已经有一条依赖，不能反过来）。
 */

export const DEFAULT_PERSONA_TOKENS = 1200
export const MIN_PERSONA_TOKENS = 600
export const MAX_PERSONA_TOKENS = 2400

/**
 * 人格预算的 token 口径：CJK 一字算一，其余按 3.5 字折一。
 * 预算、压缩腾出的额度、审查基准必须用同一个口径，不能一处算字、一处算 tok。
 */
export function estimateTokens(text) {
  const t = String(text ?? '')
  const cjk = (t.match(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) || []).length
  return Math.ceil(cjk + (t.length - cjk) / 3.5)
}

export function personaTokenLimit() {
  const n = Number(process.env.DSH_MEMORY_PERSONA_TOKENS)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_PERSONA_TOKENS
  return Math.min(MAX_PERSONA_TOKENS, Math.max(MIN_PERSONA_TOKENS, Math.round(n)))
}
