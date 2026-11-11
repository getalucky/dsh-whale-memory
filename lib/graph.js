/**
 * graph.js —— L3 知识图谱
 *
 * 记忆条目是一句句话（L2），图谱把它们拆成「实体 —关系→ 实体」：
 *   老爹 —上班@→ 公司
 *   老爹 —住在→ D 盘
 *
 * 第一版同样是规则抽取（不调 LLM），只认几种明确的句式：
 *   在X上班/工作/上课   住在X   喜欢/讨厌/怕 X   养了X   我叫X   X是Y
 * 抽不出来就不抽——宁可图谱稀一点，也不要瞎连边。
 *
 * 存储：graph/nodes.jsonl + graph/edges.jsonl，每次刷新整份重写（原子写）。
 * 图谱是全局的：私聊和群共用一个实体表，靠 refs 记住这条边来自哪个分片。
 */

import { readJsonl, writeAtomic, paths, normalizeText } from './store.js'

const OWNER_ALIASES = new Set(['我', '老爹', '爹', '老爸'])

/** 能当地名的尾缀。宁缺毋滥：认错了比不抽更糟。 */
const PLACE_TAIL = /(市|省|区|县|镇|村|路|街|楼|园|州|国|站|馆|店|岛|山|河|江|湖|海|盘|港|机场|学校|公司)$/

/**
 * 时间词和副词不是实体。
 * 「明天也是8:30上班」被拆成「明天也 —是→ 8:30上班」，就是这里漏了过滤。
 */
const NOT_ENTITY = /^(今天|明天|后天|昨天|前天|大后天|今年|明年|去年|上午|下午|晚上|早上|中午|半夜|凌晨|刚才|刚刚|现在|马上|待会|等下|等会|一会|一会儿|最近|周末|月底|年底|周一|周二|周三|周四|周五|周六|周日|周天|以后|下次|上次|这次|之前|后来|也|都|还|就|才|又|再|很|太|更|只|先|大概|应该|可能)/

/** 谓语尾巴：「8:30上班」是动作，不是东西。 */
const VERB_TAIL = /(上班|下班|上课|上学|放学|吃饭|睡觉|开会|加班|出门|回家|休息)$/

/** 泛称和代词不是实体：模型和规则都别拿它们当节点。 */
const PLACEHOLDER = /^(用户|某人|有人|对方|大家|众人|我|你|他|她|它)/

export const NODE_TYPES = ['person', 'place', 'org', 'thing', 'event']

function nodeId(name) {
  return `n_${normalizeText(name).slice(0, 40)}`
}

function clean(s) {
  return String(s ?? '')
    .replace(/^[，。、！？；：\s]+|[，。、！？；：\s]+$/g, '')
    .replace(/\s+/g, '')
    .trim()
}

/** 名词太长基本是句子而不是实体，直接放弃。 */
function okEntity(s, max = 14) {
  const v = clean(s)
  if (v.length < 1 || v.length > max) return ''
  if (NOT_ENTITY.test(v) || PLACEHOLDER.test(v)) return ''
  return v
}

/**
 * 从一句话里抽三元组。
 * 主语必须是句中真写了的：句首的「我/老爹」或动词前那截名词。
 * 抽不出主语就不抽——把别人的事记到老爹头上比漏记更糟。
 *
 * @param {string} text
 * @param {{self?: string|null}} [opts]
 *   self = 这个分片里「我」指谁（私聊给「老爹」；群里给 null，
 *   因为群里的「我」可能是任何群友，认错了比不记更糟）。
 * @returns {{s:string,sType:string,rel:string,o:string,oType:string}[]}
 */
