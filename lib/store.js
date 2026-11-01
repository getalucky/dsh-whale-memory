/**
 * store.js —— 记忆库的磁盘层
 *
 * 目录结构（root 默认 $DSH_HOME/dsh-memory）：
 *   meta.json                  版本/创建时间
 *   persona.md                 固定人格（可选，缺省用插件自带那份）
 *   scopes/<kind>-<id>/        一个私聊用户 / 一个群的记忆分片（主副库目录）
 *     memory_full/{id}.md      主库：唯一真源
 *     memory_index.md          副库：派生目录，可删可重建
 *     meta.json / tag_graph.md / status.md / .rev
 *   staging/<sessionId>.jsonl  待蒸馏的原始消息
 *   archive/                   归档
 *   graph/nodes.jsonl, edges.jsonl
 *   audit/writes.jsonl, injects.jsonl
 *   logs/
 *
 * 原则：所有写入走 writeAtomic（临时文件 + rename），永不原地截断。
 */

import { mkdir, readFile, rename, writeFile, appendFile, readdir, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

import {
  loadVault, saveVault, saveVaultMeta, migrateLegacy, scopeDir, vaultPaths,
} from './vault.js'
import { detectOrigin, readMeta, refreshTrustStamp } from './trust.js'

export const VERSION = 2

/** 记忆库根目录。 */
export function rootDir() {
  if (process.env.DSH_MEMORY_HOME) return process.env.DSH_MEMORY_HOME
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(dshHome, 'dsh-memory')
}

/** 全部路径。 */
export function paths(root = rootDir()) {
  return {
    root,
    meta: join(root, 'meta.json'),
    persona: join(root, 'persona.md'),
    scopes: join(root, 'scopes'),
    staging: join(root, 'staging'),
    archive: join(root, 'archive'),
    graph: join(root, 'graph'),
    nodes: join(root, 'graph', 'nodes.jsonl'),
    edges: join(root, 'graph', 'edges.jsonl'),
    audit: join(root, 'audit'),
    writes: join(root, 'audit', 'writes.jsonl'),
    reads: join(root, 'audit', 'reads.jsonl'),
    injects: join(root, 'audit', 'injects.jsonl'),
    logs: join(root, 'logs'),
  }
}

export async function ensureDirs(root = rootDir()) {
  const p = paths(root)
  for (const d of [p.root, p.scopes, p.staging, p.archive, p.graph, p.audit, p.logs]) {
    await mkdir(d, { recursive: true })
  }
  if (!existsSync(p.meta)) {
    // meta 缺失但有 scopes 内容 = clone/导入的库，先标 external，等人 trust
    const origin = await detectOrigin(root)
    await writeAtomic(p.meta, JSON.stringify({ version: VERSION, createdAt: new Date().toISOString(), origin }, null, 2))
  } else {
    const meta = await readMeta(root)
    if (!meta.origin) {
      meta.origin = 'local'
      await writeAtomic(p.meta, JSON.stringify(meta, null, 2))
    }
  }
  // 旧版 scopes/*.json 迁移成目录；幂等，已经有 .rev 的跳过
  try { await migrateLegacy(root) } catch { /* 迁移失败不挡启动，下次再试 */ }
}

export async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return fallback
  }
}

export async function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmp, text, 'utf8')
  await rename(tmp, file)
}

export async function appendJsonl(file, obj) {
  await appendFile(file, JSON.stringify(obj) + '\n', 'utf8')
}

// ---- 写队列 ----
//
// 分片是「读 → 改 → 整份写」，distill（5 分钟一次）、forget（每小时一次）、
// memory_save 工具、界面删除四个入口都能并发进来。writeAtomic 只保证文件不坏，
// 不保证不丢：后写的那份会把先写的整份覆盖掉。
// 全局串行足够用（单进程 + 单个 QQ 机器人），别为吞吐量在这里搞花活。

let writeChain = Promise.resolve()

/** 所有写路径都从这里过。 */
export function withWriteLock(fn) {
  const run = writeChain.catch(() => {}).then(fn)
  writeChain = run.then(() => undefined, () => undefined)
  return run
}

/** 读分片 → 改 → 落盘，整段在锁里。 */
export async function updateScope(root, kind, id, fn) {
  return withWriteLock(async () => {
    const scope = await loadScope(root, kind, id)
    const out = await fn(scope)
    await saveScope(root, scope)
    return out ?? scope
  })
}

