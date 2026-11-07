/**
 * beat/sources/chat.js —— 会话素材库
 *
 * 从用户消息里抽“值得下次聊”的话题：未完成的约定、强反应、明确推迟的事。
 * 规则版，不额外调 LLM；产出只进素材库，不进记忆、不进画像、不进人格。
 *
 * 蒸馏侧把同一批 userMsgs 传进来；长会话不空闲时由 beat 的回合内抽取兜底。
 */

import { createHash } from 'node:crypto'

import { extractConcepts } from '../../taxonomy.js'
import { addMaterial } from '../material.js'

const PROMISE = /(下次|改天|回头|以后|等.{0,6}再|到时候|明天|周末|过几天)/
const REACTION = /(受不了|太离谱|离谱|烦死|气死|崩溃|绝了|恶心|离谱|顶不住)/
const DEFER = /(以后再说|先放着|再说吧|回头再说|先这样)/
const NOISE = /(密码|token|身份证|银行卡|验证码|http:\/\/|https:\/\/|```|\{|\}|^\s*[/!])/i
const SPLIT = /[。！？!?；;\n]+/
const MAX_TEXT = 120
const CONTEXT_CHARS = 80
const CONTEXT_WINDOW_MS = 10 * 60 * 1000
const CONTEXT_SCAFFOLD = /^(【\s*群聊身份|这一批（含前情）说话的人|【以下是消息】|【现在】)/

function textOf(m) {
  return String(m?.m?.text ?? m?.text ?? '')
}

function atOf(m) {
  return String(m?.m?.at ?? m?.at ?? '')
}

function speakerOf(m) {
  return String(m?.m?.speaker ?? m?.speaker ?? '')
}

function roleOf(m) {
  return String(m?.m?.role ?? m?.role ?? 'user')
}

function replyToOf(m) {
  return String(m?.m?.reply_to ?? m?.reply_to ?? '')
}

/** 截到句号/问号/分号，别把一句话砍在半截；实在没标点才加省略号。 */
function clipText(text, max = MAX_TEXT) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (s.length <= max) return s
  const head = s.slice(0, max)
  const cut = Math.max(
    head.lastIndexOf('。'), head.lastIndexOf('！'), head.lastIndexOf('？'),
    head.lastIndexOf('；'), head.lastIndexOf('!'), head.lastIndexOf('?'), head.lastIndexOf(';'),
  )
  return cut >= Math.floor(max * 0.5) ? head.slice(0, cut + 1) : `${head}…`
}

/** 同一批消息里，往上找一条能当“上文”的话；隔太久或像脚手架的不要。 */
function contextFor(list, i, text) {
  const curAt = Date.parse(list[i]?.at || '')
  for (let j = i - 1; j >= 0; j -= 1) {
    const prev = list[j]
    const t = String(prev?.text ?? '').replace(/\s+/g, ' ').trim()
    if (!t || CONTEXT_SCAFFOLD.test(t)) continue
    const at = Date.parse(prev?.at || '')
    if (Number.isFinite(curAt) && Number.isFinite(at) && curAt - at > CONTEXT_WINDOW_MS) return ''
    const ctx = clipText(t, CONTEXT_CHARS)
    return ctx === text ? '' : ctx
  }
  return ''
}

function sentenceOf(text, re) {
  for (const s of String(text).split(SPLIT)) {
    const t = s.trim()
    if (t.length >= 4 && re.test(t)) return clipText(t)
  }
  return ''
}

function hashOf(text) {
  return createHash('sha1').update(String(text)).digest('hex').slice(0, 16)
}

/**
 * 纯规则抽取：一条消息最多出一个候选，整批最多 max 条。
 * @param {Array} messages distill 的 userMsgs 或 {text,at,speaker}[]
 * @returns {Array<{text,quote,tags,focus,conf,originId,at}>}
 */
export function extractChatCandidates(messages, { max = 3 } = {}) {
  const out = []
  const seen = new Set()
  const list = (messages || []).map((m) => ({
    text: textOf(m).trim(),
    at: atOf(m),
    speaker: speakerOf(m),
    role: roleOf(m),
    replyTo: replyToOf(m),
  }))
  for (let i = 0; i < list.length; i += 1) {
    if (out.length >= max) break
    const cur = list[i]
    if (cur.role !== 'user' || cur.replyTo) continue
    const raw = cur.text
    if (raw.length < 4 || raw.length > 400) continue
    if (NOISE.test(raw)) continue
    const re = PROMISE.test(raw) ? PROMISE : REACTION.test(raw) ? REACTION : DEFER.test(raw) ? DEFER : null
    if (!re) continue
    // 短消息整条带走，别再把一句完整的话拆出半句；长消息才挑命中的那一句。
    const text = raw.length <= MAX_TEXT ? clipText(raw) : sentenceOf(raw, re)
    if (!text) continue
    const key = text.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    const tags = extractConcepts(text).map((x) => x.tag).slice(0, 3)
    out.push({
      text,
      quote: clipText(raw, 160),
      context: contextFor(list, i, text),
      tags,
      focus: tags[0] || '聊天',
      conf: 0.5,
      originId: hashOf(`${cur.at}|${cur.speaker}|${raw}`),
      at: cur.at,
    })
  }
  return out
}

export async function addChatMaterial(root, messages, { config = {}, now = new Date(), max = 3, log } = {}) {
  // beat 关着就不在后台攒会话素材；打开后从新消息开始攒。
  if (config?.enabled === false) return { ok: true, skipped: 'disabled', candidates: 0, added: 0, duplicate: 0 }
  const candidates = extractChatCandidates(messages, { max })
  let added = 0
  let duplicate = 0
  for (const c of candidates) {
    const r = await addMaterial(root, {
      ...c,
      source: 'chat',
      at: c.at || now.toISOString(),
    }, { config, now })
    if (r.ok && r.duplicate) duplicate += 1
    else if (r.ok) added += 1
  }
  if (added) log?.(`[whale] 会话素材 +${added}${duplicate ? ` · 重复 ${duplicate}` : ''}`)
  return { ok: true, candidates: candidates.length, added, duplicate }
}
