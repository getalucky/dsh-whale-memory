/**
 * forget.js —— 淡忘与归档，以及手动删一条
 *
 * 评分：conf × exp(-ageDays/halfLife) × (1 + 0.15·min(hits,5))
 *   active  score ≥ 0.50
 *   warm    0.25 ≤ score < 0.50
 *   cold    score < 0.25
 *   archive cold 且距今 ≥ archiveDays（默认 90 天；公共池 180 天）→ 移进 archive/
 *
 * 公共池也走这条生命周期，只是半衰期更长（默认 90 天）。
 * 例外是 pin（知识库）：不按时间变冷、不归档，只有手动松开或 TTL 到期才离开。
 *
 * 只改状态、搬位置，不删内容——归档文件留着，想找回随时能翻。
 * 手动删（记忆记错了、旁白污染）走的也是同一条归档路径，只是 reason 不同。
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { paths, listScopes, saveScope, loadScope, archiveItem, auditWrite, logLine, withWriteLock, autoPinWhy, setPin, enforcePinCap, drainSearchHits } from './store.js'
import { vaultPaths, itemFromMarkdown } from './vault.js'
import { lifeState } from './inject.js'
import { buildGraph, saveGraph } from './graph.js'
import { buildProfile, buildMembers } from './profile.js'
import { listProjectRoots } from './namespace.js'

export const DEFAULTS = {
  halfLifeDays: 30,
  warmScore: 0.5,
  coldScore: 0.25,
  archiveDays: 90,
}

/**
 * 扫一遍所有分片，更新状态并归档。
 * @returns {Promise<{changed:number, archived:number}>}
 */
export async function runForget(root, cfg = {}) {
  return withWriteLock(async () => {
    const c = { ...DEFAULTS, ...cfg }
    const scopes = await listScopes(root)
    let changed = 0
    let archived = 0

    for (const sc of scopes) {
      // 公共池是外部情报，衰减慢一点、归档晚一点，但不是永不变冷：
      // 没人再查的旧情报该沉下去，重要的靠 pin（知识库）留住。
      const cc = sc.kind === 'public'
        ? { ...c, halfLifeDays: cfg.publicHalfLifeDays ?? 90, archiveDays: cfg.publicArchiveDays ?? 180 }
        : c
      // 搜索只往分片目录追加命中账本，不重写副库；这里一次性折算进 searchHits
      const gained = await drainSearchHits(root, sc.kind, sc.id).catch(() => ({}))
      const before = sc.items.length
      let scChanged = 0
      let scArchived = 0
      const keep = []
      for (const it of sc.items) {
        const got = gained[it.id] || 0
        if (got) {
          it.searchHits = (it.searchHits || 0) + got
          scChanged += 1
        }
        if (it.state === 'superseded') {
          keep.push(it)
          continue
        }
        // TTL：过期的条目标 expired，主库保留、副库和注入都剔除
        const raw = String(it.expiresAt || '')
        const exp = raw ? Date.parse(raw.length === 10 ? `${raw}T23:59:59` : raw) : NaN
        if (Number.isFinite(exp) && exp < Date.now()) {
          if (it.state !== 'expired') { it.state = 'expired'; it.expiredAt = new Date().toISOString(); scChanged += 1 }
          keep.push(it)
          continue
        }
        // 公共池：反复被搜到 / 反复写入的，批处理里升成知识。
        // 搜索侧只追加 search_hits.jsonl，这里 drain 后折算成 searchHits。
        if (sc.kind === 'public') {
          const why = autoPinWhy(it)
          if (why) { setPin(it, true, why); scChanged += 1 }
        }
        // 钉住的知识不参与半衰/归档，只有手动松开才会重新进入生命周期
        if (it.pin) {
          if (it.state !== 'active') { it.state = 'active'; scChanged += 1 }
          it.score = Number(lifeState(it, Date.now(), cc).score.toFixed(4))
          keep.push(it)
          continue
        }
        const life = lifeState(it, Date.now(), cc)
        if (life.state !== it.state) scChanged += 1
        it.state = life.state
        it.score = Number(life.score.toFixed(4))
        if (life.archive) {
          scArchived += 1
          await archiveItem(root, sc, it, 'cold+age')
        } else {
          keep.push(it)
        }
      }
      if (keep.length !== before) sc.items = keep
      // 公共池钉太多时松最久没用的；松开的也要落盘
      if (sc.kind === 'public' && enforcePinCap(sc).length) scChanged += 1
      changed += scChanged
      archived += scArchived
      if (scChanged || scArchived) {
        // 状态变了，画像和图谱都得跟着重算（画像里就写着「几件还热着」）
        const g = buildGraph([sc])
        sc.profile = buildProfile(sc, g)
        sc.members = buildMembers(sc)
        await saveScope(root, sc)
      }
    }

    if (changed || archived) {
      // 图谱涉及跨分片实体，整库重建一次
      const g = buildGraph(await listScopes(root))
      await saveGraph(root, g).catch(() => {})
      await logLine(root, `forget changed=${changed} archived=${archived}`)
    }
    return { changed, archived, scopes: scopes.length }
  })
}

