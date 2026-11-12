/**
 * personaaudit.js —— 写入新规矩之前，先审视旧人设
 *
 * 目标不是「一味添加」：每次 propose 都把 EVOLVABLE 逐行过一遍，
 * 标出写得啰嗦的、跟别的行说同一件事的、以及只做示范不参与约束的示例行。
 * 能安全写短的生成 compressions；写不短的也留在审计报告里给人看。
 *
 * 所有压缩都只是提案，appl 时按整行精确匹配替换，还要过前后探针。
 */

import { similarity } from './recall.js'
import { estimateTokens } from './personalimit.js'

/** 约束词：一条人设规矩里真正起作用的部分。砍补充说明时不能把这些砍掉。 */
const CONSTRAINT = /[不别该]|必须|默认|最多|只在|先|可以|要|收手|见好|立刻/
/** 硬伤词：压缩后的文本不能新带进这些东西。 */
const BAD = /昨天|今天|今早|今晚|刚才|前天|上周|上次|最近|昨晚|(?:19|20)\d{2}\s*[-/.年]\s*\d{1,2}|\d{1,2}\s*月\s*\d{1,2}\s*日|[A-Za-z]:[\\/]|https?:\/\/|sk-|ghp_|作为\s*(?:一个)?\s*(?:AI|人工智能|语言模型)|人工智能助手/i

export const AUDIT = {
  verboseChars: 70,   // 超过这个字数算「偏长」
  redundantSim: 0.62, // 两行相似度超过这个算「疑似重复」
  minShorten: 0.10,   // 压缩至少短 10% 才提
}

export function charsOf(text) {
  return String(text || '').trim().length
}

/**
 * 逐行审视。纯规则、零成本、可解释。
 * @returns {Array<{i:number,text:string,chars:number,flag:string,why:string,suggestion:string}>}
 */
export function inspectEvolvable(evolvable) {
  const lines = String(evolvable || '').split('\n').map((s) => s.trim()).filter(Boolean)
  const rows = lines.map((text, i) => {
    const chars = charsOf(text)
    let flag = 'keep'
    let why = '精简、独立的一条约束'
    let suggestion = ''
    // 示例 / 反例：占预算，但不参与探针的「可执行约束」判定
    if (/^(例|例子|示例)[:：]/.test(text) || /[✗✓]/.test(text) || /^[^：:]{1,8}[:：]\s*[^\s]{0,6}$/.test(text)) {
      flag = 'example'
      why = '示例 / 反例行，占预算但不是约束句'
      suggestion = '可压成一条指引，或只留 ✓ 正例'
    } else if (chars > AUDIT.verboseChars) {
      flag = 'verbose'
      why = `偏长（${chars} 字），多半含可砍的补充说明`
      suggestion = '去掉不含约束词的解释尾巴'
    }
    for (let j = 0; j < i; j += 1) {
      if (similarity(text, lines[j]) >= AUDIT.redundantSim) {
        flag = 'redundant'
        why = `与第 ${j + 1} 行疑似说的是同一件事（相似度 ${similarity(text, lines[j]).toFixed(2)}）`
        suggestion = '合并成一条，或由新说法替换'
        break
      }
    }
    return { i, text, chars, flag, why, suggestion }
  })
  return rows
}

/** 规则版压缩：只砍「不含约束词」的补充说明，砍不动就返回 null。 */
export function ruleCompact(text) {
  const src = String(text || '').trim()
  // 称呼 / 自称那类，引号里就是内容本身，砍了就变味
  if (/称呼|叫他|自称/.test(src)) return null
  let s = src
  // 连续两个以上「…」是举例列举，砍掉不影响主干约束。
  // 但「不开场「A」「B」」这种，列举本身就是禁令的宾语，砍了就不知道禁什么，必须保留。
  s = s.replace(/(?:「[^」]{1,24}」\s*){2,}/g, (m, offset) => {
    const before = s.slice(Math.max(0, offset - 4), offset)
    return /[不别][^，,。；;]{0,3}$/.test(before) ? m : ''
  })
  // 破折号拉出来的补充解释，整段不含约束词才敢砍
  s = s.replace(/——[^。；;]*$/, (m) => (CONSTRAINT.test(m) ? m : ''))
  // 括号旁注，同样只在不含约束词时砍
  s = s.replace(/[（(]([^）)]*)[）)]/g, (m, inner) => (CONSTRAINT.test(inner) ? m : ''))
  // 句尾「比如/例如」拖出来的举例
  s = s.replace(/[，,；;]\s*(?:比如|例如|像是?)[^。]*$/, '')
  s = s.replace(/\s+/g, ' ').trim().replace(/[，,；;、]+$/, '')
  if (!s.endsWith('。') && !s.endsWith('！') && !s.endsWith('？')) s += '。'
  if (s.length < 6 || s.length > src.length * (1 - AUDIT.minShorten)) return null
  if (!CONSTRAINT.test(s)) return null
  return s
}

/** 压缩结果校验：更短、仍是可执行约束、不带进硬伤、不与别的行撞车。 */
export function validateCompact(oldText, newText, lines) {
  const oldS = String(oldText || '').trim()
  const s = String(newText || '').trim()
  if (!s || s === oldS) return { ok: false, why: '没变短或没内容' }
  if (s.length > oldS.length * (1 - AUDIT.minShorten)) return { ok: false, why: `只短了 ${oldS.length - s.length} 字，不够 ${Math.round(AUDIT.minShorten * 100)}%` }
  if (s.length < 6) return { ok: false, why: '压得太短，语义没了' }
  if (!CONSTRAINT.test(s)) return { ok: false, why: '压完丢了约束词，不像一条规矩' }
  if (BAD.test(s)) return { ok: false, why: '压完带进了事件 / 日期 / 路径 / 凭据 / 自曝 AI' }
  if (lines.some((l) => String(l).trim() === s)) {
    return { ok: false, why: '和别的行重复' }
  }
  return { ok: true, rule: s }
}

/**
 * 汇总一轮「整理建议」：规则版先跑，配了 LLM 再用模型补更聪明的精简。
 * 同一行只出一条压缩建议，规则版和 LLM 版谁短用谁。
 */
export function collectCompressions(evolvable, { llmCompact = null } = {}) {
  const rows = inspectEvolvable(evolvable)
  const lines = rows.map((r) => r.text)
  const out = []
  for (const row of rows) {
    let compact = ruleCompact(row.text)
    if (llmCompact) {
      const suggested = llmCompact[row.i]
      if (suggested && suggested.length < (compact || row.text).length) compact = suggested
    }
    if (!compact) continue
    const v = validateCompact(row.text, compact, lines)
    if (!v.ok) continue
    out.push({
      old: row.text,
      rule: v.rule,
      flag: row.flag,
      why: `${row.why}；${row.suggestion || '写短一点'}`,
      // 跟预算、审查基准同一口径：tok，不是字符数
      freed: Math.max(0, estimateTokens(row.text) - estimateTokens(v.rule)),
    })
  }
  return { audit: rows, compressions: out }
}
