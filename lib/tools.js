/**
 * tools.js —— 给她的记忆工具
 *
 * memory_recall：找记忆（按关键词，跨全部分片或限定分片）
 * profile_show：看她现在记得这个人/这个群的画像
 * memory_save：手动记一条（她判断值得记的时候用）
 * memory_forget：记错了删一条（删 = 归档，能翻回来）
 *
 * 宿主规则（踩过）：每个工具必须声明 output: { schema, render }，
 * render 返回 ContentBlock 数组、签名 (args, value)；只写顶层 render 会注册失败：
 *   tool "xxx" must declare output { schema, render, presentationMeta? }
 *
 * 工具 execute 的第二个参数 exec 带 agent，能直接认出「这次调用属于哪个会话」。
 * 老宿主 / 内部调用没有 exec 时才退回 ingest 维护的「最近活跃会话」，
 * 而且必须校验时效：私聊和群可能同时在说话，拿一条十分钟前的活跃记录去写，
 * 就是把群友的话记到老爹头上。
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AsyncLocalStorage } from 'node:async_hooks'

import { listScopes, loadScope, saveScope, addItem, touchItem, appendSearchHits, autoPinWhy, setPin, enforcePinCap, auditWrite, auditRead, findSimilarItem, withWriteLock, enforceCapacity, supersedeConflicts, ensureDirs, normalizeText, mergeExistingItems } from './store.js'
import { vaultPaths, appendUsage } from './vault.js'
import { assertUsable, trustState } from './trust.js'
import { lastActive, flush, readStagingLines, isBridgeScaffold } from './ingest.js'
import { noteSessionItem, sessionIdOf, cwdOf, clearReview } from './inject.js'
import { sourceOfSessionSync } from './source.js'
import { markReviewed } from './review.js'
import { renderMemory, decayScore } from './inject.js'
import { searchFunnel, funnelLine } from './funnel.js'
import { forgetItem, reviveItem } from './forget.js'
import { resolveRelativeTime } from './time.js'
import { reindexScope } from './maintain.js'
import { confirmItem } from './confirm.js'
import { KINDS, EXTENDED, normalizeExtras, mapProgress } from './kinds.js'
import { visibleScope, writableScope, filterScopes, denyWhy, denyWriteWhy } from './visibility.js'
import { registerProject, projectOf } from './namespace.js'
import { loadDocs, addEntry, recordOutcome, promoteMemory, DOCS } from './agentdoc.js'
import { gateMode, gateDecision } from './gate.js'
import { redactText } from './redact.js'
import { originOf, readOrigin } from './origin.js'
import { writeDiary, readDiary, listDiaries, addDays } from './diary.js'
import { dayKey } from './beat/schedule.js'

const defineTool = (spec) => spec

const content = (text) => [{ type: 'text', text: String(text ?? '') }]

/** 活跃记录最多算十分钟；超了就当不知道现在在跟谁说话。 */
const ACTIVE_TTL = 10 * 60 * 1000

// read_memory 的 60 秒配额记在内存里：以前每次读都要把整个 usage.jsonl 读一遍。
// 单进程 DSH 够用；跨进程重置最多让配额多放一次，比全文件读划算。
const readQuota = new Map()

function allowRead(root, kind, id) {
  const key = `${root}|${kind}|${id}`
  const now = Date.now()
  const list = (readQuota.get(key) || []).filter((t) => now - t < 60 * 1000)
  if (list.length >= 3) {
    readQuota.set(key, list)
    return false
  }
  list.push(now)
  readQuota.set(key, list)
  if (readQuota.size > 1000) {
    const oldest = readQuota.keys().next().value
    if (oldest && oldest !== key) readQuota.delete(oldest)
  }
  return true
}

/**
 * 工具调用上下文。宿主 execute(args, exec) 的 exec 带 agent，从那里能拿到
 * 真正在说话的那个会话 —— 以前只靠 ingest 维护的全局「最近活跃」，群和私聊
 * 同时在说话时会串台：私聊里读记忆被当成群会话拒掉。
 * 并行工具调用各在一条异步链上，AsyncLocalStorage 分开存。
 */
const callCtx = new AsyncLocalStorage()

/** 当前工具调用属于哪个会话。没有工具上下文（测试/内部调用）才回退「最近活跃」。 */
function currentSid() {
  const sid = callCtx.getStore()?.sid
  if (sid) return sid
  if (!lastActive.sessionId) return ''
  if (Date.now() - lastActive.at > ACTIVE_TTL) return ''
  return lastActive.sessionId
}

/**
 * 可见性用的来源，比写入宽松（2 小时）：读错分片只是少查一条，
 * 写错分片才是把群友的话记到老爹头上。过期宁可当「不知道」按最窄算。
 */
const VIEW_TTL = 2 * 60 * 60 * 1000

function viewingSource() {
  const sid = currentSid()
  if (sid) {
    const src = sourceOfSessionSync(sid)
    if (src) return { kind: src.kind, id: src.id, label: src.label, addr: src.addr ?? '' }
    // 认不出这个会话的来源：只有「最近活跃」正好是它时，才敢用那份快照，
    // 否则宁可当不知道，也不能拿另一个会话的身份去查/拒。
    if (lastActive.sessionId !== sid) return null
  }
  if (!lastActive.scope || !lastActive.sessionId) return null
  if (Date.now() - lastActive.at > VIEW_TTL) return null
  return lastActive.scope
}

/**
 * direct 的放行信号（文档 7.7：只在三种情况免确认——用户说「记住」、纠正、
 * 明确长期偏好）。信号只从用户原话里找，模型自己写的 text 不算数。
 */
const DIRECT_QUOTE = /记住|记一下|记下|记牢|别忘了|别忘记|以后都|以后就|以后别|以后不要|说好了|约定|定下来|每次(?:都|要|别)|我喜欢|我不喜欢|我讨厌|我习惯|我的习惯|叫我|不对[，,]?是|不是[^，。]{0,8}是|错了|纠正|改成/

/** 自动钉住的显式信号：用户明说这条要长期留着，还是只认原话。 */
const PIN_QUOTE = /重要|收藏|知识库|长期|以后(?:要|得|会)?用/

/** 只留字母数字：原话核对不因全半角、空格、标点差异误判。 */
const looseText = (s) => normalizeText(s).replace(/[^\p{L}\p{N}]+/gu, '')

/** 引用块、@ 和行首发言人前缀都不是用户原话本身，匹配前剥掉。 */
function cleanQuoteText(s) {
  return String(s ?? '')
    .replace(/(?:^|\n)\s*\[引用了一条消息\]\s*/gu, '\n')
    .replace(/(?:^|\n)\s*\[回复[^\]]*\]\s*/gu, '\n')
    .replace(/@[^\s:：\n]+[\s:：]*/gu, ' ')
    .trim()
}

function quoteVariants(text) {
  const raw = String(text ?? '').trim()
  const clean = cleanQuoteText(raw)
  const noSpeaker = clean.replace(/^[^：:\n]{1,24}[：:]\s*/u, '')
  return [...new Set([looseText(clean), looseText(noSpeaker)].filter(Boolean))]
}

/**
 * 原话可能跨多条消息、带发言人前缀，或模型为了凑长度加了引用标记。
 * 逐条、首尾拼接、分段三种口径都试；命中的行必须是最近的真实用户消息。
 */
function quoteMatches(quote, rows) {
  const needles = quoteVariants(quote)
  const hayRows = (rows || []).map((r) => looseText(cleanQuoteText(r.text))).filter(Boolean)
  if (!needles.length || !hayRows.length) return false
  const hayAll = hayRows.join('')
  const parts = String(quote)
    .split(/[\n。！？!?；;]+/u)
    .map((x) => looseText(cleanQuoteText(x)))
    .filter((x) => x.length >= 4)
  for (const needle of needles) {
    if (hayRows.some((h) => h.includes(needle))) return true
    if (hayAll.includes(needle)) return true
    // 短消息被模型加了前后缀：整条原消息至少 4 个字，且落在引用里，才算对上。
    if (needle.length >= 4 && hayRows.some((h) => h.length >= 4 && needle.includes(h))) return true
    // 一句话被拆成多条消息：每一段都要能在拼接后的会话里找到。
    if (parts.length > 1 && parts.every((p) => hayAll.includes(p))) return true
  }
  return false
}

/** 整句都是「嗯 / 对 / 可以 / 记住吧」才算点头；问句和否定句不算。 */
const AFFIRM_QUOTE = /^(?:(?:嗯+|对+|好+|行|可以|没问题|没错|确认|同意|记住|就这样|就是(?:这样)?|都(?:确认|记住|可以)吧?|记(?:一下|下来|住)?吧?|你记(?:一下|下来|住)?吧?|一下|这条|是|的|啊|呀|吧|哦|ok|okay|yes))+$/u

/**
 * staging 里的真人消息。null = 不知道当前会话（CLI / 测试 / 已过期）。
 * reply_to 也收：它可能只是反馈，但用户在里面说「记住」时同样是确认证据。
 */
async function stagingUsers(root) {
  // 用工具调用自己的会话，别用「最近活跃」：私聊和群同时说话时会对到别人的原话
  const live = callCtx.getStore()?.sid
  const sid = live
    || (lastActive.sessionId && Date.now() - lastActive.at <= ACTIVE_TTL ? lastActive.sessionId : '')
  if (!sid) return null
  await flush()
  const lines = await readStagingLines(root, sid).catch(() => [])
  const rows = []
  for (const line of lines) {
    try {
      const r = JSON.parse(line)
      if (r?.role === 'user' && r.text && !isBridgeScaffold(r.text)) rows.push(r)
    } catch { /* 坏行跳过 */ }
  }
  return rows
}

