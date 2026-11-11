/**
 * memory.mjs —— 事实生命周期 / 并发写 / 容量门 / 相关注入 / 群成员 / 脱敏
 * 跑法：node test/memory.mjs
 *
 * 对应「现存问题清单」第 3、4、5、8、9、10、12 条。
 */
import assert from 'node:assert'
import { mkdtemp, readFile, rm, appendFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = await mkdtemp(join(tmpdir(), 'whale-mem-'))

const {
  ensureDirs, loadScope, saveScope, addItem, updateScope, enforceCapacity,
  slotOf, withWriteLock, paths,
} = await import('../lib/store.js')
const { renderMemory } = await import('../lib/inject.js')
const { renderSkeleton } = await import('../lib/skeleton.js')
const { buildMembers } = await import('../lib/profile.js')
const { redactText } = await import('../lib/redact.js')
const { registerTools } = await import('../lib/tools.js')
const { lastActive } = await import('../lib/ingest.js')
const { buildGraph } = await import('../lib/graph.js')

let pass = 0
const ok = (name) => { pass += 1; console.log('  ok', name) }

try {
  await ensureDirs(root)

  // 3. 同槽位的新事实要把旧的标成 superseded，不再注入
  const sc = await loadScope(root, 'private', '123456789')
  const old = addItem(sc, { text: '老爹明天8:30上班', kind: 'event' })
  const now = addItem(sc, { text: '老爹明天9点上班', kind: 'event' })
  assert.equal(old.state, 'superseded', JSON.stringify(old))
  assert.equal(old.supersededBy, now.id)
  assert.ok(old.validTo, '被取代的条目要留 validTo')
  const out1 = renderMemory(sc)
  assert.ok(out1.includes('9点'), out1)
  assert.ok(!out1.includes('8:30'), '被取代的旧事实还在注入：' + out1)
  ok('事实取代：同槽位旧事实失效')

  // 不是同一槽位的不能误取代（没有数字的「在公司上班」不是上班时间）
  assert.equal(slotOf('老爹在公司上班'), '')
  const job = addItem(sc, { text: '老爹在公司上班', kind: 'fact' })
  assert.equal(now.state, 'active', '不同槽位不该被取代')
  assert.equal(job.state, 'active')
  ok('不同槽位不误取代')

  await saveScope(root, sc)

  // 图谱也不该再抽被取代的旧事实
  const g = buildGraph([sc])
  assert.ok(!g.edges.some((e) => e.text.includes('8:30')), JSON.stringify(g.edges.map((e) => e.text)))

  // 4. 并发读改写不丢更新
  await Promise.all(Array.from({ length: 20 }, (_, i) => updateScope(root, 'private', '222', (s) => {
    // 直接 push，不走 addItem —— 这里测的是锁，不是去重
    s.items.push({ id: `c${i}`, text: `并发-${i}`, kind: 'fact', conf: 0.6, state: 'active', created: new Date().toISOString(), lastHit: new Date().toISOString(), hits: 0, merged: 0 })
  })))
  const conc = await loadScope(root, 'private', '222')
  assert.equal(conc.items.length, 20, `丢更新了：${conc.items.length}/20`)
  ok('并发写不丢更新')

  // 8. 容量门：超限归档最冷的，不删
  const cap = await loadScope(root, 'group', '999')
  for (let i = 0; i < 10; i++) {
    addItem(cap, { text: `容量测试第${i}条记忆内容`, conf: 0.2 + i * 0.05 })
    cap.items[cap.items.length - 1].lastHit = new Date(Date.now() - (10 - i) * 86400000).toISOString()
  }
  await saveScope(root, cap)
  const dropped = await enforceCapacity(root, cap, 5)
  assert.equal(dropped, 5)
  assert.equal(cap.items.length, 5)
  const arc = await readFile(join(paths(root).archive, 'group-999.jsonl'), 'utf8')
  assert.ok(arc.includes('capacity'), '归档没记原因')
  ok('容量门：超限归档')

  // 5. 相关条目排在最前
  const relOut = renderMemory(sc, { relevant: [now.id], topN: 3 })
  const lines = relOut.split('\n').filter((l) => l.startsWith('- ['))
  assert.ok(lines[0].includes('9点'), relOut)
  ok('相关记忆优先注入')

  // 9. 群成员聚合（只用昵称，不落 QQ）
  const grp = { scope: 'group:1', kind: 'group', id: '1', items: [] }
  addItem(grp, { text: '老爹说周末去钓鱼', speaker: '老爹', observedAt: '2026-10-30T12:00:00' })
  addItem(grp, { text: '小鱼说想看海', speaker: '小鱼', observedAt: '2026-10-29T12:00:00' })
  addItem(grp, { text: '老爹说鱼竿断了', speaker: '老爹', observedAt: '2026-10-31T12:00:00' })
  const members = buildMembers(grp)
  assert.equal(members[0].name, '老爹')
  assert.equal(members[0].items, 2)
  assert.equal(members[0].last, '10-31')
  assert.ok(members[0].note.includes('钓鱼') || members[0].note.includes('鱼竿'), '成员画像：' + members[0].note)
  assert.ok(!members[0].note.startsWith('老爹'), '画像里不该重复昵称：' + members[0].note)
  grp.members = members
  grp.profile = { summary: '这个群：记得 3 件事。' }
  assert.ok(renderMemory(grp).includes('【群里的人】'), renderMemory(grp))
  ok('群成员画像聚合并注入')

  // 12. 凭据在入库/注入两侧都不出现
  assert.equal(redactText('我的 api_key: sk-abcdefghijklmnopqrstuvwx'), '我的 api_key: [已隐藏]')
  assert.equal(redactText('QQ 123456789 记一下'), 'QQ 123456789 记一下', '普通数字不能被误伤')
  const secretScope = { scope: 'private:9', kind: 'private', id: '9', label: '私聊 9', profile: { summary: '' }, items: [] }
  addItem(secretScope, { text: 'token=abcdef123456 别告诉别人', kind: 'fact' })
  const secretOut = renderMemory(secretScope)
  assert.ok(!secretOut.includes('abcdef123456'), secretOut)
  assert.ok(secretOut.includes('[已隐藏]'), secretOut)
  ok('凭据打码（入库 + 注入）')

  // memory_correct：旧条目标取代，新条目生效
  const tools = []
  const ctx = { tools: { register(spec) { tools.push(spec); return () => {} } } }
  registerTools(ctx, { root, log: () => {} })
  const correct = tools.find((t) => t.name === 'memory_correct')
  assert.ok(correct, '没注册 memory_correct')

  lastActive.sessionId = 's-correct'
  lastActive.at = Date.now()
  lastActive.scope = { kind: 'private', id: '123456789', label: '私聊', addr: '老爹' }
  const r = await correct.execute({ id: now.id, text: '老爹明天10点上班' })
  assert.equal(r.ok, true, JSON.stringify(r))
  const afterCorrect = await loadScope(root, 'private', '123456789')
  const fresh = afterCorrect.items.find((x) => x.id === r.id)
  const replaced = afterCorrect.items.find((x) => x.id === now.id)
  assert.equal(fresh.state, 'active')
  assert.equal(replaced.state, 'superseded')
  assert.ok(fresh.text.includes('10点'))
  const out2 = renderMemory(afterCorrect)
  assert.ok(!out2.includes('9点上班'), out2)
  ok('memory_correct 取代旧说法')

  // 13. 常驻速览只给最近 + 高权重几条，不再按类目铺全量目录
  const stamp = (n) => new Date(Date.now() - n * 86400000).toISOString()
  const skScope = { kind: 'private', id: 'skeleton', profile: { summary: '' }, items: [] }
  for (let i = 0; i < 12; i++) {
    skScope.items.push({
      id: `m_sk${String(i).padStart(2, '0')}`,
      text: `第${i}条记忆的完整内容，用来验证速览不会把整库都铺开`,
      kind: 'fact',
      state: 'active',
      conf: 0.6,
      weight: i === 2 ? 0.95 : 0.1 + i * 0.01,
      created: stamp(12 - i),
      lastHit: stamp(12 - i),
      hits: 0,
    })
  }
  const sk = renderSkeleton(skScope, { maxChars: 700, version: '1' })
  assert.ok(sk.includes('共 12 条'), sk)
  assert.ok(sk.includes('第11条记忆'), '最近的条目要能看到：\n' + sk)
  assert.ok(sk.includes('第2条记忆'), '高权重的老条目也要能看到：\n' + sk)
  assert.ok(!sk.includes('第0条记忆'), '又老又轻的条目不该常驻：\n' + sk)
  assert.ok(sk.includes('按需查'), sk)
  assert.ok(sk.length <= 700, `超预算：${sk.length}`)
  ok('速览只给最近 + 高权重，其余按需检索')

  // 群聊手动记：speaker 从原话所在的那条消息取，不拿绑定称呼「群里的人」顶上
  lastActive.sessionId = 's-group-said'
  lastActive.at = Date.now()
  lastActive.scope = { kind: 'group', id: '123456789', label: '群 123456789', addr: '群里的人' }
  await mkdir(paths(root).staging, { recursive: true })
  await appendFile(join(paths(root).staging, 's-group-said.jsonl'), JSON.stringify({
    at: new Date().toISOString(), role: 'user', speaker: '陆小鱼', qq: '10001',
    text: '连情绪系统和月经期都要往 AI 里塞',
  }) + '\n', 'utf8')
  const save = tools.find((t) => t.name === 'memory_save')
  const gsaved = await save.execute({
    text: '陆小鱼认为往AI里塞情绪系统和月经期很离谱',
    source_quote: '连情绪系统和月经期都要往 AI 里塞',
  })
  assert.equal(gsaved.ok, true, JSON.stringify(gsaved))
  const gscope = await loadScope(root, 'group', '123456789')
  const gitem = gscope.items.find((x) => x.id === gsaved.id)
  assert.equal(gitem.speaker, '陆小鱼', '群里的发言人要从原话里取：' + JSON.stringify(gitem))
  ok('群聊手动记忆：发言人取自原话，不用会话称呼')

  // 泛称不进成员表，也不在注入里冒充发言人
  const ph = { scope: 'group:ph', kind: 'group', id: 'ph', label: '群 ph', profile: { summary: '' }, items: [] }
  addItem(ph, { text: '爹说月经期数据后面可以做', speaker: '群里的人', source: 'tool' })
  addItem(ph, { text: '小鱼说想看海', speaker: '小鱼', source: 'tool' })
  assert.ok(!buildMembers(ph).some((m) => m.name === '群里的人'), JSON.stringify(buildMembers(ph)))
  assert.ok(!renderMemory(ph).includes('群里的人'), renderMemory(ph))
  ok('泛称不进成员表 / 注入')

  console.log(`\n全部通过：${pass} 项`)
} catch (e) {
  console.error('\n失败：', e)
  process.exitCode = 1
} finally {
  await rm(root, { recursive: true, force: true }).catch(() => {})
}
