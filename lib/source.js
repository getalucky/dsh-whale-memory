/**
 * source.js —— 「这条会话是谁在说话」
 *
 * 两类来源：
 *   1. 桥接会话：不解析消息文本，直接读 `$DSH_HOME/qq-bridge-config.json` 的绑定表
 *      （类型/号码/会话 id）。sessionId → 来源是查表，不是猜。
 *   2. 本地会话：桌面端、CLI、Web 里直接开的会话，没有绑定表可查，
 *      统一归到 `local:dsh` 一个分片（全局记忆，不按项目拆）。
 *
 * 缓存按文件 mtime 刷新：桥接重建会话会改这个文件，改了下一轮就生效。
 *
 * 归到本地之前必须先确认「绑定表确实读过了」：
 *   · 文件不存在 / 从没配过桥接 → 本地
 *   · 读到且解析成功、这轮 sid 不在表里 → 本地
 *   · 文件存在但读失败 / JSON 坏了 → 不归本地（可能是桥接会话，宁可这轮跳过）
 * 旧版就在这里翻过车：绑定表读不到时把 Web 会话当成桥接收了进来。
 */

import { readFile, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

/** 本地会话统一落在这个分片。 */
export const LOCAL_SCOPE = { kind: 'local', id: 'dsh', label: '本机会话' }

function configFile() {
  if (process.env.DSH_QQ_BRIDGE_CONFIG) return process.env.DSH_QQ_BRIDGE_CONFIG
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(dshHome, 'qq-bridge-config.json')
}

/** 本地会话采集开关：默认开；`off` 退回只收桥接。 */
export function localScopeEnabled() {
  const v = String(process.env.DSH_MEMORY_LOCAL_SCOPE ?? 'on').toLowerCase()
  return !(v === 'off' || v === '0' || v === 'false' || v === 'bridge')
}

/** 一条本地会话的来源。session 只用于日志和排查，不写进记忆正文。 */
function localSource(sid) {
  return {
    kind: LOCAL_SCOPE.kind,
    id: LOCAL_SCOPE.id,
    label: LOCAL_SCOPE.label,
    addr: '',
    local: true,
    session: String(sid ?? ''),
  }
}

/**
 * cache.state:
 *   unloaded —— 还没预热，同步查询一律返回 null（宁可漏挂，不错挂）
 *   none     —— 桥接配置不存在，本地会话可用
 *   ok       —— 绑定表读到了
 *   error    —— 文件在但读/解析失败，本地会话先不归（可能正是桥接会话）
 */
let cache = { mtime: -1, bySession: new Map(), loadedAt: 0, state: 'unloaded', why: '' }

/** 读绑定表。永不抛；读不到返回空表。 */
export async function loadSources() {
  const file = configFile()
  let raw = ''
  let mtime = -1
  if (!existsSync(file)) {
    cache = { ...cache, mtime: -1, bySession: new Map(), loadedAt: Date.now(), state: 'none', why: 'no config' }
    return { ok: true, state: 'none', why: 'no config', bySession: cache.bySession, file }
  }
  try {
    const st = await stat(file)
    mtime = st.mtimeMs
    if (mtime === cache.mtime && (cache.state === 'ok' || cache.state === 'none')) {
      return { ok: cache.state === 'ok', state: cache.state, bySession: cache.bySession, file }
    }
    raw = await readFile(file, 'utf8')
  } catch (e) {
    cache = { ...cache, loadedAt: Date.now(), state: 'error', why: String(e?.message ?? e) }
    return { ok: false, state: 'error', why: String(e?.message ?? e), bySession: cache.bySession, file }
  }

  const bySession = new Map()
  try {
    const j = JSON.parse(raw)
    const bindings = Array.isArray(j?.绑定) ? j.绑定 : []
    for (const b of bindings) {
      const sid = String(b?.会话 ?? '').trim()
      if (!sid) continue
      const type = String(b?.类型 ?? '').trim()
      const num = String(b?.号码 ?? '').trim()
      const kind = type.includes('群') ? 'group' : 'private'
      bySession.set(sid, {
        kind,
        id: num,
        label: kind === 'group' ? `群 ${num}` : `私聊 ${num}`,
        addr: String(b?.称呼 ?? '').trim(),
        bridge: true,
      })
    }
  } catch (e) {
    cache = { ...cache, loadedAt: Date.now(), state: 'error', why: `bad json: ${e?.message ?? e}` }
    return { ok: false, state: 'error', why: `bad json: ${e?.message ?? e}`, bySession, file }
  }

  cache = { mtime, bySession, loadedAt: Date.now(), state: 'ok', why: '' }
  return { ok: true, state: 'ok', bySession, file }
}

/**
 * 按会话 id 查来源。
 * 桥接命中 → 绑定分片；否则（配置可读/不存在）→ 本地分片。
 * @returns {Promise<object|null>} null = 认不出来源，这一轮不采
 */
export async function sourceOfSession(sessionId) {
  if (!sessionId) return null
  const r = await loadSources()
  const hit = r.bySession.get(String(sessionId))
  if (hit) return hit
  if (r.state === 'error' || r.state === 'unloaded') return null
  if (!localScopeEnabled()) return null
  return localSource(sessionId)
}

/** 同步版：只读已预热的缓存。预热前返回 null（宁可漏挂，不错挂）。 */
export function sourceOfSessionSync(sessionId) {
  if (!sessionId || cache.state === 'unloaded') return null
  const hit = cache.bySession.get(String(sessionId))
  if (hit) return hit
  if (cache.state === 'error') return null
  if (!localScopeEnabled()) return null
  return localSource(sessionId)
}

/** 预热缓存（启动时调一次，之后 onCreated 就能同步查）。 */
export async function preloadSources() {
  const r = await loadSources()
  return { ok: r.ok, state: r.state, sessions: r.bySession.size, file: r.file }
}

/** 测试/诊断：当前缓存状态。 */
export function sourceCacheInfo() {
  return { mtime: cache.mtime, state: cache.state, sessions: cache.bySession.size, loadedAt: cache.loadedAt, file: configFile() }
}

/** 测试用：清缓存（含 unloaded 状态）。 */
export function resetSourceCache() {
  cache = { mtime: -1, bySession: new Map(), loadedAt: 0, state: 'unloaded', why: '' }
}
