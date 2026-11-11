/**
 * importer.js —— 历史会话冷启动导入
 *
 * 场景：记忆库是新装的 / 清空过，但 DSH 的 sessions/ 里还躺着一堆旧对话。
 * 把旧会话按「采集 → 蒸馏」同一条管线过一遍，只留蒸馏后的记忆条目，
 * 不复制原始会话，不把旧情绪喂给素材池和心理采集。
 *
 * 三条硬边界：
 *   1. 只导能确定分片的会话。历史 QQ 会话的 session id 如果不在当前绑定表里，
 *      一律跳过 —— 身份只能由桥接层注入，不能从「昵称（号码）：」里猜。
 *   2. 每条导入条目 source=import:<run>，运行清单落在 archive/imports/<run>.json，
 *      可以按整批回滚；回滚只删这一批新造的条目，后来被改过的条目不动。
 *   3. 导入默认走规则抽取，不调模型；每个分片有导入上限（默认 320，低于 MAX_ITEMS），
 *      到顶就停，给日常蒸馏留位置。
 */

import { readdir, readFile, stat, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { zstdDecompressSync } from 'node:zlib'

import {
  paths, ensureDirs, rootDir, loadScope, saveScope, withWriteLock, writeAtomic,
  auditWrite, logLine, archiveItem, normalizeText, listScopes, scopeLabel,
} from './store.js'
import { loadSources, LOCAL_SCOPE } from './source.js'
import { distillRecords, skipReason, extractCandidates, isPastMoment } from './distill.js'
import {
  textOf, stripSystemBlocks, isMetaMessage, isBridgeScaffold,
  stripBridgeNote, stripBridgeMarks, splitSpeakers,
} from './ingest.js'
import { redactText } from './redact.js'
import { resolveRelativeTime } from './time.js'
import { buildGraph, saveGraph, loadTriples } from './graph.js'
import { buildProfile, buildMembers } from './profile.js'

export const SESSION_FILE_RE = /^session(?:\.v4)?\.jsonl(?:\.zstd)?$/
export const IMPORT_CAP = 320
export const IMPORT_MAX_ADD = 200
export const IMPORT_MAX_MESSAGES = 400
const MAX_SESSION_BYTES = 64 * 1024 * 1024
const LLM_CHUNK = 40

export function defaultSessionsDir() {
  return join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'sessions')
}

export function newRunId(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  const salt = Math.random().toString(36).slice(2, 6)
  return `imp-${stamp}-${salt}`
}

/** 'private:123' / 'group:456' / 'local:dsh'。导入不碰仓库库和公共池。 */
export function parseScope(text) {
  const s = String(text ?? '').trim()
  const m = /^(private|group|local):(.+)$/.exec(s)
  if (!m) return null
  return { kind: m[1], id: m[2], label: scopeLabel(m[1], m[2]) }
}

const keyOf = (session) => String(session?.header?.id || session?.file || '')

function toIso(value, fallback = '') {
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString()
  const t = Date.parse(String(value ?? ''))
  if (Number.isFinite(t)) return new Date(t).toISOString()
  const f = Number(fallback)
  return Number.isFinite(f) && f > 0 ? new Date(f).toISOString() : ''
}

/**
 * 从 DSH session.v4.jsonl(.zstd) 里抽用户消息。
 * 只认 source.kind 为 user/qq（或缺省）的 user/message；
 * 宿主快照、技能目录、心跳、看屏幕、调度提醒这些一律不进。
 */
export function extractUserMessages(events, header = {}) {
  const fallbackAt = toIso(header.createdAt)
  const messages = []
  let qq = false
  for (let i = 0; i < events.length; i += 1) {
    const ev = events[i]
    if (ev?.type !== 'user/message') continue
    const srcKind = String(ev?.data?.source?.kind ?? '').trim()
    if (srcKind && srcKind !== 'user' && srcKind !== 'qq') continue
    if (srcKind === 'qq') qq = true
    const raw = textOf(ev?.data?.content ?? ev?.data?.message?.content ?? '')
    if (!raw.trim() || isMetaMessage(raw)) continue
    const body = stripSystemBlocks(raw)
    if (!body.trim()) continue
    const at = toIso(ev.time, fallbackAt)
    for (const sp of splitSpeakers(stripBridgeNote(body))) {
      if (isMetaMessage(sp.text) || isBridgeScaffold(sp.text)) continue
      // 贴过的 key / 密码在导入这里再打一次码，老会话里没人保证当时打过
      const text = redactText(stripBridgeMarks(sp.text)).trim()
      if (!text) continue
      messages.push({
        at,
        role: 'user',
        speaker: sp.nick,
        qq: sp.qq,
        text: text.slice(0, 2000),
        eventIndex: i,
        seq: Number(ev.seq) || 0,
      })
    }
  }
  return { messages, qq }
}