/**
 * source_quote 是否真的出现在用户最近的原话里。
 * null = 看不到这轮原话（staging 已消费 / 没有会话），维持旧行为；
 * false = 对不上，不能拿它当「用户亲口说过」的证据。
 */
async function quoteSeen(root, quote) {
  const rows = await stagingUsers(root)
  if (!rows?.length) return null
  return quoteMatches(quote, rows)
}

/**
 * 原话是谁说的：只认 staging 里那条真实消息的 speaker。
 *
 * 群里的 src.addr 是绑定表里的会话称呼（「群里的人」），不是发言人。
 * 2026-11-09 实盘：手动写的群记忆全挂在这个名字下，成员画像里凭空多出一个
 * 「群里的人」，注入时还排在成员表前几位。
 *
 * 一句话跨了多个人的发言 = 认不准，返回空字符串；宁可空着，也不拿会话称呼顶上。
 */
async function speakerOfQuote(root, quote) {
  const rows = await stagingUsers(root)
  if (!rows?.length) return ''
  const needles = quoteVariants(quote)
  if (!needles.length) return ''
  const hit = rows.filter((r) => {
    const hay = looseText(cleanQuoteText(r.text))
    if (!hay) return false
    return needles.some((n) => hay.includes(n) || (n.length >= 4 && hay.length >= 4 && n.includes(hay)))
  })
  const names = [...new Set(hit.map((r) => String(r.speaker ?? '').trim()).filter(Boolean))]
  return names.length === 1 ? names[0] : ''
}

/**
 * 原话前后的真实消息，当「场景」用。
 * 只写一条结论的记忆读不出背景；把当时在聊什么一起存下来，过几天才看得懂。
 * 模型没给 scene 时由这里兜底，不逼它为了凑字段编一句。
 */
async function sceneOfQuote(root, quote) {
  const rows = await stagingUsers(root)
  if (!rows?.length) return ''
  const needles = quoteVariants(quote)
  if (!needles.length) return ''
  const idx = rows.findIndex((r) => {
    const hay = looseText(cleanQuoteText(r.text))
    if (!hay) return false
    return needles.some((n) => hay.includes(n) || (n.length >= 4 && hay.length >= 4 && n.includes(hay)))
  })
  if (idx < 0) return ''
  const trim = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, 60)
  const before = idx > 0 ? trim(rows[idx - 1].text) : ''
  const after = idx < rows.length - 1 ? trim(rows[idx + 1].text) : ''
  return [
    before ? `前面在聊「${before}」` : '',
    after ? `后面接着说「${after}」` : '',
  ].filter(Boolean).join('；').slice(0, 200)
}

/** 用户在这条记忆之后点过头没有。null = 无法核对。 */
async function confirmationSeen(root, since, quote = '') {
  if (!since) return null
  const rows = await stagingUsers(root)
  if (!rows?.length) return null
  const after = Date.parse(since) || 0
  const recent = rows.filter((r) => (Date.parse(r.at || '') || 0) >= after)
  if (!recent.length) return false
  const q = looseText(cleanQuoteText(quote))
  // 带了原话就按原话核；没带才退回「整句像点头」的判断
  if (q.length >= 2) return quoteMatches(quote, recent)
  return recent.some((r) => AFFIRM_QUOTE.test(looseText(r.text)))
}

/** 当前活跃会话对应的来源。 */
export async function activeSource() {
  const sid = callCtx.getStore()?.sid
  if (sid) {
    const src = sourceOfSessionSync(sid)
    if (src) return { kind: src.kind, id: src.id, label: src.label, addr: src.addr ?? '' }
  }
  await flush()
  if (!lastActive.scope || !lastActive.sessionId) return null
  if (sid && lastActive.sessionId !== sid) return null
  if (Date.now() - lastActive.at > ACTIVE_TTL) return null
  return lastActive.scope
}

