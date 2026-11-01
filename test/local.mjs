/**
 * local.mjs —— 本地 DSH 会话也进记忆库（全局会话）
 * 跑法：node test/local.mjs
 *
 * 验的是整条链：
 *   采集（非桥接）→ local:dsh 分片 → 蒸馏出工程约定 → 注入本地会话 → 工具写进去
 * 另外验两个边界：
 *   · 桥接配置读坏时不把会话误判成本地
 *   · DSH_MEMORY_LOCAL_SCOPE=off 时退回只收桥接
 */
import assert from 'node:assert'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = await mkdtemp(join(tmpdir(), 'whale-local-'))
// 指向一个不存在的桥接配置：这台机器上没有任何绑定
process.env.DSH_QQ_BRIDGE_CONFIG = join(root, 'no-such-bridge.json')
process.env.DSH_MEMORY_HOME = root
delete process.env.DSH_MEMORY_LOCAL_SCOPE

const { ensureDirs, listScopes, loadScope, paths } = await import('../lib/store.js')
const { preloadSources, sourceOfSession, resetSourceCache } = await import('../lib/source.js')
const { registerIngest, flush, readStagingLines, lastActive } = await import('../lib/ingest.js')
const { distillSession, extractCandidates } = await import('../lib/distill.js')
const { registerInjection, resetCaches, MEMORY_SECTION } = await import('../lib/inject.js')
const { registerTools } = await import('../lib/tools.js')

let pass = 0
const ok = (name) => { pass += 1; console.log('  ok', name) }