/** 读一个会话文件。普通 .jsonl 和 .zstd 都认。 */
export async function readSessionFile(file, { maxBytes = MAX_SESSION_BYTES } = {}) {
  const st = await stat(file)
  if (st.size > maxBytes) throw new Error(`单个会话超过 ${Math.round(maxBytes / 1024 / 1024)}MB，跳过`)
  const buf = await readFile(file)
  let raw = ''
  if (file.endsWith('.zstd')) {
    if (typeof zstdDecompressSync !== 'function') {
      throw new Error('当前 Node 不支持 zstd 解压（需要 Node 22.15+ / 24）')
    }
    raw = zstdDecompressSync(buf).toString('utf8')
  } else {
    raw = buf.toString('utf8')
  }
  const events = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try { events.push(JSON.parse(line)) } catch { /* 坏行跳过 */ }
  }
  const head = events.find((e) => e?.type === 'session')
  const header = {
    id: String(head?.id ?? '').trim(),
    // 没有 createdAt 的老文件用 mtime 兜底，别让「明天」锚到导入当天
    createdAt: Number(head?.createdAt) || st.mtimeMs,
    cwd: String(head?.cwd ?? ''),
  }
  const title = [...events].reverse().find((e) => e?.type === 'session/title')?.data?.title
  const { messages, qq } = extractUserMessages(events, header)
  return {
    header,
    messages,
    qq,
    title: String(title ?? ''),
    size: st.size,
  }
}

/** 递归扫 sessions/ 下的会话文件。读不了的文件也带回来，报告里说清为什么跳过。 */
export async function scanSessions(dir = defaultSessionsDir(), { maxBytes = MAX_SESSION_BYTES } = {}) {
  const out = []
  const walk = async (d, depth) => {
    if (depth > 4) return
    let ents = []
    try { ents = await readdir(d, { withFileTypes: true }) } catch { return }
    for (const e of ents) {
      const p = join(d, e.name)
      if (e.isDirectory()) {
        await walk(p, depth + 1)
        continue
      }
      if (!SESSION_FILE_RE.test(e.name)) continue
      try {
        out.push({ file: p, ...(await readSessionFile(p, { maxBytes })) })
      } catch (err) {
        out.push({ file: p, header: { id: '', createdAt: 0, cwd: '' }, messages: [], qq: false, error: String(err?.message ?? err) })
      }
    }
  }
  await walk(dir, 0)
  return out
}

/** 读历史导入清单（用于跳过已导过的会话、回滚）。 */
export async function listImportRuns(root = rootDir()) {
  const dir = join(paths(root).archive, 'imports')
  let names = []
  try { names = await readdir(dir) } catch { return [] }
  const out = []
  for (const n of names) {
    if (!n.endsWith('.json')) continue
    try {
      const o = JSON.parse(await readFile(join(dir, n), 'utf8'))
      if (o?.run) out.push(o)
    } catch { /* 坏清单跳过 */ }
  }
  return out.sort((a, b) => String(a.startedAt || '').localeCompare(String(b.startedAt || '')))
}

function alreadyImported(runs) {
  const set = new Set()
  for (const r of runs) {
    for (const s of r.sessions || []) {
      if (s?.complete) set.add(String(s.id || s.file || ''))
    }
  }
  return set
}

const isLive = (x) => x.state !== 'archived' && x.state !== 'superseded' && x.state !== 'suggested' && x.state !== 'expired'

async function liveCount(root, scope) {
  const sc = await loadScope(root, scope.kind, scope.id)
  return (sc.items || []).filter(isLive).length
}

