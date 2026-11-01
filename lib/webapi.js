/**
 * webapi.js —— 给网页界面用的接口
 *
 * 前缀统一 /dsh-whale-memory/api。除 /forget 外全部 GET，不写库
 * （/refresh 也算只读：它只是把图谱按现有分片重建一遍，不新增内容）。
 *
 * 只开了一个写口：删一条记忆。改记忆还是得靠她自己在对话里记——
 * 但记错的、被桥接旁白污染的，总得有个地方能清掉，不然只能手改 JSON。
 */

import { readFile, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { listScopes, paths, withWriteLock, auditWrite } from './store.js'
import { confirmItem } from './confirm.js'
import { refreshGraph, loadGraph, topNodes } from './graph.js'
import { lifeState, renderMemory } from './inject.js'
import { forgetItem } from './forget.js'
import { vaultPaths } from './vault.js'
import { trustState } from './trust.js'
import { status as personaStatus } from './persona.js'

export const API_PREFIX = '/dsh-whale-memory/api'

const BODY_LIMIT = 8 * 1024

function readBody(req, limit = BODY_LIMIT) {
  return new Promise((resolve) => {
    let size = 0
    let text = ''
    let done = false
    const finish = (v) => { if (!done) { done = true; resolve(v) } }
    try {
      req.on?.('data', (c) => {
        size += c.length
        if (size > limit) { finish(''); try { req.destroy?.() } catch { /* ignore */ } return }
        text += c
      })
      req.on?.('end', () => finish(text))
      req.on?.('error', () => finish(''))
    } catch {
      finish('')
    }
  })
}

function json(res, body, code = 200) {
  const text = JSON.stringify(body)
  try {
    res.statusCode = code
    res.setHeader?.('content-type', 'application/json; charset=utf-8')
    res.setHeader?.('cache-control', 'no-store')
    res.end?.(text)
  } catch { /* 连接断了就算了 */ }
}

async function tailLines(file, n = 100) {
  try {
    const raw = await readFile(file, 'utf8')
    return raw.split('\n').filter(Boolean).slice(-n)
  } catch {
    return []
  }
}

/** 分片 → 界面需要的瘦身结构（不带整份 json 的元数据）。 */
function slimScope(sc) {
  const now = Date.now()
  const items = (sc.items || []).map((it) => {
    const life = lifeState(it, now)
    return {
      id: it.id,
      text: it.text,
      kind: it.kind,
      conf: it.conf,
      hits: it.hits,
      merged: it.merged,
      state: life.state,
      score: Number(life.score.toFixed(3)),
      lastHit: it.lastHit,
      created: it.created,
      atAbs: it.atAbs || '',
      speaker: it.speaker || '',
      trigger: it.trigger || '',
      antiPattern: it.antiPattern || '',
      goal: it.goal || '',
      progress: it.progress || '',
      lastTouched: it.lastTouched || '',
      due: it.due || '',
      toWhom: it.toWhom || '',
      validTo: it.validTo || '',
      supersededBy: it.supersededBy || '',
    }
  })
  return {
    scope: sc.scope,
    kind: sc.kind,
    id: sc.id,
    label: sc.label,
    updatedAt: sc.updatedAt,
    profile: sc.profile ?? null,
    members: Array.isArray(sc.members) ? sc.members : [],
    total: items.length,
    active: items.filter((i) => i.state === 'active' || i.state === 'warm').length,
    suggested: items.filter((i) => i.state === 'suggested').length,
    archived: items.filter((i) => i.state === 'archived').length,
    superseded: items.filter((i) => i.state === 'superseded').length,
    items: items.sort((a, b) => b.score - a.score),
    render: renderMemory(sc, { topN: 10, maxChars: 1600 }),
  }
}

/**
 * 注册路由。
 * @returns {{dispose:()=>void}|null}
 */
export function registerWebApi(ctx, { root, log, version } = {}) {
  const ws = ctx.webServer
  if (!ws || typeof ws.register !== 'function') {
    log?.('[whale] webServer 不可用，界面接口没挂上')
    return null
  }

  const disposers = []
  const route = (path, handler) => {
    try {
      const d = ws.register({ kind: 'exact', path, handler })
      if (typeof d === 'function') disposers.push(d)
      else if (d?.dispose) disposers.push(() => d.dispose())
    } catch (e) {
      log?.(`[whale] 路由注册失败 ${path}: ${String(e?.message ?? e).slice(0, 120)}`)
    }
  }

  // 总览：所有分片 + 计数
  route(`${API_PREFIX}/state`, async (_req, res) => {
    const scopes = await listScopes(root).catch(() => [])
    const p = paths(root)
    const audit = [...await tailLines(p.writes, 40), ...await tailLines(p.reads, 40)]
      .map((l) => { try { return JSON.parse(l) } catch { return null } })
      .filter(Boolean)
      .sort((a, b) => String(a.at).localeCompare(String(b.at)))
      .slice(-40)
    json(res, {
      ok: true,
      version: version ?? '?',
      root,
      scopes: scopes.map(slimScope),
      counts: {
        scopes: scopes.length,
        items: scopes.reduce((n, s) => n + (s.items?.length || 0), 0),
      },
      audit,
    })
  })

  // 运行状态：人格预算 / 信任 / 每分片容量 / 最近检索 / 跳过原因 / 读取次数
  route(`${API_PREFIX}/obs`, async (_req, res) => {
    const scopes = await listScopes(root).catch(() => [])
    const [trust, persona] = await Promise.all([
      trustState(root, { recheck: true }).catch(() => null),
      personaStatus(root).catch(() => null),
    ])
    const p = paths(root)
    const rows = (await tailLines(p.writes, 400))
      .map((l) => { try { return JSON.parse(l) } catch { return null } })
      .filter(Boolean)
    // 读账单独一份：search / read / profile。读的次数远多于写，混进 writes 会把写入账冲掉。
    const readRows = (await tailLines(p.reads, 400))
      .map((l) => { try { return JSON.parse(l) } catch { return null } })
      .filter(Boolean)
    const byKind = (k) => readRows.filter((r) => r.kind === k)
    const reads = {
      total: readRows.length,
      search: byKind('search').length,
      read: byKind('read').length,
      profile: byKind('profile').length,
      empty: readRows.filter((r) => r.empty || r.ok === false).length,
      tokens: byKind('read').reduce((n, r) => n + (r.tokens || 0), 0),
    }
    const vault = []
    for (const sc of scopes) {
      const p = vaultPaths(root, sc.kind, sc.id)
      let indexBytes = 0
      try { indexBytes = (await stat(p.index)).size } catch { indexBytes = 0 }
      const usage = (await tailLines(p.usage, 300))
        .map((l) => { try { return JSON.parse(l) } catch { return null } })
        .filter(Boolean)
      vault.push({
        scope: sc.scope,
        label: sc.label,
        live: (sc.items || []).filter((x) => x.state !== 'archived' && x.state !== 'superseded' && x.state !== 'suggested' && x.state !== 'expired').length,
        indexBytes,
        pending: existsSync(p.pending),
        lastDeepen: sc.lastDeepen || '',
        itemsSinceDeepen: sc.itemsSinceDeepen || 0,
        reads: usage.filter((x) => x.tool === 'read_memory').length,
      })
    }
    json(res, {
      ok: true,
      trust: trust ? { origin: trust.origin, usable: trust.usable, trustedAt: trust.trustedAt, drift: trust.drift } : null,
      persona,
      vault,
      reads,
      searches: byKind('search').slice(-15).reverse(),
      skips: rows.filter((r) => r.kind === 'write_skip').slice(-10).reverse(),
      deepens: rows.filter((r) => r.kind === 'deepen').slice(-5).reverse(),
    })
  })

  // 图谱
  route(`${API_PREFIX}/graph`, async (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost')
    let g = await loadGraph(root)
    if (!g.nodes.length || url.searchParams.get('rebuild') === '1') {
      const scopes = await listScopes(root).catch(() => [])
      g = await refreshGraph(root, scopes).catch(() => g)
    }
    json(res, {
      ok: true,
      nodes: g.nodes,
      edges: g.edges,
      top: topNodes(g, 10).map((n) => ({ name: n.name, type: n.type, score: Number(n.score.toFixed(2)) })),
    })
  })

  // 审计账本：默认合并「写 + 读」两本账；?source=injects 看注入账，writes / reads 看单本
  route(`${API_PREFIX}/audit`, async (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost')
    const n = Math.min(500, Math.max(10, Number(url.searchParams.get('n')) || 100))
    const which = url.searchParams.get('source') || 'all'
    const p = paths(root)
    const read = async (file, limit) =>
      (await tailLines(file, limit)).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
    let rows
    if (which === 'writes' || which === 'reads' || which === 'injects') {
      rows = await read(p[which], n)
    } else {
      rows = [...await read(p.writes, n), ...await read(p.reads, n)]
        .sort((a, b) => String(a.at).localeCompare(String(b.at)))
        .slice(-n)
    }
    json(res, { ok: true, source: which, rows })
  })

  // 运行日志
  route(`${API_PREFIX}/logs`, async (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost')
    const n = Math.min(500, Math.max(10, Number(url.searchParams.get('n')) || 120))
    const lines = await tailLines(join(paths(root).logs, 'dsh-whale-memory.log'), n)
    json(res, { ok: true, rows: lines })
  })

  // 重建图谱
  route(`${API_PREFIX}/refresh`, async (_req, res) => {
    const scopes = await listScopes(root).catch(() => [])
    const g = await refreshGraph(root, scopes)
    log?.(`[whale] 界面触发重建 · 节点 ${g.nodes.length} · 边 ${g.edges.length}`)
    json(res, { ok: true, nodes: g.nodes.length, edges: g.edges.length })
  })

  // 删一条记忆（归档，不硬删）
  route(`${API_PREFIX}/forget`, async (req, res) => {
    if (String(req?.method ?? 'GET').toUpperCase() !== 'POST') {
      json(res, { ok: false, why: '只接受 POST' }, 405)
      return
    }
    const raw = await readBody(req)
    let body
    try {
      body = JSON.parse(raw || '{}')
    } catch {
      json(res, { ok: false, why: 'body 不是 JSON' }, 400)
      return
    }
    const scope = String(body?.scope ?? '').trim()
    const itemId = String(body?.id ?? '').trim()
    const [kind, id] = scope.split(':')
    if (!kind || !id || !itemId) {
      json(res, { ok: false, why: 'scope（kind:id）和 id 都要给' }, 400)
      return
    }
    const r = await forgetItem(root, kind, id, itemId, { reason: 'ui' })
    log?.(`[whale] 界面删除 · ${scope} · ${itemId} · ${r.ok ? 'ok' : r.why}`)
    json(res, r.ok ? { ok: true, id: itemId } : { ok: false, why: r.why }, r.ok ? 200 : 404)
  })

  // 待确认转正（界面点「确认」）
  route(`${API_PREFIX}/confirm`, async (req, res) => {
    if (String(req?.method ?? 'GET').toUpperCase() !== 'POST') {
      json(res, { ok: false, why: '只接受 POST' }, 405)
      return
    }
    const raw = await readBody(req)
    let body
    try {
      body = JSON.parse(raw || '{}')
    } catch {
      json(res, { ok: false, why: 'body 不是 JSON' }, 400)
      return
    }
    const scope = String(body?.scope ?? '').trim()
    const itemId = String(body?.id ?? '').trim()
    const [kind, id] = scope.split(':')
    if (!kind || !id || !itemId) {
      json(res, { ok: false, why: 'scope（kind:id）和 id 都要给' }, 400)
      return
    }
    const r = await withWriteLock(() => confirmItem(root, kind, id, itemId))
    if (r.ok) await auditWrite(root, { kind: 'ui-confirm', scope: r.scope, item: itemId })
    log?.(`[whale] 界面确认 · ${scope} · ${itemId} · ${r.ok ? 'ok' : r.why}`)
    json(res, r.ok ? { ok: true, id: itemId, superseded: r.superseded } : { ok: false, why: r.why }, r.ok ? 200 : 404)
  })

  return {
    dispose() {
      for (const d of disposers) { try { d() } catch { /* ignore */ } }
    },
  }
}
