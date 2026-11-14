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

import { mkdir, readFile, rename, writeFile, appendFile, readdir, stat, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

import {
  loadVault, saveVault, saveVaultMeta, migrateLegacy, vaultPaths, rotateIfLarge,
} from './vault.js'
import { detectOrigin, readMeta, refreshTrustStamp } from './trust.js'
import { EXTENDED, normalizeExtras } from './kinds.js'
import { extractConcepts } from './taxonomy.js'
import { isLive } from './itemstate.js'

export const VERSION = 2

/** 会话称呼 / 泛称不是一个人；发言人字段里出现这些，一律当成「不知道是谁」。 */
export const PLACEHOLDER_SPEAKER = /^(?:群里的人|群友|群成员|群里的群友|某人|有人|用户|大家|众人|全体)$/

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
    triples: join(root, 'graph', 'triples.jsonl'),
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

/** 写入版本号文件；注入层按它的 mtime 判断要不要重画。 */
export function scopeRevFile(root, kind, id) {
  return vaultPaths(root, kind, id).rev
}

/** 分片默认显示名。local 是本地会话的全局记忆，不对应某个 QQ 号。 */
export function scopeLabel(kind, id) {
  if (kind === 'group') return `群 ${id}`
  if (kind === 'local') return '本机会话'
  if (kind === 'project') return `仓库 ${id}`
  if (kind === 'public') return '公共记忆池'
  if (kind === 'material') return '素材池'
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
const listScopesInflight = new Map()
export function listScopes(root = rootDir()) {
  // 总览轮询会同时打 /state 和 /obs；同一时刻只扫一遍，但不缓存结果——
  // 刚写完再读必须立刻看得见。
  const key = String(root || '.')
  const running = listScopesInflight.get(key)
  if (running) return running
  const p = (async () => {
    const dir = paths(root).scopes
    let ents = []
    try { ents = await readdir(dir, { withFileTypes: true }) } catch { return [] }
    const out = []
    for (const e of ents) {
      if (!e.isDirectory()) continue
      // material-pool 故意不在这里列：素材不是记忆，不进检索/画像/蒸馏/遗忘；
      // 只由 lib/beat/material.js 直接读写。
      const m = /^(private|group|local|project|public)-(.+)$/.exec(e.name)
      if (!m) continue
      try {
        const sc = await loadVault(root, m[1], m[2])
        if (sc?.scope) out.push(sc)
      } catch { /* 单个分片坏了不影响其他 */ }
    }
    return out
  })()
  listScopesInflight.set(key, p)
  p.finally(() => { if (listScopesInflight.get(key) === p) listScopesInflight.delete(key) }).catch(() => {})
  return p
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

/**
 * 近重复档：同一件事换个说法（「交给我」→「交给机器人」、「教其」→「试用」）
 * Jaccard 只有 0.55–0.71，硬卡 0.72 会全部漏过去。
 * 但也不能只降阈值：短句撞两个 bigram 就容易虚高，所以还要求
 *   · 两边都够长（至少 8 个 bigram，约 9 个字）
 *   · 较短一方有 65% 的内容落在另一方里（containment，比 Jaccard 抗长度差）
 */
export const NEAR_DUP = { floor: 0.55, containment: 0.65, minBigrams: 8 }

function gramSet(text) {
  return bigrams(normalizeText(text))
}

function containmentOf(a, b) {
  const A = a instanceof Set ? a : gramSet(a)
  const B = b instanceof Set ? b : gramSet(b)
  const min = Math.min(A.size, B.size)
  if (!min) return 0
  let inter = 0
  for (const x of A) if (B.has(x)) inter += 1
  return inter / min
}

/**
 * 模板句：去掉数字后几乎一模一样，只有编号/序号不同。
 * 「容量测试第 0 条」和「容量测试第 1 条」是两条不同的事，不能被近重复档吃掉。
 * 但「GPT-6.2 与 11 月」这种数字不同、其余措辞也不同的，仍然按近重复合并。
 */
function digitTemplate(a, b) {
  const da = (normalizeText(a).match(/\d+/g) || []).join('|')
  const db = (normalizeText(b).match(/\d+/g) || []).join('|')
  if (da === db) return false
  const A = normalizeText(a).replace(/\d+/g, '')
  const B = normalizeText(b).replace(/\d+/g, '')
  return similarity(A, B) >= 0.95
}

/** 遗忘评分：时间衰减 × 置信度 × 命中加成。 */
export function decayScore(item, now = Date.now(), halfLifeDays = 30) {
  const last = Date.parse(item?.lastHit || item?.created || '') || now
  const ageDays = Math.max(0, (now - last) / 86400000)
  const conf = typeof item?.conf === 'number' ? item.conf : 0.6
  const hitBoost = 1 + 0.15 * Math.min(5, item?.hits || 0)
  // 钉住的知识条目不随时间衰减：知识不是流水，复习方式是被查和被引用
  if (item?.pin) return Math.max(0, Math.min(1, conf * hitBoost))
  const decay = Math.exp(-ageDays / Math.max(1, halfLifeDays))
  return conf * decay * hitBoost
}

/** 自动钉住的判定阈值。显式信号由调用方（写入工具）先判。 */
export const PIN_RULES = {
  reusedAt: 3, // 同一句被反复写入/合并 ≥3 次
  usedAt: 8, // 被检索命中累计 ≥8 次
  publicMax: 50, // 公共池最多钉 50 条，超了先松最久没用的
}

/** 零 LLM 的自动钉住：知识类型、反复出现、反复被查。返回原因，不直接改条目。 */
export function autoPinWhy(item) {
  if (!item || item.pin) return ''
  if (item.kind === 'knowledge') return 'knowledge'
  if ((item.hits || 0) + (item.merged || 0) >= PIN_RULES.reusedAt) return 'reused'
  if ((item.searchHits || 0) >= PIN_RULES.usedAt) return 'used'
  return ''
}

/** 钉住 / 松开。钉住后 forget 与生命状态都会跳过它。 */
export function setPin(item, on, why = 'manual', now = new Date()) {
  if (!item) return false
  if (on) {
    if (item.pin) return false
    item.pin = true
    item.pinWhy = why
    item.pinnedAt = now.toISOString()
  } else {
    if (!item.pin) return false
    item.pin = false
    item.pinWhy = ''
    item.pinnedAt = ''
  }
  return true
}

/** 公共池的钉住上限。只松最久没被用的，知识类型不优先豁免——用得少就该让位。 */
export function enforcePinCap(scope, max = PIN_RULES.publicMax) {
  const pinned = (scope?.items || []).filter((x) => x.pin && isLive(x, { suggestedDead: false, expiredDead: false }))
  if (pinned.length <= max) return []
  const drop = pinned
    .sort((a, b) => (Date.parse(a.lastHit || a.created || '') || 0) - (Date.parse(b.lastHit || b.created || '') || 0))
    .slice(0, pinned.length - max)
  for (const it of drop) setPin(it, false)
  return drop.map((x) => x.id)
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

// 口味/喜好与观点没有固定字段，靠“说的是哪件事”做 key：
// 喜欢喝冰美式 → taste:咖啡；现在只喝拿铁 → taste:咖啡，两句话才会互相取代。
// 不这样做的话，只能把全部口味塞进一个 taste 槽，喝咖啡和吃辣会被误判成同一件事。
const TASTE_RE = /(喜欢|爱吃|爱喝|最爱|讨厌|不爱|不吃|不喝|受不了|迷上|戒了|口味|改喝|改吃|只喝|只吃|现在喝|现在吃|好喝|好吃|难喝|难吃)/
const OPINION_RE = /(觉得|认为|看好|看衰|支持|反对|赞成|同意|不同意|靠谱|不靠谱|值得|不值得|不行了|不行|没戏|凉了|拉胯|好看|难看|好听|难听|好玩|不好玩|垃圾|差劲|无聊|烂)/
const SOFT_MARKERS = /(喜欢|爱吃|爱喝|最爱|讨厌|不爱|不吃|不喝|受不了|迷上|戒了|口味|改喝|改吃|只喝|只吃|现在喝|现在吃|好喝|好吃|难喝|难吃|觉得|认为|看好|看衰|支持|反对|赞成|同意|不同意|靠谱|不靠谱|值得|不值得|不行了|不行|没戏|凉了|拉胯|好看|难看|好听|难听|好玩|不好玩|垃圾|差劲|无聊|烂)/g
const SOFT_NOISE = /(我们|你们|他们|我|你|他|她|它|这个|那个|这样|那样|这么|那么|这|那|挺|很|特别|非常|真的|确实|有点|不太|不|没|了|的|吧|啊|呀|呢|嘛|现在|最近|已经|还是|就是|其实)/g

// 这些标签太宽，不能当口味 key：喜欢猫和喜欢狗都落在「宠物」，会互相顶掉。
// 具体标签（咖啡/奶茶/编程）才够窄，可以当主题。
const BROAD_TASTE_TAGS = new Set(['宠物', '饮食', '娱乐', '购物', '运动', '影视', '游戏', '生活'])

/** 去掉人名称、语气词和极性词后，取一段能当主题的短 key。 */
function softKey(text, { skipTags = null } = {}) {
  const tags = extractConcepts(text)
    .filter((x) => x.tag && x.tag !== '家人' && x.tag !== '朋友' && !(x.parents || []).includes('关系'))
    .filter((x) => !skipTags || !skipTags.has(x.tag))
    .map((x) => x.tag)
  if (tags.length) return tags[0]
  const key = normalizeText(text)
    .replace(SOFT_MARKERS, '')
    .replace(SOFT_NOISE, '')
    .replace(/[^\u4e00-\u9fa5a-z0-9]/gi, '')
    .slice(0, 10)
  return key.length >= 2 ? key : ''
}

/** 判断一句话属于哪个事实槽位，认不出来返回空。 */
export function slotOf(text, kind = '') {
  const t = normalizeText(text)
  for (const [name, re, need] of SLOTS) {
    if (re.test(t) && need(t)) return name
  }
  if (kind === 'pref' || TASTE_RE.test(t)) {
    const raw = softKey(t, { skipTags: BROAD_TASTE_TAGS })
    // 口味是「这个人对什么东西」的偏好，key 只留东西本身：
    // 「我喜欢吃辣」和「老爹现在不爱吃辣」得落在同一个槽里。
    const key = raw.replace(/^(?:老爹|老爸|我|你|他|她|家人)/, '') || raw
    if (key) return `taste:${key}`
    if (kind === 'pref') return 'taste'
  }
  if (OPINION_RE.test(t)) {
    const key = softKey(t)
    if (key) return `opinion:${key}`
  }
  return ''
}

const NEGATIVE_POLARITY = /(不喜欢|不爱|不吃|不喝|讨厌|受不了|不靠谱|不行|没戏|凉了|拉胯|反对|不赞成|不同意|不值得|难看|难听|不好玩|垃圾|差劲|无聊|烂)/
const POSITIVE_POLARITY = /(喜欢|爱吃|爱喝|最爱|靠谱|值得|支持|赞成|同意|挺好|不错|好喝|好吃|香|好看|好听|好玩)/

/** 1 = 正向，-1 = 负向，0 = 看不出来；只用来判断「是不是翻脸了」。 */
function polarityOf(text) {
  const t = normalizeText(text)
  if (NEGATIVE_POLARITY.test(t)) return -1
  if (POSITIVE_POLARITY.test(t)) return 1
  return 0
}

/**
 * 新事实进来后，把同槽位的旧事实标成 superseded（不再注入、不进图谱，但留在库里）。
 * 只有「槽位相同 + 字面不够像（够像的走合并）」才判矛盾，宁可漏判也不乱取代。
 * @returns {object[]} 被取代的旧条目
 */
export function supersedeConflicts(scope, incoming, now = new Date().toISOString()) {
  const slot = slotOf(incoming.text, incoming.kind)
  if (!slot) return []
  // 待确认的猜测不参与取代：它还没生效，别把已经确认过的事实顶掉
  if (incoming.state === 'suggested') return []
  const hits = []
  for (const it of scope.items) {
    if (!it || it.id === incoming.id) continue
    if (!isLive(it, { expiredDead: false })) continue
    if (slotOf(it.text, it.kind) !== slot) continue
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
// 400 条对长期陪伴太紧：一天十几条，一个多月就顶到；1000 条仍能全量扫，
// 只影响落盘体积，不影响常驻注入（注入永远只看 top N）。
export const MAX_ITEMS = Math.max(100, Number(process.env.DSH_MEMORY_MAX_ITEMS) || 1000)

/** 技能单独设上限：它们是按需检索的流程，不该把普通记忆的位置挤光。 */
export const SKILL_CAP = 30

/** 挑出该归档的溢出技能：先丢用得最少、最旧的；钉住的保留。 */
export function overflowSkills(scope, max = SKILL_CAP) {
  const skills = (scope.items || []).filter((x) => x
    && x.kind === 'skill'
    && isLive(x, { expiredDead: false }))
  if (skills.length <= max) return []
  const rank = (x) => (x.pin ? 1e6 : 0) + (Number(x.hits) || 0) * 100 + (Number(x.searchHits) || 0) * 10 + (Number(x.conf) || 0)
  return [...skills]
    .sort((a, b) => rank(a) - rank(b) || String(a.lastHit || a.created || '').localeCompare(String(b.lastHit || b.created || '')))
    .slice(0, skills.length - max)
}

/** 挑出该归档的溢出条目（最冷的优先）。待确认的不算位，免得还没生效的脸把老记忆挤掉。 */
export function overflowItems(scope, max = MAX_ITEMS, now = Date.now()) {
  const live = (scope.items || []).filter((x) => isLive(x))
  if (live.length <= max) return []
  // 钉住的知识不参与容量淘汰：宁可这次少归档，也不拿知识腾位置
  const sorted = [...live.filter((x) => !x.pin)].sort((a, b) => decayScore(a, now) - decayScore(b, now))
  return sorted.slice(0, live.length - max)
}

/**
 * 落盘前的容量门：超限的旧条目搬进 archive/（不删）。
 * 技能先按自己的小配额清一轮，再走总分片容量。
 * @returns {Promise<number>} 归档条数
 */
export async function enforceCapacity(root, scope, max = MAX_ITEMS, skillMax = SKILL_CAP) {
  const skillDrop = overflowSkills(scope, skillMax)
  const skillIds = new Set(skillDrop.map((x) => x.id))
  const drop = [...skillDrop, ...overflowItems(scope, max).filter((x) => !skillIds.has(x.id))]
  if (!drop.length) return 0
  const ids = new Set(drop.map((x) => x.id))
  for (const it of drop) await archiveItem(root, scope, it, it.kind === 'skill' ? 'skill-cap' : 'capacity')
  scope.items = scope.items.filter((x) => !ids.has(x.id))
  return drop.length
}

/**
 * 找最像的已有条目。三条路：
 *   1. bigram Jaccard ≥ threshold（默认 0.72，换人称、换标点、时间写法不同）
 *   2. 近重复档（NEAR_DUP）：Jaccard 0.55+ 且较短一方 65% 落在另一方里，
 *      抓「同一件事换个说法」。话题传 0.45 时不启用，保持原来的宽松归并
 *   3. 子串包含（短的是长的一截，比如「明天8:30上班」⊂ 整句）
 *
 * opts.kind：扩展类型（教训/话题/承诺）不跟别的类型合并——
 * 「修记忆插件」是话题，「修记忆插件要跑 deploy」是教训，硬合并会把两条都写坏。
 * 普通事实之间仍然允许合并（同句话换个类型标签而已）。
 */
export function findSimilarItem(items, text, threshold = 0.72, { kind = '' } = {}) {
  const list = Array.isArray(items) ? items : []
  const blocked = (it) => {
    if (!kind || !it?.kind || it.kind === kind) return false
    return EXTENDED.includes(kind) || EXTENDED.includes(it.kind)
  }
  const target = gramSet(text)
  const floor = Math.min(threshold, NEAR_DUP.floor)
  let best = null
  let bestScore = 0
  let near = null
  let nearScore = 0
  for (const it of list) {
    if (!it || !isLive(it, { suggestedDead: false, expiredDead: false })) continue
    if (blocked(it)) continue
    const s = similarity(it.text, text)
    if (s >= threshold) {
      if (s > bestScore) {
        bestScore = s
        best = it
      }
      continue
    }
    // 近重复：Jaccard 略低，但两段都够长、且有一边大部分内容落在另一边里。
    // 只差编号的模板句除外（那是两条不同的事）。
    if (s >= floor) {
      const other = gramSet(it.text)
      if (Math.min(other.size, target.size) >= NEAR_DUP.minBigrams
        && !digitTemplate(it.text, text)
        && containmentOf(target, other) >= NEAR_DUP.containment
        && s > nearScore) {
        nearScore = s
        near = it
      }
    }
  }
  if (best) return { item: best, score: bestScore }
  if (near) return { item: near, score: nearScore }
  for (const it of list) {
    if (!it || !isLive(it, { suggestedDead: false, expiredDead: false })) continue
    if (blocked(it)) continue
    if (isSubsetText(it.text, text)) return { item: it, score: 1 }
  }
  return null
}

/**
 * 话题只认「同一件事」：目标句一样就算同一个话题，文本再像也归并。
 * 阈值放到 0.45，是因为「在修记忆插件 4.9」和「记忆插件 4.9 又推进了」
 * 这种状态更新天然长得不像 —— 话题一旦分裂成十条，就再也没法读了。
 */
function findTopic(items, text, goal) {
  const g = normalizeText(goal)
  if (g) {
    const same = (items || []).find((x) => x
      && x.kind === 'topic'
      && isLive(x, { suggestedDead: false, expiredDead: false })
      && normalizeText(x.goal) === g)
    if (same) return { item: same, score: 1 }
  }
  return findSimilarItem(items, text, 0.45, { kind: 'topic' })
}

/**
 * 原文指针只留坐标：会话号、消息下标/序号、原话指纹、观察时间。
 * 不存正文；旧数据没有 origin 就保持 null。
 */
function normalizeOrigin(origin) {
  if (!origin || typeof origin !== 'object') return null
  const sessionId = String(origin.sessionId ?? '').trim().slice(0, 128)
  const hash = String(origin.hash ?? '').trim().slice(0, 16)
  if (!sessionId || !hash) return null
  const idx = (v) => {
    const n = Number(v)
    return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : -1
  }
  const ptr = { sessionId, msgIndex: idx(origin.msgIndex), hash }
  const seq = idx(origin.seq)
  if (seq >= 0) ptr.seq = seq
  const at = String(origin.at ?? '').trim()
  if (at) ptr.at = at
  return ptr
}

/** 合并时旧原话不能丢：最新一次放 sourceQuote，之前的进 quoteHistory。 */
function keepQuote(exist, quote, at) {
  const q = String(quote ?? '').trim()
  if (!q) return
  const prev = String(exist.sourceQuote ?? '').trim()
  if (prev && normalizeText(prev) !== normalizeText(q)) {
    const known = new Set((exist.quoteHistory || []).map((x) => normalizeText(x.quote)))
    if (!known.has(normalizeText(prev))) {
      exist.quoteHistory = [
        ...(exist.quoteHistory || []),
        { quote: prev, at: exist.observedAt || at || '' },
      ].slice(-6)
    }
  }
  exist.sourceQuote = q
}

/** 场景是「当时在聊什么」，合并时别用后一条把前一条盖掉，两段不同就并起来。 */
function mergeScene(exist, scene) {
  const s = String(scene ?? '').replace(/\s+/g, ' ').trim()
  if (!s) return
  const old = String(exist.scene ?? '').replace(/\s+/g, ' ').trim()
  if (!old) {
    exist.scene = s
    return
  }
  if (old === s || old.includes(s)) return
  if (s.includes(old)) {
    exist.scene = s
    return
  }
  exist.scene = `${old}；${s}`.slice(0, 200)
}

/**
 * 合并一条已有记录。显式 merge_into 用新正文（模型已经看过两边、写过合并版）；
 * 自动查重仍然只在「新说法明显更长」时替换，避免一句复述把完整背景冲掉。
 */
function mergeItemRecord(exist, input, nowDate) {
  const { t, kind, conf, sourceQuote, scene, tags, atAbs, observedAt, speaker, originPtr, autoPin, autoWhy, ext, explicit } = input
  const now = nowDate.toISOString()
  const prevAt = String(exist.lastHit || exist.created || '')
  const oldText = String(exist.text ?? '')

  exist.hits = (exist.hits || 0) + 1
  exist.lastHit = now
  exist.conf = Math.max(Number(exist.conf) || 0.6, Number(conf) || 0.6)
  exist.conf = Math.min(1, exist.conf + 0.05)
  exist.merged = (exist.merged || 0) + 1

  // 口味/观点正负翻转时，即使新句更短也要覆盖；普通合并仍按“明显更长才换”，
  // 避免复述把带细节的旧句冲掉，也避免重导历史时把正文改得回滚不了。
  const softSlot = /^(taste|opinion):/.test(slotOf(t, kind))
  const flip = softSlot && polarityOf(t) * polarityOf(oldText) < 0
  if (t && t !== oldText && (explicit || flip || t.length > oldText.length * 1.15)) {
    exist.history = [...(exist.history || []), { text: oldText, at: prevAt }].slice(-8)
    exist.text = t
  }
  keepQuote(exist, sourceQuote, now)
  mergeScene(exist, scene)
  if (Array.isArray(tags) && tags.length) {
    exist.tags = [...new Set([...(exist.tags || []), ...tags.map(String)])].slice(0, 8)
  }

  // 同句话又提了一遍，时间以最新这次为准（「明天」说的是新的那个明天）。
  // 导入历史时按会话从新到旧跑：旧消息合并进新条目，不能把 atAbs 改回过去。
  if (atAbs) {
    const prev = String(exist.observedAt || exist.created || '')
    if (!observedAt || !prev || String(observedAt) >= prev) exist.atAbs = atAbs
  }
  if (observedAt && !exist.observedAt) exist.observedAt = observedAt
  // 原文指针跟着最近一次观察走；导入按从新到旧跑，别把坐标退回更早的会话
  if (originPtr) {
    const prev = String(exist.observedAt || '')
    if (!exist.origin || !observedAt || !prev || String(observedAt) >= prev) exist.origin = originPtr
  }
  // 发言人只补空：旧条目挂着「群里的人」这类泛称时，后来的真名字可以覆盖它
  if (speaker && (!exist.speaker || PLACEHOLDER_SPEAKER.test(exist.speaker))) exist.speaker = speaker
  // 扩展字段随写入刷新：话题更新只改状态与 last_touched，不新建条目。
  // progress 只有明确给了才改：一句「X 又推进了」不该把已完成的话题重新点亮。
  if (kind === 'topic') {
    if (ext.fields.progress) exist.progress = ext.fields.progress
    exist.lastTouched = ext.fields.lastTouched
    if (ext.fields.goal) exist.goal = ext.fields.goal
  } else if (kind === 'lesson') {
    if (ext.fields.trigger) exist.trigger = ext.fields.trigger
    if (ext.fields.antiPattern) exist.antiPattern = ext.fields.antiPattern
  } else if (kind === 'skill') {
    if (ext.fields.trigger) exist.trigger = ext.fields.trigger
    if (Array.isArray(ext.fields.steps)) exist.steps = ext.fields.steps
    if (ext.fields.verify) exist.verify = ext.fields.verify
    // 流程改过了，之前那次失败不再代表当前版本
    exist.skillFails = 0
    exist.skillReview = false
  } else if (kind === 'commitment') {
    if (ext.fields.due) exist.due = ext.fields.due
    if (ext.fields.toWhom) exist.toWhom = ext.fields.toWhom
  }
  // 重复写入也能把一条普通事实升级成知识：之前是流水，现在就钉住
  if (autoPin && !exist.pin) setPin(exist, true, autoWhy, nowDate)
  return exist
}

/**
 * 加一条记忆：完全一样或足够像就合并，不新增。
 *
 * atAbs：这句话里的相对时间（明天/下周三）锚出来的绝对时间，由 lib/time.js 算。
 * observedAt：这句话本身是什么时候说的。两个都留空也没关系，只是注入时没有日期。
 * scene：当时在聊什么、为什么说这句。检索和主库都要能读出来，不能只剩一句结论。
 * mergeInto：调用方已经查过重、明确要并进哪条；跳过相似度门槛。
 *
 * 扩展类型（lesson/topic/commitment/skill）额外带必填字段，校验不过直接返回 null ——
 * 写入口要先自己校验一遍，好把原因告诉调用方。
 */
export function addItem(scope, {
  text, kind = 'fact', conf = 0.6, source = '', sourceQuote = '', scene = '', refs = [], tags = [],
  atAbs = '', observedAt = '', speaker = '', state = 'active',
  trigger = '', antiPattern = '', goal = '', progress = '', due = '', toWhom = '',
  steps = [], verify = '', origin = null, mergeInto = '',
  pin = false, pinWhy = '',
}) {
  const t = String(text ?? '').trim()
  if (!t) return null
  const nowDate = new Date()
  // 知识类型默认就是长期知识：不管从工具、蒸馏还是导入写进来，都不吃时间衰减
  const autoPin = !!pin || kind === 'knowledge'
  const autoWhy = autoPin ? (pinWhy || (kind === 'knowledge' ? 'knowledge' : 'manual')) : ''
  const ext = normalizeExtras(kind, { trigger, antiPattern, goal, progress, due, toWhom, steps, verify }, nowDate)
  if (!ext.ok) return null
  const originPtr = normalizeOrigin(origin)

  const explicit = String(mergeInto ?? '').trim()
  let hit = null
  if (explicit) {
    const target = (scope.items || []).find((x) => x
      && x.id === explicit
      && isLive(x, { suggestedDead: false, expiredDead: false }))
    const extendedKind = (k) => EXTENDED.includes(k)
    // 扩展类型不跨类合并：「修插件」是话题，「修插件要跑 deploy」是教训。
    // 普通事实/偏好/事件之间允许合并，模型已经查过重，不必再卡字面相似度。
    if (target && (target.kind === kind || (!extendedKind(target.kind) && !extendedKind(kind)))) {
      hit = { item: target, score: 1 }
    }
  }
  if (!hit) hit = kind === 'topic' ? findTopic(scope.items, t, ext.fields.goal) : findSimilarItem(scope.items, t, 0.72, { kind })
  if (hit) {
    return mergeItemRecord(hit.item, {
      t, kind, conf, sourceQuote, scene, tags, atAbs, observedAt, speaker,
      originPtr, autoPin, autoWhy, ext, explicit: !!explicit,
    }, nowDate)
  }
  const now = nowDate.toISOString()
  const item = {
    id: newItemId(),
    text: t,
    kind,
    conf: Math.max(0.1, Math.min(1, conf)),
    source,
    sourceQuote: String(sourceQuote ?? '').trim(),
    scene: String(scene ?? '').replace(/\s+/g, ' ').trim(),
    refs,
    ...(Array.isArray(tags) && tags.length ? { tags: [...new Set(tags.map(String))].slice(0, 8) } : {}),
    atAbs,
    observedAt,
    speaker,
    ...(originPtr ? { origin: originPtr } : {}),
    ...ext.fields,
    ...(kind === 'skill' ? { skillFails: 0, skillReview: false } : {}),
    validFrom: now,
    validTo: '',
    supersededBy: '',
    created: now,
    lastHit: now,
    hits: 0,
    searchHits: 0,
    merged: 0,
    pin: autoPin,
    pinWhy: autoWhy,
    pinnedAt: autoPin ? now : '',
    state, // active | suggested（待确认） | warm | cold | superseded | archived
  }
  scope.items.push(item)
  // 新话题总得有个状态；合并时没给状态就不动旧的（见上面的 progress 分支）
  if (kind === 'topic' && !item.progress) item.progress = 'active'
  scope.itemsSinceDeepen = (scope.itemsSinceDeepen || 0) + 1
  supersedeConflicts(scope, item, now)
  return item
}

/**
 * 合并两条已经存在的条目：正文/场景/原话并进 target，source 标 superseded。
 * 写入口的 merge_into 处理「新话并进旧条」，这里是清理「旧库里已经重复的两条」。
 */
export function mergeExistingItems(scope, sourceId, targetId, nowDate = new Date()) {
  const items = scope?.items || []
  const source = items.find((x) => x && x.id === sourceId)
  const target = items.find((x) => x && x.id === targetId)
  if (!source || !target || source === target) return null
  const dead = (x) => !isLive(x, { expiredDead: false })
  if (dead(source) || dead(target)) return null
  const extendedKind = (k) => EXTENDED.includes(k)
  if (source.kind !== target.kind && (extendedKind(source.kind) || extendedKind(target.kind))) return null

  const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()
  const a = clean(target.text)
  const b = clean(source.text)
  // 两句话都留着：一条讲事实、一条补细节时，只取长的那句会丢信息
  const text = !a ? b
    : !b || a.includes(b) ? a
      : b.includes(a) ? b
        : `${a}；${b}`.slice(0, 400)
  const ext = normalizeExtras(source.kind, {
    trigger: source.trigger,
    antiPattern: source.antiPattern,
    goal: source.goal,
    progress: source.progress,
    due: source.due,
    toWhom: source.toWhom,
    steps: source.steps,
    verify: source.verify,
  }, nowDate)
  const now = nowDate.toISOString()
  mergeItemRecord(target, {
    t: text,
    kind: source.kind,
    conf: source.conf,
    sourceQuote: source.sourceQuote,
    scene: source.scene,
    tags: source.tags,
    atAbs: source.atAbs,
    observedAt: source.observedAt,
    speaker: source.speaker,
    originPtr: normalizeOrigin(source.origin),
    autoPin: !!source.pin,
    autoWhy: source.pinWhy || '',
    ext: ext.ok ? ext : { fields: {} },
    explicit: true,
  }, nowDate)
  source.state = 'superseded'
  source.supersededBy = target.id
  source.mergedInto = target.id
  source.validTo = now
  return target
}

/** 命中时刷新。search=true 时另计检索命中数，给自动钉住用。 */
export function touchItem(scope, id, { search = false } = {}) {
  const it = scope.items.find((x) => x.id === id)
  if (it) {
    it.hits += 1
    it.lastHit = new Date().toISOString()
    if (search) it.searchHits = (it.searchHits || 0) + 1
    return it
  }
  return null
}

/**
 * 检索命中账本：一次搜索追加一行，不重写副库、不 bump .rev。
 * 搜索每次都 loadScope，直接把 searchHits 加在内存里会随调用结束丢掉；
 * 这里只做追加，交给每小时 forget 批处理 drain 后折算（文档 8.2 访问强化）。
 */
export async function appendSearchHits(root, kind, id, ids) {
  const list = [...new Set((ids || []).filter(Boolean))]
  if (!list.length) return 0
  const p = vaultPaths(root, kind, id)
  await mkdir(p.dir, { recursive: true })
  await appendFile(p.hits, JSON.stringify({ at: new Date().toISOString(), ids: list }) + '\n', 'utf8')
  return list.length
}

/**
 * 取走命中账本并汇总。先原子改名再读：改名后搜索侧的新追加会落进新文件，
 * 不丢不重；和 forget 的写锁一起用，不会有两边同时消费同一批。
 * @returns {Promise<Record<string, number>>} itemId -> 次数
 */
export async function drainSearchHits(root, kind, id) {
  const p = vaultPaths(root, kind, id)
  const tmp = `${p.hits}.${process.pid}.${Date.now()}.drain`
  try {
    await rename(p.hits, tmp)
  } catch {
    return {}
  }
  let text = ''
  try {
    text = await readFile(tmp, 'utf8')
  } catch {
    return {}
  }
  await rm(tmp, { force: true }).catch(() => {})
  const out = {}
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const row = JSON.parse(line)
      for (const x of Array.isArray(row?.ids) ? row.ids : []) out[x] = (out[x] || 0) + 1
    } catch { /* 坏行跳过 */ }
  }
  return out
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
  const file = paths(root).writes
  await rotateIfLarge(file).catch(() => {})
  await appendJsonl(file, { at: new Date().toISOString(), ...entry })
}

/**
 * 读账：search / read / profile 三个入口。
 * 单独一份文件，是因为读的次数比写多一个量级——混进 writes.jsonl 会把写入账冲掉，
 * 而「她到底有没有先查再答」这件事只能靠这份账算。
 */
export async function auditRead(root, entry) {
  const file = paths(root).reads
  await rotateIfLarge(file).catch(() => {})
  await appendJsonl(file, { at: new Date().toISOString(), ...entry })
}

export async function auditInject(root, entry) {
  const file = paths(root).injects
  await rotateIfLarge(file).catch(() => {})
  await appendJsonl(file, { at: new Date().toISOString(), ...entry })
}

// ---- 日志 ----

export async function logLine(root, msg) {
  try {
    const file = join(paths(root).logs, 'dsh-whale-memory.log')
    await rotateIfLarge(file, { maxBytes: 4 * 1024 * 1024, keep: 2 }).catch(() => {})
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