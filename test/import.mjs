/**
 * import.mjs —— 历史会话冷启动导入
 *
 * 验的行为：
 *   · 只导当前绑定表里能确定分片的 QQ 会话；未绑定的不猜身份
 *   · 只收 user/qq 来源的真人消息，宿主快照、运行环境不进
 *   · 过期计划（昨天/上个月的「明天」）默认丢，稳定事实和偏好留下
 *   · 每条 source=import:<run>，清单可回滚；重跑不重复导
 *   · 每个分片的导入上限生效
 *   · 凭据在导入入口就打码
 */
import assert from 'node:assert'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ensureDirs, loadScope } from '../lib/store.js'
import { scanSessions, importHistory, rollbackImport } from '../lib/importer.js'

let pass = 0
const ok = (name) => { pass += 1; console.log('  ok', name) }
const day = 86400000

const userEvent = (text, { at, kind = 'qq', seq = 1 } = {}) => ({
  type: 'user/message',
  seq,
  time: at,
  data: { role: 'user', content: [{ type: 'text', text }], source: { kind } },
})

const metaEvent = (text, kind, at) => ({
  type: 'user/message',
  seq: 2,
  time: at,
  data: { role: 'user', content: [{ type: 'text', text }], source: { kind } },
})

async function writeSession(dir, folder, header, events) {
  const d = join(dir, folder)
  await mkdir(d, { recursive: true })
  const file = join(d, 'session.v4.jsonl')
  await writeFile(file, [header, ...events].map((x) => JSON.stringify(x)).join('\n') + '\n', 'utf8')
  return file
}

const base = await mkdtemp(join(tmpdir(), 'whale-import-'))
const root = join(base, 'memory')
const sessionsDir = join(base, 'sessions')
const old = Date.now() - 60 * day
const recent = Date.now() - 2 * day

