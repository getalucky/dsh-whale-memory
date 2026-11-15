/**
 * evalnote.js —— 负反馈记账（文档 12.7）
 *
 * 用户的「太好了 / 怎么又错了」是人格蒸馏最值钱的真实证据；以前只当普通消息。
 * 这里只认明确的评价句，落 audit/evals.jsonl，供人格候选与面板引用。
 * 不进 scopes、不进检索、不进画像，避免一句气话变成一条“偏好”。
 */

import { appendJsonl, paths } from './store.js'

const PRAISE = /(太好了|真棒|厉害|这[次下]?(?:就)?对了|就是这样|说得对|靠谱|有用|记住了)/
const CRITIC = /(又错了|说错了|不对[，,]?不是|不是这个|怎么又|别这样|别这么说|太啰嗦|吵死了|烦死|答非所问|跑题了)/

const CATEGORY = [
  [/(太长|啰嗦|简短|字数|废话)/, 'length'],
  [/(语气|态度|凶|冷|怼|嘴欠)/, 'tone'],
  [/(记错|忘了|不记得|记忆)/, 'memory'],
  [/(格式|排版|markdown|代码块)/, 'format'],
  [/(答非所问|跑题|没回答|没说到)/, 'relevance'],
]

export function detectEvaluation(text) {
  const s = String(text ?? '').trim()
  if (!s) return null
  const praise = PRAISE.test(s)
  const critic = CRITIC.test(s)
  if (!praise && !critic) return null
  // 一句话里又夸又骂时以批评为准：蒸馏人格时宁可少收一条，也别把批评读成认可。
  const polarity = critic ? 'fail' : 'ok'
  const category = CATEGORY.find(([re]) => re.test(s))?.[1] || ''
  return { polarity, category, quote: s.slice(0, 80) }
}

export function evalPath(root) {
  return `${paths(root).audit}/evals.jsonl`
}

/**
 * @param {{text:string, scope?:string, at?:string}} input
 * @returns {Promise<boolean>} 是否记了一条
 */
export async function noteEvaluation(root, { text, scope = '', at = new Date().toISOString() } = {}) {
  const hit = detectEvaluation(text)
  if (!hit) return false
  await appendJsonl(evalPath(root), {
    at,
    kind: 'feedback',
    polarity: hit.polarity,
    category: hit.category,
    quote: hit.quote,
    scope: String(scope || ''),
  }).catch(() => {})
  return true
}
