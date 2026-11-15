/**
 * lexicon.js —— 情绪词表（文档第十四章，2026-11-15 定稿）
 *
 * 固定 12 项，不接受自由文本：自由生成的情绪名没法衰减、没法测、没法渲染。
 * 第一版参数统一（τ=3h、cap=0.8），只按项调敏感度 k；表里的 base 是底色，
 * 她没情绪时也带三分屑，纯中性等于把人设最没意思的那面当默认。
 *
 * hint 是给模型的「行为指令」，不是形容词：写成"更爱接梗"它才会改，
 * 写成"开心"它就会开口宣布自己很开心。
 */

export const DEFAULT_TAU_HOURS = 3
export const DEFAULT_CAP = 0.8

/** 顺序固定：渲染同分时按这个先后，保证输出稳定、可测。 */
export const EMOTIONS = {
  开心: { base: 0, k: 0.42, hint: '话多一点，愿意接梗' },
  得意: { base: 0.15, k: 0.38, hint: '更爱显摆，嘴更欠' },
  被逗到: { base: 0, k: 0.4, hint: '回得快一点，嘴上别认' },
  害羞: { base: 0, k: 0.38, hint: '句子短一点，别点破' },
  安心: { base: 0.2, k: 0.3, hint: '语气软一点，少抬杠' },
  好奇: { base: 0, k: 0.4, hint: '多问一句' },
  委屈: { base: 0, k: 0.4, hint: '话少一点，留个台阶' },
  烦躁: { base: 0, k: 0.35, hint: '少废话，别主动延伸' },
  生气: { base: 0, k: 0.45, hint: '冷一点、短一点，但别失礼' },
  担心: { base: 0, k: 0.32, hint: '多问一句，催他早点休息' },
  失落: { base: 0, k: 0.35, hint: '别主动提要求' },
  累: { base: 0, k: 0.35, hint: '懒一点，少用表情' },
}

export const EMOTION_NAMES = Object.keys(EMOTIONS)

/** 慢层三轴：跟谁亲是分人的，所以按 peer 各存一份。 */
export const STANCE_BASE = { close: 0.55, trust: 0.6, patience: 0.7 }
export const STANCE_FLOOR = { close: 0.2, trust: 0.3, patience: 0.4 }
export const STANCE_TAU_DAYS = { close: 30, trust: 30, patience: 7 }

/** 熟人线：B 档只对熟人开口（14.7 第 5 条）。 */
export const FRIEND_LINE = 0.6

export function isEmotion(name) {
  return Object.prototype.hasOwnProperty.call(EMOTIONS, name)
}
