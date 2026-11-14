/**
 * backupbundle.js —— 界面用的可移植记忆备份
 *
 * 和 tools/backup.mjs 的区别：那边是整目录备份/恢复，要求关闭 DSH；
 * 这里是给网页维护页用的 JSON 包，导出后在界面里重新导入时做「合并召回」，
 * 不覆盖当前库，所以不用停 DSH。
 *
 * 只合并记忆条目和缺失的人格文件；不导入 settings.json，避免把旧环境
 * 的模型地址或密钥带回来。
 */

import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  addItem, emptyScope, ensureDirs, findSimilarItem, listScopes, loadScope,
  saveScope, scopeLabel, writeAtomic,
} from './store.js'
import { isLive } from './itemstate.js'

export const BUNDLE_FORMAT = 'whale-memory-bundle'
export const BUNDLE_VERSION = 1

const PERSONA_FILES = ['persona.md', 'persona_full.md', 'AGENT.md', 'USER.md']

async function readTextIfExists(file) {
  try { return await readFile(file, 'utf8') } catch { return '' }
}

/** 导出当前库：分片条目 + 人格文件。 */
export async function buildBundle(root, { withAudit = false } = {}) {
  const scopes = await listScopes(root)
  const files = {}
  for (const name of PERSONA_FILES) {
    const text = await readTextIfExists(join(root, name))
    if (text) files[name] = text
  }
  return {
    format: BUNDLE_FORMAT,
    version: BUNDLE_VERSION,
    at: new Date().toISOString(),
    source: String(root || ''),
    files,
    scopes: scopes.map((sc) => ({
      scope: sc.scope,
      kind: sc.kind,
      id: sc.id,
      label: sc.label || scopeLabel(sc.kind, sc.id),
      profile: sc.profile ?? null,
      members: Array.isArray(sc.members) ? sc.members : [],
      items: (sc.items || []).map((it) => ({
        id: it.id,
        text: it.text,
        kind: it.kind,
        conf: it.conf,
        state: it.state,
        source: it.source,
        sourceQuote: it.sourceQuote,
        scene: it.scene,
        refs: it.refs,
        tags: it.tags,
        atAbs: it.atAbs,
        observedAt: it.observedAt,
        speaker: it.speaker,
        trigger: it.trigger,
        antiPattern: it.antiPattern,
        goal: it.goal,
        progress: it.progress,
        due: it.due,
        toWhom: it.toWhom,
        steps: it.steps,
        verify: it.verify,
        pin: it.pin,
        pinWhy: it.pinWhy,
        created: it.created,
        lastHit: it.lastHit,
        hits: it.hits,
        searchHits: it.searchHits,
        merged: it.merged,
      })),
    })),
  }
}

function itemKey(item) {
  return item && item.id ? String(item.id) : ''
}

function hasDuplicate(scope, raw, text) {
  const id = itemKey(raw)
  if (id && (scope.items || []).some((x) => x && x.id === id)) return true
  return !!findSimilarItem(scope.items || [], text, 0.72, { kind: raw.kind || 'fact' })
}

/**
 * 合并导入：同 id / 足够相似的条目不重复新增；只合并活着的条目。
 * dryRun=true 时不写盘，只返回预计数量。
 */
export async function importBundle(root, bundle, { dryRun = true } = {}) {
  if (!bundle || bundle.format !== BUNDLE_FORMAT) {
    throw new Error('不是 whale-memory 备份文件')
  }
  if (!Array.isArray(bundle.scopes)) {
    throw new Error('备份文件缺少 scopes')
  }
  await ensureDirs(root)
  const result = {
    ok: true,
    dryRun: !!dryRun,
    at: bundle.at || '',
    scopes: [],
    totals: { scopes: 0, added: 0, merged: 0, skipped: 0, dead: 0 },
  }

  for (const src of bundle.scopes.slice(0, 500)) {
    const kind = String(src?.kind || '')
    const id = String(src?.id || '')
    if (!kind || !id) continue
    let scope
    try { scope = await loadScope(root, kind, id) } catch { scope = null }
    if (!scope) scope = emptyScope(kind, id, src.label || '')
    if (!Array.isArray(scope.items)) scope.items = []
    let added = 0
    let merged = 0
    let skipped = 0
    let dead = 0
    for (const raw of (Array.isArray(src.items) ? src.items : []).slice(0, 10000)) {
      const text = String(raw?.text || '').trim()
      if (!text) continue
      // archived / superseded / merged 不导入；suggested / expired 仍按原状态保留
      if (!isLive(raw, { suggestedDead: false, expiredDead: false, mergedDead: true })) { dead += 1; continue }
      if (hasDuplicate(scope, raw, text)) { skipped += 1; continue }
      if (dryRun) { added += 1; continue }
      const before = new Set(scope.items.map((x) => x?.id))
      const item = addItem(scope, {
        text,
        kind: raw.kind || 'fact',
        conf: raw.conf ?? 0.6,
        source: raw.source || `import:backup:${bundle.at || ''}`,
        sourceQuote: raw.sourceQuote || '',
        scene: raw.scene || '',
        refs: Array.isArray(raw.refs) ? raw.refs : [],
        tags: Array.isArray(raw.tags) ? raw.tags : [],
        atAbs: raw.atAbs || '',
        observedAt: raw.observedAt || raw.created || '',
        speaker: raw.speaker || '',
        state: raw.state || 'active',
        trigger: raw.trigger || '',
        antiPattern: raw.antiPattern || '',
        goal: raw.goal || '',
        progress: raw.progress || '',
        due: raw.due || '',
        toWhom: raw.toWhom || '',
        steps: Array.isArray(raw.steps) ? raw.steps : [],
        verify: raw.verify || '',
        pin: raw.pin === true,
        pinWhy: raw.pinWhy || '',
      })
      if (!item) { skipped += 1; continue }
      if (before.has(item.id)) merged += 1
      else added += 1
    }
    if (!dryRun && (added > 0 || merged > 0)) {
      await saveScope(root, scope)
    }
    // 缺失的人格文件才补，已有内容绝不覆盖
    if (!dryRun && bundle.files && typeof bundle.files === 'object') {
      for (const name of PERSONA_FILES) {
        const file = join(root, name)
        const text = bundle.files[name]
        if (text && !existsSync(file)) await writeAtomic(file, String(text))
      }
    }
    result.scopes.push({
      scope: `${kind}:${id}`,
      label: scope.label || scopeLabel(kind, id),
      added,
      merged,
      skipped,
      dead,
    })
    result.totals.scopes += 1
    result.totals.added += added
    result.totals.merged += merged
    result.totals.skipped += skipped
    result.totals.dead += dead
  }
  return result
}
