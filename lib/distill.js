/**
 * distill.js —— 从 staging 里蒸馏出「值得记的」
 *
 * 主路径：配了 LLM 就让 distillMessages 抽（见 llm.js），它能认自由表述、
 * 能判断值不值得记。规则抽取（extractCandidates）退成兜底，管两件事：
 *   1. LLM 没开 / 失败 / 冷却中：全量跑规则，链路不断。
 *   2. LLM 成功：只补它没覆盖到的消息（按候选的 src 判断）；本地工程会话例外，
 *      路径、版本、端口这类硬事实正则比模型稳，照常双写。
 *
 * 写入顺序是「规则先、LLM 后」：addItem 合并时只在「新说法明显更长」才替换正文
 * （store.js），把 LLM 的完整表述放后面，才能升级规则截出来的残句，而不是
 * 让残句白给 LLM 那条加一次命中。
 *
 * 时间锚：LLM 候选带 src 就按那条消息的 at 锚；没有才退回会话最后一句。
 * 蒸馏后 staging 按水位清空，写审计。
 */

import { addItem, loadScope, saveScope, auditWrite, logLine, listScopes, withWriteLock, enforceCapacity } from './store.js'
import { tokens, UNIGRAM } from './recall.js'
import { addChatMaterial } from './beat/sources/chat.js'
import { loadConfig } from './beat/config.js'
import { sourceOfSession, loadSources } from './source.js'
import { buildGraph, saveGraph, loadTriples, mergeTriples, saveTriples } from './graph.js'
import { buildProfile, buildMembers } from './profile.js'
import { isLive } from './itemstate.js'
import { readStagingLines, consumeStaging, listStaging, lastActive, stripBridgeNote, quarantineStaging, pruneStaging, isBridgeScaffold, stripBridgeMarks } from './ingest.js'
import { resolveRelativeTime } from './time.js'
import { originFromMessage } from './origin.js'
import { llmReady, llmCoolingDown, markLlmFailure, distillMessages, extractGraphTriples, lastLlmError } from './llm.js'
import { capturePsych } from './secure/psych.js'

const IDLE_MS = 10 * 60 * 1000

/**
 * 预筛信号：这一轮有没有可能值得记的东西。
 * 没命中就不抽候选、不跑降维，直接记一条 write_skip 审计。
 * 目的不是准，是省——日常对话绝大多数轮次什么都没有。
 */
const SIGNAL = /记住|记一下|别忘了|帮我记|我叫|我住|我(?:最|比较|特别|很)?(?:喜欢|讨厌|不喜欢|爱|怕|习惯)|养了|下次|以后|回头|明天|下周|约定|说好|不是.{1,12}是|装在|目录是|地址|电话|生日/

/**
 * 本地干活会话（桌面/CLI/Web）的信号词。
 * 这些会话里值得记的不是「我喜欢吃鱼」，而是路径、版本、约定、以后怎么干。
 * 只对 local 分片启用，别拿工程词去筛 QQ 聊天。
 */
const WORK_SIGNAL = /记住|记一下|以后|统一|一律|约定|说好|决定|敲定|改用|改成|换成|不要用|别用|路径|目录|工作区|装在|安装在|版本|端口|依赖|脚本/

export function hasSignal(text, { work = false } = {}) {
  const t = String(text ?? '')
  return (work ? WORK_SIGNAL : SIGNAL).test(t) || (work && SIGNAL.test(t))
}

/** 这条消息为什么没进候选；空串表示"有信号"。 */
export function skipReason(text, opts = {}) {
  const t = String(text ?? '').trim()
  if (!t || t.length < 4) return 'too-short'
  // 「我叫你肉肉好吗」这种带语气词的反问/征求，本质上还是问句
  if (/(?:[？?]|吗|呢|好不好|行不行|对不对|是不是)[。~～!！\s]*$/.test(t)) return 'question'
  if (!hasSignal(t, opts)) return 'no-signal'
  if (!extractCandidates(t, opts).length) return 'no-candidate'
  return ''
}

