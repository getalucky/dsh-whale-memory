/**
 * secure/vault.js —— 敏感文件加密
 *
 * 只服务三样：心理画像、心事匣、情绪日记（阶段 10 预留）。
 * 记忆、人格、素材索引保持明文，方便 diff/手改。
 *
 * 文件格式：WHLV1 | nonce(12) | tag(16) | ciphertext，AES-256-GCM。
 * 密钥：Windows 优先 DPAPI（CurrentUser）保护；其他平台或 DPAPI 不可用时
 * 退回 0600 原始密钥。密钥丢 = 敏感数据丢，不假装能恢复。
 */

import { spawnSync } from 'node:child_process'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { chmod, mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const MAGIC = Buffer.from('WHLV1', 'ascii')
const KEY_MAGIC = 'WKEY1'
const NONCE = 12
const TAG = 16
const KEY_BYTES = 32

export function secureDir(root) {
  return join(root, 'secure')
}

export function keyPath(root) {
  return join(secureDir(root), 'vault.key')
}

export function notepadPath(root) {
  return join(secureDir(root), 'notepad.enc')
}

export function affectJournalPath(root) {
  return join(secureDir(root), 'affect-journal.enc')
}

export function psychPath(root) {
  return join(root, 'person', 'psych.json')
}

export function sensitiveFiles(root) {
  return [
    psychPath(root),
    notepadPath(root),
    affectJournalPath(root),
  ]
}

function dpapiScript() {
  try {
    return fileURLToPath(new URL('./dpapi.ps1', import.meta.url))
  } catch {
    return ''
  }
}

function dpapiAvailable() {
  if (String(process.env.DSH_MEMORY_VAULT || '').toLowerCase() === 'plain') return false
  if (process.platform !== 'win32') return false
  return existsSync(dpapiScript())
}

function runDpapi(action, b64) {
  const script = dpapiScript()
  const r = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', script, action,
  ], { input: b64, encoding: 'utf8', timeout: 30000, windowsHide: true })
  if (r.status !== 0) throw new Error(`dpapi ${action}: ${String(r.stderr || r.error || '').slice(0, 120)}`)
  const out = String(r.stdout || '').trim()
  if (!out) throw new Error(`dpapi ${action}: empty output`)
  return out
}

async function writeAtomic(file, buf) {
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  const fh = await open(tmp, 'w')
  try {
    await fh.writeFile(buf)
    await fh.sync()
  } catch (e) {
    await fh.close().catch(() => {})
    await unlink(tmp).catch(() => {})
    throw e
  }
  await fh.close()
  await rename(tmp, file)
}

function aadFor(root, file) {
  if (!file) return null
  return Buffer.from(`WHLV1|${relative(root, file).replace(/\\/g, '/')}`, 'utf8')
}

async function newKey() {
  return randomBytes(KEY_BYTES)
}

/** 读密钥；没有就生成。DPAPI 可用时把密钥包成 WKEY1+base64。 */
export async function loadKey(root) {
  const file = keyPath(root)
  if (existsSync(file)) {
    const raw = await readFile(file)
    const text = raw.toString('utf8')
    if (text.startsWith(KEY_MAGIC)) {
      const b64 = text.slice(KEY_MAGIC.length).replace(/\s+/g, '')
      if (!dpapiAvailable()) throw new Error('vault.key 是 DPAPI 容器，但当前环境没有 DPAPI')
      const out = Buffer.from(runDpapi('unprotect', b64), 'base64')
      if (out.length !== KEY_BYTES) throw new Error('vault.key 解出来的长度不对')
      return out
    }
    if (raw.length === KEY_BYTES) return raw
    throw new Error('vault.key 格式不认识（既不是 DPAPI 容器，也不是 32 字节密钥）')
  }

  const key = await newKey()
  await mkdir(secureDir(root), { recursive: true })
  if (dpapiAvailable()) {
    try {
      const b64 = runDpapi('protect', key.toString('base64'))
      await writeAtomic(file, Buffer.from(`${KEY_MAGIC}${b64}`, 'utf8'))
      return key
    } catch { /* DPAPI 失败就用原始密钥，下面会写 0600 */ }
  }
  await writeAtomic(file, key)
  try { await chmod(file, 0o600) } catch { /* Windows 上 chmod 可能无效 */ }
  return key
}

/**
 * 加密文本。给了 file 就把相对路径绑进 AAD——密文被挪到别的文件就解不开。
 */
export async function encryptText(root, text, { file = '' } = {}) {
  const key = await loadKey(root)
  const nonce = randomBytes(NONCE)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  const aad = aadFor(root, file)
  if (aad) cipher.setAAD(aad)
  const ct = Buffer.concat([cipher.update(Buffer.from(String(text ?? ''), 'utf8')), cipher.final()])
  return Buffer.concat([MAGIC, nonce, cipher.getAuthTag(), ct])
}

export async function decryptText(root, buf, { file = '' } = {}) {
  if (!Buffer.isBuffer(buf) || buf.length < MAGIC.length + NONCE + TAG || !buf.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error('不是 WHLV1 加密文件')
  }
  const key = await loadKey(root)
  const nonce = buf.subarray(MAGIC.length, MAGIC.length + NONCE)
  const tag = buf.subarray(MAGIC.length + NONCE, MAGIC.length + NONCE + TAG)
  const ct = buf.subarray(MAGIC.length + NONCE + TAG)
  const decipher = createDecipheriv('aes-256-gcm', key, nonce)
  const aad = aadFor(root, file)
  if (aad) decipher.setAAD(aad)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8')
}

export async function writeEncrypted(root, file, text) {
  await writeAtomic(file, await encryptText(root, text, { file }))
  return file
}

/**
 * 读敏感文件；不存在返回 fallback。坏容器直接抛，别静默当空。
 * 旧版密文没绑 AAD：能按旧方式解开就顺手重写为路径绑定版。
 */
export async function readEncrypted(root, file, fallback = '') {
  let raw
  try { raw = await readFile(file) } catch { return fallback }
  try {
    return await decryptText(root, raw, { file })
  } catch (e) {
    const legacy = await decryptText(root, raw).catch(() => null)
    if (legacy === null) throw e
    await writeEncrypted(root, file, legacy).catch(() => {})
    return legacy
  }
}

/** 只删敏感文件；默认留密钥，方便以后重新启用。 */
export async function burnSensitive(root, { key = false } = {}) {
  const out = []
  for (const f of sensitiveFiles(root)) {
    try {
      await unlink(f)
      out.push(f)
    } catch { /* 不存在就算 */ }
  }
  if (key) {
    try {
      await unlink(keyPath(root))
      out.push(keyPath(root))
    } catch { /* 不存在就算 */ }
  }
  return out
}

/**
 * 敏感文件体检：能存在就必须能解开。解不开返回错误清单，beat 据此停跳。
 * @returns {Promise<{ok:boolean, checked:number, errors:Array<{file:string, why:string}>}>}
 */
export async function checkSensitiveHealth(root) {
  const errors = []
  let checked = 0
  for (const file of sensitiveFiles(root)) {
    if (!existsSync(file)) continue
    checked += 1
    try {
      await readEncrypted(root, file, '')
    } catch (e) {
      errors.push({ file, why: String(e?.message ?? e).slice(0, 160) })
    }
  }
  return { ok: errors.length === 0, checked, errors }
}

export function vaultInfo(root) {
  return {
    dir: secureDir(root),
    key: keyPath(root),
    keyExists: existsSync(keyPath(root)),
    files: sensitiveFiles(root).map((f) => ({ path: f, exists: existsSync(f) })),
    dpapi: dpapiAvailable(),
  }
}