/**
 * 为一个会话确定落点。顺序：显式映射 → 当前绑定表 → 未绑定判定 → 兜底 scope / 本地。
 * 未绑定的 QQ 会话绝不自动猜身份。
 */
export function resolveTarget(session, { bindings, maps = new Map(), fallback = null } = {}) {
  const sid = String(session?.header?.id ?? '')
  if (sid && maps.has(sid)) return { ok: true, scope: { ...maps.get(sid), mapped: true } }
  const hit = sid ? bindings?.get(sid) : null
  if (hit) {
    return { ok: true, scope: { kind: hit.kind, id: hit.id, label: hit.label || scopeLabel(hit.kind, hit.id), bridge: true } }
  }
  if (session?.qq) {
    if (fallback) return { ok: true, scope: { ...fallback, forced: true } }
    return {
      ok: false,
      why: 'unbound-qq',
      hint: '历史 QQ 会话不在当前绑定表里；身份不能从聊天文本里猜。确认归属后用 --map <session>=private:<QQ> 或 --scope 显式指定。',
    }
  }
  if (fallback) return { ok: true, scope: { ...fallback, forced: true } }
  return { ok: true, scope: { ...LOCAL_SCOPE } }
}

function parseWhen(value, endOfDay = false) {
  const s = String(value ?? '').trim()
  if (!s) return 0
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const t = Date.parse(`${s}T00:00:00`)
    return endOfDay ? t + 86400000 - 1 : t
  }
  return Date.parse(s) || 0
}

/** 规则抽取的预估，不写盘、不调模型。 */
export function estimateSession(session, scope, { includePastEvents = false } = {}) {
  const work = scope?.kind === 'local'
  const seen = new Set()
  const skipped = {}
  let candidates = 0
  for (const m of session.messages || []) {
    const reason = skipReason(m.text, { work })
    if (reason) {
      skipped[reason] = (skipped[reason] || 0) + 1
      continue
    }
    for (const c of extractCandidates(m.text, { work })) {
      if (!includePastEvents && c.kind === 'event') {
        const rt = resolveRelativeTime(c.text, m.at)
        if (rt?.abs && isPastMoment(rt.abs)) {
          skipped['past-event'] = (skipped['past-event'] || 0) + 1
          continue
        }
      }
      const k = normalizeText(c.text)
      if (!k || seen.has(k)) continue
      seen.add(k)
      candidates += 1
    }
  }
  return { messages: (session.messages || []).length, candidates, skipped }
}

/**
 * 导入历史会话。
 *
 * @param {object} [opts]
 * @param {string} [opts.root] 记忆库根
 * @param {object[]} [opts.sessions] 已扫描好的会话；不传就扫 dir
 * @param {string} [opts.dir] sessions 目录
 * @param {string} [opts.since] 只导这个日期之后创建的会话
 * @param {string} [opts.until] 只导这个日期之前创建的会话
 * @param {string} [opts.scope] 未绑定/本地会话的兜底落点
 * @param {object|Map} [opts.maps] session id → 落点（优先级最高）
 * @param {number} [opts.maxSessions] 最多处理多少个会话；0 = 不限
 * @param {number} [opts.maxMessages] 每个会话最多取最近多少条用户消息
 * @param {number} [opts.maxAdd] 本次最多新增多少条；0 = 不限
 * @param {number} [opts.cap] 每个分片导入后最多多少条生效记忆；0 = 不设限
 * @param {boolean} [opts.llm] 允许调模型（默认 false，只走规则）
 * @param {boolean} [opts.includePastEvents] 连过期的计划类事件一起导（默认 false）
 * @param {boolean} [opts.force] 重导已经导过的会话
 * @param {boolean} [opts.dryRun] 只出报告
 */
