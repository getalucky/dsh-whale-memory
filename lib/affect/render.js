/**
 * render.js —— 把状态渲染成注入里那一行（纯函数，可测）
 *
 * 文档 14.6：
 *   · 只注档位，不注数值；最多两个分量
 *   · 写成行为指令，不写成"我很烦"，否则模型会当场表演
 *   · ≤90 字、一行；内容不变就不该重画（签名由 signature 负责）
 */

import { EMOTIONS, EMOTION_NAMES, FRIEND_LINE } from './lexicon.js'
import { stanceOf } from './state.js'

/** 0=没有 1=轻 2=中 3=明显。阈值低是因为底色本来就有 0.15/0.2。 */
export function bucketOf(value) {
  const v = Number(value) || 0
  if (v >= 0.65) return 3
  if (v >= 0.35) return 2
  if (v > 0.1) return 1
  return 0
}

const LABEL = { 1: '轻', 2: '中', 3: '明显' }
const MAX_CHARS = 90

/** 当前档位的一句话，够稳、够短，拿去当签名用。 */
export function stanceWord(snap, peer) {
  const s = stanceOf(snap, peer)
  if (s.patience < 0.4) return '有点僵'
  if (s.close >= 0.65) return '熟'
  if (s.close <= 0.35) return '生'
  return '平常'
}

/** 签名：档位 + stance 一个词。数值变化不到跨档就不该改注入。 */
export function signature(snap, peer) {
  const bits = EMOTION_NAMES.map((n) => `${n}${bucketOf(snap.mood[n])}`)
  return `${bits.join(',')}|${stanceWord(snap, peer)}`
}

/**
 * 渲染注入行。
 * @param {object} snap snapshot() 的结果
 * @param {string} [peer] 当前聊天对象的 scope id
 */
export function renderLine(snap, peer) {
  const ranked = EMOTION_NAMES
    .map((name) => {
      const value = Number(snap?.mood?.[name]) || 0
      // 排序看"离底色多远"，不看绝对值：底色 0.2 的安心不该压过刚冒头的 0.15 委屈
      return { name, value, lift: value - (EMOTIONS[name].base || 0), bucket: bucketOf(value) }
    })
    .filter((x) => x.bucket > 0)
    .sort((a, b) => (b.bucket - a.bucket) || (b.lift - a.lift) || (b.value - a.value))
    .slice(0, 2)

  const word = stanceWord(snap, peer || firstPeer(snap))
  if (!ranked.length) {
    return `【此刻】${word}。该怎么答就怎么答；不要说出心情，也不要拿它当理由。`
  }

  const parts = ranked.map((x) => `${x.name}（${LABEL[x.bucket]}）`).join('·')
  const hints = [...new Set(ranked.map((x) => EMOTIONS[x.name].hint))]
  // 熟人可以冲一句：这是 14.7「B 档只对熟人、最多一句」的落地口子
  if (word === '熟') hints.push('可以冲他一句，但只一句')

  let line = `【此刻】${parts}｜${word}。${hints.join('；')}。不要说出心情，也不要拿它当理由。`
  if (line.length > MAX_CHARS && hints.length > 1) {
    line = `【此刻】${parts}｜${word}。${hints[0]}。不要说出心情，也不要拿它当理由。`
  }
  return line.slice(0, MAX_CHARS + 10)
}

function firstPeer(snap) {
  const keys = Object.keys(snap?.stance || {})
  return keys.length === 1 ? keys[0] : ''
}

export { FRIEND_LINE, MAX_CHARS }
