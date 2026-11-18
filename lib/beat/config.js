/**
 * beat/config.js —— 主动行为层的配置与落点
 *
 * 配置放 $DSH_HOME/dsh-memory/beat/config.json，手编优先，按 mtime 热加载。
 * 默认关：没写 enabled=true 时，插件不会起定时器，也不会碰任何 agent。
 */

import { mkdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

import { writeAtomic } from '../store.js'

export const DEFAULT_CONFIG = {
  enabled: false,
  dryRun: true,
  installPreset: true,
  // 找素材走哪条路：agent = 宿主里带 web_search 的那一路；search = 直连联网模型
  engine: 'agent',
  model: '',
  provider: '',
  windows: [
    { start: '11:00', end: '15:00' },
    { start: '17:00', end: '21:00' },
  ],
  minIntervalHours: 4,
  maxWanderPerDay: 2,
  refillBelow: 6,
  // 按来源的低水位：web 见底就补，不看总量。0 = 关。
  refillBelowBySource: { web: 2 },
  maxMaterial: 30,
  maxPerSource: { chat: 14, web: 8, public: 8 },
  maxPerFocus: 4,
  ttlDays: { public: 7, web: 7, chat: 14 },
  // 长会话每 N 条用户消息抽一次聊天素材；0 = 只在压缩/收尾时抽
  chatTurnEvery: 10,
  cooldownMinutes: 30,
  // 绑定会话安静这么久才能投；所有会话也静了这么久就算离开。0 = 两边都不判。
  idleMinutes: 30,
  maxDailySend: 10,
  sessionRotateDays: 7,
  // 投递目标：设置页绑定的会话；空 = 不投
  targetSessionId: '',
  targetSessionLabel: '',
  targetSessionKind: '',
  quietHours: { start: '01:00', end: '08:00' },
  allowGroups: false,
  interests: [],
  retryUsedHours: 48,
  archiveCap: 50,
  logRetentionDays: { deliveries: 90, feedback: 90, logs: 30 },
}

export function beatDir(root) {
  return join(root, 'beat')
}

export function configPath(root) {
  return join(beatDir(root), 'config.json')
}

export function statePath(root) {
  return join(beatDir(root), 'state.json')
}

export function sessionsPath(root) {
  return join(beatDir(root), 'sessions.json')
}

/** 手编兴趣清单（文档 13.3）；配置里的 interests 仍作兜底。 */
export function interestsPath(root) {
  return join(beatDir(root), 'interests.json')
}

/** 专注模式（文档 13.3）：重启后仍有效，和 state.json 互为镜像。 */
export function focusPath(root) {
  return join(beatDir(root), 'focus.json')
}

export async function loadInterests(root, fallback = []) {
  try {
    const o = JSON.parse(await readFile(interestsPath(root), 'utf8'))
    const list = Array.isArray(o) ? o : Array.isArray(o?.items) ? o.items : []
    const clean = list.map((x) => String(x || '').trim()).filter(Boolean)
    if (clean.length) return [...new Set(clean)]
  } catch { /* 没文件或坏了就走兜底 */ }
  return Array.isArray(fallback) ? fallback : []
}

export async function saveInterests(root, list = []) {
  const items = [...new Set((Array.isArray(list) ? list : []).map((x) => String(x || '').trim()).filter(Boolean))]
  await writeAtomic(interestsPath(root), JSON.stringify({ items, updatedAt: new Date().toISOString() }, null, 2))
  return items
}

export async function loadFocus(root) {
  try {
    const o = JSON.parse(await readFile(focusPath(root), 'utf8'))
    return String(o?.until || '')
  } catch {
    return null
  }
}

export async function saveFocus(root, until = '') {
  const value = String(until || '')
  await writeAtomic(focusPath(root), JSON.stringify({ until: value, updatedAt: new Date().toISOString() }, null, 2))
  return value
}

export function logsPath(root) {
  return join(beatDir(root), 'logs.jsonl')
}

export function deliveriesPath(root) {
  return join(beatDir(root), 'deliveries.jsonl')
}

export function feedbackPath(root) {
  return join(beatDir(root), 'feedback.jsonl')
}

/** 目标会话最近几句话的快照：staging 被蒸馏清掉后，投递前还能对一次话题。 */
export function topicPath(root) {
  return join(beatDir(root), 'topic.json')
}

export function materialDir(root) {
  return join(beatDir(root), 'material')
}

export async function ensureBeatDirs(root) {
  for (const d of [beatDir(root), materialDir(root), join(beatDir(root), 'logs')]) {
    await mkdir(d, { recursive: true })
  }
}

function isPlainObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v)
}