/**
 * 半句检测：事件抽取是从时间词截到标点，句子本身可能就是残的。
 * 「回头看一眼的」「回头的余地」都是这么进库的——
 * 结尾挂着结构助词/介词，说明后面还有话，不该当成一条完整记忆。
 *
 * 2026-11-02 补：群里大量「以后我在群里找人」「以后谁欺负我」这种
 * 结尾是代词的短残句，原来一条都没拦住，15 条记忆里 10 条是同一句的碎片。
 * 判据收紧成「长度 ≤9 且通篇没有标点」——有逗号的说明本来就念完了一整口气，
 * 「以后别理他」这种 5 字完整句会误杀，但这类记忆价值低，比让残句进库划算。
 */
export function looksLikeFragment(text) {
  const t = String(text ?? '').trim()
  if (t.length < 5) return true
  if (/[的地得之和与跟把被对在是]$/.test(t)) return true
  if (/^[的了着过]/.test(t)) return true
  // 结尾是单字代词、整句又没有标点：多半是从「以后谁欺负我，我就……」截断的
  if (/[我你他她它]$/.test(t) && t.length <= 9 && !/[，。！？,.!?；;：:]/.test(t)) return true
  // 引号/括号没闭合：正文被切掉了一半
  if ((t.match(/[「『（(]/g) || []).length !== (t.match(/[」』）)]/g) || []).length) return true
  // 省略号结尾：后面还有话说
  if (/…{1,2}$|\.{3}$/.test(t)) return true
  return false
}

/** LLM 端点挂了就别每轮都等 8 秒，冷十分钟再用（冷却状态在 llm.js，设置页保存会清）。 */