try {
  await ensureDirs(root)
  for (const k of ['DSH_MEMORY_LLM_BASE', 'DSH_MEMORY_LLM_MODEL', 'DSH_MEMORY_LLM_KEY']) delete process.env[k]

  const cfg = join(base, 'qq-bridge-config.json')
  await writeFile(cfg, JSON.stringify({
    拥有者QQ: '900001',
    拥有者称呼: '爹',
    绑定: [{ 类型: '私聊', 号码: '900001', 会话: 'session-bound', 称呼: '爹' }],
  }, null, 2), 'utf8')
  process.env.DSH_QQ_BRIDGE_CONFIG = cfg

  // 已绑定的 QQ 会话：一条稳定偏好、一条过期计划、一条带 key 的话、一条宿主快照
  await writeSession(sessionsDir, 'a/session-bound', {
    type: 'session', version: 4, id: 'session-bound', createdAt: recent, cwd: 'D:/x',
  }, [
    userEvent('爹（900001）：记住，我特别喜欢喝乌龙茶', { at: recent, seq: 3 }),
    userEvent('爹（900001）：明天8:30上班', { at: old, seq: 4 }),
    userEvent('爹（900001）：记住，我的 token: sk-abcdefghijklmnop123456', { at: recent, seq: 5 }),
    metaEvent('Current runtime context. This snapshot supersedes earlier snapshots.', 'runtime-context', recent),
  ])

  // 未绑定的历史 QQ 会话：不许猜归属
  await writeSession(sessionsDir, 'b/session-ghost', {
    type: 'session', version: 4, id: 'session-ghost', createdAt: old, cwd: 'D:/y',
  }, [
    userEvent('陌生人（123456789）：记住，我家住在海边', { at: old, seq: 3 }),
  ])

  // 本地会话：工作约定 + 一条过期计划
  await writeSession(sessionsDir, 'c/session-local', {
    type: 'session', version: 4, id: 'session-local', createdAt: recent, cwd: 'D:/Workspace',
  }, [
    userEvent('记住，我的工作区在 D:\\Workspace', { at: recent, kind: 'user', seq: 3 }),
    userEvent('明天8:30上班', { at: old, kind: 'user', seq: 4 }),
  ])

  const scanned = await scanSessions(sessionsDir)
  assert.equal(scanned.filter((s) => s.messages.length).length, 3, JSON.stringify(scanned.map((s) => [s.file, s.messages.length])))

  // 1. 预演：能认出两个可导会话，未绑定的单独列出来，且不写盘
  const dry = await importHistory({ root, sessions: scanned, dir: sessionsDir, dryRun: true })
  assert.ok(dry.ok && dry.dryRun, JSON.stringify(dry))
  assert.equal(dry.totals.picked, 2, JSON.stringify(dry.totals))
  assert.ok(dry.skipped.some((s) => s.why === 'unbound-qq'), JSON.stringify(dry.skipped))
  assert.ok(dry.scopes['private:900001'] && dry.scopes['local:dsh'], JSON.stringify(dry.scopes))
  assert.equal((await loadScope(root, 'private', '900001')).items.length, 0, '预演不该写盘')
  ok('预演：认出绑定/本地会话，未绑定 QQ 跳过，不写盘')

  // 2. 真导入：过期计划丢掉、凭据打码、来源带 import:<run>
  const run = await importHistory({
    root, sessions: scanned, dir: sessionsDir, dryRun: false, maxAdd: 50, cap: 320,
  })
  assert.ok(run.ok && !run.dryRun, JSON.stringify(run))
  assert.ok(run.totals.added >= 3, JSON.stringify(run.totals))
  assert.ok(run.totals.sessions === 2, JSON.stringify(run.totals))

  const priv = await loadScope(root, 'private', '900001')
  const tea = priv.items.find((x) => x.text.includes('乌龙茶'))
  assert.ok(tea, JSON.stringify(priv.items.map((x) => x.text)))
  assert.ok(tea.source.startsWith('import:imp-'), tea.source)
  assert.ok(tea.observedAt, '导入条目要带说话时间')
  assert.ok(tea.origin && tea.origin.sessionId === 'session-bound' && tea.origin.hash, JSON.stringify(tea.origin))
  assert.ok(!JSON.stringify(tea.origin).includes('乌龙茶'), '原文指针只存坐标，不存正文')
  assert.ok(!priv.items.some((x) => /sk-abcdefghijklmnop/.test(x.text) || /sk-abcdefghijklmnop/.test(x.sourceQuote || '')), JSON.stringify(priv.items))
  assert.ok(!priv.items.some((x) => x.text.includes('上班')), '过期计划不该进库')

  const local = await loadScope(root, 'local', 'dsh')
  assert.ok(local.items.some((x) => x.text.includes('D:\\Workspace')), JSON.stringify(local.items.map((x) => x.text)))
  assert.ok(!local.items.some((x) => x.text.includes('上班')), '本地会话里的过期计划也不该进库')

  const manifest = JSON.parse(await readFile(run.manifestFile, 'utf8'))
  assert.equal(manifest.status, 'done', JSON.stringify(manifest))
  assert.ok(manifest.scopes['private:900001'].items.length >= 1)
  ok('真导入：稳定事实留下、过期计划丢掉、凭据打码、清单落盘')

  // 3. 重跑：已完成的会话不重复处理；--force 也只会合并，不新增
  const again = await importHistory({ root, sessions: scanned, dir: sessionsDir, dryRun: false, maxAdd: 50, cap: 320 })
  assert.equal(again.totals.added, 0, JSON.stringify(again.totals))
  assert.ok(again.skipped.some((s) => s.why === 'already-imported'), JSON.stringify(again.skipped))

  const forced = await importHistory({ root, sessions: scanned, dir: sessionsDir, dryRun: false, maxAdd: 50, cap: 320, force: true })
  assert.equal(forced.totals.added, 0, JSON.stringify(forced.totals))
  assert.ok(forced.totals.merged > 0, JSON.stringify(forced.totals))
  ok('重跑：默认跳过已导会话；强制重导只加命中不重复造条目')

  // 4. 回滚：这一批新造的条目删掉，正文被改过的不删
  const beforeRollback = (await loadScope(root, 'private', '900001')).items.length
  const rb = await rollbackImport(root, run.run, { log: () => {} })
  assert.ok(rb.removed >= 1, JSON.stringify(rb))
  const afterRollback = (await loadScope(root, 'private', '900001')).items
  assert.ok(afterRollback.length < beforeRollback, '回滚后该变少')
  assert.ok(!afterRollback.some((x) => x.text.includes('乌龙茶')), JSON.stringify(afterRollback.map((x) => x.text)))
  const rbManifest = JSON.parse(await readFile(run.manifestFile, 'utf8'))
  assert.ok(rbManifest.rolledBackAt, '清单要记回滚时间')
  ok('回滚：按清单删掉这一批，清单留痕')

  // 5. 分片上限：已有一条生效记忆，cap=1 时不能再往里加
  const fullRoot = join(base, 'full-memory')
  await ensureDirs(fullRoot)
  const { addItem, saveScope } = await import('../lib/store.js')
  const pre = await loadScope(fullRoot, 'private', '900001')
  addItem(pre, { text: '已经存在的一条记忆', kind: 'fact', conf: 0.8, source: 'test' })
  await saveScope(fullRoot, pre)

  const full = await importHistory({ root: fullRoot, sessions: scanned, dir: sessionsDir, dryRun: false, maxAdd: 50, cap: 1 })
  assert.ok(full.skipped.some((s) => s.why === 'scope-full'), JSON.stringify(full.skipped))
  const fullPriv = await loadScope(fullRoot, 'private', '900001')
  assert.equal(fullPriv.items.length, 1)
  assert.ok(!fullPriv.items.some((x) => x.text.includes('乌龙茶')), '到顶的分片不能继续加')
  ok('分片上限：到顶的分片不再导入')

  // 6. --scope / --map 显式指定未绑定会话
  const mapped = await importHistory({
    root, sessions: scanned.filter((s) => s.header.id === 'session-ghost'),
    dir: sessionsDir, dryRun: false, maps: { 'session-ghost': 'group:555' }, maxAdd: 50, cap: 320,
  })
  assert.ok(mapped.totals.added >= 1, JSON.stringify(mapped.totals))
  assert.ok((await loadScope(root, 'group', '555')).items.some((x) => x.text.includes('海边')))
  ok('--map：显式指定落点后才导未绑定的历史会话')

  console.log(`\n${pass} 通过 · 0 失败`)
} finally {
  await rm(base, { recursive: true, force: true }).catch(() => {})
}