const LEGACY_IDLE_KEYS = ['chatIdleMinutes', 'tokenSaverIdleMinutes']
const LEGACY_KEYS = [...LEGACY_IDLE_KEYS, 'busyMinutes']

/** 旧配置里的两段闲置合成一个值：谁先设的就用谁，都没有用默认 30 分钟。 */
export function idleMinutesOf(config = {}) {
  const raw = config.idleMinutes ?? config.chatIdleMinutes ?? config.tokenSaverIdleMinutes
  if (raw === undefined || raw === null || raw === '') return DEFAULT_CONFIG.idleMinutes
  return Math.max(0, Number(raw) || 0)
}

/** 深合并：对象递归，数组和标量后者覆盖。 */
export function mergeConfig(base, over) {
  if (!isPlainObject(over)) return base
  const out = { ...base }
  for (const [k, v] of Object.entries(over)) {
    if (isPlainObject(v) && isPlainObject(base[k])) out[k] = mergeConfig(base[k], v)
    else out[k] = v
  }
  return out
}

/** 配置缓存：同一 root 只在 mtime 变了时重读。 */
const cache = new Map()

async function readText(file, fallback = '') {
  try { return await readFile(file, 'utf8') } catch { return fallback }
}

/**
 * 读配置。坏 JSON 不阻塞启动：退回默认值，并在日志里由调用方报。
 * @returns {Promise<object>} 合并后的配置
 */
export async function loadConfig(root, { reload = false } = {}) {
  const file = configPath(root)
  let mtime = -1
  try { mtime = (await stat(file)).mtimeMs } catch { mtime = -1 }
  const hit = cache.get(root)
  if (!reload && hit && hit.mtime === mtime) return hit.config

  let parsed = {}
  let bad = ''
  if (mtime >= 0) {
    try {
      parsed = JSON.parse(await readText(file, '{}')) || {}
    } catch (e) {
      bad = String(e?.message ?? e)
      parsed = {}
    }
  }
  const config = mergeConfig(DEFAULT_CONFIG, parsed)
  config.idleMinutes = idleMinutesOf(parsed)
  for (const key of LEGACY_KEYS) delete config[key]
  cache.set(root, { mtime, config, bad })
  return config
}

/** 只写用户改动，不把默认值整份倒进去。 */
export async function saveConfig(root, patch = {}) {
  await ensureBeatDirs(root)
  const file = configPath(root)
  let current = {}
  try { current = JSON.parse(await readText(file, '{}')) || {} } catch { current = {} }
  const next = mergeConfig(current, patch)
  const patchedIdle = patch.idleMinutes ?? patch.chatIdleMinutes ?? patch.tokenSaverIdleMinutes
  next.idleMinutes = patchedIdle === undefined
    ? idleMinutesOf(next)
    : Math.max(0, Number(patchedIdle) || 0)
  // 旧的两个闲置键和新页面都不用了；保存时顺手从配置里清掉。
  for (const key of LEGACY_KEYS) delete next[key]
  await writeAtomic(file, JSON.stringify(next, null, 2))
  cache.delete(root)
  return loadConfig(root, { reload: true })
}