export function extractTriples(text, opts = {}) {
  const self = opts.self === undefined ? null : opts.self
  const t = clean(text)
  if (!t || t.length < 3) return []
  const out = []
  const push = (s, sType, rel, o, oType) => {
    const S = okEntity(s, 10)
    const O = okEntity(o)
    if (!S || !O) return
    out.push({ s: S, sType, rel, o: O, oType })
  }

  // 拆主语：句首的「我/老爹」，否则看动词前有没有一段短名词
  const mOwner = /^(老爹|爹|老爸|我)/.exec(t)
  let subj = mOwner ? mOwner[1] : ''
  let body = mOwner ? t.slice(subj.length) : t
  if (subj === '我') {
    // 群里认不出「我」是谁 → 整句不抽；私聊里「我」就是主人
    if (!self) return []
    subj = self
  } else if (OWNER_ALIASES.has(subj)) {
    subj = self || '老爹'
  }
  if (!subj) {
    const sp = /^([^，。！？]{1,8}?)(?=住在|在|最喜欢|不喜欢|喜欢|讨厌|怕|爱|养了)/.exec(body)
    if (sp && okEntity(sp[1], 8)) {
      subj = sp[1]
      body = body.slice(subj.length)
    }
  }

  const relRules = [
    [/^[^，。]{0,4}?在([^，。！？]{1,20}?)(?:上班|工作|上课|上学|读书)/, () => '上班@', 'place'],
    [/^[^，。]{0,4}?住在([^，。！？]{1,40})/, () => '住在', 'place'],
    [/^(?:最|比较|特别|很)?(喜欢|讨厌|不喜欢|怕|爱)([^，。！？]{1,40})/, (m) => m[1], 'thing'],
    [/^养了([^，。！？]{1,40})/, () => '养了', 'thing'],
    // 「在杭州」这种裸地点：只认地名尾缀，否则「在这里」也会被当成实体
    [/^在([^，。！？]{2,14})$/, (m) => (PLACE_TAIL.test(m[1]) ? '在' : ''), 'place'],
  ]

  if (subj) {
    for (const [re, rel, oType] of relRules) {
      const m = re.exec(body)
      if (!m) continue
      const relName = rel(m)
      if (!relName) continue
      const obj = m.length > 2 ? m[2] : m[1]
      push(subj, 'person', relName, obj, oType)
    }
  }

  // 我叫 X / 名字叫 X
  const mName = /(?:我叫|名字叫)([^，。！？]{1,8})/.exec(t)
  if (mName && subj) push(subj, 'person', '叫', mName[1], 'person')

  // X 自称是 Y：别把「自称」算进主语，也避免再被下面的「X是Y」拆一遍
  const mSelf = /^([^，。！？]{1,10}?)自称是([^，。！？]{1,14})$/.exec(t)
  if (mSelf) push(mSelf[1], 'person', '自称是', mSelf[2], 'person')

  // X 是 Y（只说「是」，避免把「是不是」也算进来）
  // 两侧都得像名词短语：主语带「也/都/就」或时间词，宾语带谓语尾巴的，
  // 基本是「明天也是8:30上班」这种句子，不是「A 是 B」。
  // 「以后是不是还得配个产检系统」「用户询问是否需要…」也栽在这：
  // 一个是时间词开头，一个是「询问」这种动词短语当主语，都不是实体关系。
  const mIs = /^([^，。！？]{1,8}?)是([^，。！？]{1,14})$/.exec(t)
  if (
    mIs &&
    !/[吗呢吧]$/.test(mIs[2]) &&
    !/是不是|是否|要不要|能不能|会不会|有没有/.test(t) &&
    !/[昵称自称名字]$/.test(mIs[1]) &&
    !/^(询问|提问|问|说|觉得|认为|表示|提到|讨论|决定|建议|要求|希望)/.test(mIs[1]) &&
    !NOT_ENTITY.test(mIs[1]) &&
    !/[也都还就才又再]/.test(mIs[1]) &&
    !VERB_TAIL.test(mIs[2])
  ) push(mIs[1], 'person', '是', mIs[2], 'thing')

  return out
}

/** 实体类型粗判：能当人的词。 */
function guessType(name) {
  if (OWNER_ALIASES.has(name)) return 'person'
  if (/(公司|学校|店|厂|局|院|部|组|群)$/.test(name)) return 'org'
  if (/(市|省|区|县|镇|村|路|街|楼|家|室|盘|镇)$/.test(name)) return 'place'
  return 'thing'
}

/** LLM 抽取的实体类型；模型乱报的类型按 guessType 兜底。 */
const ENTITY_TYPES = new Set(NODE_TYPES)

/**
 * 从全部分片重建图谱。
 * @param {object[]} scopes
 * @param {object[]} [llmTriples] 落盘的 LLM 三元组（graph/triples.jsonl）
 * @returns {{nodes:object[], edges:object[]}}
 */
