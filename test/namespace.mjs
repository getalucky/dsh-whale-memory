/**
 * namespace.mjs —— global / project 命名空间分层（文档 4.7）
 *
 * 验的是：
 *   · 从会话 cwd 向上找仓库标记，分片 id 稳定；认不出来 / DSH_HOME 内不给命名空间
 *   · DSH_MEMORY_PROJECT_SCOPE=off 退回只有个人库
 *   · memory_save(namespace=project) 真的写进 <repo>/.dsh/storages，个人库不留副本
 *   · 仓库会话检索同时看两个根，read_memory 按条目所在根读正文
 *   · 注入把「本仓库记忆」和「个人目录」分两段渲染，规矩段只出一次
 *   · 不在仓库里的会话要 project 命名空间直接拒写
 */
import assert from 'node:assert'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ensureDirs, listScopes } from '../lib/store.js'
import { registerIngest, flush } from '../lib/ingest.js'
import { registerTools } from '../lib/tools.js'
import { registerInjection, startMemoryRefresh, resetCaches } from '../lib/inject.js'
import { preloadSources, resetSourceCache } from '../lib/source.js'
import { preloadTrust, resetTrustCache, trust } from '../lib/trust.js'
import { projectOf, resetNamespaceCache, listProjectRoots } from '../lib/namespace.js'

let pass = 0
const ok = (name) => { pass += 1; console.log('  ok', name) }

const base = await mkdtemp(join(tmpdir(), 'whale-ns-'))
const root = join(base, 'memory')
const repo = join(base, 'myrepo')
await mkdir(join(repo, 'src'), { recursive: true })
await writeFile(join(repo, 'package.json'), '{"name":"myrepo"}', 'utf8')
process.env.DSH_MEMORY_HOME = root
process.env.DSH_QQ_BRIDGE_CONFIG = join(base, 'no-bridge.json')
process.env.DSH_MEMORY_PROJECT_SCOPE = 'on'
await ensureDirs(root)
await preloadTrust(root)
resetSourceCache()
await preloadSources()