try {
  await ensureDirs(root)
  const pre = await preloadSources()
  assert.equal(pre.state, 'none', JSON.stringify(pre))

  const sid = 'session-local-work-1'

  // 1. 来源：绑定表里没有的会话归本地，不是 null
  const src = await sourceOfSession(sid)
  assert.ok(src, '本地会话没认出来')
  assert.equal(src.kind, 'local')
  assert.equal(src.id, 'dsh')
  ok('非桥接会话归 local:dsh')

  // 2. 采集：本地会话的消息也要落 staging
  const handlers = new Map()
  const ctx = {
    on(ev, fn) { if (!handlers.has(ev)) handlers.set(ev, []); handlers.get(ev).push(fn); return () => {} },
    logger: { info() {} },
  }
  registerIngest(ctx, { root, log: () => {} })
  for (const fn of handlers.get('session/event') || []) {
    // 宿主运行环境快照（source.kind=runtime-context）：不是人说的话，必须丢
    fn(
      { header: { id: sid, cwd: '$WORKSPACE/demo' } },
      { type: 'user/message', data: { content: [{ type: 'text', text: 'Current working directory: "$WORKSPACE\\demo".' }], source: { kind: 'runtime-context' } } },
    )
    fn(
      { header: { id: sid, cwd: '$WORKSPACE/demo' } },
      { type: 'user/message', data: { content: [{ type: 'text', text: '以后都用 pnpm；路径是 $WORKSPACE\\demo' }], source: { kind: 'user' } } },
    )
  }
  await flush()
  const lines = await readStagingLines(root, sid)
  assert.equal(lines.length, 1, `staging 应只有 1 条真人消息，实际 ${lines.length}`)
  assert.ok(existsSync(join(paths(root).staging, `${sid}.jsonl`)), 'staging 文件没落盘')
  ok('本地会话消息进 staging（运行环境快照被丢掉）')

  // 3. 工程语境抽取：路径/约定能抽，纯闲聊抽不出
  const work = extractCandidates('以后都用 pnpm；路径是 $WORKSPACE\\demo', { work: true })
  assert.ok(work.some((c) => c.text.includes('pnpm')), JSON.stringify(work))
  assert.ok(work.some((c) => c.text.includes('$WORKSPACE\\demo')), JSON.stringify(work))
  assert.equal(extractCandidates('路径是 $WORKSPACE\\demo', { work: false }).length, 0, 'QQ 规则不该抽工程路径')
  ok('工程语境抽取只对本地生效')

  // 4. 蒸馏：落到 local:dsh，条目带路径和 pnpm
  const d = await distillSession(root, sid, { log: () => {} })
  assert.equal(d.ok, true, JSON.stringify(d))
  assert.equal(d.scope, 'local:dsh')
  const sc = await loadScope(root, 'local', 'dsh')
  const texts = sc.items.map((x) => x.text).join(' | ')
  assert.ok(texts.includes('pnpm'), texts)
  assert.ok(texts.includes('$WORKSPACE\\demo'), texts)
  assert.equal((await readStagingLines(root, sid)).length, 0, '蒸馏后 staging 该清空')
  const all = await listScopes(root)
  assert.ok(all.some((x) => x.scope === 'local:dsh'), 'listScopes 没列到本地分片')
  ok('本地会话蒸馏进 local:dsh')

  // 5. 注入：本地会话也挂记忆段，且带规矩
  resetCaches()
  const sections = []
  const ictx = {
    on(ev, fn) { if (!handlers.has(ev)) handlers.set(ev, []); handlers.get(ev).push(fn); return () => {} },
    logger: { info() {} },
  }
  registerInjection(ictx, { root, log: () => {} })
  for (const fn of handlers.get('agent/created') || []) {
    fn({ agent: { session: { header: { id: sid, cwd: '$WORKSPACE/demo' } }, ctx: { systemPrompt: { section(s) { sections.push(s) } } } } })
  }
  await new Promise((r) => setTimeout(r, 120))
  const mem = sections.find((s) => s.name === MEMORY_SECTION)
  assert.ok(mem, `本地会话没挂记忆段：${sections.map((s) => s.name).join(',')}`)
  assert.ok(String(mem.text()).includes('记忆使用规矩'), '记忆段缺规矩')
  ok('本地会话注入记忆段')

  // 6. 工具：活跃会话是本地时，memory_save 写进 local:dsh
  const tools = []
  const tctx = { tools: { register(spec) { tools.push(spec); return () => {} } }, logger: { info() {} } }
  registerTools(tctx, { root, log: () => {} })
  assert.equal(lastActive.scope?.kind, 'local', 'ingest 没记住活跃会话')
  const save = tools.find((t) => t.name === 'memory_save')
  const out = await save.execute({ text: '这个仓库用 pnpm 管理依赖', source_quote: '以后都用 pnpm' })
  assert.equal(out.ok, true, JSON.stringify(out))
  assert.equal(out.scope, 'local:dsh')
  const sc2 = await loadScope(root, 'local', 'dsh')
  assert.ok(sc2.items.some((x) => x.text.includes('pnpm 管理依赖')), sc2.items.map((x) => x.text).join(' | '))
  ok('memory_save 写进本地分片')

  // 7. 边界：桥接配置读坏时不归本地
  const badCfg = join(root, 'qq-bridge-config.json')
  await writeFile(badCfg, '{坏掉的 json', 'utf8')
  process.env.DSH_QQ_BRIDGE_CONFIG = badCfg
  resetSourceCache()
  assert.equal(await sourceOfSession(sid), null, '配置读坏时不该把会话算成本地')
  ok('桥接配置损坏不误归本地')

  // 8. 边界：显式关掉本地记忆，退回只收桥接
  const goodCfg = join(root, 'empty-bindings.json')
  await writeFile(goodCfg, JSON.stringify({ 绑定: [] }), 'utf8')
  process.env.DSH_QQ_BRIDGE_CONFIG = goodCfg
  resetSourceCache()
  process.env.DSH_MEMORY_LOCAL_SCOPE = 'off'
  assert.equal(await sourceOfSession('session-another'), null, '关掉后不该再收本地会话')
  delete process.env.DSH_MEMORY_LOCAL_SCOPE
  assert.ok(await sourceOfSession('session-another'), '默认应该收本地会话')
  ok('本地记忆开关生效')

  // 9. 主库/副库都在（派生视图没漏）
  assert.ok(existsSync(join(root, 'scopes', 'local-dsh', 'memory_index.md')), '副库没生成')
  assert.ok(existsSync(join(root, 'scopes', 'local-dsh', 'memory_full')), '主库目录没生成')
  const index = await readFile(join(root, 'scopes', 'local-dsh', 'memory_index.md'), 'utf8')
  assert.ok(index.includes('pnpm'), '副库里没有本地记忆')
  ok('本地分片主副库齐全')

  console.log(`\n全部通过：${pass} 项`)
} catch (e) {
  console.error('\n失败：', e)
  process.exitCode = 1
} finally {
  await rm(root, { recursive: true, force: true }).catch(() => {})
}
