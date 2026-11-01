/**
 * personadistill.js —— 人格蒸馏的采样门与确定性审查（文档 8.6）
 *
 * 两道门，分别解决两个问题：
 *   1. 采样：不能把整群聊天史直接扔给模型。先本地过滤命令/日志/转述，
 *      凭据先打码，按分片均衡抽样，防止一个活跃用户把人格带偏。
 *   2. 审查：生成模型说的不算数。证据 id 必须在库里、规则不能写事件/日期/
 *      号码/路径/凭据、不能自曝 AI、不能跟现有规则重复、不能超预算。
 *      确定性检查先跑；配了审查模型再跑一次独立审查，两关都过才进提案。
 */

import { listScopes, decayScore } from './store.js'
import { redactText } from './redact.js'

export const SAMPLE = { max: 40, perScope: 6, maxChars: 60 }

/** 命令、日志、转发、代码片段不当人格样本。 */
const SKIP = /^(?:\/|node\s|npm\s|pnpm\s|git\s|curl\s|http|cd\s|\.\/|powershell|cmd\b)|```|error:|traceback|exception/i

/** 只挑跟「怎么说」有关的：偏好/关系，或明确在讲说话方式的句子。 */
const STYLE = /说|语气|回复|回答|称呼|叫|别|不要|以后|总是|每次|习惯|emoji|表情|结论|啰嗦|道歉|免责|短|长|怼|骂|夸|正经|严肃/

function oneLine(s) {
  return String(s ?? '').replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim()
}

function clip(s, n) {
  const v = oneLine(s)
  return v.length > n ? `${v.slice(0, n - 1)}…` : v
}

function estimateTokens(text) {
  const t = String(text ?? '')
  const cjk = (t.match(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) || []).length
  return Math.ceil(cjk + (t.length - cjk) / 3.5)
}

/**
 * 采样：脱敏 + 过滤 + 按分片轮转。
 * @returns {Promise<{samples:object[], knownIds:Set<string>, stats:{scopes:number, skipped:number, total:number}}>}
 */
export async function samplePersona(root, { max = SAMPLE.max, perScope = SAMPLE.perScope } = {}) {
  const scopes = await listScopes(root).catch(() => [])
  const buckets = []
  const knownIds = new Set()
  let skipped = 0
  let total = 0

  for (const sc of scopes) {
    const rows = []
    for (const it of sc.items || []) {
      if (!it || ['archived', 'superseded', 'expired', 'suggested'].includes(it.state)) continue
      const raw = String(it.text || '').trim()
      if (!raw) continue
      total += 1
      knownIds.add(it.id)
      if (raw.length < 4 || raw.length > 200) { skipped += 1; continue }
      if (SKIP.test(raw)) { skipped += 1; continue }
      const text = clip(redactText(raw), SAMPLE.maxChars)
      // 打码之后还剩凭据标记的，整条不要：宁可少一条样本
      if (/\[(?:密钥)?已隐藏\]/.test(text)) { skipped += 1; continue }
      if (!STYLE.test(text) && it.kind !== 'pref' && it.kind !== 'relation') { skipped += 1; continue }
      rows.push({ id: it.id, scope: sc.scope, text, w: decayScore(it) })
    }
    if (rows.length) buckets.push(rows.sort((a, b) => b.w - a.w))
  }

  // 轮转取：每个分片先取一条，避免大群/活跃用户把样本吃满
  const samples = []
  for (let round = 0; round < perScope && samples.length < max; round += 1) {
    for (const b of buckets) {
      if (samples.length >= max) break
      const row = b[round]
      if (row) samples.push({ id: row.id, scope: row.scope, text: row.text })
    }
  }
  return { samples, knownIds, stats: { scopes: scopes.length, skipped, total } }
}

/**
 * 确定性审查。返回 ok=false 时 why 直接进提案的 rejected 列表。
 */
export function reviewRule(rule, {
  evidence = [], knownIds = new Set(), current = '', tokens = 0, limit = 1200,
} = {}) {
  const r = oneLine(rule).replace(/^[-+~]\s*/, '')
  if (r.length < 4) return { ok: false, why: '太短，不像一条规则' }
  if (r.length > 80) return { ok: false, why: `太长（${r.length} 字）` }
  if (/\d{5,}|20\d{2}[-年/]|https?:|[A-Za-z]:\\|sk-|ghp_|AIza/.test(r)) {
    return { ok: false, why: '含日期 / 号码 / 路径 / 凭据' }
  }
  if (/(?:昨天|今天|明天|前天|上周|下周|刚才|这次|那次|最近)/.test(r)) {
    return { ok: false, why: '写进了具体事件或时间' }
  }
  if (/作为(?:一个)?\s*(?:AI|人工智能|语言模型)|语言模型|人工智能助手/.test(r)) {
    return { ok: false, why: '自曝 AI 身份' }
  }
  const ids = [...new Set((evidence || []).map(String).filter(Boolean))]
  if (!ids.length) return { ok: false, why: '没有证据 id' }
  const missing = ids.filter((id) => !knownIds.has(id))
  if (missing.length) return { ok: false, why: `证据 id 不在库里：${missing.slice(0, 2).join('、')}` }
  if (current && current.includes(r.slice(0, 8))) return { ok: false, why: '和现有规则重复' }
  if (tokens + estimateTokens(r) > limit) return { ok: false, why: '超人格预算' }
  return { ok: true, rule: r }
}
