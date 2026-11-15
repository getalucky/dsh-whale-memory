/**
 * replybudget.js —— 单轮字数预算（文档 12.7）
 *
 * 规则段负责“让它短”，这里负责“留证据”：她的回复超了预算就记一行审计，
 * 不改写、不拦截。字数口径按可见字符算，去掉 QQ 块标记后再数。
 */

export const REPLY_LIMIT = { group: 15, private: 30, local: 0 }

export function replyLimit(kind) {
  return Number(REPLY_LIMIT[String(kind || '')] ?? 0) || 0
}

/** 去掉桥接标记后的可见字数。 */
export function visibleChars(text) {
  const s = String(text ?? '')
    .replace(/\[\/?QQ\]/gi, '')
    .replace(/\[表情[^\]]*\]/g, '')
    .replace(/\[图片[^\]]*\]/g, '')
    .trim()
  return [...s].length
}

export function checkReplyBudget(kind, text) {
  const limit = replyLimit(kind)
  const chars = visibleChars(text)
  if (!limit || !chars) return { ok: true, chars, limit }
  return { ok: chars <= limit, chars, limit, over: Math.max(0, chars - limit) }
}
