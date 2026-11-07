/**
 * person/rebuild.js —— 画像重建入口
 *
 * profile.json 是派生缓存；这个文件只做“重建 / 校验 / 摘要”，不引入
 * 第二套真源。CLI 与 beat 维护相都从这里进。
 */

import { readFile } from 'node:fs/promises'

import { profilePath, rebuildProfile } from './profile.js'

export { rebuildProfile }

export async function rebuildAndVerify(root, { now = new Date(), log } = {}) {
  const before = await readProfileHash(root)
  const profile = await rebuildProfile(root, { now, log })
  return { ok: true, before, after: profile.hash, profile }
}

async function readProfileHash(root) {
  try {
    const o = JSON.parse(await readFile(profilePath(root), 'utf8'))
    return String(o.hash || '')
  } catch {
    return ''
  }
}

export async function profileStatus(root) {
  try {
    const o = JSON.parse(await readFile(profilePath(root), 'utf8'))
    return {
      ok: true,
      hash: o.hash || '',
      updatedAt: o.updatedAt || '',
      counts: Object.fromEntries(Object.entries(o.partitions || {}).map(([k, v]) => [k, v.length])),
      evidence: Object.values(o.partitions || {}).flat().every((e) => Array.isArray(e.evidenceIds) && e.evidenceIds.length > 0),
    }
  } catch {
    return { ok: false, hash: '', updatedAt: '', counts: {}, evidence: false }
  }
}