export async function readJsonl(file, limit = 0) {
  try {
    const raw = await readFile(file, 'utf8')
    const lines = raw.split('\n').filter(Boolean)
    const slice = limit > 0 ? lines.slice(-limit) : lines
    const out = []
    for (const l of slice) {
      try { out.push(JSON.parse(l)) } catch { /* 单行坏了跳过 */ }
    }
    return out
  } catch {
    return []
  }
}

// ---- 分片 ----

export function scopeKey(kind, id) {
  return `${kind}:${id}`
}

/** 旧版 JSON 路径，只给迁移/兼容用；运行时读写走目录。 */
export function scopeFile(root, kind, id) {
  return join(paths(root).scopes, `${kind}-${id}.json`)
}

/** 目录路径（分片根）。 */
export function scopeRoot(root, kind, id) {
  return scopeDir(root, kind, id)
}

/** 写入版本号文件；注入层按它的 mtime 判断要不要重画。 */
export function scopeRevFile(root, kind, id) {
  return vaultPaths(root, kind, id).rev
}

/** 分片默认显示名。local 是本地会话的全局记忆，不对应某个 QQ 号。 */
export function scopeLabel(kind, id) {
  if (kind === 'group') return `群 ${id}`
  if (kind === 'local') return '本机会话'
  return `用户 ${id}`
}

export function emptyScope(kind, id, label = '') {
  return {
    scope: scopeKey(kind, id),
    kind,
    id: String(id),
    label: label || scopeLabel(kind, id),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    profile: { summary: '', traits: [], updated: '' },
    members: {},
    items: [],
  }
}

export async function loadScope(root, kind, id) {
  return loadVault(root, kind, id)
}

/** 读改写整段。主库先落盘，副库失败不阻塞。 */
export async function saveScope(root, scope) {
  await saveVault(root, scope)
  await refreshTrustStamp(root).catch(() => {})
  return scope
}

/** 只写元信息（画像/成员变了，但条目没动）。 */
export async function saveScopeMeta(root, scope) {
  await saveVaultMeta(root, scope)
  await refreshTrustStamp(root).catch(() => {})
  return scope
}

/** 列全部已有分片（扫目录，不读条目正文以外的派生文件）。 */
export async function listScopes(root = rootDir()) {
  const dir = paths(root).scopes
  let ents = []
  try { ents = await readdir(dir, { withFileTypes: true }) } catch { return [] }
  const out = []
  for (const e of ents) {
    if (!e.isDirectory()) continue
    const m = /^(private|group|local)-(.+)$/.exec(e.name)
    if (!m) continue
    try {
      const sc = await loadVault(root, m[1], m[2])
      if (sc?.scope) out.push(sc)
    } catch { /* 单个分片坏了不影响其他 */ }
  }
  return out
}

// ---- 记忆条目 ----

let seq = 0
export function newItemId() {
  seq = (seq + 1) % 10000
  return `m_${Date.now().toString(36)}${seq.toString(36).padStart(2, '0')}`
}

/**
 * 归一化：全角转半角、去空白、统一标点、小写。
 * 目的只是让「同一句话换个写法」长得一样，不改变语义。
 */
export function normalizeText(s) {
  return String(s ?? '')
    .replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/[\u3000\s]+/g, '')
    .replace(/[，。！？；：、“”‘’（）《》【】…—]/g, '')
    // 数字之间的分隔符换成空格，别把 8:30 粘成 830——切词时 8 和 30 该是两个 token
    .replace(/(?<=\d)[.,:;!?](?=\d)/g, ' ')
    // 全角转换后剩下的是 ASCII 标点，也要清掉：
    // 「明天也是8:30上班」和「…（明天）也是8:30上班」差个括号就判不成同一条，会重复入库
    .replace(/[\u0021-\u002F\u003A-\u0040\u005B-\u0060\u007B-\u007E]/g, '')
    .toLowerCase()
}

/** 字符二元组集合（中文没有空格分词，bigram 是最省事的近似）。 */
function bigrams(s) {
  const set = new Set()
  for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2))
  if (!set.size && s) set.add(s)
  return set
}

/** 两段文本的 bigram Jaccard 相似度，0–1。 */
export function similarity(a, b) {
  const A = bigrams(normalizeText(a))
  const B = bigrams(normalizeText(b))
  if (!A.size || !B.size) return 0
  let inter = 0
  for (const x of A) if (B.has(x)) inter += 1
  return inter / (A.size + B.size - inter)
}

/** 短句是长句的一部分（且不算太短）就算重复。 */
export function isSubsetText(a, b) {
  const A = normalizeText(a)
  const B = normalizeText(b)
  if (!A || !B) return false
  const [short, long] = A.length <= B.length ? [A, B] : [B, A]
  return short.length >= 6 && short.length / long.length >= 0.4 && long.includes(short)
}

