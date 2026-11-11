/**
 * settings.js —— 界面能改的运行配置
 *
 * 只放「需要用户自己填、不想每次改环境变量」的东西，目前是模型端点。
 * 文件在 <root>/settings.json，和 persona.md 同级。
 *
 * key 落盘优先用 DPAPI 加密成 keyEnc；DPAPI 不可用（非 Windows / 显式 plain）
 * 才退回明文，并保持 0600。另外：
 *   · 界面只回显打码后的尾巴，GET 接口永远不返回完整 key
 *   · 环境变量仍然生效：文件优先，没填的字段回落到 DSH_MEMORY_*
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { protectSecretSync, unprotectSecretSync } from './secure/vault.js'

const SECRET_KINDS = ['llm', 'search', 'embed', 'review']
// DPAPI 解密要 spawn PowerShell；同一个密文只解一次。
const plainCache = new Map()

function decryptKeys(o) {
  for (const k of SECRET_KINDS) {
    const e = o?.[k]
    if (!e || typeof e !== 'object' || e.key || typeof e.keyEnc !== 'string' || !e.keyEnc) continue
    let plain = plainCache.get(e.keyEnc)
    if (plain === undefined) {
      plain = unprotectSecretSync(e.keyEnc)
      if (plain) {
        plainCache.set(e.keyEnc, plain)
        if (plainCache.size > 20) plainCache.delete(plainCache.keys().next().value)
      }
    }
    if (plain) e.key = plain
  }
  return o
}

export function settingsPath(root) {
  return join(root || '.', 'settings.json')
}

/** 读配置。文件不在、JSON 坏了都当空配置，不抛。 */
export function loadSettings(root) {
  if (!root) return {}
  const file = settingsPath(root)
  if (!existsSync(file)) return {}
  try {
    const o = JSON.parse(readFileSync(file, 'utf8'))
    return o && typeof o === 'object' && !Array.isArray(o) ? decryptKeys(o) : {}
  } catch {
    return {}
  }
}

function writeSettingsFile(file, data) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
  renameSync(tmp, file)
  // Windows 上 chmod 基本是空转，但 unix 下有用，失败不影响保存
  try { chmodSync(file, 0o600) } catch { /* ignore */ }
}

/** 整份覆盖写（先写临时文件再改名，断电不会留下半截 JSON）。 */
export function saveSettings(root, next, { log } = {}) {
  const data = { ...(next ?? {}) }
  for (const k of SECRET_KINDS) {
    if (!data[k] || typeof data[k] !== 'object') continue
    const entry = { ...data[k] }
    const key = String(entry.key ?? '')
    if (!key) {
      // 只有界面显式「清除」才删密文；解密失败/没回显时保留旧密文，避免一次保存把 key 弄丢。
      if (entry.clearKey === true) delete entry.keyEnc
    } else {
      // 读配置时已经解过一次的密文，明文没变就不再 spawn PowerShell 重加密。
      const cached = typeof entry.keyEnc === 'string' ? plainCache.get(entry.keyEnc) : undefined
      if (cached === key) {
        delete entry.key
      } else {
        const enc = protectSecretSync(key)
        if (enc) {
          entry.keyEnc = enc
          delete entry.key
          plainCache.set(enc, key)
        } else {
          delete entry.keyEnc
          log?.(`[whale] settings.${k}.key 仍是明文：DPAPI 不可用或加密失败`)
        }
      }
    }
    delete entry.clearKey
    data[k] = entry
  }
  writeSettingsFile(settingsPath(root), data)
  return next ?? {}
}

/**
 * 启动时把历史明文 key 迁成 DPAPI。失败/不可用就保持原样，只提示一次。
 * 返回迁移了几项，方便启动日志说清楚。
 */
export function migratePlaintextSettings(root, { log } = {}) {
  if (!root) return 0
  const file = settingsPath(root)
  if (!existsSync(file)) return 0
  let raw
  try { raw = JSON.parse(readFileSync(file, 'utf8')) } catch { return 0 }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 0
  let moved = 0
  for (const k of SECRET_KINDS) {
    const e = raw[k]
    if (!e || typeof e !== 'object' || !e.key) continue
    const enc = protectSecretSync(String(e.key))
    if (!enc) continue
    e.keyEnc = enc
    delete e.key
    moved += 1
  }
  if (moved) {
    writeSettingsFile(file, raw)
    log?.(`[whale] settings.json 已把 ${moved} 个明文 key 迁移成 DPAPI`)
  } else if (SECRET_KINDS.some((k) => raw[k] && typeof raw[k] === 'object' && raw[k].key)) {
    log?.('[whale] settings.json 里仍有明文 key：当前环境 DPAPI 不可用')
  }
  return moved
}

/** sk-abcdef1234 → sk-…1234；短到没有尾巴就整个打掉。 */
export function maskKey(key) {
  const s = String(key ?? '')
  if (!s) return ''
  if (s.length <= 8) return '••••'
  return `${s.slice(0, 3)}…${s.slice(-4)}`
}
