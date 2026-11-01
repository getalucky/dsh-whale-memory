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
 * 工具 execute 拿不到会话 id（宿主只传 args），所以写入靠 ingest 维护的
 * 「最近活跃会话」推断。这里必须校验时效：私聊和群可能同时在说话，
 * 拿一条十分钟前的活跃记录去写，就是把群友的话记到老爹头上。
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { listScopes, loadScope, addItem, auditWrite, auditRead, findSimilarItem, withWriteLock, enforceCapacity, supersedeConflicts, ensureDirs } from './store.js'
import { vaultPaths, appendUsage } from './vault.js'
import { assertUsable } from './trust.js'
import { lastActive, flush } from './ingest.js'
import { noteSessionItem } from './inject.js'
import { renderMemory, decayScore } from './inject.js'
import { searchFunnel, funnelLine } from './funnel.js'
import { forgetItem, reviveItem } from './forget.js'
import { resolveRelativeTime } from './time.js'
import { reindexScope } from './maintain.js'
import { confirmItem } from './confirm.js'
import { KINDS, normalizeExtras, mapProgress } from './kinds.js'
import { registerProject } from './namespace.js'

const defineTool = (spec) => spec

const content = (text) => [{ type: 'text', text: String(text ?? '') }]

/** 活跃记录最多算十分钟；超了就当不知道现在在跟谁说话。 */
const ACTIVE_TTL = 10 * 60 * 1000

/**
 * direct 的放行信号（文档 7.7：只在三种情况免确认——用户说「记住」、纠正、
 * 明确长期偏好）。信号只从用户原话里找，模型自己写的 text 不算数。
 */
const DIRECT_QUOTE = /记住|记一下|记下|记牢|别忘了|别忘记|以后都|以后就|以后别|以后不要|说好了|约定|定下来|每次(?:都|要|别)|我喜欢|我不喜欢|我讨厌|我习惯|我的习惯|叫我|不对[，,]?是|不是[^，。]{0,8}是|错了|纠正|改成/

/** 当前活跃会话对应的来源。 */
export async function activeSource() {
  await flush()
  if (!lastActive.scope || !lastActive.sessionId) return null
  if (Date.now() - lastActive.at > ACTIVE_TTL) return null
  return lastActive.scope
}