/** 遗忘评分：时间衰减 × 置信度 × 命中加成。 */
export function decayScore(item, now = Date.now(), halfLifeDays = 30) {
  const last = Date.parse(item?.lastHit || item?.created || '') || now
  const ageDays = Math.max(0, (now - last) / 86400000)
  const conf = typeof item?.conf === 'number' ? item.conf : 0.6
  const hitBoost = 1 + 0.15 * Math.min(5, item?.hits || 0)
  const decay = Math.exp(-ageDays / Math.max(1, halfLifeDays))
  return conf * decay * hitBoost
}

/**
 * 事实槽位。只有「同一个人、同一个槽位、值不一样」才算矛盾。
 * 每条槽位带一个附加条件：两边都得像这个字段的值，避免「在X上班」被当成「上班时间」。
 */
const SLOTS = [
  ['worktime', /上班|下班|开工|到岗|打卡/, (t) => /\d/.test(t)],
  ['home', /住在|家住|住址/, (t) => /住在|家住|住址/.test(t)],
  ['name', /我叫|名字叫|叫我/, (t) => /我叫|名字叫|叫我/.test(t)],
  ['age', /\d{1,2}\s*岁/, (t) => /\d{1,2}\s*岁/.test(t)],
  ['phone', /电话|手机号|号码/, (t) => /\d{5,}/.test(t)],
]

/** 判断一句话属于哪个事实槽位，认不出来返回空。 */
export function slotOf(text) {
  const t = normalizeText(text)
  for (const [name, re, need] of SLOTS) {
    if (re.test(t) && need(t)) return name
  }
  return ''
}

/**
 * 新事实进来后，把同槽位的旧事实标成 superseded（不再注入、不进图谱，但留在库里）。
 * 只有「槽位相同 + 字面不够像（够像的走合并）」才判矛盾，宁可漏判也不乱取代。
 * @returns {object[]} 被取代的旧条目
 */
export function supersedeConflicts(scope, incoming, now = new Date().toISOString()) {
  const slot = slotOf(incoming.text)
  if (!slot) return []
  const hits = []
  for (const it of scope.items) {
    if (!it || it.id === incoming.id) continue
    if (it.state === 'archived' || it.state === 'superseded') continue
    if (slotOf(it.text) !== slot) continue
    // 低置信度的规则兜底不许顶掉高置信度的模型写入：
    // 「明天也是8:30上班」(0.55) 覆盖掉「老爹11月1日（明天）也是8:30上班」(0.8)，
    // 结果就是把带日期和主语的版本标记成 superseded，留下一个更差的。
    if ((incoming.conf ?? 0) + 0.1 < (it.conf ?? 0)) continue
    if (similarity(it.text, incoming.text) >= 0.72) continue
    it.state = 'superseded'
    it.validTo = now
    it.supersededBy = incoming.id
    hits.push(it)
  }
  return hits
}

/** 分片容量上限。到顶后先归档最冷的条目，还是超就拒写新的。 */
export const MAX_ITEMS = 400

/** 挑出该归档的溢出条目（最冷的优先）。 */
export function overflowItems(scope, max = MAX_ITEMS, now = Date.now()) {
  const live = (scope.items || []).filter((x) => x.state !== 'archived' && x.state !== 'superseded' && x.state !== 'expired')
  if (live.length <= max) return []
  const sorted = [...live].sort((a, b) => decayScore(a, now) - decayScore(b, now))
  return sorted.slice(0, live.length - max)
}

/**
 * 落盘前的容量门：超限的旧条目搬进 archive/（不删）。
 * @returns {Promise<number>} 归档条数
 */
export async function enforceCapacity(root, scope, max = MAX_ITEMS) {
  const drop = overflowItems(scope, max)
  if (!drop.length) return 0
  const ids = new Set(drop.map((x) => x.id))
  for (const it of drop) await archiveItem(root, scope, it, 'capacity')
  scope.items = scope.items.filter((x) => !ids.has(x.id))
  return drop.length
}

/**
 * 找最像的已有条目。两条路：
 *   1. bigram Jaccard ≥ 0.72（换人称、换标点、时间写法不同）
 *   2. 子串包含（短的是长的一截，比如「明天8:30上班」⊂ 整句）
 */
