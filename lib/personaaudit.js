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

/**
 * 替换结果校验：换说法可以，但不能换主题、不能变长、不能丢约束词。
 * 只用于模型提出的 replace；候选替换仍走 reviewRule + findReplacement 的老路。
 */
export function validateReplace(oldText, newText, lines) {
  const oldS = String(oldText || '').trim()
  const s = String(newText || '').trim()
  if (!s || s === oldS) return { ok: false, why: '没有变化' }
  if (s.length < 4 || s.length > 100) return { ok: false, why: '长度不在 4–100 字' }
  if (estimateTokens(s) > estimateTokens(oldS) + 6) return { ok: false, why: '比旧说法长太多' }
  if (similarity(oldS, s) < 0.35) return { ok: false, why: '不像同一条约束（相似度太低）' }
  if (!CONSTRAINT.test(s)) return { ok: false, why: '丢了约束词，不像一条规矩' }
  if (BAD.test(s)) return { ok: false, why: '带进了事件 / 日期 / 路径 / 凭据 / 自曝 AI' }
  if ((lines || []).some((l) => String(l).trim() === s)) {
    return { ok: false, why: '和别的行重复' }
  }
  return { ok: true, rule: s }
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

const ACTION_ALIAS = {
  keep: 'keep', 保留: 'keep', 必须保留: 'keep', 维持: 'keep', 原样: 'keep',
  shorten: 'shorten', 缩短: 'shorten', 压缩: 'shorten', 精简: 'shorten', 写短: 'shorten',
  replace: 'replace', 替换: 'replace', 改写: 'replace', 替代: 'replace', 换掉: 'replace',
}

function 动作(v) {
  const s = String(v ?? '').trim()
  return ACTION_ALIAS[s] || ACTION_ALIAS[s.toLowerCase()] || ''
}

/**
 * 汇总一轮「整理建议」：
 *   · 规则版压缩一定跑
 *   · triage（模型逐行 keep/shorten/replace）存在时，keep 行不参与任何整理，
 *     shorten 与规则压缩各自校验后取最短，replace 单独出一份替换建议
 * 同一行可能同时有 replace 和压缩建议：这是故意的，留给调用方在替换被审查
 * 否决后让压缩补位；最终提案里会按 old 去重。
 * @returns {{audit:Array, keeps:Array, compressions:Array, replacements:Array, triage:Array}}
 */
export function collectCompressions(evolvable, { llmCompact = null, triage = null } = {}) {
  const rows = inspectEvolvable(evolvable)
  const lines = rows.map((r) => r.text)
  const keeps = []
  const keepIdx = new Set()
  const shorten = {}
  const replaceByI = new Map()
  const triageByI = new Map()

  const 记 = (i, row) => {
    const prev = triageByI.get(i)
    if (!prev || (row.action === 'keep' && prev.action !== 'keep')) triageByI.set(i, row)
  }

  if (Array.isArray(triage)) {
    for (const t of triage) {
      const i = Number(t?.i)
      if (!Number.isInteger(i) || !rows[i]) continue
      const action = 动作(t?.action)
      if (!action) continue
      const why = String(t?.why ?? '').replace(/\s+/g, ' ').trim().slice(0, 60)
      if (action === 'keep') {
        const prev = triageByI.get(i)
        if (prev && prev.action === 'keep') continue
        keepIdx.add(i)
        keeps.push({ i, text: rows[i].text, why: why || '模型判定必须保留' })
        记(i, { i, text: rows[i].text, action, rule: '', why, ok: true, whyDropped: '' })
        continue
      }
      if (keepIdx.has(i)) continue
      const next = String(t?.text ?? t?.compact ?? '').replace(/\s+/g, ' ').trim().slice(0, 300)
      if (action === 'shorten') {
        shorten[i] = next
        const v = validateCompact(rows[i].text, next, lines)
        记(i, { i, text: rows[i].text, action, rule: v.ok ? v.rule : '', why, ok: v.ok, whyDropped: v.ok ? '' : v.why })
      } else {
        const v = validateReplace(rows[i].text, next, lines)
        if (v.ok) replaceByI.set(i, { rule: v.rule, why })
        记(i, { i, text: rows[i].text, action, rule: v.ok ? v.rule : '', why, ok: v.ok, whyDropped: v.ok ? '' : v.why })
      }
    }
  }

  for (const row of rows) {
    const t = triageByI.get(row.i)
    if (!t) continue
    // 只加展示字段，不改动原有结构，旧调用方不受影响
    row.modelAction = t.action
    row.modelWhy = t.why
    row.modelOk = t.ok
    row.modelWhyDropped = t.whyDropped
  }

  const out = []
  const replacements = []
  for (const row of rows) {
    if (keepIdx.has(row.i)) continue
    const mr = replaceByI.get(row.i)
    if (mr) {
      replacements.push({
        old: row.text,
        rule: mr.rule,
        source: 'llm',
        why: mr.why || '模型判定可替换',
        // 跟预算、审查基准同一口径：tok，不是字符数
        freed: estimateTokens(row.text) - estimateTokens(mr.rule),
      })
    }
    // 规则版 + 模型 shorten 各自独立校验，再取最短；旧逻辑一旦模型文本非法会连规则压缩一起丢
    const cands = []
    const rc = ruleCompact(row.text)
    if (rc) cands.push({ text: rc, source: 'rule' })
    const suggested = (shorten[row.i] !== undefined ? shorten[row.i] : llmCompact?.[row.i]) || ''
    if (suggested) cands.push({ text: suggested, source: 'llm' })
    const valid = []
    for (const c of cands) {
      const v = validateCompact(row.text, c.text, lines)
      if (v.ok) valid.push({ ...c, rule: v.rule })
    }
    if (!valid.length) continue
    valid.sort((a, b) => a.rule.length - b.rule.length)
    const best = valid[0]
    out.push({
      old: row.text,
      rule: best.rule,
      flag: row.flag,
      source: best.source,
      why: `${row.why}；${row.suggestion || '写短一点'}`,
      freed: Math.max(0, estimateTokens(row.text) - estimateTokens(best.rule)),
    })
  }
  return { audit: rows, keeps, compressions: out, replacements, triage: [...triageByI.values()] }
}