/** 从一句用户发言里抽候选。返回 [{text, kind, conf}] */
export function extractCandidates(text, { work = false } = {}) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (!t || t.length < 4 || t.length > 300) return []
  const out = []

  const add = (s, kind, conf) => {
    const v = String(s ?? '').replace(/^[，。、\s]+|[，。、\s]+$/g, '').trim()
    if (v.length >= 4 && v.length <= 120) out.push({ text: v, kind, conf })
  }

  // 1. 明确要求记
  let m = t.match(/(?:记住|记一下|别忘了|帮我记着)[:：，,\s]*(.{4,120})/)
  if (m) add(m[1], 'fact', 0.85)

  // 2. 自我介绍
  const selfRules = [
    // 「我叫你肉肉」是在给别人起名，不是在自我介绍
    [/我叫(?!你|他|她|它)([^\s，。！？!?]{1,20})/, (x) => `名字叫${x}`, 'fact', 0.8],
    [/住在([^，。！？!?]{2,40})/, (x) => `住在${x}`, 'fact', 0.75],
    [/在([^，。！？!?]{2,30})(?:工作|上班|上学|读书)/, (x) => `在${x}工作`, 'fact', 0.7],
    [/养了([^，。！？!?]{1,30})/, (x) => `养了${x}`, 'fact', 0.7],
    [/(?:今年)?(\d{1,2})岁/, (x) => `今年${x}岁`, 'fact', 0.7],
  ]
  for (const [re, fmt, kind, conf] of selfRules) {
    const mm = t.match(re)
    if (mm) add(fmt(mm[1]), kind, conf)
  }

  // 3. 稳定偏好
  const prefRe = /我(?:最|比较|特别|很)?(喜欢|讨厌|不喜欢|爱|怕|习惯)([^，。！？!?]{2,50})/g
  let pm
  while ((pm = prefRe.exec(t))) {
    add(`${pm[1]}${pm[2]}`, 'pref', 0.65)
  }

  // 4. 约定 / 承诺
  // 「回头」是这组里唯一有歧义的：当名词（留个回头的余地）和当副词（回头看一眼的）
  // 都截不出完整计划，只认「回头我/咱/再/要/把」。其他时间词可以出现在主语后面
  // （「老爹明天8:30上班」），不能强求句首。
  //
  // 2026-11-02 修：原来字符类是 `[^，。！？!?；;]`，逗号也在排除里，
  // 「以后我在群里找人，就说杂口杂口」被腰斩成「以后我在群里找人」。
  // 群里一句话带好几个「以后」，全局匹配就切出一堆碎片（15 条里 10 条是碎块）。
  // 现在逗号不再断句，只认句末标点和换行。同一句里前一个匹配吃掉的范围
  // 后面不再重复抽，避免「以后A，以后B」被抽两遍。
  const promiseRe = /((?:下次|以后|回头(?:我|咱|再|要|把)|明天|后天|下周[一二三四五六日天]?)[^。！？!?；;\n]{2,60})/g
  let qm
  let lastEnd = -1
  while ((qm = promiseRe.exec(t))) {
    if (qm.index < lastEnd) continue
    if (looksLikeFragment(qm[1])) continue
    add(qm[1], 'event', 0.55)
    lastEnd = qm.index + qm[1].length
  }

  // 5. 本地干活的约定：以后怎么干、东西装哪、用什么版本
  // 只在 local 分片启用：这些词在 QQ 闲聊里到处都是，扔给私人记忆就是噪声。
  if (work) {
    const workRules = [
      [/(?:以后|今后)(?:都|一律|统一)?(?:用|走|按)([^，。！？!?；;\n]{2,50})/, (x) => `以后用${x}`, 'pref', 0.7],
      [/(?:以后|今后)(?:别|不要|不再)([^，。！？!?；;\n]{2,50})/, (x) => `以后不要${x}`, 'pref', 0.7],
      [/(?:统一|一律)(?:用|走|按)([^，。！？!?；;\n]{2,50})/, (x) => `统一用${x}`, 'pref', 0.65],
      [/(?:路径|目录|工作区)(?:是|在|为)[:：]?\s*([A-Za-z]:[\\/][^，。！？\n]{2,80})/, (x) => `路径是${x}`, 'fact', 0.8],
      [/(?:装在|安装在|放在|装到)([^，。！？\n]{2,60})/, (x) => `装在${x}`, 'fact', 0.7],
      [/(?:版本(?:是|为)?|用的是|使用)\s*([A-Za-z0-9._\-+/]{2,30})/, (x) => `用的是${x}`, 'fact', 0.7],
      [/(?:决定|约定|说好|敲定)([^，。！？\n]{2,60})/, (x) => `决定${x}`, 'event', 0.6],
      [/(?:不要|别)(?:再)?(?:用|动|改|删)([^，。！？\n]{2,50})/, (x) => `不要${x}`, 'pref', 0.65],
    ]
    for (const [re, fmt, kind, conf] of workRules) {
      const mm = t.match(re)
      if (!mm) continue
      // 半句检测只用于事件（路径、版本号本身可能很短，不能按长度卡）
      if (kind === 'event' && looksLikeFragment(mm[1])) continue
      add(fmt(mm[1]), kind, conf)
    }
  }

  // 去重、去掉纯问句
  const seen = new Set()
  return out.filter((c) => {
    if (/[？?]$/.test(c.text)) return false
    const k = c.text.replace(/\s+/g, '')
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

/**
 * 蒸馏一个 staging 会话。
 * @param {object} [opts]
 * @param {object} [opts.src] 覆盖来源（导入历史会话时用，staging 里的 sid 不是真实会话）
 * @param {string} [opts.sourcePrefix] 写入条目的 source 前缀；默认 session:xxx / llm:xxx
 * @param {boolean} [opts.skipExtras] 跳过会话素材与心理采集（导入历史时不能把旧情绪当现在）
 * @param {boolean} [opts.useLlm] 默认 true；导入工具默认关，免得一次跑掉几百次模型调用
 * @returns {Promise<{ok:boolean, scope?:string, added:number, why?:string}>}
 */
export async function distillSession(root, sid, {
  log, fetchImpl, src: srcOverride, sourcePrefix = '', skipExtras = false, useLlm = true,
} = {}) {
  const lines = await readStagingLines(root, sid)
  if (!lines.length) return { ok: false, added: 0, why: 'no staging' }

  const src = srcOverride || (await sourceOfSession(sid).catch(() => null))
  if (!src) {
    // 认不出来源：别每 5 分钟重试一辈子，也别偷偷删数据。
    // 绑定表读不出来时（可能正写到一半），只跳过、不搬，下轮再试。
    const cfg = await loadSources().catch(() => ({ ok: false }))
    if (!cfg.ok) return { ok: false, added: 0, why: 'source config unreadable' }
    const moved = await quarantineStaging(root, sid, 'unknown source').catch(() => false)
    if (moved) {
      await auditWrite(root, { kind: 'quarantine', session: sid, why: 'unknown source' }).catch(() => {})
      await logLine(root, `quarantine ${sid.slice(0, 22)} · 认不出来源，挪进 staging/orphan/`).catch(() => {})
    }
    return { ok: false, added: 0, why: moved ? 'quarantined' : 'unknown source' }
  }

  // 先把 staging 解析出来；LLM 调用放在锁外面（最长 8 秒，不能挡别的写入）
  const msgs = []
  for (const l of lines) {
    try { msgs.push(JSON.parse(l)) } catch { /* skip */ }
  }

  const out = await distillRecords(root, src, msgs, {
    log,
    fetchImpl,
    sessionId: sid,
    sourcePrefix,
    skipExtras,
    useLlm,
    // 水位断点：只划掉这一轮读到的前缀，蒸馏期间新进来的消息留给下一轮
    consume: () => consumeStaging(root, sid, lines),
  })
  if (out && 'fresh' in out) delete out.fresh
  return out
}

/** 'YYYY-MM-DD' 或 'YYYY-MM-DDTHH:mm' 是否已经早于现在（给导入历史过滤过期计划用）。 */
export function isPastMoment(abs, now = new Date()) {
  const s = String(abs ?? '')
  if (!s) return false
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const pad = (n) => String(n).padStart(2, '0')
    const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
    return s < today
  }
  const t = Date.parse(s)
  // 留一天缓冲：凌晨说「今天 8:30」在当天晚上导入不算过期
  return Number.isFinite(t) && t < now.getTime() - 24 * 60 * 60 * 1000
}

/**
 * 给模型看的旧记忆：只挑和这批消息有共同内容词的，最多 12 条。
 * 不把全库塞进去——查重靠的是「相关旧条目」，不是让模型读完整本账。
 */
function relatedExisting(items, userMsgs, limit = 12) {
  const text = (userMsgs || []).map(({ m }) => m.text).join(' ')
  const chat = new Set(tokens(text).filter((t) => !t.startsWith(UNIGRAM)))
  if (!chat.size) return []
  return (items || [])
    .filter((it) => it && it.id && isLive(it, { expiredDead: false }))
    .map((it) => {
      const own = new Set(tokens(`${it.text || ''} ${it.scene || ''} ${(it.tags || []).join(' ')}`)
        .filter((t) => !t.startsWith(UNIGRAM)))
      let inter = 0
      for (const g of own) if (chat.has(g)) inter += 1
      return { it, inter }
    })
    .filter((x) => x.inter >= 2)
    .sort((a, b) => b.inter - a.inter || String(b.it.lastHit || b.it.created || '').localeCompare(String(a.it.lastHit || a.it.created || '')))
    .slice(0, limit)
    .map((x) => ({ id: x.it.id, kind: x.it.kind, text: x.it.text, summary: x.it.summary, scene: x.it.scene }))
}

/** 规则路径没有模型写场景，就拿原话前后两条真实消息兜底。 */
function sceneFor(userMsgs, idx) {
  if (!(idx >= 0) || !userMsgs?.[idx]) return ''
  const trim = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, 60)
  const before = idx > 0 ? trim(stripBridgeMarks(userMsgs[idx - 1].m.text)) : ''
  const after = idx < userMsgs.length - 1 ? trim(stripBridgeMarks(userMsgs[idx + 1].m.text)) : ''
  return [
    before ? `前面在聊「${before}」` : '',
    after ? `后面接着说「${after}」` : '',
  ].filter(Boolean).join('；').slice(0, 200)
}