/**
 * 手动删一条记忆：从分片里摘掉，写进 archive/（可回溯），审计留痕，
 * 然后重算这个分片的画像和整库图谱。
 *
 * @param {string} root
 * @param {'private'|'group'} kind
 * @param {string} id
 * @param {string} itemId
 * @param {{reason?:string}} [opts]
 * @returns {Promise<{ok:boolean, item?:object, why?:string}>}
 */
export async function forgetItem(root, kind, id, itemId, { reason = 'manual' } = {}) {
  if (!kind || !id || !itemId) return { ok: false, why: '参数不全' }
  return withWriteLock(async () => {
    const scope = await loadScope(root, kind, id)
    const idx = (scope.items || []).findIndex((x) => x.id === itemId)
    if (idx < 0) return { ok: false, why: '没找到这条记忆' }

    const [item] = scope.items.splice(idx, 1)
    await archiveItem(root, scope, item, reason)

    const scopes = (await listScopes(root).catch(() => [])).map((s) => (s.scope === scope.scope ? scope : s))
    const g = buildGraph(scopes)
    scope.profile = buildProfile(scope, g)
    scope.members = buildMembers(scope)
    await saveScope(root, scope)
    await saveGraph(root, g).catch(() => {})

    await auditWrite(root, { kind: 'forget', scope: scope.scope, item: itemId, text: String(item.text).slice(0, 120), why: reason })
    await logLine(root, `forget ${scope.scope} · ${itemId} · ${reason} · 「${String(item.text).slice(0, 40)}」`)
    return { ok: true, item }
  })
}

/**
 * 复活一条归档/过期的记忆：主库文件在 archive/full 里就搬回来。
 * 不传 kind/id 时全库按 id 找。
 */
export async function reviveItem(root, kind, id, itemId, { allowPublic = true } = {}) {
  return withWriteLock(async () => {
    let sc = null
    if (kind && id) {
      sc = await loadScope(root, kind, id)
    } else {
      for (const s of await listScopes(root)) {
        const p = vaultPaths(root, s.kind, s.id)
        if (s.items?.some((x) => x.id === itemId)) { sc = s; break }
        try {
          await import('node:fs/promises').then((m) => m.stat(join(p.archiveFull, `${itemId}.md`)))
          sc = s
          break
        } catch { /* 继续找 */ }
      }
    }
    if (!sc) return { ok: false, why: '全库都没找到这条记忆' }
    // 公共池谁都能读，但不是谁都能改；桌面界面（本机）不受限
    if (sc.kind === 'public' && !allowPublic) return { ok: false, why: '公共记忆池只有本机会话能改' }

    let it = (sc.items || []).find((x) => x.id === itemId)
    if (!it) {
      const p = vaultPaths(root, sc.kind, sc.id)
      let md = ''
      try { md = await readFile(join(p.archiveFull, `${itemId}.md`), 'utf8') } catch { /* ignore */ }
      if (!md) return { ok: false, why: '归档文件不见了' }
      it = itemFromMarkdown(md)
      if (!it) return { ok: false, why: '归档文件解析失败' }
      sc.items.push(it)
    }
    it.state = 'active'
    it.expiresAt = ''
    it.expiredAt = ''
    it.archivedAt = ''
    it.archiveReason = ''
    it.lastHit = new Date().toISOString()
    await saveScope(root, sc)
    await auditWrite(root, { kind: 'revive', scope: sc.scope, item: itemId, text: String(it.text).slice(0, 80) })
    await logLine(root, `revive ${sc.scope} · ${itemId}`)
    return { ok: true, id: itemId, scope: sc.scope }
  })
}

/** 启动遗忘循环（每小时一次）。 */
export function startForgetLoop({ root, log, cfg, everyMs = 60 * 60 * 1000 } = {}) {
  let timer = null
  const tick = async () => {
    try {
      // 仓库库也要按同样的规矩衰减：只扫 global 根的话，仓库里的条目永远不会变冷
      const roots = [root, ...(await listProjectRoots(root).catch(() => []))]
      let changed = 0
      let archived = 0
      for (const r of roots) {
        const out = await runForget(r, cfg).catch((e) => {
          log?.(`[whale] 遗忘失败 ${String(e?.message ?? e).slice(0, 120)}`)
          return { changed: 0, archived: 0 }
        })
        changed += out.changed || 0
        archived += out.archived || 0
      }
      if (changed || archived) log?.(`[whale] 遗忘：${changed} 条降级，${archived} 条归档`)
    } catch (e) {
      log?.(`[whale] 遗忘失败 ${String(e?.message ?? e).slice(0, 160)}`)
    }
  }
  timer = setInterval(tick, everyMs)
  timer.unref?.()
  tick()
  return {
    dispose() {
      if (timer) clearInterval(timer)
      timer = null
    },
    tick,
  }
}

/** 列出归档内容（面板/工具用）。 */
export async function listArchive(root, kind, id) {
  const file = join(paths(root).archive, `${kind}-${id}.jsonl`)
  try {
    const raw = await readFile(file, 'utf8')
    return raw.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  } catch {
    return []
  }
}
