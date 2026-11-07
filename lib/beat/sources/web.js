/**
 * beat/sources/web.js —— 兴趣搜索（闲逛）
 *
 * 模型只负责“搜到什么、为什么值得说”，落盘由代码做。严格 JSON、URL 只认
 * http/https、解析失败就放弃——宁可这一跳空手，也不往素材库塞编出来的东西。
 */

import { addMaterial } from '../material.js'
import { pickFocus } from '../schedule.js'

const MAX_ITEMS = 4
const SEARCH_ROUNDS = '3–9'

export function wanderPrompt(focus, query, maxItems = MAX_ITEMS, { direct = false } = {}) {
  const ask = query || `${focus} 最近的新鲜事`
  if (direct) {
    return [
      `你在帮「大肥鱼」找下次聊天可以自然带出的素材。焦点：${focus}。`,
      `请联网检索：${ask}。最多留 ${maxItems} 条，只要真的新、具体、能接话的；不要旧闻、不要广告、不要重复。`,
      '只返回严格 JSON，不要解释、不要 markdown 代码块：',
      '{"items":[{"text":"一句话≤60字","url":"https://...","why":"为什么值得说","focus":"焦点"}]}',
      '每条必须有你实际打开过的 http/https URL；搜不到就返回 {"items":[]}，不要编。',
    ].join('\n')
  }
  return [
    `你在帮「大肥鱼」找下次聊天可以自然带出的素材。焦点：${focus}。`,
    `先用 web_search 搜 ${SEARCH_ROUNDS} 轮，查：${ask}。`,
    `最多留 ${maxItems} 条，只要真的新、具体、能接话的；不要旧闻、不要广告、不要重复。`,
    '只返回严格 JSON，不要解释、不要 markdown 代码块：',
    '{"items":[{"text":"一句话≤60字","url":"https://...","why":"为什么值得说","focus":"焦点"}]}',
    '每条必须有可访问的 http/https URL；没有 URL 的不要写。',
  ].join('\n')
}

function extractJson(text) {
  const s = String(text ?? '').trim()
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(s)
  const body = fence ? fence[1].trim() : s
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try { return JSON.parse(body.slice(start, end + 1)) } catch { return null }
}

function isHttpUrl(s) {
  try {
    const u = new URL(String(s))
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * 解析闲逛结果。坏行丢掉，整批坏返回 jsonOk=false；不抛。
 * @returns {{items:Array, jsonOk:boolean, badUrl:number}}
 */
export function parseWanderDetailed(text, { maxItems = MAX_ITEMS, focus = '' } = {}) {
  const parsed = extractJson(text)
  const rows = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.items) ? parsed.items : []
  const out = []
  const seen = new Set()
  let badUrl = 0
  for (const row of rows) {
    if (out.length >= Math.max(0, maxItems)) break
    if (!row || typeof row !== 'object') continue
    const url = String(row.url ?? row.refs?.[0] ?? '').trim()
    if (!isHttpUrl(url)) {
      badUrl += 1
      continue
    }
    const text = String(row.text ?? row.summary ?? row.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 100)
    if (text.length < 4) continue
    const key = `${url}|${text.toLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key)
    const tags = Array.isArray(row.tags) ? row.tags.map(String).slice(0, 4) : []
    const ttlDays = row.kind === 'news' || tags.includes('新闻')
      ? 3
      : row.kind === 'evergreen' || tags.includes('常青')
        ? 14
        : 7
    out.push({
      text,
      refs: [url],
      quote: String(row.why ?? '').slice(0, 160),
      focus: String(row.focus ?? focus ?? '').trim().slice(0, 40),
      conf: 0.4,
      tags,
      ttlDays,
    })
  }
  return { items: out, jsonOk: Boolean(parsed), badUrl }
}

export function parseWanderResponse(text, opts = {}) {
  return parseWanderDetailed(text, opts).items
}

/**
 * 跑一轮闲逛。agentTurn(prompt, label, timeoutMs) 由宿主接线；没有就返回 no-agent。
 * direct=true 时 prompt 改成「模型自己联网」，由调用方把 agentTurn 换成搜索模型直连。
 *
 * 文档 13.13：JSON 不合法重试一次，仍坏就整批丢弃；坏 URL 单条丢弃并记数。
 * @returns {Promise<{ok:boolean, why?:string, added?:number, items?:number, badUrl?:number}>}
 */
export async function wander({ root, config = {}, agentTurn, focus = '', query = '', direct = false, now = new Date(), log } = {}) {
  if (typeof agentTurn !== 'function') return { ok: false, why: 'no-agent' }
  const picked = focus || pickFocus(config.interests, '') || '生活'
  const prompt = wanderPrompt(picked, query, MAX_ITEMS, { direct })

  let parsed = { items: [], jsonOk: false, badUrl: 0 }
  let badUrl = 0
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let raw = ''
    try {
      raw = await agentTurn(prompt, 'wander', 240000)
    } catch (e) {
      log?.(`[whale] 闲逛失败 ${String(e?.message ?? e).slice(0, 120)}`)
      return { ok: false, why: 'turn-failed' }
    }
    if (!raw) {
      if (attempt === 0) continue // 空回复也重试一次
      return { ok: false, why: 'empty' }
    }
    parsed = parseWanderDetailed(raw, { maxItems: MAX_ITEMS, focus: picked })
    badUrl += parsed.badUrl
    if (parsed.jsonOk) break
    log?.(`[whale] 闲逛 JSON 不合法${attempt === 0 ? '，重试一次' : '，放弃'}`)
  }
  if (!parsed.jsonOk) return { ok: false, why: 'bad-json', badUrl }
  if (badUrl > 0) log?.(`[whale] 闲逛丢弃坏链接 ${badUrl} 条`)
  if (!parsed.items.length) return { ok: false, why: 'empty', badUrl }

  let added = 0
  for (const it of parsed.items) {
    const r = await addMaterial(root, {
      ...it,
      source: `web:${picked}`,
      at: now.toISOString(),
    }, { config, now })
    if (r.ok && !r.duplicate) added += 1
  }
  log?.(`[whale] 闲逛 ${picked} · ${direct ? '搜索模型' : '工具搜索'} · 搜到 ${parsed.items.length} 条 · 入库 ${added}`)
  return { ok: true, items: parsed.items.length, added, focus: picked, badUrl }
}