export function findSimilarItem(items, text, threshold = 0.72) {
  const list = Array.isArray(items) ? items : []
  let best = null
  let bestScore = 0
  for (const it of list) {
    if (!it || it.state === 'archived' || it.state === 'superseded') continue
    const s = similarity(it.text, text)
    if (s > bestScore) {
      bestScore = s
      best = it
    }
  }
  if (bestScore >= threshold) return { item: best, score: bestScore }
  for (const it of list) {
    if (!it || it.state === 'archived' || it.state === 'superseded') continue
    if (isSubsetText(it.text, text)) return { item: it, score: 1 }
  }
  return null
}

/**
 * 加一条记忆：完全一样或足够像就合并，不新增。
 *
 * atAbs：这句话里的相对时间（明天/下周三）锚出来的绝对时间，由 lib/time.js 算。
 * observedAt：这句话本身是什么时候说的。两个都留空也没关系，只是注入时没有日期。
 */
export function addItem(scope, { text, kind = 'fact', conf = 0.6, source = '', sourceQuote = '', refs = [], atAbs = '', observedAt = '', speaker = '' }) {
  const t = String(text ?? '').trim()
  if (!t) return null
  const hit = findSimilarItem(scope.items, t)
  if (hit) {
    const exist = hit.item
    exist.hits += 1
    exist.lastHit = new Date().toISOString()
    exist.conf = Math.min(1, (exist.conf ?? 0.6) + 0.05)
    exist.merged = (exist.merged ?? 0) + 1
    // 新说法更完整（明显更长）就替换，旧说法留在 history 里（主库会写成「曾经」）
    if (t.length > exist.text.length * 1.15) {
      exist.history = [
        ...(exist.history || []),
        { text: exist.text, at: exist.lastHit || exist.created || '' },
      ].slice(-8)
      exist.text = t
    }
    // 同句话又提了一遍，时间以最新这次为准（「明天」说的是新的那个明天）
    if (atAbs) exist.atAbs = atAbs
    if (observedAt && !exist.observedAt) exist.observedAt = observedAt
    if (speaker && !exist.speaker) exist.speaker = speaker
    return exist
  }
  const now = new Date().toISOString()
  const item = {
    id: newItemId(),
    text: t,
    kind,
    conf: Math.max(0.1, Math.min(1, conf)),
    source,
    sourceQuote,
    refs,
    atAbs,
    observedAt,
    speaker,
    validFrom: now,
    validTo: '',
    supersededBy: '',
    created: now,
    lastHit: now,
    hits: 0,
    merged: 0,
    state: 'active', // active | warm | cold | superseded | archived
  }
  scope.items.push(item)
  scope.itemsSinceDeepen = (scope.itemsSinceDeepen || 0) + 1
  supersedeConflicts(scope, item, now)
  return item
}

/** 命中时刷新。 */
export function touchItem(scope, id) {
  const it = scope.items.find((x) => x.id === id)
  if (it) {
    it.hits += 1
    it.lastHit = new Date().toISOString()
    return it
  }
  return null
}

// ---- 审计 ----

/** 把一条记忆挪进 archive/（不删，随时能翻回来）。 */
export async function archiveItem(root, scope, item, reason = 'cold+age') {
  if (!item) return false
  await appendJsonl(join(paths(root).archive, `${scope.kind}-${scope.id}.jsonl`), {
    at: new Date().toISOString(),
    reason,
    scope: scope.scope,
    item,
  })
  await auditWrite(root, { kind: 'archive', scope: scope.scope, item: item.id, text: String(item.text).slice(0, 120), why: reason })
  return true
}

export async function auditWrite(root, entry) {
  await appendJsonl(paths(root).writes, { at: new Date().toISOString(), ...entry })
}

/**
 * 读账：search / read / profile 三个入口。
 * 单独一份文件，是因为读的次数比写多一个量级——混进 writes.jsonl 会把写入账冲掉，
 * 而「她到底有没有先查再答」这件事只能靠这份账算。
 */
export async function auditRead(root, entry) {
  await appendJsonl(paths(root).reads, { at: new Date().toISOString(), ...entry })
}

export async function auditInject(root, entry) {
  await appendJsonl(paths(root).injects, { at: new Date().toISOString(), ...entry })
}

// ---- 日志 ----

export async function logLine(root, msg) {
  try {
    const file = join(paths(root).logs, 'dsh-whale-memory.log')
    await appendFile(file, `${new Date().toISOString()} ${msg}\n`, 'utf8')
  } catch { /* 日志失败不影响主流程 */ }
}

/** 库是否已初始化。 */
export function exists(root = rootDir()) {
  return existsSync(paths(root).meta)
}

export async function mtime(file) {
  try { return (await stat(file)).mtimeMs } catch { return -1 }
}