/**
 * settings.js —— 界面能改的运行配置
 *
 * 只放「需要用户自己填、不想每次改环境变量」的东西，目前是模型端点。
 * 文件在 <root>/settings.json，和 persona.md 同级。
 *
 * key 是明文（没有主密钥可加密，加密等于自欺），所以：
 *   · 写入时尽量收成 0600
 *   · 界面只回显打码后的尾巴，GET 接口永远不返回完整 key
 *   · 环境变量仍然生效：文件优先，没填的字段回落到 DSH_MEMORY_*
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

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
    return o && typeof o === 'object' && !Array.isArray(o) ? o : {}
  } catch {
    return {}
  }
}

/** 整份覆盖写（先写临时文件再改名，断电不会留下半截 JSON）。 */
export function saveSettings(root, next) {
  const file = settingsPath(root)
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(next ?? {}, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
  renameSync(tmp, file)
  // Windows 上 chmod 基本是空转，但 unix 下有用，失败不影响保存
  try { chmodSync(file, 0o600) } catch { /* ignore */ }
  return next ?? {}
}

/** sk-abcdef1234 → sk-…1234；短到没有尾巴就整个打掉。 */
export function maskKey(key) {
  const s = String(key ?? '')
  if (!s) return ''
  if (s.length <= 8) return '••••'
  return `${s.slice(0, 3)}…${s.slice(-4)}`
}