/** 两条候选共享多少个内容 bigram（不算单字）。 */
function sharedBigrams(a, b) {
  const A = new Set(tokens(a).filter((t) => !t.startsWith(UNIGRAM)))
  const B = new Set(tokens(b).filter((t) => !t.startsWith(UNIGRAM)))
  let n = 0
  for (const t of A) if (B.has(t)) n += 1
  return n
}

/**
 * 同一批候选里的合并兜底：模型已经把两句话拆开时，靠提示词不一定收得住。
 * 同类型、共享 ≥6 个内容 bigram（同一件事换个说法/补细节）就并成一条；
 * 文字用「；」接起来，信息不丢，只是不再各存一条。
 */
function consolidateCandidates(cands, maxLen = 240) {
  const out = []
  for (const c of cands || []) {
    const hit = out.find((o) => o.kind === c.kind
      && o.text !== c.text
      && sharedBigrams(o.text, c.text) >= 6)
    if (!hit) {
      out.push({ ...c })
      continue
    }
    const join = (a, b) => [...new Set([a, b].map((x) => String(x || '').trim()).filter(Boolean))].join('；')
    hit.text = join(hit.text, c.text).slice(0, maxLen)
    hit.scene = join(hit.scene, c.scene).slice(0, 200)
    hit.quote = join(hit.quote, c.quote).slice(0, 240)
    hit.conf = Math.max(Number(hit.conf) || 0.6, Number(c.conf) || 0.6)
    hit.mergeId = hit.mergeId || c.mergeId || ''
    if (hit.src < 0 || (c.src >= 0 && c.src < hit.src)) hit.src = c.src
  }
  return out
}