export function registerTools(ctx, { root, log, gate = {} } = {}) {
  const say = log ?? (() => {})
  const disposers = []
  // 灰度三态在启动时定一次；改 env / 配置要重启，免得同一进程里两套口径。
  const gateLevel = gateMode(gate)

  const reg = (spec) => {
    // 外部库未信任：所有记忆工具一律拒绝，宁可不回答，也不把可疑内容送进上下文
    const run = spec.execute
    spec.execute = async (args, exec) => {
      const gate = await assertUsable(root)
      if (!gate.ok) return { ok: false, why: gate.why }
      // 宿主的 exec 带 agent：把「这次调用属于哪个会话」钉在异步链上，
      // 后面所有判定都读它，不再靠会被别的会话覆盖的全局「最近活跃」。
      const store = {
        sid: sessionIdOf(exec?.agent),
        ns: projectOf(cwdOf(exec?.agent)),
      }
      return callCtx.run(store, () => run(args, exec))
    }
    try {
      const d = ctx.tools.register(defineTool(spec))
      if (typeof d === 'function') disposers.push(d)
      else if (d?.dispose) disposers.push(() => d.dispose())
    } catch (e) {
      say(`[whale] 工具注册失败 ${spec.name}: ${String(e?.message ?? e).slice(0, 160)}`)
    }
  }

  const live = (x) => x && x.state !== 'archived' && x.state !== 'superseded'

  /** 估算 token：中日韩 ≈1 字 1 token，其余按 3.5 字。 */
  function estimateTokens(text) {
    const t = String(text ?? '')
    const cjk = (t.match(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) || []).length
    return Math.ceil(cjk + (t.length - cjk) / 3.5)
  }

  /** 读账入口：账写坏了也不能影响回答，所以一律吞异常。 */
  const readAudit = (entry) => auditRead(root, entry).catch(() => {})

  /**
   * 当前会话挂的仓库命名空间。工具调用带 exec 时在入口就算好；
   * 没有工具上下文才退回「最近活跃」，且十分钟不说话的旧记录不能拿来
   * 决定往哪个仓库写。
   */
  function activeNs() {
    // 工具调用带着自己的会话上下文时，仓库命名空间在入口就算好了
    const store = callCtx.getStore()
    if (store?.sid) return store.ns || null
    if (!lastActive.sessionId) return null
    if (Date.now() - lastActive.at > ACTIVE_TTL) return null
    return lastActive.ns || null
  }

  /** 仓库库也要过信任门：clone 下来的仓库带一份未确认的 .dsh/storages，不能直接读/写。 */
  async function nsUsable(ns) {
    if (!ns?.root) return false
    const s = await trustState(ns.root).catch(() => ({ usable: false }))
    return Boolean(s.usable)
  }

  /** 当前会话挂的仓库命名空间；未信任时按「不在仓库里」处理。 */
  async function activeTrustedNs() {
    const ns = activeNs()
    return ns && await nsUsable(ns) ? ns : null
  }

  /** 本会话要看的根：仓库在前，个人库在后；仓库未信任或没有仓库就只有个人库。 */
  async function roots() {
    const ns = await activeTrustedNs()
    return ns?.root && ns.root !== root ? [ns.root, root] : [root]
  }

  /** 跨根列出全部分片，并标上它属于哪个根（写入必须回到原根）。 */
  async function mountScopes() {
    const out = []
    for (const r of await roots()) {
      for (const sc of await listScopes(r).catch(() => [])) {
        sc._root = r
        out.push(sc)
      }
    }
    return out
  }

  const rootOf = (sc) => sc?._root || root

  /** 按 id 找分片：先认显式 scope，再全库扫。 */
  async function resolveScope(id, scopeArg) {
    const want = String(scopeArg ?? '').trim()
    const mounts = await mountScopes()
    if (want) {
      const [kind, sid] = want.split(':')
      if (kind && sid) {
        const sc = mounts.find((s) => s.kind === kind && s.id === sid)
        if (sc && (sc.items || []).some((x) => x.id === id)) return sc
      }
    }
    for (const sc of mounts) {
      if ((sc.items || []).some((x) => x.id === id)) return sc
    }
    return null
  }

  /** 按 id 或原句找「分片 + 条目」；原句时跨根按相似度找。 */
  async function findTarget({ id = '', text = '', scopeArg = '' } = {}) {
    if (id) {
      const sc = await resolveScope(id, scopeArg)
      const it = sc?.items.find((x) => x.id === id)
      return it ? { sc, it } : null
    }
    if (!text) return null
    for (const sc of await mountScopes()) {
      const hit = findSimilarItem(sc.items, text, 0.6)
      if (hit?.item) return { sc, it: hit.item }
    }
    return null
  }

  function sectionOf(md, name) {
    const re = new RegExp('## ' + name + '\\s*\\r?\\n([\\s\\S]*?)(?=\\r?\\n## |$)')
    const m = re.exec(md)
    return m ? m[1].trim() : ''
  }

  /** 检索副库视图：只用摘要/标签/时间线，不读正文。 */
  const searchSpec = (name, description) => ({
    name,
    description,
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '关键词或一句话；留空则返回权重最高的几条' },
        tags: { type: 'array', items: { type: 'string' }, description: '可选：按标签过滤，如 ["高数","数学"]' },
        scope: { type: 'string', description: '可选：限定分片 kind:id，如 group:123456789' },
        pinned: { type: 'boolean', description: '可选：只看知识库（钉住的长期条目）' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          count: { type: 'number' },
          results: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                scope: { type: 'string' },
                kind: { type: 'string' },
                summary: { type: 'string' },
                scene: { type: 'string' },
                quote: { type: 'string' },
                match: { type: 'string' },
                tags: { type: 'array', items: { type: 'string' } },
                weight: { type: 'number' },
                timeline: { type: 'string' },
                pinned: { type: 'boolean' },
                review: { type: 'boolean' },
                why: { type: 'string' },
              },
            },
          },
          text: { type: 'string' },
        },
        required: ['ok', 'count', 'results', 'text'],
      },
      render: (_a, out) => content(
        out?.ok
          ? (out.count ? out.text : '没找到。')
          : (out?.text ? `[没查：${out.text}]` : '[查记忆失败]'),
      ),
    },
    async execute(args) {
      const t0 = Date.now()
      const q = String(args?.query ?? '').trim()
      const want = String(args?.scope ?? '').trim()
      const tags = (Array.isArray(args?.tags) ? args.tags : String(args?.tags ?? '').split(/[,，\s]+/))
        .map((x) => String(x).trim()).filter(Boolean)
      // 可见性：群 = 本群 + 公共池 + 仓库；私聊 = 本人 + 圈子池 + 本机 + 公共池；本机全可见
      // （文档 4.7 的分片合并不能越过隐私边界）
      const viewer = viewingSource()
      let scopes = await mountScopes()
      if (want) {
        const [k, sid] = want.split(':')
        if (!visibleScope(viewer, { kind: k, id: sid })) {
          readAudit({ kind: 'search', tool: name, query: q.slice(0, 80), scope: want, denied: true, ms: Date.now() - t0 })
          return { ok: false, count: 0, results: [], text: denyWhy(viewer) }
        }
        scopes = scopes.filter((s) => s.scope === want)
      } else {
        scopes = filterScopes(viewer, scopes)
      }

      const top = searchFunnel(scopes, { query: q, tags, hops: true, topK: 8, pinned: args?.pinned === true }).slice(0, 8)

      // 搜索只往分片目录追加命中账本（不重写副库、不 bump .rev）；
      // 攒够次数的自动钉住交给每小时 forget 批处理，读正文才算用。
      const byScope = new Map(scopes.map((s) => [s.scope, s]))
      const hitsByScope = new Map()
      for (const x of top) {
        const sc = byScope.get(x.scope)
        if (!sc) continue
        const arr = hitsByScope.get(sc) || []
        arr.push(x.id)
        hitsByScope.set(sc, arr)
      }
      for (const [sc, ids] of hitsByScope) {
        await appendSearchHits(rootOf(sc), sc.kind, sc.id, ids).catch(() => {})
      }

      readAudit({
        kind: 'search',
        tool: name,
        query: q.slice(0, 80),
        tags,
        scope: want,
        count: top.length,
        empty: top.length === 0,
        hops: top.filter((x) => x.hop > 0).length,
        ms: Date.now() - t0,
        top: top.slice(0, 3).map((x) => ({ id: x.id, score: x.score, why: x.why })),
      })
      return {
        ok: true,
        count: top.length,
        results: top.map((x) => ({
          id: x.id,
          scope: x.scope,
          kind: x.kind,
          summary: x.summary,
          scene: x.scene || '',
          quote: x.quote || '',
          match: x.match || '',
          tags: x.tags,
          weight: Number((x.weight || 0).toFixed(2)),
          timeline: x.timeline,
          pinned: !!x.pinned,
          review: !!x.review,
          why: x.why.join('；'),
        })),
        text: top.map((x) => (x.pinned ? '[知识] ' : '') + funnelLine(x) + (x.hop ? '（' + x.why[x.why.length - 1] + '）' : '')).join('\n'),
      }
    },
  })

  reg(searchSpec('search_memory', '查记忆（摘要 + 正文 + 标签）。给关键词、具体名词或标签，返回 id、摘要、标签、权重；正文命中会带一小段上下文，要完整正文再用 read_memory(id)。'))
  // 旧名兼容：改名时同时注册别名，别让旧编排突然 unknown tool
  reg(searchSpec('memory_recall', '旧名，等价于 search_memory（兼容用）。'))

  reg({
    name: 'read_memory',
    description: '读一条记忆的正文。默认返回「提炼 + 要点 + 步骤 + 场景 + 原话 + 背景」，section 可选 场景/原话/完整记录/来源/原文/full；原文按写入时的会话坐标去翻旧会话，可能已被清理。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '记忆 id，从 search_memory 结果里拿' },
        section: { type: 'string', description: '可选：背景 / 场景 / 原话 / 完整记录 / 提炼 / 要点 / 步骤 / 来源 / 原文 / full' },
        max_tokens: { type: 'number', description: '可选：单次上限，默认 800，最大 1200' },
        scope: { type: 'string', description: '可选：kind:id；不填就全库按 id 找' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          id: { type: 'string' },
          scope: { type: 'string' },
          section: { type: 'string' },
          tokens: { type: 'number' },
          text: { type: 'string' },
          origin: { type: 'object' },
          why: { type: 'string' },
        },
        required: ['ok'],
      },
      render: (_a, out) => content(out?.ok ? out.text : '[读不到：' + (out?.why ?? '未知') + ']'),
    },
    async execute(args) {
      const t0 = Date.now()
      const id = String(args?.id ?? '').trim()
      const out = await readOne(args)
      readAudit({
        kind: 'read',
        tool: 'read_memory',
        id,
        scope: out.scope || String(args?.scope ?? '').trim(),
        section: out.section || String(args?.section ?? '').trim(),
        tokens: out.tokens || 0,
        ok: !!out.ok,
        why: out.ok ? '' : String(out.why ?? '').slice(0, 60),
        ms: Date.now() - t0,
      })
      return out
    },
  })

  /** read_memory 的本体，拆出来是为了让审计只包一层、不漏失败分支。 */
  async function readOne(args) {
    const id = String(args?.id ?? '').trim()
    if (!id) return { ok: false, why: '缺 id' }
    const sc = await resolveScope(id, args?.scope)
    if (!sc) return { ok: false, why: '没有这条记忆' }
    // 群会话拿到 id 也不能读私聊正文：id 可能来自旧骨架里的引用或别人递进来的数字
    if (!visibleScope(viewingSource(), sc)) return { ok: false, why: denyWhy(viewingSource()) }
    const p = vaultPaths(rootOf(sc), sc.kind, sc.id)
    // 粗粒度配额：60 秒窗口内最多读 3 次。宿主没给 turn id，只能按时间近似，
    // 目的不是卡准，是防止模型在一个回合里把库翻个底朝天。
    if (!allowRead(rootOf(sc), sc.kind, sc.id)) {
      return { ok: false, why: '这个回合已经读了 3 条，先用手上的内容回答' }
    }

    let raw = ''
    try {
      raw = await readFile(join(p.full, id + '.md'), 'utf8')
    } catch {
      return { ok: false, why: '主库文件不见了，跑 rebuild-index' }
    }

    const item = (sc.items || []).find((x) => x.id === id) || null
    const body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')
    const section = String(args?.section ?? '').trim()
    const maxTokens = Math.max(200, Math.min(1200, Number(args?.max_tokens) || 800))
    let text = ''
    let originInfo = null
    if (section === '原文' || section === '原文追溯') {
      const r = await readOrigin(rootOf(sc), item, { maxChars: Math.max(1200, maxTokens * 2) })
        .catch((e) => ({ found: false, text: `翻原文失败：${String(e?.message ?? e).slice(0, 80)}` }))
      text = r.text
      originInfo = { found: r.found === true, cached: r.cached === true, sessionId: item?.origin?.sessionId || '' }
    } else if (section === 'full') text = body.trim()
    else if (section) text = sectionOf(body, section)
    // 默认带「要点 / 步骤」：教训的触发条件、话题的目标、承诺的到期、技能的流程都不能丢
    else text = [sectionOf(body, '提炼'), sectionOf(body, '要点'), sectionOf(body, '步骤'), sectionOf(body, '场景'), sectionOf(body, '原话'), sectionOf(body, '背景')].filter(Boolean).join('\n\n')
    if (!text) text = sectionOf(body, '完整记录') || body.trim()

    let tokens = estimateTokens(text)
    if (tokens > maxTokens) {
      const lines = text.split('\n')
      const out = []
      let used = 0
      for (const line of lines) {
        const t = estimateTokens(line)
        if (used + t > maxTokens) break
        out.push(line)
        used += t
      }
      text = out.join('\n') + '\n…（已截断）'
      tokens = used
    }
    await appendUsage(rootOf(sc), sc.kind, sc.id, { tool: 'read_memory', id, section: section || '提炼', tokens }).catch(() => {})
    // 读了正文才算「用上了」：刷新命中与新近度，下一次检索排前面。
    // 搜到没读的不算，避免搜索热度把条目养虚（文档 8.2 的访问强化口径）。
    // 必须拿锁重读再改：sc 是读正文前加载的，直接整段回写会盖掉并发写入。
    // 读已经被 allowRead 限到 60 秒 3 次，三次小文件写换来命中数不丢，值。
    const rdRoot = rootOf(sc)
    await withWriteLock(async () => {
      const fresh = await loadScope(rdRoot, sc.kind, sc.id).catch(() => null)
      const it = (fresh?.items || []).find((x) => x.id === id)
      if (!it || it.state === 'suggested') return
      touchItem(fresh, id)
      await saveScope(rdRoot, fresh).catch(() => {})
    })
    const readSid = currentSid()
    if (readSid) noteSessionItem(root, readSid, 'read', id)
    return {
      ok: true, id, scope: sc.scope, section: section || '提炼', tokens, text,
      ...(originInfo ? { origin: originInfo } : {}),
    }
  }

  reg({
    name: 'profile_show',
    description: '看当前（或指定）分片里，你记得关于这个人/这个群的东西。',
    parameters: {
      type: 'object',
      properties: {
        scope: { type: 'string', description: '可选：kind:id，留空看当前会话对应的分片' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          scope: { type: 'string' },
          label: { type: 'string' },
          total: { type: 'number' },
          active: { type: 'number' },
          text: { type: 'string' },
          why: { type: 'string' },
        },
        required: ['ok'],
      },
      render: (_a, out) => content(
        out?.ok
          ? `${out.label} · 共 ${out.total} 条（可用 ${out.active}）\n${out.text}`
          : `[${out?.why ?? '查不到'}]`,
      ),
    },
    async execute(args) {
      const t0 = Date.now()
      const want = String(args?.scope ?? '').trim()
      let src = null
      let base = root
      if (want) {
        const [kind, id] = want.split(':')
        if (kind && id) {
          src = { kind, id, label: want }
          if (!visibleScope(viewingSource(), src)) {
            readAudit({ kind: 'profile', tool: 'profile_show', scope: want, ok: false, denied: true, ms: Date.now() - t0 })
            return { ok: false, why: denyWhy(viewingSource()) }
          }
          // 仓库分片在仓库根下：当前会话在哪个仓库，就只能读那个仓库的。
          // 仓库库未信任时明确拒绝，不能悄悄退回个人库给出错误答案。
          if (kind === 'project' && activeNs()) {
            const ns = await activeTrustedNs()
            if (!ns) return { ok: false, why: '这个仓库的记忆库还没信任：先运行 node tools/memory-trust.mjs trust' }
            base = ns.root
          }
        }
      } else {
        // 仓库会话默认看仓库画像；没有仓库（或仓库库未信任）再退回个人分片
        const ns = await activeTrustedNs()
        if (ns) { src = { kind: ns.kind, id: ns.id, label: ns.label }; base = ns.root }
        else src = await activeSource()
      }
      if (!src) {
        readAudit({ kind: 'profile', tool: 'profile_show', scope: want, ok: false, why: '不知道在跟谁说话', ms: Date.now() - t0 })
        return { ok: false, why: '不知道现在在跟谁说话' }
      }
      let sc = await loadScope(base, src.kind, src.id)
      // 仓库库还空着的时候别装失忆：退回个人画像，不然「仓库会话里她什么都不记得」
      if (!want && src.kind === 'project' && !(sc.items || []).length) {
        const g = await activeSource()
        if (g) sc = await loadScope(root, g.kind, g.id)
      }
      const active = sc.items.filter((x) => x.state !== 'archived' && x.state !== 'cold' && x.state !== 'superseded' && x.state !== 'suggested').length
      readAudit({ kind: 'profile', tool: 'profile_show', scope: sc.scope, ok: true, total: sc.items.length, active, ms: Date.now() - t0 })
      return {
        ok: true,
        scope: sc.scope,
        label: sc.label,
        total: sc.items.length,
        active,
        text: renderMemory(sc, { topN: 10, maxChars: 1600 }) || '（还空着）',
      }
    },
  })

  reg({
    name: 'memory_save',
    description: '把一件值得记住的事写进当前对话的记忆里。必须带用户原话片段 source_quote 和当时场景 scene；'
      + '写之前先 search_memory：找到同一条/同一件事就传 merge_into，把它并进旧条目，不要新建。'
      + '正文一到两句：第一句讲清事实，第二句补背景；禁止只写半句结论。'
      + '群里写清是哪位群友说的（用群昵称），不要写「用户」「群里的人」。'
      + '扩展类型各自带必填字段：lesson（trigger「当……时」+ anti_pattern）、topic（goal）、commitment（due + to_whom）、skill（trigger + steps 3–8 步 + verify）。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要记的事，一到两句：第一句事实，第二句背景；不要只写半句' },
        kind: { type: 'string', enum: KINDS, description: '类型，默认 fact。knowledge=知识（进公共知识库，不随时间遗忘）/ lesson=教训 / topic=进行中话题 / commitment=承诺 / skill=有固定步骤的技能' },
        source_quote: { type: 'string', description: '用户原话片段，至少 8 个字；没有原话不许写' },
        scene: { type: 'string', description: '当时在聊什么、因何说起；一句话，别重复正文。不填会用原话前后的消息兜底' },
        merge_into: { type: 'string', description: '可选：search_memory 找到的同一条记忆 id；给了就合并进旧条目，不再新建' },
        tags: { type: 'array', items: { type: 'string' }, description: '可选：2-5 个标签，系统会归一化到受控词表' },
        pin: { type: 'boolean', description: '可选：钉住成长期知识，不参与时间衰减；群/私聊不能改公共池' },
        namespace: { type: 'string', enum: ['global', 'project', 'public'], description: '可选：project = 跟这个仓库绑的共识，存进仓库的 .dsh/storages（可随 git 分享）；public = 公共记忆池（网上学到的公开内容，所有会话可读，只有本机能写）；不填 global = 个人记忆库' },
        mode: { type: 'string', enum: ['confirm', 'direct'], description: '可选：不填就按原话自动判断——原话里有「记住 / 纠正 / 长期偏好」才直接生效，否则进待确认。direct 也不能绕过这个判断' },
        trigger: { type: 'string', description: 'lesson / skill 必填：在什么情况下适用，必须写成「当……时」' },
        anti_pattern: { type: 'string', description: 'lesson 必填：踩过的坑 / 以后别再怎么做' },
        goal: { type: 'string', description: 'topic 必填：一句话说清这件事要做成什么' },
        status: { type: 'string', description: 'topic 可选：进行中 / 暂停 / 已完成；状态变化优先用 memory_update' },
        due: { type: 'string', description: 'commitment 必填：到期日期（2026-11-05）或条件（下次提到 X 时）' },
        to_whom: { type: 'string', description: 'commitment：答应的是谁；私聊不填默认「你」' },
        steps: { type: 'array', items: { type: 'string' }, description: 'skill 必填：3–8 个步骤，按顺序写；只写动作，不写背景' },
        verify: { type: 'string', description: 'skill 必填：怎么确认这次做完了、做对了' },
      },
      required: ['text', 'source_quote'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          id: { type: 'string' },
          scope: { type: 'string' },
          status: { type: 'string' },
          committed: { type: 'boolean' },
          pinned: { type: 'boolean' },
          gate: { type: 'string' },
          why: { type: 'string' },
        },
        required: ['ok'],
      },
      render: (_a, out) => content(
        out?.ok
          ? (out.status === 'suggested'
            ? `[先记下待确认 ${out.id}，等用户点头再生效]`
            : out.status === 'exists'
              ? `[库里已经有了 ${out.id}，没重复记]`
              : `[记下了 ${out.id}${out.status === 'merged' ? '（合并到已有条目）' : ''}]`)
          : `[没记：${out?.why ?? '未知'}]`,
      ),
    },
    async execute(args) {
      const src = await activeSource()
      if (!src) return { ok: false, why: '当前会话没有对应的记忆分片（或最近没有桥接消息）' }
      // 命名空间：默认个人库。project 只在当前会话确实在仓库里时可用，
      // 而且要显式声明——自动蒸馏不进仓库，免得私人对话被提交进别人的仓库。
      const nsArg = String(args?.namespace ?? 'global').toLowerCase()
      const ns = activeNs()
      let targetRoot = root
      let tKind = src.kind
      let tId = src.id
      if (nsArg === 'project') {
        if (!ns) return { ok: false, why: '当前会话不在仓库里，project 命名空间没有落点' }
        if (!(await nsUsable(ns))) {
          return { ok: false, why: `仓库记忆库未信任（${ns.root}）：先在那个仓库运行 node tools/memory-trust.mjs trust` }
        }
        targetRoot = ns.root
        tKind = ns.kind
        tId = ns.id
        await ensureDirs(targetRoot)
        // 登记到 global 库：遗忘/深化循环才知道这个仓库库也要扫
        await registerProject(root, ns).catch(() => {})
      } else if (nsArg === 'public') {
        // 公共池所有会话都能读，写必须收口：只有本机会话（没有第三人在场）能往里写
        if (src.kind !== 'local') {
          return { ok: false, why: '公共记忆池只有本机会话能写；群里和私聊里只能读。要记自己的事，直接写当前对话的记忆就行。' }
        }
        tKind = 'public'
        tId = 'web'
      }
      const quote = String(args?.source_quote ?? '').trim()
      // 先核对再卡长度：短消息原话（比如「后面可以做」）只要能在 staging 里
      // 完整对上，就允许当证据；不能为了凑 8 个字逼模型拼前缀，那样反而校不上。
      const seen = await quoteSeen(root, quote)
      if (quote.length < 8 && seen !== true) {
        return { ok: false, why: 'source_quote 至少 8 个字，得是用户原话片段（短原话要能完整对上最近消息）' }
      }
      // 谁说的从原话所在的那条消息取；群里拿不到就留空，不拿会话称呼冒充
      const saidBy = await speakerOfQuote(root, quote)
      // 正文和原话入库前同样打码：QQ 里贴的 key 不能绕过蒸馏链路写进记忆
      const saveText = redactText(String(args?.text ?? '').trim())
      const quoteClean = redactText(quote)
      const kind = String(args?.kind ?? 'fact').trim() || 'fact'
      if (!KINDS.includes(kind)) return { ok: false, why: `不认识的类型：${kind}` }
      const mergeInto = String(args?.merge_into ?? '').trim()
      // 模型给了场景就用它的；没给就从原话前后的真实消息里捞，不硬编
      const scene = redactText(String(args?.scene ?? '').replace(/\s+/g, ' ').trim()).slice(0, 200)
        || await sceneOfQuote(root, quote)
      // 公共池是外部情报：教训/话题/承诺都是私人语境里的东西，写进去别人也会读到。
      // knowledge 例外——知识库本来就要所有会话都能查。
      if (tKind === 'public' && !['fact', 'event', 'pref', 'knowledge'].includes(kind)) {
        return { ok: false, why: '公共池只收事实、事件、偏好、知识；教训、话题、承诺、技能写进自己那层。' }
      }

      // 只认原话里的信号：模型给 mode=direct 但原话没信号，一样进待确认。
      // 原话还要能在最近的真实用户消息里对上——模型自己编一句带「记住」的话，
      // 不能当成用户点头直接生效。
      const saveMode = String(args?.mode ?? '').trim()
      const hint = seen !== false && DIRECT_QUOTE.test(quote)
      const direct = saveMode === 'direct' ? hint : saveMode === 'confirm' ? false : hint
      // 自动钉住：手动要求、知识类型、或原话里明说要长期留着
      const pinWhy = args?.pin === true ? 'manual' : kind === 'knowledge' ? 'knowledge' : seen !== false && PIN_QUOTE.test(quote) ? 'explicit' : ''
      // 灰度三态（文档 4.6）：off/warn 都放行，只有 enforce 真拦
      const dec = gateDecision(gateLevel, direct)
      // 原话对不上就不许直接生效，灰度关了也一样：这条不是确认策略，是来源校验
      if (seen === false) {
        dec.state = 'suggested'
        dec.gate = 'unverified-quote'
        dec.why = 'source_quote 在用户最近的原话里对不上，先放待确认'
      }

      // 扩展类型的必填字段先校验：入口自己拦，才能把「缺什么」带回给模型。
      // 「明天」这类相对日期在这里锚成绝对日期，跟正文的时间锚定同一套规则。
      const now = new Date().toISOString()
      const due = kind === 'commitment'
        ? (resolveRelativeTime(String(args?.due ?? ''), now)?.abs || String(args?.due ?? ''))
        : ''
      const toWhom = kind === 'commitment'
        ? (String(args?.to_whom ?? '').trim() || (src.kind === 'group' ? '群里' : src.kind === 'local' ? '自己' : '你'))
        : ''
      const ext = normalizeExtras(kind, {
        trigger: typeof args?.trigger === 'string' ? redactText(args.trigger) : args?.trigger,
        antiPattern: typeof args?.anti_pattern === 'string' ? redactText(args.anti_pattern) : args?.anti_pattern,
        goal: typeof args?.goal === 'string' ? redactText(args.goal) : args?.goal,
        progress: args?.status,
        due,
        toWhom,
        steps: Array.isArray(args?.steps)
          ? args.steps.map((x) => redactText(String(x)))
          : (typeof args?.steps === 'string' ? redactText(args.steps) : args?.steps),
        verify: typeof args?.verify === 'string' ? redactText(args.verify) : args?.verify,
      }, new Date(now))
      if (!ext.ok) return { ok: false, why: ext.why }

      const out = await withWriteLock(async () => {
        const sc = await loadScope(targetRoot, tKind, tId)
        const before = sc.items.length
        // 显式合并：模型已经 search 过、认出这是同一件事，别再拿字面相似度去卡它
        let explicitTarget = null
        if (mergeInto) {
          explicitTarget = sc.items.find((x) => x && x.id === mergeInto
            && x.state !== 'archived' && x.state !== 'superseded') || null
          if (!explicitTarget) return { ok: false, why: `merge_into 找不到 ${mergeInto}（要传 search_memory 返回的 id）` }
          const extKind = (k) => EXTENDED.includes(k)
          if (explicitTarget.kind !== kind && (extKind(explicitTarget.kind) || extKind(kind))) {
            return { ok: false, why: `不能把 ${kind} 并进 ${explicitTarget.kind}：扩展类型各管各的` }
          }
        }
        // 库里已经有同一条（而且是生效的），这次又没带「记住」：不要拿一条待确认去给旧条目加命中。
        // 话题例外：话题的「更新」就是合并，交给 addItem 刷新 progress / last_touched。
        const dup = mergeInto ? null : findSimilarItem(sc.items, saveText, kind === 'topic' ? 0.45 : 0.72, { kind })
        if (dup && dup.item.state !== 'suggested' && !direct && kind !== 'topic') {
          return { ok: true, id: dup.item.id, scope: sc.scope, status: 'exists', committed: true, why: '库里已经有同一条，没重复记' }
        }
        // 手动记的时候也把「明天」锚掉，不然只有蒸馏链路有时间，工具写的是裸句子
        const rt = resolveRelativeTime(saveText, now)
        const it = addItem(sc, {
          text: saveText,
          kind,
          // 公共池是外部情报，置信度压一档；而且本机显式写就是决意记下，不再走待确认
          conf: tKind === 'public' ? 0.55 : (dec.state === 'active' ? (direct ? 0.8 : 0.55) : 0.5),
          source: 'tool',
          sourceQuote: quoteClean,
          scene,
          tags: Array.isArray(args?.tags) ? args.tags.map(String) : [],
          mergeInto: explicitTarget ? explicitTarget.id : '',
          origin: originOf(quoteClean, { sessionId: currentSid(), at: now }),
          atAbs: rt?.abs ?? '',
          observedAt: now,
          speaker: saidBy || (src.kind === 'group' ? '' : (src.addr || '')),
          state: tKind === 'public' ? 'active' : dec.state,
          pin: !!pinWhy,
          pinWhy,
          ...ext.fields,
        })
        if (!it) return { ok: false, why: '空的' }
        // warn 放行了，但得在条目上留个记号：事后能算出「这一条 enforce 会拦」
        if (dec.gate && it.state !== 'suggested') it.gate = dec.gate
        if (Array.isArray(args?.tags) && args.tags.length) {
          it.tags = [...new Set([...(it.tags || []), ...args.tags.map(String)])].slice(0, 8)
        }

        const merged = sc.items.length === before
        let turned = false
        // 同一条之前是待确认，用户这回明确说「记住」：就地转正，不新建
        if (merged && direct && it.state === 'suggested') {
          it.state = 'active'
          it.conf = Math.max(it.conf, 0.7)
          it.lastHit = now
          supersedeConflicts(sc, it, now)
          turned = true
        }
        // 偏好进 USER.md、教训进 AGENT.md（文档 4.8）。只在「新条目 / 刚转正」
        // 时沉淀，重复提一句不重写文件，免得常驻文件的 mtime 天天跳。
        if (it.state === 'active' && (!merged || turned) && tKind !== 'public') {
          const docRoot = it.kind === 'pref' ? root : targetRoot
          await promoteMemory(docRoot, it).catch(() => {})
        }

        // 公共池：同一条反复出现就自动升格成知识；钉太多时松最久没用的
        if (tKind === 'public') {
          const autoWhy = autoPinWhy(it)
          if (autoWhy) setPin(it, true, autoWhy)
          enforcePinCap(sc)
        }

        const dropped = await enforceCapacity(targetRoot, sc)
        await reindexScope(targetRoot, sc)
        return {
          ok: true,
          id: it.id,
          scope: sc.scope,
          dropped,
          merged,
          committed: true,
          status: it.state === 'suggested' ? 'suggested' : merged ? 'merged' : 'active',
          pinned: !!it.pin,
          gate: dec.gate,
          why: dec.why,
        }
      })
      if (out.ok) {
        const saveSid = currentSid()
        if (saveSid) noteSessionItem(root, saveSid, 'write', out.id)
        await auditWrite(root, {
          kind: 'tool-save',
          scope: out.scope,
          item: out.id,
          merged: out.merged,
          status: out.status,
          gate: out.gate,
        })
      }
      return out
    },
  })

  reg({
    name: 'memory_update',
    description: '更新一条已有话题、承诺或技能：话题改进展、承诺改到期或对象、技能改触发/步骤/验证。'
      + '只改状态，不新建条目，也不碰正文。技能用 outcome 记一次执行结果：连续两次失败标待复核。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '话题 / 承诺 / 技能的 id（search_memory 或骨架提醒里能看到）' },
        scope: { type: 'string', description: '可选：kind:id；留空全库按 id 找' },
        status: { type: 'string', description: '话题进展：进行中 / 暂停 / 已完成' },
        goal: { type: 'string', description: '可选：改话题目标句' },
        due: { type: 'string', description: '可选：改承诺到期（日期或「下次提到 X 时」）' },
        to_whom: { type: 'string', description: '可选：改承诺对象' },
        trigger: { type: 'string', description: '可选：改技能触发条件（必须写成「当……时」）' },
        steps: { type: 'array', items: { type: 'string' }, description: '可选：改技能步骤（3–8 步）' },
        verify: { type: 'string', description: '可选：改技能验证方式' },
        outcome: { type: 'string', enum: ['ok', 'fail'], description: '技能执行结果：ok 清零失败计数，fail 累计；连续两次 fail 标待复核' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          id: { type: 'string' },
          scope: { type: 'string' },
          kind: { type: 'string' },
          progress: { type: 'string' },
          due: { type: 'string' },
          review: { type: 'boolean' },
          fails: { type: 'number' },
          why: { type: 'string' },
        },
        required: ['ok'],
      },
      render: (_a, out) => content(
        out?.ok
          ? `[更新了 ${out.id}${out.progress ? ` · ${out.progress}` : ''}${out.due ? ` · ${out.due}` : ''}${out.review ? ' · 待复核' : ''}]`
          : `[没更新：${out?.why ?? '未知'}]`,
      ),
    },
    async execute(args) {
      const id = String(args?.id ?? '').trim()
      if (!id) return { ok: false, why: '缺 id' }
      const out = await withWriteLock(async () => {
        const sc = await resolveScope(id, args?.scope)
        if (!sc) return { ok: false, why: '没有这条记忆' }
        if (!writableScope(viewingSource(), sc)) return { ok: false, why: denyWriteWhy(viewingSource(), sc) }
        const it = (sc.items || []).find((x) => x.id === id)
        if (!it) return { ok: false, why: '没有这条记忆' }
        if (it.kind !== 'topic' && it.kind !== 'commitment' && it.kind !== 'skill') {
          return { ok: false, why: '只有话题、承诺和技能能这样更新' }
        }
        const now = new Date().toISOString()
        if (it.kind === 'topic') {
          const p = mapProgress(args?.status)
          if (p) it.progress = p
          const goal = redactText(String(args?.goal ?? '').trim())
          if (goal) it.goal = goal
          // 话题更新只改状态与 last_touched，不新建条目
          it.lastTouched = now
        } else if (it.kind === 'commitment') {
          const due = String(args?.due ?? '').trim()
          if (due) it.due = resolveRelativeTime(due, now)?.abs || due
          const to = String(args?.to_whom ?? '').trim()
          if (to) it.toWhom = to
        } else {
          const edited = args?.trigger !== undefined || args?.steps !== undefined || args?.verify !== undefined
          const outcome = String(args?.outcome ?? '').trim()
          if (!edited && !outcome) return { ok: false, why: '技能要改 trigger / steps / verify，或用 outcome 记一次执行结果' }
          if (edited) {
            // 允许只改一项：拿旧值补全后整体再校验一遍，半截流程不许落盘
            const ext = normalizeExtras('skill', {
              trigger: args?.trigger !== undefined ? redactText(String(args.trigger)) : it.trigger,
              steps: args?.steps !== undefined
                ? (Array.isArray(args.steps) ? args.steps.map((x) => redactText(String(x))) : redactText(String(args.steps)))
                : it.steps,
              verify: args?.verify !== undefined ? redactText(String(args.verify)) : it.verify,
            }, new Date(now))
            if (!ext.ok) return { ok: false, why: ext.why }
            it.trigger = ext.fields.trigger
            it.steps = ext.fields.steps
            it.verify = ext.fields.verify
            it.skillFails = 0
            it.skillReview = false
          }
          if (outcome === 'fail') {
            it.skillFails = (Number(it.skillFails) || 0) + 1
            if (it.skillFails >= 2) it.skillReview = true
          } else if (outcome === 'ok') {
            it.skillFails = 0
            it.skillReview = false
          } else if (outcome) {
            return { ok: false, why: `outcome 只认 ok / fail，现在是「${outcome}」` }
          }
        }
        it.lastHit = now
        await reindexScope(rootOf(sc), sc)
        return {
          ok: true,
          id,
          scope: sc.scope,
          kind: it.kind,
          progress: it.progress || '',
          due: it.due || '',
          review: it.skillReview === true,
          fails: Number(it.skillFails) || 0,
        }
      })
      if (out.ok) {
        await auditWrite(root, {
          kind: 'tool-update',
          scope: out.scope,
          item: id,
          progress: out.progress,
          due: out.due,
          review: out.review,
          fails: out.fails,
        }).catch(() => {})
      }
      return out
    },
  })

  reg({
    name: 'memory_pin',
    description: '把一条记忆钉成长期知识（不随时间遗忘、不归档），或松开。知识库落在公共池，所有会话可读；只有本机能改公共池。'
      + '普通事实不用钉；只在用户说「这个要长期留着 / 当知识库」或确实是稳定结论时用。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '记忆 id' },
        scope: { type: 'string', description: '可选：kind:id；留空全库按 id 找' },
        action: { type: 'string', enum: ['pin', 'unpin'], description: '默认 pin；unpin = 松开，重新按时间衰减' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          id: { type: 'string' },
          scope: { type: 'string' },
          pinned: { type: 'boolean' },
          changed: { type: 'boolean' },
          why: { type: 'string' },
        },
        required: ['ok'],
      },
      render: (_a, out) => content(
        out?.ok
          ? (out.changed
            ? `[${out.pinned ? '钉成知识' : '松开了'} ${out.id}]`
            : `[没动：${out.why || '状态没变'}]`)
          : `[没钉：${out?.why ?? '未知'}]`,
      ),
    },
    async execute(args) {
      const id = String(args?.id ?? '').trim()
      if (!id) return { ok: false, why: '缺 id' }
      const want = String(args?.action ?? 'pin') === 'unpin' ? false : true
      const out = await withWriteLock(async () => {
        const sc = await resolveScope(id, args?.scope)
        if (!sc) return { ok: false, why: '没有这条记忆' }
        if (!writableScope(viewingSource(), sc)) return { ok: false, why: denyWriteWhy(viewingSource(), sc) }
        const it = (sc.items || []).find((x) => x.id === id)
        if (!it) return { ok: false, why: '没有这条记忆' }
        if (['archived', 'superseded', 'expired'].includes(it.state)) {
          return { ok: false, why: '这条已经归档或过期，先用 memory_revive 复活' }
        }
        const changed = setPin(it, want, want ? 'manual' : '')
        if (changed && it.pin && sc.kind === 'public') enforcePinCap(sc)
        if (changed) await reindexScope(rootOf(sc), sc)
        return {
          ok: true,
          id,
          scope: sc.scope,
          pinned: !!it.pin,
          changed,
          why: changed ? '' : it.pin ? '本来就钉着' : '本来就没钉',
        }
      })
      if (out.ok && out.changed) {
        await auditWrite(root, { kind: 'tool-pin', scope: out.scope, item: id, pin: out.pinned }).catch(() => {})
      }
      return out
    },
  })

  reg({
    name: 'memory_experience',
    description: '经验和画像：AGENT.md 记「下次还用得上」的原则/路径/坑，USER.md 记偏好/习惯/红线。'
      + '这不是存事实的地方——一件事、一句话用 memory_save；只有「以后干活要照着做」的才写这里。'
      + 'show 看全文；add 加一条；ok / fail 给某条记一次用后结果——连续两次失败会自动标待复核、停止注入。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['show', 'add', 'ok', 'fail'], description: '要做的事' },
        doc: { type: 'string', enum: ['agent', 'user'], description: 'add 时必填：agent=经验，user=画像' },
        type: { type: 'string', description: '可选：agent = 原则/路径/坑，user = 偏好/习惯/红线/背景' },
        text: { type: 'string', description: 'add 必填：一句可执行的话；ok/fail 时也可以用它匹配条目' },
        ref: { type: 'string', description: '可选：指回主库的 id（m_xxx），方便复核' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          doc: { type: 'string' },
          text: { type: 'string' },
          review: { type: 'boolean' },
          why: { type: 'string' },
        },
        required: ['ok'],
      },
      render: (_a, out) => content(
        out?.ok
          ? (out.text || (out.review ? `[记了一次失败，已经连续两次，标为待复核并停止注入]` : '[记下了]'))
          : `[没成：${out?.why ?? '未知'}]`,
      ),
    },
    async execute(args) {
      const action = String(args?.action ?? '').trim()
      if (action === 'show') {
        const docs = await loadDocs(root)
        const parts = []
        for (const k of ['agent', 'user']) {
          const d = docs[k]
          parts.push(`## ${DOCS[k].file}（${d.chars} 字符 / 上限 3000）\n${d.text.trim() || '（空）'}`)
        }
        return { ok: true, text: parts.join('\n\n') }
      }
      if (action === 'add') {
        const which = String(args?.doc ?? 'agent').trim()
        if (!DOCS[which]) return { ok: false, why: 'doc 只能是 agent 或 user' }
        const text = String(args?.text ?? '').trim()
        if (!text) return { ok: false, why: 'text 是空的' }
        const r = await addEntry(root, which, {
          type: args?.type,
          text,
          ref: String(args?.ref ?? '').trim(),
        })
        if (!r.ok) return r
        await auditWrite(root, { kind: 'experience-add', doc: which, entry: r.entry.text, ref: r.entry.ref })
        return { ok: true, doc: which, text: `[写进 ${DOCS[which].file}：${r.entry.text}（${r.chars}/3000）]` }
      }
      if (action === 'ok' || action === 'fail') {
        const ref = String(args?.ref ?? '').trim()
        const text = String(args?.text ?? '').trim()
        if (!ref && !text) return { ok: false, why: '给 ref 或 text 才能对上条目' }
        const r = await recordOutcome(root, { ref, text, ok: action === 'ok' })
        if (!r.ok) return r
        await auditWrite(root, { kind: `experience-${action}`, doc: r.doc, entry: r.entry.text, review: r.review })
        return {
          ok: true,
          doc: r.doc,
          review: r.review,
          text: `[${action === 'ok' ? '记了一次成功' : '记了一次失败'}：${r.entry.text}${r.review ? '（连续失败 2 次，待复核，已停止注入）' : ''}]`,
        }
      }
      return { ok: false, why: `不认识的 action：${action}` }
    },
  })

  reg({
    name: 'memory_pending',
    description: '看待确认的记忆（模型主动记下、但用户还没点头的那些）。这些还没生效，不会进目录、不会被检索到。',
    parameters: {
      type: 'object',
      properties: {
        scope: { type: 'string', description: '可选：kind:id，留空看当前会话对应的分片' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          count: { type: 'number' },
          text: { type: 'string' },
          why: { type: 'string' },
        },
        required: ['ok'],
      },
      render: (_a, out) => content(out?.ok ? (out.count ? out.text : '没有待确认的。') : `[查不到：${out?.why ?? '未知'}]`),
    },
    async execute(args) {
      const want = String(args?.scope ?? '').trim()
      const ns = await activeTrustedNs()
      const targets = []
      if (want) {
        const [kind, id] = want.split(':')
        if (kind && id) {
          // 待确认的内容也是正文，同样受可见性约束
          if (!visibleScope(viewingSource(), { kind, id })) return { ok: false, why: denyWhy(viewingSource()) }
          targets.push({ root: kind === 'project' && ns ? ns.root : root, kind, id })
        }
      } else {
        const src = await activeSource()
        if (src) targets.push({ root, kind: src.kind, id: src.id })
        // 仓库库里的待确认也要看得见，不然用户点了头也找不到
        if (ns) targets.unshift({ root: ns.root, kind: ns.kind, id: ns.id })
      }
      if (!targets.length) return { ok: false, why: '不知道现在在跟谁说话' }
      const list = []
      for (const t of targets) {
        const sc = await loadScope(t.root, t.kind, t.id)
        list.push(...(sc.items || []).filter((x) => x.state === 'suggested'))
      }
      const shown = list.slice(-10).reverse()
      return {
        ok: true,
        count: shown.length,
        text: shown.length
          ? shown.map((x) => `${x.id}｜${String(x.text).slice(0, 80)}`).join('\n')
          : '',
      }
    },
  })

  reg({
    name: 'memory_confirm',
    description: '用户点头后，把一条待确认的记忆转正。转正后才进目录、才会被检索和注入。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '待确认条目的 id（先用 memory_pending 看）' },
        scope: { type: 'string', description: '可选：kind:id；留空全库按 id 找' },
        source_quote: { type: 'string', description: '可选：用户点头的原话片段；有最近消息时会核对' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          id: { type: 'string' },
          scope: { type: 'string' },
          superseded: { type: 'number' },
          why: { type: 'string' },
        },
        required: ['ok'],
      },
      render: (_a, out) => content(out?.ok ? `[转正了 ${out.id}${out.superseded ? `，顺带取代 ${out.superseded} 条旧说法` : ''}]` : `[没转正：${out?.why ?? '未知'}]`),
    },
    async execute(args) {
      const id = String(args?.id ?? '').trim()
      if (!id) return { ok: false, why: '缺 id' }
      // 先核对用户是不是真点了头。核对要读 staging、等采集队列，
      // 不能放进写锁里（ingest 落盘也抢同一把锁，会自我等待）。
      const pre = await resolveScope(id, args?.scope)
      if (pre) {
        if (!writableScope(viewingSource(), pre)) return { ok: false, why: denyWriteWhy(viewingSource(), pre) }
        const it = (pre.items || []).find((x) => x.id === id)
        if (it?.state === 'suggested') {
          const seen = await confirmationSeen(root, it.observedAt, String(args?.source_quote ?? ''))
          if (seen === false) {
            return { ok: false, why: '最近消息里没看到用户点头，不能替他确认；等他说「嗯 / 对 / 记住」再转正' }
          }
        }
      }
      const out = await withWriteLock(async () => {
        const sc = await resolveScope(id, args?.scope)
        if (!sc) return { ok: false, why: '没有这条记忆' }
        if (!writableScope(viewingSource(), sc)) return { ok: false, why: denyWriteWhy(viewingSource(), sc) }
        return confirmItem(rootOf(sc), sc.kind, sc.id, id)
      })
      if (out.ok) {
        await auditWrite(root, { kind: 'tool-confirm', scope: out.scope, item: id })
        const confirmSid = currentSid()
        if (confirmSid) noteSessionItem(root, confirmSid, 'write', id)
      }
      return out
    },
  })

  reg({
    name: 'memory_merge',
    description: '把两条已经存在的重复记忆合并成一条：正文、场景、原话并进 target，source 标成「已取代」（不物理删）。'
      + '写新记忆时用 memory_save(merge_into)；这个工具清理的是库里已经重复的两条。',
    parameters: {
      type: 'object',
      properties: {
        source_id: { type: 'string', description: '要并掉的重复条目 id' },
        target_id: { type: 'string', description: '保留的条目 id（两条要在同一个分片）' },
        scope: { type: 'string', description: '可选：kind:id；留空按 source 所在分片找' },
      },
      required: ['source_id', 'target_id'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          id: { type: 'string' },
          source: { type: 'string' },
          scope: { type: 'string' },
          why: { type: 'string' },
        },
        required: ['ok'],
      },
      render: (_a, out) => content(out?.ok ? `[合并了 ${out.source} → ${out.id}]` : `[没合并：${out?.why ?? '未知'}]`),
    },
    async execute(args) {
      const sourceId = String(args?.source_id ?? '').trim()
      const targetId = String(args?.target_id ?? '').trim()
      if (!sourceId || !targetId || sourceId === targetId) {
        return { ok: false, why: 'source_id 和 target_id 都要有，且不能是同一条' }
      }
      const pre = await resolveScope(sourceId, args?.scope)
      if (!pre) return { ok: false, why: '找不到 source 那条记忆' }
      if (!writableScope(viewingSource(), pre)) return { ok: false, why: denyWriteWhy(viewingSource(), pre) }
      const out = await withWriteLock(async () => {
        const sc = await resolveScope(sourceId, args?.scope)
        if (!sc) return { ok: false, why: '找不到 source 那条记忆' }
        if (!writableScope(viewingSource(), sc)) return { ok: false, why: denyWriteWhy(viewingSource(), sc) }
        const target = (sc.items || []).find((x) => x.id === targetId)
        if (!target) return { ok: false, why: 'target 不在同一个分片，跨分片不能合并' }
        const merged = mergeExistingItems(sc, sourceId, targetId)
        if (!merged) return { ok: false, why: '合并失败：两条可能已归档、待确认，或扩展类型不同' }
        await reindexScope(rootOf(sc), sc)
        return { ok: true, id: targetId, source: sourceId, scope: sc.scope }
      })
      if (out.ok) await auditWrite(root, { kind: 'tool-merge', scope: out.scope, item: out.id, source: out.source })
      return out
    },
  })

  reg({
    name: 'memory_correct',
    description: '改一条记错的记忆。给 id（或 old_text）找旧条目，text 写新的说法；旧条目标成「已取代」，不再注入但留在库里（界面能看到），需要时还能 memory_forget 清掉。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '要改的记忆 id' },
        old_text: { type: 'string', description: '不知道 id 时给原句，按相似度找' },
        text: { type: 'string', description: '新的说法，一句话讲清' },
        scope: { type: 'string', description: '可选：kind:id，留空用当前会话的分片' },
      },
      required: ['text'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          id: { type: 'string' },
          oldId: { type: 'string' },
          scope: { type: 'string' },
          why: { type: 'string' },
        },
        required: ['ok'],
      },
      render: (_a, out) => content(out?.ok ? `[改了 ${out.oldId} → ${out.id}]` : `[没改成：${out?.why ?? '未知'}]`),
    },
    async execute(args) {
      const src = await activeSource()
      if (!src) return { ok: false, why: '不知道现在在跟谁说话' }
      const newText = redactText(String(args?.text ?? '').trim())
      if (!newText) return { ok: false, why: '新说法是空的' }
      const targetId = String(args?.id ?? '').trim()
      const oldText = String(args?.old_text ?? '').trim()

      const out = await withWriteLock(async () => {
        // 跨根找：要改的那条可能在仓库库里，不在当前个人分片里
        let sc = null
        let target = null
        if (targetId) {
          sc = await resolveScope(targetId, args?.scope)
          target = sc?.items.find((x) => x.id === targetId) ?? null
        }
        if (!target && oldText) {
          for (const s of await mountScopes()) {
            const hit = findSimilarItem(s.items, oldText, 0.6)
            if (hit?.item) { sc = s; target = hit.item; break }
          }
        }
        if (!target) return { ok: false, why: '没找到要改的那条' }
        if (!writableScope(viewingSource(), sc)) return { ok: false, why: denyWriteWhy(viewingSource(), sc) }
        if (target.state === 'archived' || target.state === 'superseded') {
          return { ok: false, why: '那条已经不在用了' }
        }

        const now = new Date().toISOString()
        const rt = resolveRelativeTime(newText, now)
        const item = addItem(sc, {
          text: newText,
          kind: target.kind,
          conf: Math.min(1, (target.conf ?? 0.6) + 0.1),
          source: 'tool-correct',
          sourceQuote: target.sourceQuote || '',
          scene: target.scene || '',
          atAbs: rt?.abs ?? '',
          observedAt: now,
          // 改说法不换人：继承旧条目的发言人；没有才退会话称呼（群里宁可空着）
          speaker: target.speaker || (src.kind === 'group' ? '' : (src.addr || '')),
          // 扩展类型的必填字段跟着旧条目走：改一句话不该让教训变成"缺 trigger"的废条目
          trigger: target.trigger || '',
          antiPattern: target.antiPattern || '',
          goal: target.goal || '',
          progress: target.progress || '',
          due: target.due || '',
          toWhom: target.toWhom || '',
        })
        if (!item) return { ok: false, why: '空的' }

        if (item.id === target.id) {
          // 新说法跟旧句太像，被当成「又提了一次」合并了：就地改文本
          item.text = newText
          if (rt?.abs) item.atAbs = rt.abs
        } else {
          target.state = 'superseded'
          target.validTo = now
          target.supersededBy = item.id
        }
        await reindexScope(rootOf(sc), sc)
        return { ok: true, id: item.id, oldId: target.id, scope: sc.scope, oldText: target.text, newText: item.text }
      })

      if (out.ok) {
        await auditWrite(root, {
          kind: 'tool-correct',
          scope: out.scope,
          item: out.id,
          replaced: out.oldId,
          old: String(out.oldText ?? '').slice(0, 120),
          text: String(out.newText ?? '').slice(0, 120),
        })
      }
      return out
    },
  })

  reg({
    name: 'memory_review',
    description: '记忆复审回写：系统提示里出现「记忆复审」提醒时，用这个写回结论和理由。写完提醒才消失；不写它每轮都在。',
    parameters: {
      type: 'object',
      properties: {
        verdict: {
          type: 'string',
          enum: ['yes', 'not-yet', 'broken', 'unsure'],
          description: 'yes=还在 / not-yet=还没到 / broken=断了 / unsure=说不清',
        },
        reason: { type: 'string', description: '具体理由：哪一刻、哪句话、哪件事。至少一句话，不写「就是感觉」' },
        relation: { type: 'string', description: '可选：这段关系叫什么（恋人 / 父女 / 朋友），yes 时填' },
      },
      required: ['verdict', 'reason'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          verdict: { type: 'string' },
          scope: { type: 'string' },
          relation: { type: 'object' },
          why: { type: 'string' },
        },
        required: ['ok'],
      },
      render: (_a, out) => content(out?.ok
        ? `[复审已记：${out.verdict}${out.relation?.label ? ` · ${out.relation.label}${out.relation.status === 'broken' ? '（已断）' : ''}` : ''}]`
        : `[没记：${out?.why ?? '未知'}]`),
    },
    async execute(args) {
      const src = viewingSource()
      if (!src) return { ok: false, why: '不知道现在在跟谁说话' }
      // 只审自己这一片：群审本群，私聊审自己。公共池、仓库库不做关系复审。
      if (!['private', 'group', 'local'].includes(src.kind)) {
        return { ok: false, why: '这个分片不做关系复审' }
      }
      const sc = await loadScope(root, src.kind, src.id).catch(() => null)
      if (!sc) return { ok: false, why: '分片读不到，先跑 rebuild-index' }
      const out = await markReviewed(root, {
        scope: sc,
        verdict: args?.verdict,
        reason: args?.reason,
        relationLabel: args?.relation,
      })
      if (out.ok) {
        await auditWrite(root, {
          kind: 'tool-review',
          scope: out.scope,
          verdict: out.verdict,
          reason: String(args?.reason ?? '').slice(0, 120),
        })
        // 回写成功就立刻撤掉注入缓存里的提醒，不用等下一轮巡检
        const sid = currentSid()
        if (sid) clearReview(sid)
      }
      return out
    },
  })

  reg({
    name: 'memory_forget',
    description: '删掉一条记错的、或不该记的记忆。给 id 最准，给 text 会按相似度找最像的一条。删掉的内容会进归档，能找回来。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '记忆 id（memory_recall / profile_show 里能看到格式，如 m_xxx）' },
        text: { type: 'string', description: '不确定 id 时给原句，按相似度匹配' },
        scope: { type: 'string', description: '可选：kind:id，留空用当前会话的分片' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          id: { type: 'string' },
          text: { type: 'string' },
          why: { type: 'string' },
        },
        required: ['ok'],
      },
      render: (_a, out) => content(out?.ok ? `[删了 ${out.id}：${out.text}]` : `[没删：${out?.why ?? '未知'}]`),
    },
    async execute(args) {
      const itemId = String(args?.id ?? '').trim()
      const text = String(args?.text ?? '').trim()
      if (!itemId && !text) return { ok: false, why: '要么给 id，要么给 text' }

      // 跨根找：删的是个人库还是仓库库，按条目实际在哪儿决定
      const found = await findTarget({ id: itemId, text, scopeArg: args?.scope })
      if (!found) return { ok: false, why: '没找到那条记忆' }
      const { sc, it: target } = found
      if (!writableScope(viewingSource(), sc)) return { ok: false, why: denyWriteWhy(viewingSource(), sc) }

      const r = await forgetItem(rootOf(sc), sc.kind, sc.id, target.id, { reason: 'tool' })
      if (!r.ok) return { ok: false, why: r.why }
      return { ok: true, id: target.id, text: String(target.text).slice(0, 80) }
    },
  })

  reg({
    name: 'memory_revive',
    description: '把删掉/归档/过期的记忆找回来。给 id；分片不确定就留空，全库按 id 查。'
      + '只在用户明确说「把那条找回来」时用；平时检索用 search_memory，别拿 revive 当搜索。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '记忆 id' },
        scope: { type: 'string', description: '可选：kind:id；留空全库找' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          id: { type: 'string' },
          scope: { type: 'string' },
          why: { type: 'string' },
        },
        required: ['ok'],
      },
      render: (_a, out) => content(out?.ok ? `[找回来了 ${out.id}]` : `[没找回来：${out?.why ?? '未知'}]`),
    },
    async execute(args) {
      const itemId = String(args?.id ?? '').trim()
      if (!itemId) return { ok: false, why: '缺 id' }
      const want = String(args?.scope ?? '').trim()
      let kind = ''
      let sid = ''
      if (want) {
        const parts = want.split(':')
        kind = parts[0] || ''
        sid = parts[1] || ''
      }
      // 跨根找：仓库库和个人库都试一遍，谁有就回谁那儿
      // 公共池只有本机能改：群/私聊里 revive 到公共条目要立刻拒绝，不能等下一个根说「没找到」
      const allowPublic = viewingSource()?.kind === 'local'
      let last = null
      for (const r of await roots()) {
        const out = await reviveItem(r, kind, sid, itemId, { allowPublic })
        if (out.ok) return out
        if (!allowPublic && /公共记忆池/.test(String(out.why ?? ''))) return out
        last = out
      }
      return last ?? { ok: false, why: '全库都没找到这条记忆' }
    },
  })

  reg({
    name: 'memory_diary',
    description: '看她写的日记。日记是她按当天记忆用自己口吻写的，不是记忆条目。action=read 读某天（默认昨天），list 列最近，write 写/重写当天。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['read', 'list', 'write'], description: '要做什么' },
        day: { type: 'string', description: 'YYYY-MM-DD；read 默认昨天，write 默认今天' },
        rewrite: { type: 'boolean', description: 'write 时这天已经写过，也覆盖重写' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          day: { type: 'string' },
          text: { type: 'string' },
          why: { type: 'string' },
        },
        required: ['ok'],
      },
      render: (_a, out) => content(out?.ok ? (out?.text || '[空的]') : `[日记没成：${out?.why ?? '未知'}]`),
    },
    async execute(args) {
      const action = String(args?.action ?? 'read').toLowerCase()
      const today = dayKey()
      if (action === 'list') {
        const items = await listDiaries(root, { limit: 14 })
        return {
          ok: true,
          text: items.length ? items.map((x) => `${x.day} · ${x.chars} 字`).join('\n') : '还没写过日记。',
        }
      }
      if (action === 'write') {
        const day = String(args?.day ?? '').trim() || today
        const r = await writeDiary(root, { day, force: args?.rewrite === true, log: say })
        if (!r.ok) {
          return { ok: false, why: r.why === 'empty' ? '今天没什么可写的' : (r.why || '没写成') }
        }
        const note = r.skipped === 'exists' ? '这天已经写过了，要覆盖重写就带 rewrite=true。\n\n' : ''
        return { ok: true, day: r.day, text: `${note}${r.title}\n\n${r.text}` }
      }
      if (action !== 'read') return { ok: false, why: `不认识的 action：${action}` }
      const day = String(args?.day ?? '').trim() || addDays(today, -1)
      const r = await readDiary(root, day)
      if (!r.ok) return { ok: false, why: r.why }
      return { ok: true, day: r.day, text: `${r.title}\n\n${r.text}` }
    },
  })

  return {
    dispose() {
      for (const d of disposers) { try { d() } catch { /* ignore */ } }
    },
  }
}