export function registerTools(ctx, { root, log } = {}) {
  const say = log ?? (() => {})
  const disposers = []

  const reg = (spec) => {
    // 外部库未信任：所有记忆工具一律拒绝，宁可不回答，也不把可疑内容送进上下文
    const run = spec.execute
    spec.execute = async (args) => {
      const gate = await assertUsable(root)
      if (!gate.ok) return { ok: false, why: gate.why }
      return run(args)
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
   * 当前会话挂的仓库命名空间。工具拿不到 agent，只能靠 ingest 记下的
   * 「最近活跃」推断；十分钟不说话的旧记录不能拿来决定往哪个仓库写。
   */
  function activeNs() {
    if (!lastActive.sessionId) return null
    if (Date.now() - lastActive.at > ACTIVE_TTL) return null
    return lastActive.ns || null
  }

  /** 本会话要看的根：仓库在前，个人库在后；没仓库就只有个人库。 */
  function roots() {
    const ns = activeNs()
    return ns?.root && ns.root !== root ? [ns.root, root] : [root]
  }

  /** 跨根列出全部分片，并标上它属于哪个根（写入必须回到原根）。 */
  async function mountScopes() {
    const out = []
    for (const r of roots()) {
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
                tags: { type: 'array', items: { type: 'string' } },
                weight: { type: 'number' },
                timeline: { type: 'string' },
                why: { type: 'string' },
              },
            },
          },
          text: { type: 'string' },
        },
        required: ['ok', 'count', 'results', 'text'],
      },
      render: (_a, out) => content(out?.ok ? (out.count ? out.text : '没找到。') : '[查记忆失败]'),
    },
    async execute(args) {
      const t0 = Date.now()
      const q = String(args?.query ?? '').trim()
      const want = String(args?.scope ?? '').trim()
      const tags = (Array.isArray(args?.tags) ? args.tags : String(args?.tags ?? '').split(/[,，\s]+/))
        .map((x) => String(x).trim()).filter(Boolean)
      let scopes = await mountScopes()
      if (want) scopes = scopes.filter((s) => s.scope === want)

      const top = searchFunnel(scopes, { query: q, tags, hops: true, topK: 8 }).slice(0, 8)
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
          tags: x.tags,
          weight: Number((x.weight || 0).toFixed(2)),
          timeline: x.timeline,
          why: x.why.join('；'),
        })),
        text: top.map((x) => funnelLine(x) + (x.hop ? '（' + x.why[x.why.length - 1] + '）' : '')).join('\n'),
      }
    },
  })

  reg(searchSpec('search_memory', '查记忆目录（副库）。给关键词或标签，返回 id、摘要、标签、权重；要正文再用 read_memory(id)。'))
  // 旧名兼容：改名时同时注册别名，别让旧编排突然 unknown tool
  reg(searchSpec('memory_recall', '旧名，等价于 search_memory（兼容用）。'))

  reg({
    name: 'read_memory',
    description: '读一条记忆的正文。默认返回「提炼 + 背景」，section 可选 完整记录/来源/full；单次有 token 上限。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '记忆 id，从 search_memory 结果里拿' },
        section: { type: 'string', description: '可选：背景 / 完整记录 / 提炼 / 来源 / full' },
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
    const p = vaultPaths(rootOf(sc), sc.kind, sc.id)
    // 粗粒度配额：60 秒窗口内最多读 3 次。宿主没给 turn id，只能按时间近似，
    // 目的不是卡准，是防止模型在一个回合里把库翻个底朝天。
    try {
      const rows = (await readFile(p.usage, 'utf8')).split('\n').filter(Boolean)
      const since = Date.now() - 60 * 1000
      let recent = 0
      for (const line of rows) {
        try {
          const r = JSON.parse(line)
          if (r.tool === 'read_memory' && Date.parse(r.at) >= since) recent += 1
        } catch { /* 坏行跳过 */ }
      }
      if (recent >= 3) return { ok: false, why: '这个回合已经读了 3 条，先用手上的内容回答' }
    } catch { /* 没有 usage 文件就是第一次读 */ }

    let raw = ''
    try {
      raw = await readFile(join(p.full, id + '.md'), 'utf8')
    } catch {
      return { ok: false, why: '主库文件不见了，跑 rebuild-index' }
    }

    const body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')
    const section = String(args?.section ?? '').trim()
    let text = ''
    if (section === 'full') text = body.trim()
    else if (section) text = sectionOf(body, section)
    // 要点只在扩展类型（教训/话题/承诺）里有：触发条件、目标、到期不能丢
    else text = [sectionOf(body, '提炼'), sectionOf(body, '要点'), sectionOf(body, '背景')].filter(Boolean).join('\n\n')
    if (!text) text = sectionOf(body, '完整记录') || body.trim()

    const maxTokens = Math.max(200, Math.min(1200, Number(args?.max_tokens) || 800))
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
    if (lastActive.sessionId && Date.now() - lastActive.at < 10 * 60 * 1000) {
      noteSessionItem(root, lastActive.sessionId, 'read', id)
    }
    return { ok: true, id, scope: sc.scope, section: section || '提炼', tokens, text }
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
          // 仓库分片在仓库根下：当前会话在哪个仓库，就只能读那个仓库的
          if (kind === 'project' && activeNs()) base = activeNs().root
        }
      } else {
        // 仓库会话默认看仓库画像；没有仓库再退回个人分片
        const ns = activeNs()
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
    description: '把一句值得记住的话写进当前对话的记忆里。必须带用户原话片段 source_quote；写之前先 search_memory 查重。'
      + '扩展类型各自带必填字段：lesson（trigger「当……时」+ anti_pattern）、topic（goal）、commitment（due + to_whom）。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要记的那句话，一句话讲清事实' },
        kind: { type: 'string', enum: KINDS, description: '类型，默认 fact。lesson=教训 / topic=进行中话题 / commitment=承诺' },
        source_quote: { type: 'string', description: '用户原话片段，至少 8 个字；没有原话不许写' },
        tags: { type: 'array', items: { type: 'string' }, description: '可选：2-5 个标签，系统会归一化到受控词表' },
        namespace: { type: 'string', enum: ['global', 'project'], description: '可选：project = 跟这个仓库绑的共识，存进仓库的 .dsh/storages（可随 git 分享）；不填 global = 个人记忆库' },
        mode: { type: 'string', enum: ['confirm', 'direct'], description: '可选：不填就按原话自动判断——原话里有「记住 / 纠正 / 长期偏好」才直接生效，否则进待确认。direct 也不能绕过这个判断' },
        trigger: { type: 'string', description: 'lesson 必填：在什么情况下适用，必须写成「当……时」' },
        anti_pattern: { type: 'string', description: 'lesson 必填：踩过的坑 / 以后别再怎么做' },
        goal: { type: 'string', description: 'topic 必填：一句话说清这件事要做成什么' },
        status: { type: 'string', description: 'topic 可选：进行中 / 暂停 / 已完成；状态变化优先用 memory_update' },
        due: { type: 'string', description: 'commitment 必填：到期日期（2026-11-05）或条件（下次提到 X 时）' },
        to_whom: { type: 'string', description: 'commitment：答应的是谁；私聊不填默认「你」' },
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
        targetRoot = ns.root
        tKind = ns.kind
        tId = ns.id
        await ensureDirs(targetRoot)
        // 登记到 global 库：遗忘/深化循环才知道这个仓库库也要扫
        await registerProject(root, ns).catch(() => {})
      }
      const quote = String(args?.source_quote ?? '').trim()
      if (quote.length < 8) return { ok: false, why: 'source_quote 至少 8 个字，得是用户原话片段' }
      const kind = String(args?.kind ?? 'fact').trim() || 'fact'
      if (!KINDS.includes(kind)) return { ok: false, why: `不认识的类型：${kind}` }

      // 只认原话里的信号：模型给 mode=direct 但原话没信号，一样进待确认
      const mode = String(args?.mode ?? '').trim()
      const hint = DIRECT_QUOTE.test(quote)
      const direct = mode === 'direct' ? hint : mode === 'confirm' ? false : hint

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
        trigger: args?.trigger,
        antiPattern: args?.anti_pattern,
        goal: args?.goal,
        progress: args?.status,
        due,
        toWhom,
      }, new Date(now))
      if (!ext.ok) return { ok: false, why: ext.why }

      const out = await withWriteLock(async () => {
        const sc = await loadScope(targetRoot, tKind, tId)
        const before = sc.items.length
        // 库里已经有同一条（而且是生效的），这次又没带「记住」：不要拿一条待确认去给旧条目加命中。
        // 话题例外：话题的「更新」就是合并，交给 addItem 刷新 progress / last_touched。
        const dup = findSimilarItem(sc.items, String(args?.text ?? ''), kind === 'topic' ? 0.45 : 0.72, { kind })
        if (dup && dup.item.state !== 'suggested' && !direct && kind !== 'topic') {
          return { ok: true, id: dup.item.id, scope: sc.scope, status: 'exists', committed: true, why: '库里已经有同一条，没重复记' }
        }
        // 手动记的时候也把「明天」锚掉，不然只有蒸馏链路有时间，工具写的是裸句子
        const rt = resolveRelativeTime(args?.text, now)
        const it = addItem(sc, {
          text: args?.text,
          kind,
          conf: direct ? 0.8 : 0.5,
          source: 'tool',
          sourceQuote: quote,
          atAbs: rt?.abs ?? '',
          observedAt: now,
          speaker: src.addr || '',
          state: direct ? 'active' : 'suggested',
          ...ext.fields,
        })
        if (!it) return { ok: false, why: '空的' }
        if (Array.isArray(args?.tags) && args.tags.length) it.tags = args.tags.map(String).slice(0, 5)

        const merged = sc.items.length === before
        // 同一条之前是待确认，用户这回明确说「记住」：就地转正，不新建
        if (merged && direct && it.state === 'suggested') {
          it.state = 'active'
          it.conf = Math.max(it.conf, 0.7)
          it.lastHit = now
          supersedeConflicts(sc, it, now)
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
          why: direct ? '' : '原话里没有「记住 / 纠正 / 长期偏好」的信号，先放待确认',
        }
      })
      if (out.ok) {
        if (lastActive.sessionId && Date.now() - lastActive.at < 10 * 60 * 1000) {
          noteSessionItem(root, lastActive.sessionId, 'write', out.id)
        }
        await auditWrite(root, {
          kind: 'tool-save',
          scope: out.scope,
          item: out.id,
          merged: out.merged,
          status: out.status,
        })
      }
      return out
    },
  })

  reg({
    name: 'memory_update',
    description: '更新一条已有话题或承诺：话题改进展（进行中/暂停/已完成）、承诺改到期或对象。只改状态，不新建条目，也不碰正文。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '话题 / 承诺的 id（search_memory 或骨架提醒里能看到）' },
        scope: { type: 'string', description: '可选：kind:id；留空全库按 id 找' },
        status: { type: 'string', description: '话题进展：进行中 / 暂停 / 已完成' },
        goal: { type: 'string', description: '可选：改话题目标句' },
        due: { type: 'string', description: '可选：改承诺到期（日期或「下次提到 X 时」）' },
        to_whom: { type: 'string', description: '可选：改承诺对象' },
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
          why: { type: 'string' },
        },
        required: ['ok'],
      },
      render: (_a, out) => content(
        out?.ok
          ? `[更新了 ${out.id}${out.progress ? ` · ${out.progress}` : ''}${out.due ? ` · ${out.due}` : ''}]`
          : `[没更新：${out?.why ?? '未知'}]`,
      ),
    },
    async execute(args) {
      const id = String(args?.id ?? '').trim()
      if (!id) return { ok: false, why: '缺 id' }
      const out = await withWriteLock(async () => {
        const sc = await resolveScope(id, args?.scope)
        if (!sc) return { ok: false, why: '没有这条记忆' }
        const it = (sc.items || []).find((x) => x.id === id)
        if (!it) return { ok: false, why: '没有这条记忆' }
        if (it.kind !== 'topic' && it.kind !== 'commitment') {
          return { ok: false, why: '只有话题和承诺能这样更新' }
        }
        const now = new Date().toISOString()
        if (it.kind === 'topic') {
          const p = mapProgress(args?.status)
          if (p) it.progress = p
          const goal = String(args?.goal ?? '').trim()
          if (goal) it.goal = goal
          // 话题更新只改状态与 last_touched，不新建条目
          it.lastTouched = now
        } else {
          const due = String(args?.due ?? '').trim()
          if (due) it.due = resolveRelativeTime(due, now)?.abs || due
          const to = String(args?.to_whom ?? '').trim()
          if (to) it.toWhom = to
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
        }
      })
      if (out.ok) {
        await auditWrite(root, { kind: 'tool-update', scope: out.scope, item: id, progress: out.progress, due: out.due }).catch(() => {})
      }
      return out
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
      const ns = activeNs()
      const targets = []
      if (want) {
        const [kind, id] = want.split(':')
        if (kind && id) targets.push({ root: kind === 'project' && ns ? ns.root : root, kind, id })
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
      const out = await withWriteLock(async () => {
        const sc = await resolveScope(id, args?.scope)
        if (!sc) return { ok: false, why: '没有这条记忆' }
        return confirmItem(rootOf(sc), sc.kind, sc.id, id)
      })
      if (out.ok) {
        await auditWrite(root, { kind: 'tool-confirm', scope: out.scope, item: id })
        if (lastActive.sessionId && Date.now() - lastActive.at < 10 * 60 * 1000) {
          noteSessionItem(root, lastActive.sessionId, 'write', id)
        }
      }
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
      const newText = String(args?.text ?? '').trim()
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
          atAbs: rt?.abs ?? '',
          observedAt: now,
          speaker: src.addr || '',
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

      const r = await forgetItem(rootOf(sc), sc.kind, sc.id, target.id, { reason: 'tool' })
      if (!r.ok) return { ok: false, why: r.why }
      return { ok: true, id: target.id, text: String(target.text).slice(0, 80) }
    },
  })

  reg({
    name: 'memory_revive',
    description: '把删掉/归档/过期的记忆找回来。给 id；分片不确定就留空，全库按 id 查。',
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
      let last = null
      for (const r of roots()) {
        const out = await reviveItem(r, kind, sid, itemId)
        if (out.ok) return out
        last = out
      }
      return last ?? { ok: false, why: '全库都没找到这条记忆' }
    },
  })

  return {
    dispose() {
      for (const d of disposers) { try { d() } catch { /* ignore */ } }
    },
  }
}