/**
 * 把一批 staging 形状的消息蒸馏进 src 对应的分片。
 * 实时链路（distillSession）和历史导入（tools/import-history.mjs）走同一个核，
 * 过滤、时间锚定、合并、容量门、审计只有一份实现。
 *
 * @param {object} src sourceOfSession 形状的来源（kind/id/label/owner）
 * @param {object[]} msgs 形状同 staging 行：{at, role:'user'|'her', text, speaker, qq}
 * @param {object} [opts]
 * @param {string} [opts.sessionId] 审计/日志里的会话 id
 * @param {string|null} [opts.originSessionId] 原文指针用的会话 id；传空串表示不写指针
 * @param {string} [opts.sourcePrefix] 非空时统一写进条目的 source（导入用 import:<run>）
 * @param {boolean} [opts.skipExtras] 跳过会话素材与心理采集
 * @param {boolean} [opts.useLlm] 是否允许调模型
 * @param {boolean} [opts.dropPastEvents] 丢掉已经过期的计划类事件（导入历史默认开）
 * @param {number} [opts.maxNew] 本次最多新增多少条；0 = 不限
 * @param {() => Promise<number>} [opts.consume] 蒸馏成功后消费 staging 水位
 */
export async function distillRecords(root, src, msgs, {
  log, fetchImpl, sessionId = '', originSessionId = null, sourcePrefix = '', skipExtras = false, useLlm = true,
  dropPastEvents = false, maxNew = 0, consume = null, keepFresh = false,
} = {}) {
  if (!src) return { ok: false, added: 0, why: 'unknown source' }
  const list = Array.isArray(msgs) ? msgs : []
  if (!list.length) return { ok: false, added: 0, why: 'no messages' }
  const sid = String(sessionId || src.session || src.id || '')
  const originSid = originSessionId === null ? sid : String(originSessionId || '')
  const originFor = (m) => originFromMessage(m, originSid)

  const owner = src?.owner || { qq: '', name: '爹' }
  const ownerQQ = String(owner.qq || '').trim()
  const ownerName = owner.name || '爹'
  // 拥有者是谁只认 QQ：昵称可以被任何人改成「爹」，但桥接签名里的号码改不了。
  // 拿不到号码时才退回称呼比对（至少别让没配拥有者QQ的库完全失明）。
  const isOwnerMsg = (m) => {
    const qq = String(m?.qq || '').trim()
    if (ownerQQ && qq) return qq === ownerQQ
    return String(m?.speaker || '').trim() === ownerName
  }

  // 用户消息单独列一遍并保留原下标：LLM 返回的 src 要能找回当时的时间戳和发言人
  // 桥接脚手架（身份名单、前情标题）不是人说的，老 staging 里还留着，喂给模型只会
  // 让它拿名单里的名字去补对话里的「你」——2026-11-04 的错位就是这么来的。
  // reply_to 是投递后的第一条回复，属于反馈信号，不是用户知识。
  const userMsgs = list
    .map((m, i) => ({ m, i }))
    .filter(({ m }) => m.role === 'user' && m.text && !isBridgeScaffold(m.text) && !m.reply_to)
  let llmCands = null
  // 没有真人消息就别发请求，也别把「这次没东西可蒸」记成端点失败，
  // 否则一次空转会把 LLM 冷却十分钟，后面真有消息也赶不上。
  if (userMsgs.length && useLlm && llmReady() && !llmCoolingDown()) {
    // 先读一份旧记忆快照，让模型自己判断「这是不是库里已经有的那条」。
    // 只给相关条目，避免把整本账塞进提示词；真正的合并仍在写锁里做。
    const snap = await loadScope(root, src.kind, src.id).catch(() => null)
    const related = relatedExisting(snap?.items || [], userMsgs)
    llmCands = await distillMessages(
      userMsgs.map(({ m }) => ({
        at: m.at,
        speaker: m.speaker,
        qq: m.qq,
        text: stripBridgeMarks(m.text),
        owner: isOwnerMsg(m),
      })),
      { fetchImpl, group: src.kind === 'group', ownerName, existing: related },
    ).catch(() => null)
    if (llmCands) {
      // src 是 userMsgs 里的位置，换成那条消息本身，后面按它锚时间和发言人
      llmCands = llmCands.map((c) => {
        const from = c.src >= 0 ? userMsgs[c.src] : null
        return {
          ...c,
          at: from?.m.at || '',
          // 模型认准的发言人优先；它没报（或报了对不上的名字）才退回 src 那条消息
          speaker: c.speaker || from?.m.speaker || '',
          msgIdx: from ? c.src : -1,
          // 原话留一份：模型改写错了还能对着原文查，别又是一条无凭无据的记忆
          quote: String(from?.m.text ?? '').slice(0, 200),
          scene: c.scene || sceneFor(userMsgs, c.src),
          origin: originFor(from?.m),
        }
      })
      // 模型把同一条偏好拆成两句时，这里再收一次口
      llmCands = consolidateCandidates(llmCands)
    } else {
      markLlmFailure()
      log?.(`[whale] LLM 蒸馏失败：${lastLlmError() || '未知原因'}，回退规则（10 分钟内不再试）`)
    }
  }

  // 读 → 改 → 重建图谱 → 落盘：整段在写队列里，别的写入插不进来
  const result = await withWriteLock(async () => {
    const scope = await loadScope(root, src.kind, src.id)
    const lastAt = [...list].reverse().find((m) => m.role === 'user' && m.at)?.at

    let added = 0
    let merged = 0
    let skipped = 0
    const fresh = []
    const skipWhy = {}
    const record = (c, at, source, origin = null, quote = '') => {
      // 相对时间按「这条消息说话的时刻」锚，不按蒸馏时刻——
      // 空闲十分钟后才蒸，用 now 会让「明天」错一天。
      const rt = resolveRelativeTime(c.text, at || new Date().toISOString())
      // 历史导入：几个月前的「明天交作业」不是待办，别把过期计划当现在的事实
      if (dropPastEvents && c.kind === 'event' && rt?.abs && isPastMoment(rt.abs)) {
        skipped += 1
        skipWhy['past-event'] = (skipWhy['past-event'] || 0) + 1
        return
      }
      if (maxNew > 0 && added >= maxNew) {
        skipped += 1
        skipWhy['import-budget'] = (skipWhy['import-budget'] || 0) + 1
        return
      }
      const before = scope.items.length
      const it = addItem(scope, {
        ...c,
        sourceQuote: c.quote || quote || '',
        scene: c.scene || '',
        mergeInto: c.mergeId || '',
        atAbs: rt?.abs ?? '',
        observedAt: at || '',
        speaker: c.speaker || '',
        source,
        origin,
      })
      // addItem 命中合并时也返回条目，别把「又提了一次」算成「新记了一条」
      if (!it) return
      if (scope.items.length > before) {
        added += 1
        fresh.push({ id: it.id, text: it.text })
      } else merged += 1
    }

    // 规则先写。LLM 已经抽过这条消息就不再按句式抽一遍；
    // 本地工程会话例外：路径、版本、端口这类硬事实正则比模型稳，值得双写。
    const work = src.kind === 'local'
    const ruleSource = sourcePrefix || `session:${sid.slice(0, 18)}`
    const llmSource = sourcePrefix || `llm:${sid.slice(0, 14)}`
    const covered = new Set((llmCands || []).map((c) => c.msgIdx).filter((i) => i >= 0))
    for (const [ui, { m }] of userMsgs.entries()) {
      if (maxNew > 0 && added >= maxNew) {
        skipped += 1
        skipWhy['import-budget'] = (skipWhy['import-budget'] || 0) + 1
        continue
      }
      if (!work && covered.has(ui)) continue
      const text = stripBridgeNote(m.text)
      const reason = skipReason(text, { work })
      if (reason) {
        skipped += 1
        skipWhy[reason] = (skipWhy[reason] || 0) + 1
        continue
      }
      for (const c of extractCandidates(text, { work })) {
        // 本地会话没有「谁说的」这回事，别把昵称位留成空的怪样子
        record({
          ...c,
          speaker: work ? '' : (m.speaker || ''),
          scene: sceneFor(userMsgs, ui),
          quote: text.slice(0, 200),
        }, m.at, ruleSource, originFor(m), text)
      }
    }

    // LLM 后写：同一件事以模型的完整表述为准，靠「更长就替换」升级规则那条
    for (const c of llmCands || []) record(c, c.at || lastAt, llmSource, c.origin || null)

    // 容量门：超限的旧条目进 archive/，别让分片无限长
    const dropped = await enforceCapacity(root, scope)

    if (added > 0 || dropped > 0) {
      // 先按「别的分片 + 本分片新内容」重建图谱，再拿它算画像，最后只写一次盘
      const others = (await listScopes(root).catch(() => [])).filter((s) => s.scope !== scope.scope)
      const g = buildGraph([...others, scope], await loadTriples(root))
      scope.profile = buildProfile(scope, g)
      scope.members = buildMembers(scope)
      await saveScope(root, scope)
      await saveGraph(root, g)
      await auditWrite(root, { kind: 'distill', scope: scope.scope, session: sid, added, merged, dropped, consumed: list.length, total: scope.items.length })
      if (skipped) await auditWrite(root, { kind: 'write_skip', scope: scope.scope, session: sid, skipped, reasons: skipWhy })
      await logLine(root, `distill ${scope.scope} +${added}${merged ? ` ~${merged}` : ''}${dropped ? ` -${dropped}` : ''} (total ${scope.items.length}) · 画像「${scope.profile.summary}」`)
    } else if (merged > 0) {
      // 没有新条目，但命中数/置信度变了，也该落盘——画像里的「最近」跟着走
      scope.members = buildMembers(scope)
      await saveScope(root, scope)
    }
    if (skipped && !added && !dropped) {
      await auditWrite(root, { kind: 'write_skip', scope: scope.scope, session: sid, skipped, reasons: skipWhy }).catch(() => {})
    }
    const consumed = consume ? await consume() : list.length
    return { ok: true, scope: scope.scope, added, merged, skipped, consumed, fresh, budgetHit: maxNew > 0 && added >= maxNew }
  })

  // 图谱补抽：新条目再过一遍模型，三元组单独落盘；放在写锁外面，
  // 别让一次几十秒的模型调用挡住别的写入。失败只记日志，不影响蒸馏结果。
  const fresh = Array.isArray(result?.fresh) ? result.fresh : []
  if (result?.ok && fresh.length && useLlm && llmReady() && !llmCoolingDown()) {
    const batch = fresh.slice(0, 16)
    const triples = await extractGraphTriples(batch, { fetchImpl }).catch(() => null)
    if (triples) {
      const got = new Set(triples.map((t) => t.item))
      const incoming = [
        ...triples,
        ...batch.filter((x) => !got.has(x.id)).map((x) => ({ item: x.id, checked: true, at: new Date().toISOString() })),
      ]
      try {
        await withWriteLock(async () => {
          const rows = mergeTriples(await loadTriples(root), incoming)
          await saveTriples(root, rows)
          const all = await listScopes(root).catch(() => [])
          await saveGraph(root, buildGraph(all, rows))
        })
      } catch { /* 图谱写盘失败不影响蒸馏结果 */ }
      log?.(`[whale] 图谱补抽 ${batch.length} 条 → ${triples.length} 个关系${fresh.length > batch.length ? `（剩 ${fresh.length - batch.length} 条等回填）` : ''}`)
    } else {
      log?.(`[whale] 图谱补抽失败：${lastLlmError() || '未知原因'}`)
    }
  }
  if (result && !keepFresh && 'fresh' in result) delete result.fresh
  if (skipExtras) return result

  // 会话素材要连同她上一句一起给，否则「以后跟我吧」这种单句剪出来没人看得懂。
  const chatMsgs = list.filter((m) => (
    m.role === 'her'
      ? Boolean(m.text)
      : m.role === 'user' && m.text && !isBridgeScaffold(m.text) && !m.reply_to
  ))
  await addChatMaterial(root, chatMsgs, { config: await loadConfig(root).catch(() => ({})), log }).catch(() => {})
  // 群里说话的不一定是本人，心理自述只从私聊/本地会话收。
  if (src.kind !== 'group' && src.kind !== 'public') {
    await capturePsych(root, userMsgs.map(({ m }) => ({
      text: stripBridgeMarks(m.text),
      at: m.at,
    }))).catch(() => {})
  }
  return result
}

