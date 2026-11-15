/**
 * events.js —— 规则快路：零 LLM，入站消息一进来就打分
 *
 * 文档 14.5：规则负责"这一轮的语气当场变"，模型那一路只做回填。
 * 规则宁可窄，不可宽：把玩笑当嘲讽，比漏掉一次被夸贵得多。
 * 单条事件的强度一律 ≤0.5，剩下的交给冲量的饱和曲线和习惯化。
 */

/** 一条消息最多贡献这么多；再多就该靠累积，不是靠一句话。 */
const MAX_I = 0.5

const RULES = [
  {
    id: 'praise',
    re: /(厉害|好棒|真棒|太强|很强|牛啊|聪明|可爱|喜欢你|爱你|乖巧|优秀)/,
    moods: { 得意: 0.3, 害羞: 0.15 },
    stance: { close: 0.01 },
  },
  {
    id: 'thanks',
    re: /(谢谢|多谢|感谢|辛苦你了|辛苦了)/,
    moods: { 安心: 0.2 },
    stance: { close: 0.005 },
  },
  {
    id: 'sorry',
    re: /(对不起|抱歉|是我错|我错了|原谅我)/,
    moods: { 安心: 0.25, 委屈: -0.08 },
    stance: { trust: 0.01 },
  },
  {
    id: 'affection',
    re: /(抱抱|贴贴|摸摸头|摸摸|亲亲|么么|蹭蹭)/,
    moods: { 害羞: 0.3, 开心: 0.2 },
    stance: { close: 0.02 },
  },
  {
    id: 'abuse',
    re: /(你真笨|真笨|傻[逼比]|太蠢|废物|给我滚|闭嘴|垃圾|烦死了|讨厌你)/,
    moods: { 生气: 0.35, 委屈: 0.25 },
    stance: { close: -0.03, patience: -0.05 },
  },
  {
    id: 'correct',
    re: /(不对|你错了|不是这样|搞错了|理解错|没听懂)/,
    moods: { 委屈: 0.15, 烦躁: 0.1 },
  },
  {
    id: 'goodnews',
    re: /(考上了|过了|成功了|搞定了|升职|加薪|发工资|中奖|赢了)/,
    moods: { 开心: 0.3 },
  },
  {
    id: 'userlow',
    re: /(难受|不开心|烦死|累死|崩溃|想哭|压力好大|emo了|失眠)/,
    moods: { 担心: 0.3 },
    stance: { trust: 0.01 },
  },
  {
    id: 'tease',
    re: /(哈哈哈哈|哈哈哈|嘿嘿|笑死|绷不住|乐死)/,
    moods: { 被逗到: 0.2 },
  },
  {
    id: 'otherbot',
    re: /(别的\s*(?:ai|AI|Ai|机器人|助手)|豆包|kimi|chatgpt|gpt|claude|文心一言)/,
    moods: { 委屈: 0.2, 烦躁: 0.1 },
    stance: { close: -0.01 },
  },
  {
    id: 'push',
    re: /(快点|赶紧|怎么还没|别磨蹭|催你)/,
    moods: { 烦躁: 0.2 },
  },
  {
    id: 'night',
    re: /./,
    // 凌晨还在聊：不是聊出来的情绪，是身体状态
    guard: ({ hour }) => hour >= 1 && hour < 5,
    moods: { 累: 0.2 },
  },
]

/**
 * 读一条用户消息，出一组情绪事件。
 * @param {{text:string, at?:number, hour?:number, gapMs?:number}} ctx
 * @returns {{kind:string, i:number, why:string}[]}
 */
export function readEvents({ text, hour, gapMs } = {}) {
  const body = String(text ?? '')
  if (!body.trim()) return []
  const h = Number.isFinite(Number(hour)) ? Number(hour) : new Date().getHours()
  const out = []
  const seen = new Set()

  // 久别：超过 12 小时没说话又来找她。比任何关键词都可靠。
  if (Number(gapMs) > 12 * 3600 * 1000) {
    out.push({ kind: '开心', i: 0.2, why: 'gap' })
    seen.add('开心')
  }

  for (const rule of RULES) {
    if (typeof rule.guard === 'function' && !rule.guard({ hour: h })) continue
    if (!rule.re.test(body)) continue
    for (const [kind, i] of Object.entries(rule.moods)) {
      // 同一条消息里同一个分量只加一次，取绝对值大的那次
      if (seen.has(kind) && i > 0) continue
      seen.add(kind)
      out.push({ kind, i: Math.max(-MAX_I, Math.min(MAX_I, i)), why: rule.id })
    }
  }
  return out
}

/** 事件带出来的 stance 微调，和情绪分开算：一次事件只动千分位。 */
export function stanceDeltas(text, hour) {
  const body = String(text ?? '')
  const out = {}
  for (const rule of RULES) {
    if (typeof rule.guard === 'function' && !rule.guard({ hour: Number(hour) })) continue
    if (!rule.stance) continue
    if (!rule.re.test(body)) continue
    for (const [axis, d] of Object.entries(rule.stance)) {
      out[axis] = (out[axis] || 0) + d
    }
  }
  return out
}