export function buildGraph(scopes = [], llmTriples = []) {
  const nodes = new Map()
  const edges = new Map()
  const live = new Map()
  const ruleSeen = new Set()

  const node = (name, type) => {
    const id = nodeId(name)
    let n = nodes.get(id)
    if (!n) {
      n = { id, name, type: type || guessType(name), aliases: [], mentions: 0, scopes: [], texts: [] }
      nodes.set(id, n)
    }
    if (type === 'person' && n.type !== 'person') n.type = 'person'
    return n
  }

  const addTriple = (sc, it, tr, origin = '') => {
    const S = okEntity(tr.s, 20)
    const O = okEntity(tr.o, 20)
    const rel = clean(tr.rel).slice(0, 12)
    if (!S || !O || !rel) return
    const s = node(S, tr.sType === 'person' ? 'person' : (ENTITY_TYPES.has(tr.sType) ? tr.sType : ''))
    const o = node(O, tr.oType)
    s.mentions += 1
    o.mentions += 1
    const sample = String(it.text || '').slice(0, 120)
    for (const n of [s, o]) {
      if (!n.scopes.includes(sc.scope)) n.scopes.push(sc.scope)
      if (!Array.isArray(n.texts)) n.texts = []
      if (sample && n.texts.length < 6 && !n.texts.includes(sample)) n.texts.push(sample)
    }

    const key = `${s.id}|${rel}|${o.id}`
    const e = edges.get(key)
    if (e) {
      e.weight += 1 + Math.max(0, (it.hits || 0) * 0.2)
      e.updated = it.lastHit || e.updated
      if (!Array.isArray(e.scopes)) e.scopes = e.scope ? [e.scope] : []
      if (!e.scopes.includes(sc.scope)) e.scopes.push(sc.scope)
      // 同一关系可能来自多句记忆；留最近几条原文，点开关系时能对回出处
      const sample2 = String(it.text || '').slice(0, 120)
      if (!Array.isArray(e.texts)) e.texts = e.text ? [e.text] : []
      if (sample2 && e.texts.length < 5 && !e.texts.includes(sample2)) e.texts.push(sample2)
    } else {
      edges.set(key, {
        id: `e_${edges.size + 1}`,
        from: s.id,
        to: o.id,
        rel,
        weight: 1 + Math.max(0, (it.hits || 0) * 0.2),
        scope: sc.scope,
        scopes: [sc.scope],
        text: String(it.text || '').slice(0, 80),
        texts: [String(it.text || '').slice(0, 120)].filter(Boolean),
        created: it.created,
        updated: it.lastHit || it.created,
        ...(origin === 'llm' ? { origin: 'llm' } : {}),
      })
    }
  }

  for (const sc of scopes) {
    // 「我」在私聊里就是主人；群里认不出是谁，宁可这条不抽
    const self = sc.kind === 'private' ? '老爹' : null
    for (const it of sc.items || []) {
      if (it.state === 'archived' || it.state === 'superseded' || it.state === 'suggested' || it.state === 'expired') continue
      live.set(it.id, { sc, it })
      for (const tr of extractTriples(it.text, { self })) {
        addTriple(sc, it, tr)
        const sId = nodeId(tr.s)
        const oId = nodeId(tr.o)
        ruleSeen.add(`${it.id}|${sId}|${clean(tr.rel).slice(0, 12)}|${oId}`)
      }
    }
  }

  // 模型抽的关系：只认还活着、没被规则重复抽中的条目，旧图不会因为删条目留下孤边。
  for (const t of llmTriples || []) {
    const hit = live.get(String(t?.item ?? ''))
    if (!hit || t?.checked) continue
    const S = clean(t.s)
    const O = clean(t.o)
    const rel = clean(t.rel).slice(0, 12)
    if (!S || !O || !rel) continue
    if (ruleSeen.has(`${hit.it.id}|${nodeId(S)}|${rel}|${nodeId(O)}`)) continue
    addTriple(hit.sc, hit.it, {
      s: S,
      sType: ENTITY_TYPES.has(t.sType) ? t.sType : '',
      rel,
      o: O,
      oType: ENTITY_TYPES.has(t.oType) ? t.oType : '',
    }, 'llm')
  }

  return { nodes: [...nodes.values()], edges: [...edges.values()] }
}

/** 读 LLM 三元组（没有就返回空）。 */
export async function loadTriples(root) {
  return readJsonl(paths(root).triples)
}

/** 落盘 LLM 三元组；整份重写。 */
export async function saveTriples(root, rows = []) {
  await writeAtomic(paths(root).triples, rows.map((x) => JSON.stringify(x)).join('\n') + (rows.length ? '\n' : ''))
  return rows
}

