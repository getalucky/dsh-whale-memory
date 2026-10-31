/**
 * trust.js —— 外部记忆库信任门（阶段 8 / 文档 4.10）
 *
 * 记忆库是会进 system prompt 的文本，所以它是输入面，不是纯数据：
 * clone 下来的 .dsh-memory 里完全可以埋一条"忽略之前的指令"。
 *
 * 规则：
 *   · origin = local  ：本机创建，直接可用
 *   · origin = external：默认不注入、不检索、不参与整理；要人来 trust
 *   · trust 时记内容指纹；开机发现指纹变了（库被替换/外部改了）→ 自动撤销
 *   · 我们自己的写入会刷新指纹，避免"用一次就掉信任"
 *
 * 指纹 = persona.md + 每个分片的 memory_index.md + memory_full 文件名/大小。
 * 不做逐字节全库哈希：主库可能很大，开机不该扫 GB。
 */

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

const cache = new Map() // root -> {mtime, state}

async function readText(file, fallback = '') {
  try { return await readFile(file, 'utf8') } catch { return fallback }
}

async function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmp, text, 'utf8')
  await rename(tmp, file)
}

export async function readMeta(root) {
  try {
    return JSON.parse(await readText(join(root, 'meta.json'), '{}'))
  } catch {
    return {}
  }
}

async function writeMeta(root, meta) {
  await mkdir(root, { recursive: true })
  await writeAtomic(join(root, 'meta.json'), JSON.stringify(meta, null, 2))
}

/**
 * 判断一个库是不是外来的。只在 meta 缺失时判断：
 * 目录里已经有 scopes/ 内容 → 是 clone/导入的；空目录/new → 本地。
 */
function inGitRepo(root) {
  let d = resolve(root)
  for (let i = 0; i < 3; i += 1) {
    if (existsSync(join(d, '.git'))) return true
    const up = dirname(d)
    if (up === d) break
    d = up
  }
  return false
}

export async function detectOrigin(root) {
  if (process.env.DSH_MEMORY_EXTERNAL === '1') return 'external'
  const meta = await readMeta(root)
  if (meta.origin) return meta.origin
  // 有 meta 但没写 origin 的是老版本本地库，不能误判成外来库；
  // 除非它躺在 git 仓库里（clone 下来的记忆库通常这样）
  if (Object.keys(meta).length) return inGitRepo(root) ? 'external' : 'local'
  let names = []
  try { names = await readdir(join(root, 'scopes')) } catch { names = [] }
  return inGitRepo(root) || names.length ? 'external' : 'local'
}

/** 内容指纹。只读索引和文件清单，不读主库正文。 */
export async function fingerprint(root) {
  const h = createHash('sha1')
  const persona = await readText(join(root, 'persona.md'), '')
  h.update('persona\0').update(persona).update('\0')

  let dirs = []
  try {
    dirs = (await readdir(join(root, 'scopes'), { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort()
  } catch { dirs = [] }

  for (const dir of dirs) {
    const base = join(root, 'scopes', dir)
    h.update(`scope:${dir}\0`)
    h.update(await readText(join(base, 'memory_index.md'), '')).update('\0')
    let files = []
    try { files = (await readdir(join(base, 'memory_full'))).filter((n) => n.endsWith('.md')).sort() } catch { files = [] }
    for (const f of files) {
      let size = 0
      try { size = (await stat(join(base, 'memory_full', f))).size } catch { size = 0 }
      h.update(`${f}:${size}\0`)
    }
  }
  return h.digest('hex').slice(0, 20)
}

/** 读信任状态（带文件 mtime 缓存）。 */
export async function trustState(root, { recheck = false } = {}) {
  const metaFile = join(root, 'meta.json')
  let mtime = -1
  try { mtime = (await stat(metaFile)).mtimeMs } catch { mtime = -1 }
  const hit = cache.get(root)
  if (!recheck && hit && hit.mtime === mtime) return hit.state

  const meta = await readMeta(root)
  const origin = meta.origin || await detectOrigin(root)
  let state = {
    origin,
    usable: origin !== 'external',
    trustedAt: meta.trustedAt || '',
    stored: meta.fingerprint || '',
    current: '',
    drift: false,
  }
  if (origin === 'external') {
    state.current = await fingerprint(root)
    if (meta.trustedAt) {
      state.drift = Boolean(meta.fingerprint) && state.current !== meta.fingerprint
      state.usable = !state.drift
    }
  }
  cache.set(root, { mtime, state })
  return state
}

/** 同步读：只给启动预载后、inject 的同步回调用。 */
export function trustStateSync(root) {
  return cache.get(root)?.state ?? { origin: 'local', usable: true, trustedAt: '', stored: '', current: '', drift: false }
}

/** 启动时预载并做一次漂移检查；漂移就撤销信任并写回 meta。 */
export async function preloadTrust(root) {
  const s = await trustState(root, { recheck: true })
  if (s.origin === 'external' && s.drift) {
    const meta = await readMeta(root)
    meta.trustedAt = ''
    meta.fingerprint = ''
    meta.revokedAt = new Date().toISOString()
    meta.revokeReason = 'fingerprint changed'
    await writeMeta(root, meta)
    cache.delete(root)
    return { ...s, usable: false, trustedAt: '', drift: true }
  }
  return s
}

/** 人工确认信任。 */
export async function trust(root) {
  const meta = await readMeta(root)
  meta.origin = meta.origin || await detectOrigin(root)
  meta.trustedAt = new Date().toISOString()
  meta.fingerprint = await fingerprint(root)
  await writeMeta(root, meta)
  cache.delete(root)
  return trustState(root, { recheck: true })
}

export async function revoke(root) {
  const meta = await readMeta(root)
  meta.trustedAt = ''
  meta.fingerprint = ''
  meta.revokedAt = new Date().toISOString()
  await writeMeta(root, meta)
  cache.delete(root)
  return trustState(root, { recheck: true })
}

/**
 * 我们自己的写入完成后刷新指纹，防止外部库一旦用起来就掉信任。
 * 只对已信任的 external 库生效，local 库零开销。
 */
export async function refreshTrustStamp(root) {
  const meta = await readMeta(root)
  if (meta.origin !== 'external' || !meta.trustedAt) return
  meta.fingerprint = await fingerprint(root)
  await writeMeta(root, meta)
  cache.delete(root)
}

/** 工具侧的快速门禁。 */
export async function assertUsable(root) {
  const s = await trustState(root)
  if (s.usable) return { ok: true }
  return {
    ok: false,
    why: s.origin === 'external'
      ? '外部记忆库未信任（或指纹变了）：先运行 node tools/memory-trust.mjs trust'
      : '记忆库不可用',
  }
}

export function resetTrustCache() {
  cache.clear()
}
