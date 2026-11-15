/**
 * appraise.js —— 蒸馏旁路的解析（文档 14.5）
 *
 * 不新增 LLM 调用：蒸馏本来就在读这轮对话，让它顺手在数组末尾多给一个
 * {"affect":[{"k":"得意","i":0.6}]} 元素。那条元素没有 text，记忆解析会当空条目丢掉，
 * 这里按同样的 [] 切片再读一遍。
 *
 * 只做形状收口：词表外的名字、强度越界一律丢。模型编出来的情绪不许进状态。
 */

import { isEmotion } from './lexicon.js'

const MAX_I = 0.5

export function parseAppraisal(content) {
  const s = String(content ?? '')
  const a = s.indexOf('[')
  const b = s.lastIndexOf(']')
  if (a < 0 || b <= a) return []
  let arr = null
  try { arr = JSON.parse(s.slice(a, b + 1)) } catch { return [] }
  if (!Array.isArray(arr)) return []

  const out = []
  const seen = new Set()
  for (const x of arr) {
    const list = Array.isArray(x?.affect) ? x.affect : []
    for (const it of list) {
      const k = String(it?.k ?? it?.kind ?? '').trim()
      const i = Number(it?.i ?? it?.intensity)
      if (!isEmotion(k) || !Number.isFinite(i) || i <= 0) continue
      const v = Math.min(MAX_I, i)
      if (seen.has(k)) continue
      seen.add(k)
      out.push({ kind: k, i: v, why: 'llm' })
      if (out.length >= 2) return out
    }
  }
  return out
}

/** 给蒸馏提示词末尾加的那一句；单独拎出来，改词表时不用翻 llm.js。 */
export const APPRAISE_PROMPT = '同一个数组里，如果这轮对话明显让她（机器人）产生了情绪，可以在最后再加一个元素 {"affect":[{"k":"得意","i":0.6}]}（不要 text 字段）；k 只能取 开心/得意/被逗到/害羞/安心/好奇/委屈/烦躁/生气/担心/失落/累，i 取 0~0.5；没有就省略。'
