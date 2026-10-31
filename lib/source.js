/**
 * source.js —— 「这条会话是谁在说话」
 *
 * 不解析消息文本，直接读 `$DSH_HOME/qq-bridge-config.json` 的绑定表：
 *   每条绑定写着 类型（私聊/群）、号码、会话 id。
 * 会话 id 是确定的，所以 sessionId → 来源是查表，不是猜。
 *
 * 缓存按文件 mtime 刷新：桥接重建会话会改这个文件，改了下一轮就生效。
 */

import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

function configFile() {
  if (process.env.DSH_QQ_BRIDGE_CONFIG) return process.env.DSH_QQ_BRIDGE_CONFIG
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(dshHome, 'qq-bridge-config.json')
}

let cache = { mtime: -1, bySession: new Map(), loadedAt: 0 }

/** 读绑定表。永不抛；读不到返回空表。 */
export async function loadSources() {
  const file = configFile()
  let raw = ''
  let mtime = -1
  try {
    if (!existsSync(file)) return { ok: false, why: 'no config', bySession: new Map(), file }
    const st = await import('node:fs/promises').then((m) => m.stat(file))
    mtime = st.mtimeMs
    if (mtime === cache.mtime) return { ok: true, bySession: cache.bySession, file }
    raw = await readFile(file, 'utf8')
  } catch (e) {
    return { ok: false, why: String(e?.message ?? e), bySession: cache.bySession, file }
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
      })
    }
  } catch (e) {
    return { ok: false, why: `bad json: ${e?.message ?? e}`, bySession, file }
  }

  cache = { mtime, bySession, loadedAt: Date.now() }
  return { ok: true, bySession, file }
}

/** 按会话 id 查来源。查不到返回 null（= 不是桥接会话，或绑定被删了）。 */
export async function sourceOfSession(sessionId) {
  if (!sessionId) return null
  const r = await loadSources()
  return r.bySession.get(String(sessionId)) ?? null
}

/** 同步版：只读已预热的缓存。预热前返回 null（宁可漏挂，不错挂）。 */
export function sourceOfSessionSync(sessionId) {
  if (!sessionId || cache.mtime < 0) return null
  return cache.bySession.get(String(sessionId)) ?? null
}

/** 预热缓存（启动时调一次，之后 onCreated 就能同步查）。 */
export async function preloadSources() {
  const r = await loadSources()
  return { ok: r.ok, sessions: r.bySession.size, file: r.file }
}

/** 测试/诊断：当前缓存状态。 */
export function sourceCacheInfo() {
  return { mtime: cache.mtime, sessions: cache.bySession.size, loadedAt: cache.loadedAt, file: configFile() }
}