try {
  // ---- 识别 ----
  const ns = projectOf(repo)
  assert.ok(ns && ns.scope.startsWith('project:'), JSON.stringify(ns))
  assert.equal(projectOf(join(repo, 'src')).scope, ns.scope, '子目录应该归到同一个仓库分片')
  ok('仓库识别：从子目录向上找到仓库根，分片 id 稳定')

  resetNamespaceCache()
  process.env.DSH_MEMORY_PROJECT_SCOPE = 'off'
  assert.equal(projectOf(repo), null)
  process.env.DSH_MEMORY_PROJECT_SCOPE = 'on'
  resetNamespaceCache()
  assert.equal(projectOf(base), null, '没有仓库标记的目录不该给命名空间')
  ok('开关能关；认不出来就不给命名空间')

  const fakeHome = join(base, 'dsh-home')
  await mkdir(fakeHome, { recursive: true })
  await writeFile(join(fakeHome, 'package.json'), '{"name":"host"}', 'utf8')
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = fakeHome
  resetNamespaceCache()
  assert.equal(projectOf(fakeHome), null, 'DSH_HOME 是宿主目录，不该当成仓库')
  if (oldHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = oldHome
  resetNamespaceCache()
  ok('DSH_HOME 内的目录不当仓库')

  // ---- 采集 + 工具 ----
  const handlers = new Map()
  const ctx = {
    on(ev, fn) {
      if (!handlers.has(ev)) handlers.set(ev, [])
      handlers.get(ev).push(fn)
      return () => {}
    },
    logger: { info() {} },
  }
  registerIngest(ctx, { root, log: () => {} })
  const tools = new Map()
  registerTools({ tools: { register(spec) { tools.set(spec.name, spec); return () => {} } } }, { root, log: () => {} })

  const say = async (sid, cwd, text) => {
    for (const fn of handlers.get('session/event') || []) {
      fn({ header: { id: sid, cwd } }, { type: 'user/message', data: { content: text } })
    }
    await flush()
  }

  await say('s-local-1', repo, '记住，这个仓库发布前必须跑 node tools/deploy.mjs')
  const saved = await tools.get('memory_save').execute({
    text: '发布前必须跑 node tools/deploy.mjs',
    kind: 'lesson',
    trigger: '当准备发布这个仓库时',
    anti_pattern: '不跑部署脚本直接 push',
    source_quote: '记住，这个仓库发布前必须跑 node tools/deploy.mjs',
    namespace: 'project',
  })
  assert.ok(saved.ok, JSON.stringify(saved))
  assert.equal(saved.scope, ns.scope)

  const idxFile = join(ns.root, 'scopes', `project-${ns.id}`, 'memory_index.md')
  const idx = await readFile(idxFile, 'utf8')
  assert.ok(idx.includes('deploy.mjs'), idx.slice(0, 200))
  const globalScopes = await listScopes(root)
  assert.ok(!globalScopes.some((s) => (s.items || []).some((x) => String(x.text).includes('deploy.mjs'))),
    '仓库条目不该同时写进个人库')
  ok('memory_save(namespace=project)：写进仓库自己的库，个人库不留副本')

  assert.deepEqual(await listProjectRoots(root), [ns.root.replace(/\\/g, '/')], '仓库库要登记，遗忘循环才扫得到')
  ok('仓库库登记到 namespaces.json')

  const s1 = await tools.get('search_memory').execute({ query: '发布部署' })
  assert.ok(s1.results.some((x) => x.scope === ns.scope), JSON.stringify(s1))
  const r1 = await tools.get('read_memory').execute({ id: saved.id })
  assert.ok(r1.ok && r1.text.includes('deploy.mjs'), JSON.stringify(r1))
  ok('仓库会话检索/读取能命中仓库库')

  // 同一个会话里写个人偏好：仍然落个人库，检索时两个根都能看到
  await say('s-local-1', repo, '记住，我这边一律用深色主题')
  const globalSave = await tools.get('memory_save').execute({
    text: '用户喜欢深色主题',
    kind: 'pref',
    source_quote: '记住，我这边一律用深色主题',
  })
  assert.ok(globalSave.ok && globalSave.scope.startsWith('local:'), JSON.stringify(globalSave))
  const s2 = await tools.get('search_memory').execute({ query: '深色主题' })
  assert.ok(s2.results.some((x) => x.scope.startsWith('local:')), JSON.stringify(s2))
  ok('默认写入仍是个人库，检索同时看两个根')

  // ---- 注入 ----
  resetCaches()
  const created = []
  const ictx = {
    on(ev, fn) { if (ev === 'agent/created') created.push(fn); return () => {} },
    logger: { info() {} },
  }
  registerInjection(ictx, { root, log: () => {} })
  const sections = []
  const agent = {
    session: { header: { id: 's-local-2', cwd: repo } },
    ctx: { systemPrompt: { section(s) { sections.push(s) } } },
  }
  for (const fn of created) fn({ agent })
  await startMemoryRefresh({ root, log: () => {} }).tick()
  const mem = sections.find((x) => x.name === 'whale:memory')
  const text = mem.text()
  assert.ok(text.includes('本仓库记忆'), text.slice(0, 400))
  assert.ok(text.includes('当准备发布这个仓库时'), text.slice(-400))
  assert.ok(text.includes('记忆速览'), '个人速览也要在，不能只剩仓库')
  assert.equal((text.match(/【记忆使用规矩】/g) || []).length, 1, '规矩段只能出一份')
  ok('注入：仓库 + 个人两段骨架，规矩段只出一次')

  // ---- 不在仓库里 ----
  await say('s-local-3', base, '在吗')
  const bad = await tools.get('memory_save').execute({
    text: '随便一条',
    source_quote: '记住，这句话够八个字了吧',
    namespace: 'project',
  })
  assert.equal(bad.ok, false)
  assert.ok(/不在仓库/.test(bad.why), bad.why)
  ok('不在仓库的会话写 project 直接拒写')

  // ---- 仓库库未信任：读写和注入都要停 ----
  // clone 下来的仓库会带一份 .dsh/storages；没人工确认前不能当可信记忆用
  await mkdir(ns.root, { recursive: true })
  await writeFile(join(ns.root, 'meta.json'), JSON.stringify({ origin: 'external' }), 'utf8')
  resetTrustCache()
  await say('s-local-4', repo, '在吗，看看仓库记忆')

  const blocked = await tools.get('memory_save').execute({
    text: '未信任仓库里不该写进去',
    source_quote: '记住，这句话够八个字了吧',
    namespace: 'project',
  })
  assert.equal(blocked.ok, false)
  assert.ok(/未信任/.test(blocked.why), blocked.why)

  const s3 = await tools.get('search_memory').execute({ query: '发布部署' })
  assert.ok(!s3.results.some((x) => x.scope === ns.scope), '未信任的仓库条目不能进检索结果')

  resetCaches()
  const agent2 = {
    session: { header: { id: 's-local-4', cwd: repo } },
    ctx: { systemPrompt: { section(s) { sections.push(s) } } },
  }
  for (const fn of created) fn({ agent: agent2 })
  await startMemoryRefresh({ root, log: () => {} }).tick()
  const mem2 = sections.filter((x) => x.name === 'whale:memory').at(-1).text()
  assert.ok(!mem2.includes('本仓库记忆'), '未信任的仓库骨架不能注入')
  assert.ok(mem2.includes('记忆速览'), '个人速览不受影响')
  ok('仓库库未信任：写入 / 检索 / 注入全部停用')

  // 人工 trust 后恢复
  await trust(ns.root)
  const s4 = await tools.get('search_memory').execute({ query: '发布部署' })
  assert.ok(s4.results.some((x) => x.scope === ns.scope), JSON.stringify(s4))
  ok('仓库库 trust 后恢复检索')

  console.log(`\n${pass} 通过 · 0 失败`)
} finally {
  await rm(base, { recursive: true, force: true }).catch(() => {})
}
