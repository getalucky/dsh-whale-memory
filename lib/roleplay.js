/**
 * roleplay.js —— 酒馆预设会话不记忆
 *
 * 「酒馆模式」看的是会话当前挂的 agentPreset，不是聊天里说了什么：
 *   · `$DSH_HOME/.agent-presets/presets.json` 里登记过（酒馆注册表，mode=roleplay）；
 *   · 或预设目录的 `agent.cordis.yml` 头部带「酒馆管理面板生成」标记；
 *   · 或目录名/注册名带酒馆、角色扮演、roleplay、tavern 字样；
 *   · 或用户在 settings.json 的 `roleplay_presets` / 环境变量
 *     `DSH_MEMORY_ROLEPLAY_PRESETS` 里显式列出的 id。
 * 换一个酒馆插件时，如果它的预设 id/目录名不好认，就把它写进后两项。
 * 角色扮演内容再像真事也不能进记忆，所以采集层在写 staging 之前就整条跳过。
 *
 * 当前预设的取值顺序：
 *   1. 会话投影 `sessionProjections.stateOf(session, 'agentPreset')` —— 顶部选择器
 *      切换后立刻变，是运行时最权威的一处；
 *   2. 本进程收到过的 `agent-preset/selected`；
 *   3. 会话 header 里的 agentPreset —— 那只是出生值，切过预设就会过期。
 *
 * 不能拿 `.agent-presets/session-bindings.json` 当判据：那是酒馆面板的账本，
 * 已经有会话从没真正切过预设、账本里却留着 tavern-lite 的情况（实盘见过）。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const TAVERN_MARK = '酒馆管理面板生成'
const NAME_HINT = /酒馆|角色扮演|roleplay|tavern/i
const REFRESH_MS = 10_000

let cache = { at: 0, ids: new Set() }
let settingsCache = { mtime: -1, ids: [] }
const current = new Map()
const MAX_TRACKED = 1000

export function presetsRoot() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, '.agent-presets')
}

function splitIds(raw) {
  const list = Array.isArray(raw) ? raw : String(raw ?? '').split(/[\s,，;；]+/)
  return list.map((x) => String(x).trim()).filter(Boolean)
}

/** 显式跳过清单：settings.json 优先，环境变量每次现读（换插件时最省事）。 */
function extraPresetIds() {
  const ids = new Set(splitIds(process.env.DSH_MEMORY_ROLEPLAY_PRESETS))
  const root = process.env.DSH_MEMORY_HOME
    || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'dsh-memory')
  const file = join(root, 'settings.json')
  try {
    const mtime = statSync(file).mtimeMs
    if (mtime !== settingsCache.mtime) {
      const data = JSON.parse(readFileSync(file, 'utf8'))
      const raw = data?.roleplay_presets ?? data?.roleplayPresets ?? []
      settingsCache = { mtime, ids: splitIds(raw) }
    }
  } catch { settingsCache = { mtime: -1, ids: [] } }
  for (const x of settingsCache.ids) ids.add(x)
  return ids
}

function refresh(force = false) {
  const now = Date.now()
  if (!force && now - cache.at < REFRESH_MS) return
  const ids = extraPresetIds()
  const root = presetsRoot()

  // 酒馆注册表：老条目没有 mode 字段，按酒馆默认补成 roleplay
  try {
    const data = JSON.parse(readFileSync(join(root, 'presets.json'), 'utf8'))
    for (const p of Array.isArray(data?.presets) ? data.presets : []) {
      if (p?.mode && p.mode !== 'roleplay') continue
      if (p?.id) ids.add(String(p.id))
      if (p?.dir) ids.add(String(p.dir))
    }
  } catch { /* 没有注册表 = 没有酒馆预设 */ }

  // 注册表之外的酒馆目录（面板生成、还没登记的那类）；换插件时靠名字也能兜住
  try {
    for (const ent of readdirSync(root, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue
      if (NAME_HINT.test(ent.name)) { ids.add(ent.name); continue }
      try {
        const head = readFileSync(join(root, ent.name, 'agent.cordis.yml'), 'utf8').slice(0, 300)
        if (head.includes(TAVERN_MARK)) ids.add(ent.name)
      } catch { /* 没有组合文件，不算 */ }
    }
  } catch { /* 目录不存在 */ }

  cache = { at: now, ids }
}

/** 预设 id 是否属于酒馆（角色扮演）。 */
export function isRoleplayPreset(id) {
  const v = String(id ?? '').trim()
  if (!v) return false
  refresh()
  return cache.ids.has(v)
}

/** 记住本进程看到的预设切换（投影服务不可用时的兜底）。 */
export function noteSessionPreset(sid, preset) {
  const id = String(sid ?? '')
  const v = String(preset ?? '').trim()
  if (!id || !v) return
  current.set(id, v)
  if (current.size > MAX_TRACKED) {
    const oldest = current.keys().next().value
    if (oldest && oldest !== id) current.delete(oldest)
  }
}

/** 会话当前预设：投影 → 本次进程见过的切换 → header 出生值。 */
export function presetOfSession(ctx, session, sid) {
  const id = String(sid ?? '')
  try {
    const projections = ctx?.get?.('sessionProjections')
    const sessions = ctx?.get?.('sessions')
    if (projections?.stateOf && sessions?.get && id) {
      const s = sessions.get(id)
      if (s) {
        const v = projections.stateOf(s, 'agentPreset')
        if (typeof v === 'string' && v) {
          noteSessionPreset(id, v)
          return v
        }
      }
    }
  } catch { /* 旧版宿主没有投影服务 */ }
  const seen = current.get(id)
  if (seen) return seen
  const header = String(session?.header?.agentPreset ?? '')
  if (header) noteSessionPreset(id, header)
  return header
}

export function isRoleplaySession(ctx, session, sid) {
  return isRoleplayPreset(presetOfSession(ctx, session, sid))
}

/** 测试用：清缓存。 */
export function resetRoleplayCache() {
  cache = { at: 0, ids: new Set() }
  settingsCache = { mtime: -1, ids: [] }
  current.clear()
}
