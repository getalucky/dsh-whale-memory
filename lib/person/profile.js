/**
 * person/profile.js —— 从 memory 派生画像
 *
 * `person/profile.json` 是缓存，不是真源：删掉、重建都能回来。
 * 输入是 scopes 里的条目（material 不在 listScopes 里，天然排除）；
 * 输出只有 interest / projects / comm 三个明文分区，psych 单独在
 * `person/psych.json`（加密），不进这个文件。
 */

import { createHash } from 'node:crypto'
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { listScopes, writeAtomic } from '../store.js'
import { isExplicit, isGenericKey, isUsableItem, keyOf, partitionOf } from './partitions.js'

export const PROFILE_SCHEMA = 1
export const PROFILE_FILE = 'person/profile.json'
export const AUDIT_FILE = 'person/audit.jsonl'

export function profilePath(root) {
  return join(root, PROFILE_FILE)
}

export function auditPath(root) {
  return join(root, AUDIT_FILE)
}

export function emptyProfile() {
  return {
    schema: PROFILE_SCHEMA,
    updatedAt: '',
    builtFrom: { scopes: 0, items: 0 },
    hash: '',
    partitions: { interest: [], projects: [], comm: [] },
  }
}

function dateOf(item) {
  return String(item.lastHit || item.observedAt || item.created || '')
}

function hashOf(partitions) {
  return createHash('sha1').update(JSON.stringify(partitions), 'utf8').digest('hex').slice(0, 16)
}

function stabilityOf(entry) {
  if (entry.explicit) return 'stable'
  if (entry.count >= 3 && entry.spanDays >= 7) return 'stable'
  return 'recent'
}

/** 纯函数：分片数组 → 画像。方便测试与 rebuild。 */
export function buildProfileFromScopes(scopes, { now = new Date() } = {}) {
  const acc = new Map()
  let items = 0
  for (const sc of scopes || []) {
    if (!sc || sc.kind === 'public' || sc.kind === 'material') continue
    for (const it of sc.items || []) {
      if (!isUsableItem(it)) continue
      const part = partitionOf(it)
      if (!part) continue
      const key = keyOf(it, part)
      if (!key) continue
      items += 1
      const id = `${part}|${key}`
      let e = acc.get(id)
      if (!e) {
        e = {
          key,
          partition: part,
          count: 0,
          evidenceIds: [],
          confidence: 0,
          explicit: false,
          firstSeen: '',
          lastSeen: '',
        }
        acc.set(id, e)
      }
      e.count += 1
      if (e.evidenceIds.length < 12 && !e.evidenceIds.includes(it.id)) e.evidenceIds.push(it.id)
      e.confidence = Math.max(e.confidence, Number(it.conf) || 0)
      if (isExplicit(it)) e.explicit = true
      const at = dateOf(it)
      if (at && (!e.firstSeen || at < e.firstSeen)) e.firstSeen = at
      if (at && (!e.lastSeen || at > e.lastSeen)) e.lastSeen = at
    }
  }

  const partitions = { interest: [], projects: [], comm: [] }
  for (const e of acc.values()) {
    const first = Date.parse(e.firstSeen || '') || 0
    const last = Date.parse(e.lastSeen || '') || 0
    const spanDays = first && last ? Math.max(0, (last - first) / 86400000) : 0
    const entry = {
      key: e.key,
      partition: e.partition,
      count: e.count,
      evidenceIds: e.evidenceIds,
      confidence: Math.round(Math.min(0.9, e.confidence || 0.5) * 100) / 100,
      explicit: e.explicit,
      firstSeen: e.firstSeen,
      lastSeen: e.lastSeen,
      stability: '',
    }
    entry.stability = stabilityOf({ ...entry, spanDays })
    partitions[e.partition].push(entry)
  }
  for (const list of Object.values(partitions)) {
    list.sort((a, b) => (b.stability === 'stable') - (a.stability === 'stable') || b.count - a.count || b.confidence - a.confidence)
  }
  partitions.interest = partitions.interest.slice(0, 8)
  partitions.projects = partitions.projects.slice(0, 6)
  partitions.comm = partitions.comm.slice(0, 6)

  return {
    schema: PROFILE_SCHEMA,
    updatedAt: now.toISOString(),
    builtFrom: { scopes: (scopes || []).length, items },
    hash: hashOf(partitions),
    partitions,
  }
}

export async function loadProfile(root) {
  try {
    const raw = await readFile(profilePath(root), 'utf8')
    const o = JSON.parse(raw)
    if (o && o.schema === PROFILE_SCHEMA && o.partitions) return o
  } catch { /* 重建 */ }
  return rebuildProfile(root)
}

export async function rebuildProfile(root, { now = new Date(), log } = {}) {
  const scopes = await listScopes(root).catch(() => [])
  const profile = buildProfileFromScopes(scopes, { now })
  await mkdir(join(root, 'person'), { recursive: true })
  await writeAtomic(profilePath(root), JSON.stringify(profile, null, 2))
  await appendFile(auditPath(root), JSON.stringify({
    at: now.toISOString(),
    kind: 'rebuild',
    hash: profile.hash,
    builtFrom: profile.builtFrom,
    counts: Object.fromEntries(Object.entries(profile.partitions).map(([k, v]) => [k, v.length])),
  }) + '\n', 'utf8').catch(() => {})
  log?.(`[whale] 画像重建 · ${profile.builtFrom.scopes} 分片 / ${profile.builtFrom.items} 条 · i${profile.partitions.interest.length} p${profile.partitions.projects.length} c${profile.partitions.comm.length}`)
  return profile
}

/** 给闲逛用的兴趣：只取非通用主题，类型标签（事实/聊天等）不当焦点。 */
export function profileInterests(profile) {
  const keys = (profile?.partitions?.interest || [])
    .map((e) => String(e.key || '').trim())
    .filter((k) => k.length >= 2 && k.length <= 16 && !isGenericKey(k))
  return [...new Set(keys)]
}


export function profileExists(root) {
  return existsSync(profilePath(root))
}
