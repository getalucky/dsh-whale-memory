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

import { listScopes, loadScope, saveScope, addItem, touchItem, appendSearchHits, autoPinWhy, setPin, enforcePinCap, auditWrite, auditRead, findSimilarItem, withWriteLock, enforceCapacity, supersedeConflicts, ensureDirs } from './store.js'
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
import { visibleScope, writableScope, filterScopes, denyWhy, denyWriteWhy } from './visibility.js'
import { registerProject } from './namespace.js'
import { loadDocs, addEntry, recordOutcome, promoteMemory, DOCS } from './agentdoc.js'
import { gateMode, gateDecision } from './gate.js'
import { writeDiary, readDiary, listDiaries, addDays } from './diary.js'
import { dayKey } from './beat/schedule.js'

const defineTool = (spec) => spec

const content = (text) => [{ type: 'text', text: String(text ?? '') }]

/** 活跃记录最多算十分钟；超了就当不知道现在在跟谁说话。 */
const ACTIVE_TTL = 10 * 60 * 1000

/**
 * 可见性用的来源，比写入宽松（2 小时）：读错分片只是少查一条，
 * 写错分片才是把群友的话记到老爹头上。过期宁可当「不知道」按最窄算。
 */
const VIEW_TTL = 2 * 60 * 60 * 1000

function viewingSource() {
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

/** 当前活跃会话对应的来源。 */
export async function activeSource() {
  await flush()
  if (!lastActive.scope || !lastActive.sessionId) return null
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
                tags: { type: 'array', items: { type: 'string' } },
                weight: { type: 'number' },
                timeline: { type: 'string' },
                pinned: { type: 'boolean' },
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
          tags: x.tags,
          weight: Number((x.weight || 0).toFixed(2)),
          timeline: x.timeline,
          pinned: !!x.pinned,
          why: x.why.join('；'),
        })),
        text: top.map((x) => (x.pinned ? '[知识] ' : '') + funnelLine(x) + (x.hop ? '（' + x.why[x.why.length - 1] + '）' : '')).join('\n'),
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
    // 群会话拿到 id 也不能读私聊正文：id 可能来自旧骨架里的引用或别人递进来的数字
    if (!visibleScope(viewingSource(), sc)) return { ok: false, why: denyWhy(viewingSource()) }
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
    // 读了正文才算「用上了」：刷新命中与新近度，下一次检索排前面。
    // 搜到没读的不算，避免搜索热度把条目养虚（文档 8.2 的访问强化口径）。
    const it = (sc.items || []).find((x) => x.id === id)
    if (it && it.state !== 'suggested') {
      touchItem(sc, id)
      await saveScope(rootOf(sc), sc).catch(() => {})
    }
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
          if (!visibleScope(viewingSource(), src)) {
            readAudit({ kind: 'profile', tool: 'profile_show', scope: want, ok: false, denied: true, ms: Date.now() - t0 })
            return { ok: false, why: denyWhy(viewingSource()) }
          }
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
        kind: { type: 'string', enum: KINDS, description: '类型，默认 fact。knowledge=知识（进公共知识库，不随时间遗忘）/ lesson=教训 / topic=进行中话题 / commitment=承诺' },
        source_quote: { type: 'string', description: '用户原话片段，至少 8 个字；没有原话不许写' },
        tags: { type: 'array', items: { type: 'string' }, description: '可选：2-5 个标签，系统会归一化到受控词表' },
        pin: { type: 'boolean', description: '可选：钉住成长期知识，不参与时间衰减；群/私聊不能改公共池' },
        namespace: { type: 'string', enum: ['global', 'project', 'public'], description: '可选：project = 跟这个仓库绑的共识，存进仓库的 .dsh/storages（可随 git 分享）；public = 公共记忆池（网上学到的公开内容，所有会话可读，只有本机能写）；不填 global = 个人记忆库' },
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
      if (quote.length < 8) return { ok: false, why: 'source_quote 至少 8 个字，得是用户原话片段' }
      const kind = String(args?.kind ?? 'fact').trim() || 'fact'
      if (!KINDS.includes(kind)) return { ok: false, why: `不认识的类型：${kind}` }
      // 公共池是外部情报：教训/话题/承诺都是私人语境里的东西，写进去别人也会读到。
      // knowledge 例外——知识库本来就要所有会话都能查。
      if (tKind === 'public' && !['fact', 'event', 'pref', 'knowledge'].includes(kind)) {
        return { ok: false, why: '公共池只收事实、事件、偏好、知识；教训、话题、承诺写进自己那层。' }
      }

      // 只认原话里的信号：模型给 mode=direct 但原话没信号，一样进待确认
      const saveMode = String(args?.mode ?? '').trim()
      const hint = DIRECT_QUOTE.test(quote)
      const direct = saveMode === 'direct' ? hint : saveMode === 'confirm' ? false : hint
      // 自动钉住：手动要求、知识类型、或原话里明说要长期留着
      const pinWhy = args?.pin === true ? 'manual' : kind === 'knowledge' ? 'knowledge' : PIN_QUOTE.test(quote) ? 'explicit' : ''
      // 灰度三态（文档 4.6）：off/warn 都放行，只有 enforce 真拦
      const dec = gateDecision(gateLevel, direct)

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
          // 公共池是外部情报，置信度压一档；而且本机显式写就是决意记下，不再走待确认
          conf: tKind === 'public' ? 0.55 : (dec.state === 'active' ? (direct ? 0.8 : 0.55) : 0.5),
          source: 'tool',
          sourceQuote: quote,
          atAbs: rt?.abs ?? '',
          observedAt: now,
          speaker: src.addr || '',
          state: tKind === 'public' ? 'active' : dec.state,
          pin: !!pinWhy,
          pinWhy,
          ...ext.fields,
        })
        if (!it) return { ok: false, why: '空的' }
        // warn 放行了，但得在条目上留个记号：事后能算出「这一条 enforce 会拦」
        if (dec.gate && it.state !== 'suggested') it.gate = dec.gate
        if (Array.isArray(args?.tags) && args.tags.length) it.tags = args.tags.map(String).slice(0, 5)

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
        if (lastActive.sessionId && Date.now() - lastActive.at < 10 * 60 * 1000) {
          noteSessionItem(root, lastActive.sessionId, 'write', out.id)
        }
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
        if (!writableScope(viewingSource(), sc)) return { ok: false, why: denyWriteWhy(viewingSource(), sc) }
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
    name: 'memory_pin',
    description: '把一条记忆钉成长期知识（不随时间遗忘、不归档），或松开。知识库落在公共池，所有会话可读；只有本机能改公共池。',
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
      const ns = activeNs()
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
        if (!writableScope(viewingSource(), sc)) return { ok: false, why: denyWriteWhy(viewingSource(), sc) }
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
      if (!writableScope(viewingSource(), sc)) return { ok: false, why: denyWriteWhy(viewingSource(), sc) }

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
      // 公共池只有本机能改：群/私聊里 revive 到公共条目要立刻拒绝，不能等下一个根说「没找到」
      const allowPublic = viewingSource()?.kind === 'local'
      let last = null
      for (const r of roots()) {
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