export async function importHistory({
  root = rootDir(), sessions: given = null, dir = defaultSessionsDir(),
  since = '', until = '', scope = '', maps = new Map(),
  maxSessions = 0, maxMessages = IMPORT_MAX_MESSAGES, maxAdd = IMPORT_MAX_ADD, cap = IMPORT_CAP,
  llm = false, includePastEvents = false, force = false, dryRun = true, log = () => {},
} = {}) {
  await ensureDirs(root)
  const run = newRunId()
  const srcTable = await loadSources()
  const bindings = srcTable.bySession || new Map()
  const owner = srcTable.owner || { qq: '', name: '爹' }
  const fallback = scope ? parseScope(scope) : null
  if (scope && !fallback) throw new Error('--scope 要写成 private:<号> / group:<群号> / local:dsh')

  const map = new Map()
  const rawMap = maps instanceof Map ? maps : new Map(Object.entries(maps || {}))
  for (const [sid, target] of rawMap) {
    const p = typeof target === 'string' ? parseScope(target) : target
    if (!p) throw new Error(`--map ${sid}=... 的落点要写成 private:<号> / group:<群号> / local:dsh`)
    map.set(String(sid), p)
  }

  const from = parseWhen(since, false)
  const to = parseWhen(until, true)
  const scanned = Array.isArray(given) ? given : await scanSessions(dir)
  const imported = force ? new Set() : alreadyImported(await listImportRuns(root))

  const skipped = []
  const eligible = []
  for (const s of scanned) {
    const key = keyOf(s)
    if (s.error) { skipped.push({ id: key, file: s.file, why: s.error }); continue }
    if (!s.messages?.length) { skipped.push({ id: key, file: s.file, why: 'no-user-messages' }); continue }
    const at = Number(s.header?.createdAt) || 0
    if (from && at && at < from) { skipped.push({ id: key, file: s.file, why: 'before-since' }); continue }
    if (to && at && at > to) { skipped.push({ id: key, file: s.file, why: 'after-until' }); continue }
    if (imported.has(key) || imported.has(String(s.file))) {
      skipped.push({ id: key, file: s.file, why: 'already-imported' })
      continue
    }
    const target = resolveTarget(s, { bindings, maps: map, fallback })
    if (!target.ok) {
      skipped.push({ id: key, file: s.file, why: target.why, hint: target.hint })
      continue
    }
    // 只取最近 N 条；会话内部按时间正序蒸馏，时间锚和合并结果才稳
    const messages = s.messages.length > maxMessages ? s.messages.slice(-maxMessages) : s.messages
    eligible.push({ ...s, messages, target: target.scope })
  }

  // 新会话优先占预算；同一会话内部再按正序跑，最新的说法最后落库
  eligible.sort((a, b) => (Number(b.header?.createdAt) || 0) - (Number(a.header?.createdAt) || 0))
  const picked = maxSessions > 0 ? eligible.slice(0, maxSessions) : eligible
  for (const s of eligible.slice(picked.length)) {
    skipped.push({ id: keyOf(s), file: s.file, why: 'over-session-limit' })
  }

  if (dryRun) {
    const scopes = {}
    for (const s of picked) {
      const sk = `${s.target.kind}:${s.target.id}`
      const est = estimateSession(s, s.target, { includePastEvents })
      const row = scopes[sk] || (scopes[sk] = {
        kind: s.target.kind, id: s.target.id, label: s.target.label || scopeLabel(s.target.kind, s.target.id),
        sessions: 0, messages: 0, candidates: 0, live: 0, wouldAdd: 0, skipped: {},
      })
      row.sessions += 1
      row.messages += est.messages
      row.candidates += est.candidates
      for (const [k, v] of Object.entries(est.skipped)) row.skipped[k] = (row.skipped[k] || 0) + v
    }
    for (const row of Object.values(scopes)) {
      row.live = await liveCount(root, row)
      const room = cap > 0 ? Math.max(0, cap - row.live) : row.candidates
      row.wouldAdd = Math.min(row.candidates, room)
    }
    const totalCandidates = Object.values(scopes).reduce((n, x) => n + x.candidates, 0)
    const totalRooms = Object.values(scopes).reduce((n, x) => n + x.wouldAdd, 0)
    return {
      ok: true,
      dryRun: true,
      run: null,
      sessionsDir: dir,
      totals: {
        scanned: scanned.length,
        eligible: eligible.length,
        picked: picked.length,
        messages: picked.reduce((n, x) => n + x.messages.length, 0),
        candidates: totalCandidates,
        wouldAdd: maxAdd > 0 ? Math.min(totalRooms, maxAdd) : totalRooms,
        skipped: skipped.length,
      },
      scopes,
      sessions: picked.map((s) => {
        const sk = `${s.target.kind}:${s.target.id}`
        return {
          id: keyOf(s), file: s.file, createdAt: new Date(Number(s.header?.createdAt) || 0).toISOString(),
          scope: sk, label: s.target.label || scopeLabel(s.target.kind, s.target.id),
          messages: s.messages.length,
          estimate: estimateSession(s, s.target, { includePastEvents }).candidates,
        }
      }),
      skipped,
    }
  }

  // ---- 真导入 ----
  const manifestDir = join(paths(root).archive, 'imports')
  await mkdir(manifestDir, { recursive: true })
  const manifestFile = join(manifestDir, `${run}.json`)
  const manifest = {
    run,
    startedAt: new Date().toISOString(),
    finishedAt: '',
    status: 'running',
    mode: llm ? 'llm' : 'rules',
    options: { since, until, scope, maxSessions, maxMessages, maxAdd, cap, llm, includePastEvents, force },
    totals: { added: 0, merged: 0, sessions: 0 },
    scopes: {},
    sessions: [],
    skipped,
  }
  await writeAtomic(manifestFile, JSON.stringify(manifest, null, 2))

  let totalAdded = 0
  let totalMerged = 0
  let budgetHit = false
  for (const s of picked) {
    if (maxAdd > 0 && totalAdded >= maxAdd) { budgetHit = true; break }
    const sk = `${s.target.kind}:${s.target.id}`
    const before = await liveCount(root, s.target)
    const room = cap > 0 ? Math.max(0, cap - before) : 0
    if (cap > 0 && room <= 0) {
      manifest.skipped.push({ id: keyOf(s), file: s.file, why: 'scope-full' })
      await writeAtomic(manifestFile, JSON.stringify(manifest, null, 2))
      continue
    }
    const runRoom = maxAdd > 0 ? Math.max(0, maxAdd - totalAdded) : 0
    let budget = 0
    if (cap > 0) budget = room
    if (runRoom > 0) budget = budget > 0 ? Math.min(budget, runRoom) : runRoom

    const src = {
      kind: s.target.kind,
      id: s.target.id,
      label: s.target.label || scopeLabel(s.target.kind, s.target.id),
      addr: '',
      owner,
    }
    const chunkSize = llm ? LLM_CHUNK : s.messages.length
    let added = 0
    let merged = 0
    let sessionBudgetHit = false
    let error = ''
    for (let i = 0; i < s.messages.length; i += chunkSize) {
      const chunk = s.messages.slice(i, i + chunkSize)
      if (!chunk.length) break
      const left = budget > 0 ? budget - added : 0
      if (budget > 0 && left <= 0) {
        sessionBudgetHit = true
        break
      }
      const r = await distillRecords(root, src, chunk, {
        log,
        sessionId: s.header?.id || s.file,
        originSessionId: s.header?.id || '',
        sourcePrefix: `import:${run}`,
        skipExtras: true,
        useLlm: llm,
        dropPastEvents: !includePastEvents,
        maxNew: budget > 0 ? Math.max(0, left) : 0,
        keepFresh: true,
      }).catch((e) => ({ ok: false, added: 0, merged: 0, why: String(e?.message ?? e) }))
      if (!r.ok) {
        error = String(r.why || 'distill failed')
        break
      }
      added += r.added || 0
      merged += r.merged || 0
      if (r.budgetHit) sessionBudgetHit = true
      const row = manifest.scopes[sk] || (manifest.scopes[sk] = {
        kind: s.target.kind, id: s.target.id,
        label: src.label, added: 0, merged: 0, items: [],
      })
      row.added += r.added || 0
      row.merged += r.merged || 0
      for (const it of r.fresh || []) {
        if (!row.items.some((x) => x.id === it.id)) row.items.push({ id: it.id, text: it.text })
      }
      if (sessionBudgetHit) break
    }

    totalAdded += added
    totalMerged += merged
    manifest.totals.added = totalAdded
    manifest.totals.merged = totalMerged
    manifest.totals.sessions += 1
    manifest.sessions.push({
      id: keyOf(s),
      file: s.file,
      createdAt: s.header?.createdAt || 0,
      scope: sk,
      messages: s.messages.length,
      added,
      merged,
      complete: !sessionBudgetHit && !error,
      error,
    })
    await writeAtomic(manifestFile, JSON.stringify(manifest, null, 2))
    log(`[import] ${s.header?.id || s.file} → ${sk} +${added}${merged ? ` ~${merged}` : ''}${error ? ` 失败：${error}` : ''}${sessionBudgetHit ? '（到上限，下次可续）' : ''}`)
    if (sessionBudgetHit) {
      budgetHit = true
      break
    }
  }

  manifest.status = 'done'
  manifest.finishedAt = new Date().toISOString()
  manifest.budgetHit = budgetHit
  await writeAtomic(manifestFile, JSON.stringify(manifest, null, 2))
  await auditWrite(root, {
    kind: 'import', run, added: totalAdded, merged: totalMerged,
    sessions: manifest.sessions.length, scopes: Object.keys(manifest.scopes),
    manifest: manifestFile,
  }).catch(() => {})
  await logLine(root, `import ${run} +${totalAdded}${totalMerged ? ` ~${totalMerged}` : ''} · ${manifest.sessions.length} 个会话 · 清单 ${manifestFile}`).catch(() => {})

  return {
    ok: true,
    dryRun: false,
    run,
    manifestFile,
    budgetHit,
    totals: { added: totalAdded, merged: totalMerged, sessions: manifest.sessions.length },
    scopes: manifest.scopes,
    sessions: manifest.sessions,
    skipped: manifest.skipped,
  }
}