/**
 * 扫描所有 staging，空闲够久的就蒸馏。
 * 并发只在 LLM 等待上有收益（写盘由 withWriteLock 串行），限 3 是防端点被自己打满。
 */
export async function distillIdle(root, { idleMs = IDLE_MS, log, concurrency = 3 } = {}) {
  const sids = await listStaging(root)
  const now = Date.now()
  const todo = []
  for (const sid of sids) {
    const lines = await readStagingLines(root, sid)
    if (!lines.length) {
      await pruneStaging(root, sid).catch(() => {})
      continue
    }
    let lastAt = 0
    try { lastAt = Date.parse(JSON.parse(lines[lines.length - 1]).at) || 0 } catch { /* ignore */ }
    // 当前活跃会话还在说话就不动它
    if (sid === lastActive.sessionId && now - lastActive.at < idleMs) continue
    if (now - lastAt < idleMs) continue
    todo.push(sid)
  }

  let done = 0
  let cursor = 0
  const worker = async () => {
    while (cursor < todo.length) {
      const sid = todo[cursor]
      cursor += 1
      const r = await distillSession(root, sid, { log }).catch((e) => ({ ok: false, added: 0, why: String(e?.message ?? e) }))
      if (r.ok) done += 1
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, todo.length) }, worker))
  return { done }
}

/** 启动蒸馏循环。 */
export function startDistillLoop({ root, log, idleMs = IDLE_MS, everyMs = 5 * 60 * 1000 } = {}) {
  let timer = null
  const tick = async () => {
    try {
      const r = await distillIdle(root, { idleMs, log })
      if (r.done) log?.(`[whale] 蒸馏完成 ${r.done} 个会话`)
    } catch (e) {
      log?.(`[whale] 蒸馏失败 ${String(e?.message ?? e).slice(0, 160)}`)
    }
  }
  timer = setInterval(tick, everyMs)
  timer.unref?.()
  return {
    dispose() {
      if (timer) clearInterval(timer)
      timer = null
    },
    tick,
  }
}