/** 三元组去重键；没抽到东西的条目用 checked 标记，回填时别再重复请求。 */
function tripleKey(t) {
  if (t?.checked) return `${String(t.item ?? '')}|#checked`
  return `${String(t?.item ?? '')}|${normalizeText(t?.s || '')}|${clean(t?.rel || '')}|${normalizeText(t?.o || '')}`
}

/** 合并新旧三元组：同一条记忆的同一个三元组只留一份。 */
export function mergeTriples(existing = [], incoming = []) {
  const map = new Map()
  for (const t of existing || []) {
    const k = tripleKey(t)
    if (k && !k.startsWith('|')) map.set(k, t)
  }
  for (const t of incoming || []) {
    const k = tripleKey(t)
    if (!k || k.startsWith('|')) continue
    map.set(k, { ...t, at: t.at || new Date().toISOString() })
  }
  return [...map.values()]
}

/** 读磁盘上的图谱（没有就返回空）。 */
export async function loadGraph(root) {
  const p = paths(root)
  const nodes = await readJsonl(p.nodes)
  const edges = await readJsonl(p.edges)
  return { nodes, edges }
}

/** 落盘：nodes/edges 各一份 jsonl，整份重写。 */
export async function saveGraph(root, g) {
  const p = paths(root)
  await writeAtomic(p.nodes, g.nodes.map((n) => JSON.stringify(n)).join('\n') + (g.nodes.length ? '\n' : ''))
  await writeAtomic(p.edges, g.edges.map((e) => JSON.stringify(e)).join('\n') + (g.edges.length ? '\n' : ''))
  return g
}

/** 扫全部分片重建并落盘。 */
export async function refreshGraph(root, scopes) {
  const g = buildGraph(scopes, await loadTriples(root))
  await saveGraph(root, g)
  return g
}

/** 找实体（按名字或别名，忽略大小写/全半角）。 */
export function findNode(g, name) {
  const key = normalizeText(name)
  return (g.nodes || []).find((n) => normalizeText(n.name) === key || (n.aliases || []).some((a) => normalizeText(a) === key)) || null
}

/** N 跳邻居。返回 {nodes, edges}。 */
export function neighbors(g, name, depth = 1) {
  const start = findNode(g, name)
  if (!start) return { nodes: [], edges: [] }
  const seen = new Set([start.id])
  const edgeSeen = new Set()
  let frontier = [start.id]
  for (let d = 0; d < depth; d++) {
    const next = []
    for (const e of g.edges || []) {
      if (!frontier.includes(e.from) && !frontier.includes(e.to)) continue
      if (!edgeSeen.has(e.id)) edgeSeen.add(e.id)
      for (const id of [e.from, e.to]) {
        if (!seen.has(id)) {
          seen.add(id)
          next.push(id)
        }
      }
    }
    frontier = next
    if (!frontier.length) break
  }
  return {
    nodes: (g.nodes || []).filter((n) => seen.has(n.id)),
    edges: (g.edges || []).filter((e) => edgeSeen.has(e.id)),
  }
}

/** 按「重不重要」排序的节点：提到次数 × 边权重。 */
export function topNodes(g, limit = 12) {
  const deg = new Map()
  for (const e of g.edges || []) {
    deg.set(e.from, (deg.get(e.from) || 0) + e.weight)
    deg.set(e.to, (deg.get(e.to) || 0) + e.weight)
  }
  return [...(g.nodes || [])]
    .map((n) => ({ ...n, score: (deg.get(n.id) || 0) + (n.mentions || 0) * 0.3 }))
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, limit)
}

/**
 * 渲染成提示词里的一小段：只给跟当前记忆相关的 1 跳关系。
 * 太长就不给——图谱是辅助，不是噪音源。
 */
export function renderGraph(g, focusTexts = [], opts = {}) {
  const max = opts.max ?? 6
  if (!g?.nodes?.length) return ''
  const nameById = new Map(g.nodes.map((n) => [n.id, n.name]))
  const mentioned = new Set()
  const all = focusTexts.join(' ')
  for (const n of g.nodes) {
    if (n.name.length >= 2 && all.includes(n.name)) mentioned.add(n.id)
  }
  if (!mentioned.size) return ''
  const lines = []
  for (const e of g.edges) {
    if (!mentioned.has(e.from) && !mentioned.has(e.to)) continue
    lines.push(`- ${nameById.get(e.from)} —${e.rel}→ ${nameById.get(e.to)}`)
    if (lines.length >= max) break
  }
  return lines.join('\n')
}