/**
 * 整批回滚。只删「这一批新造、而且正文没被后来改过」的条目；
 * 被后续对话合并/改写过的条目保留，报告里列出来。
 */
export async function rollbackImport(root, runId, { log = () => {} } = {}) {
  const id = String(runId ?? '').trim()
  if (!/^imp-[A-Za-z0-9-]+$/.test(id)) throw new Error('run id 形如 imp-20261111-201500-abcd')
  const manifestFile = join(paths(root).archive, 'imports', `${id}.json`)
  let manifest
  try {
    manifest = JSON.parse(await readFile(manifestFile, 'utf8'))
  } catch {
    throw new Error(`找不到导入清单：${manifestFile}`)
  }
  const affected = new Set(Object.keys(manifest.scopes || {}))
  let removed = 0
  const kept = []
  for (const [sk, info] of Object.entries(manifest.scopes || {})) {
    const i = sk.indexOf(':')
    const kind = sk.slice(0, i)
    const scopeId = sk.slice(i + 1)
    if (!kind || !scopeId) continue
    await withWriteLock(async () => {
      const sc = await loadScope(root, kind, scopeId)
      const wanted = new Map((info.items || []).map((x) => [String(x.id), x]))
      const keep = []
      for (const it of sc.items || []) {
        const rec = wanted.get(String(it.id))
        if (!rec) { keep.push(it); continue }
        if (it.source !== `import:${id}` || String(it.text) !== String(rec.text)) {
          kept.push({ scope: sk, id: it.id, why: it.source !== `import:${id}` ? 'source-changed' : 'text-changed' })
          keep.push(it)
          continue
        }
        await archiveItem(root, sc, it, 'import-rollback')
        removed += 1
      }
      if (keep.length !== (sc.items || []).length) {
        sc.items = keep
        await saveScope(root, sc)
      }
    })
  }

  if (removed && affected.size) {
    const all = await listScopes(root).catch(() => [])
    const g = buildGraph(all, await loadTriples(root))
    for (const sc of all) {
      if (!affected.has(sc.scope)) continue
      sc.profile = buildProfile(sc, g)
      sc.members = buildMembers(sc)
      await saveScope(root, sc)
    }
    await saveGraph(root, g).catch(() => {})
  }

  manifest.rolledBackAt = new Date().toISOString()
  manifest.rollback = { removed, kept: kept.length }
  await writeAtomic(manifestFile, JSON.stringify(manifest, null, 2))
  await auditWrite(root, { kind: 'import-rollback', run: id, removed, kept: kept.length }).catch(() => {})
  await logLine(root, `import rollback ${id} -${removed}${kept.length ? `（保留 ${kept.length} 条被改过的）` : ''}`).catch(() => {})
  log(`[import] 回滚 ${id}：删除 ${removed} 条${kept.length ? `，保留 ${kept.length} 条（后来被改过）` : ''}`)
  return { ok: true, run: id, removed, kept, manifestFile }
}
