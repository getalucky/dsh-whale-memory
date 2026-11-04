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
import { sourceOfSession, loadSources } from './source.js'
import { buildGraph, saveGraph } from './graph.js'
import { buildProfile, buildMembers } from './profile.js'
import { readStagingLines, consumeStaging, listStaging, lastActive, stripBridgeNote, quarantineStaging, isBridgeScaffold, stripBridgeMarks } from './ingest.js'
import { resolveRelativeTime } from './time.js'
import { llmReady, llmCoolingDown, markLlmFailure, distillMessages, lastLlmError } from './llm.js'

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
 * 蒸馏一个会话。
 * @returns {Promise<{ok:boolean, scope?:string, added:number, why?:string}>}
 */
export async function distillSession(root, sid, { log, fetchImpl } = {}) {
  const lines = await readStagingLines(root, sid)
  if (!lines.length) return { ok: false, added: 0, why: 'no staging' }

  const src = (await sourceOfSession(sid).catch(() => null))
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
  // 用户消息单独列一遍并保留原下标：LLM 返回的 src 要能找回当时的时间戳和发言人
  // 桥接脚手架（身份名单、前情标题）不是人说的，老 staging 里还留着，喂给模型只会
  // 让它拿名单里的名字去补对话里的「你」——2026-11-04 的错位就是这么来的。
  const userMsgs = msgs
    .map((m, i) => ({ m, i }))
    .filter(({ m }) => m.role === 'user' && m.text && !isBridgeScaffold(m.text))
  let llmCands = null
  if (llmReady() && !llmCoolingDown()) {
    llmCands = await distillMessages(
      userMsgs.map(({ m }) => ({ at: m.at, speaker: m.speaker, text: stripBridgeMarks(m.text) })),
      { fetchImpl },
    ).catch(() => null)
    if (llmCands) {
      // src 是 userMsgs 里的位置，换成那条消息本身，后面按它锚时间和发言人
      llmCands = llmCands.map((c) => {
        const src = c.src >= 0 ? userMsgs[c.src] : null
        return {
          ...c,
          at: src?.m.at || '',
          speaker: src?.m.speaker || '',
          msgIdx: src ? c.src : -1,
          // 原话留一份：模型改写错了还能对着原文查，别又是一条无凭无据的记忆
          quote: String(src?.m.text ?? '').slice(0, 200),
        }
      })
    } else {
      markLlmFailure()
      log?.(`[whale] LLM 蒸馏失败：${lastLlmError() || '未知原因'}，回退规则（10 分钟内不再试）`)
    }
  }

  // 读 → 改 → 重建图谱 → 落盘：整段在写队列里，别的写入插不进来
  return withWriteLock(async () => {
    const scope = await loadScope(root, src.kind, src.id)
    const lastAt = [...msgs].reverse().find((m) => m.role === 'user' && m.at)?.at

    let added = 0
    let merged = 0
    let skipped = 0
    const skipWhy = {}
    const record = (c, at, source) => {
      // 相对时间按「这条消息说话的时刻」锚，不按蒸馏时刻——
      // 空闲十分钟后才蒸，用 now 会让「明天」错一天。
      const rt = resolveRelativeTime(c.text, at || new Date().toISOString())
      const before = scope.items.length
      const it = addItem(scope, {
        ...c,
        sourceQuote: c.quote || '',
        atAbs: rt?.abs ?? '',
        observedAt: at || '',
        speaker: c.speaker || '',
        source,
      })
      // addItem 命中合并时也返回条目，别把「又提了一次」算成「新记了一条」
      if (!it) return
      if (scope.items.length > before) added += 1
      else merged += 1
    }

    // 规则先写。LLM 已经抽过这条消息就不再按句式抽一遍；
    // 本地工程会话例外：路径、版本、端口这类硬事实正则比模型稳，值得双写。
    const work = src.kind === 'local'
    const covered = new Set((llmCands || []).map((c) => c.msgIdx).filter((i) => i >= 0))
    for (const [ui, { m }] of userMsgs.entries()) {
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
        record({ ...c, speaker: work ? '' : (m.speaker || '') }, m.at, `session:${sid.slice(0, 18)}`)
      }
    }

    // LLM 后写：同一件事以模型的完整表述为准，靠「更长就替换」升级规则那条
    for (const c of llmCands || []) record(c, c.at || lastAt, `llm:${sid.slice(0, 14)}`)

    // 容量门：超限的旧条目进 archive/，别让分片无限长
    const dropped = await enforceCapacity(root, scope)

    if (added > 0 || dropped > 0) {
      // 先按「别的分片 + 本分片新内容」重建图谱，再拿它算画像，最后只写一次盘
      const others = (await listScopes(root).catch(() => [])).filter((s) => s.scope !== scope.scope)
      const g = buildGraph([...others, scope])
      scope.profile = buildProfile(scope, g)
      scope.members = buildMembers(scope)
      await saveScope(root, scope)
      await saveGraph(root, g)
      await auditWrite(root, { kind: 'distill', scope: scope.scope, session: sid, added, merged, dropped, consumed: lines.length, total: scope.items.length })
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
    // 水位断点：只划掉这一轮读到的前缀，蒸馏期间新进来的消息留给下一轮
    const consumed = await consumeStaging(root, sid, lines)
    return { ok: true, scope: scope.scope, added, merged, skipped, consumed }
  })
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
    if (!lines.length) continue
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