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
  maxMaterial: 30,
  maxPerSource: { chat: 14, web: 8, public: 8 },
  maxPerFocus: 4,
  ttlDays: { public: 7, web: 7, chat: 14 },
  // 长会话每 N 条用户消息抽一次聊天素材；0 = 只在压缩/收尾时抽
  chatTurnEvery: 10,
  cooldownMinutes: 30,
  maxDailySend: 10,
  sessionRotateDays: 7,
  // 投递目标：设置页绑定的会话；空 = 不投
  targetSessionId: '',
  targetSessionLabel: '',
  targetSessionKind: '',
  quietHours: { start: '01:00', end: '08:00' },
  busyMinutes: 10,
  tokenSaverIdleMinutes: 30,
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

export function logsPath(root) {
  return join(beatDir(root), 'logs.jsonl')
}

export function deliveriesPath(root) {
  return join(beatDir(root), 'deliveries.jsonl')
}

export function feedbackPath(root) {
  return join(beatDir(root), 'feedback.jsonl')
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
  cache.set(root, { mtime, config, bad })
  return config
}

export function configError(root) {
  return cache.get(root)?.bad || ''
}

/** 只写用户改动，不把默认值整份倒进去。 */
export async function saveConfig(root, patch = {}) {
  await ensureBeatDirs(root)
  const file = configPath(root)
  let current = {}
  try { current = JSON.parse(await readText(file, '{}')) || {} } catch { current = {} }
  const next = mergeConfig(current, patch)
  await writeAtomic(file, JSON.stringify(next, null, 2))
  cache.delete(root)
  return loadConfig(root, { reload: true })
}

export function resetConfigCache() {
  cache.clear()
}
