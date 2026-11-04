/**
 * inbound.mjs —— B站账本单向入库
 * 跑法：node test/inbound.mjs
 *
 * 验的是：账本新增行 → local:dsh 条目；水位/正文 hash 两道幂等；
 * 半行不入库；账本被截断时不重复入库；开关能关掉。
 */
import assert from 'node:assert'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = await mkdtemp(join(tmpdir(), 'whale-inbound-'))
const ledgerHome = await mkdtemp(join(tmpdir(), 'whale-bili-'))
process.env.DSH_MEMORY_HOME = root
process.env.BILI_DUTY_HOME = ledgerHome
delete process.env.DSH_MEMORY_BILI_SYNC

const { ensureDirs, loadScope } = await import('../lib/store.js')
const { syncBiliLedger, ledgerFile, stateFile } = await import('../lib/inbound.js')

let pass = 0
const ok = (name) => { pass += 1; console.log('  ok', name) }
const ledger = ledgerFile()
const line = (o) => JSON.stringify(o) + '\n'

try {
  await ensureDirs(root)
  assert.equal(ledger, join(ledgerHome, 'memory.jsonl'), '账本路径没认 BILI_DUTY_HOME')

  // 1. 两条新观察入 public:web（B站公开情报进公共池）
  const a = { t: 'dsh-see-now 出了准实时视觉插件。', why: '跟我关注的 DSH 插件方向相关', bv: 'BV1aaaaaaa', d: '2026-11-02 13:35' }
  const b = { t: '登录态掉过一次，整条读内容链路断了。', why: '下轮开工先确认登录，别再空跑', bv: '', d: '2026-11-02 13:40' }
  await writeFile(ledger, line(a) + line(b), 'utf8')

  const r1 = await syncBiliLedger(root, {})
  assert.equal(r1.added, 2, JSON.stringify(r1))
  let sc = await loadScope(root, 'public', 'web')
  assert.equal(sc.items.length, 2)
  const one = sc.items.find((x) => x.text.includes('dsh-see-now'))
  assert.ok(one, '没找到第一条')
  assert.equal(one.source, 'bili')
  assert.equal(one.state, 'active')
  assert.deepEqual(one.refs, ['B站 BV1aaaaaaa'])
  assert.ok(one.observedAt.startsWith('2026-11-02'), one.observedAt)
  ok('新增行入库，来源/refs/时间都对')

  // 2. 再跑一次：水位挡住，不重复
  const r2 = await syncBiliLedger(root, {})
  assert.equal(r2.added, 0)
  sc = await loadScope(root, 'public', 'web')
  assert.equal(sc.items.length, 2)
  ok('水位幂等')

  // 3. 半行不入库，补全后才进
  await writeFile(ledger, line(a) + line(b) + '{"t":"写了一半的观察"', 'utf8')
  const r3 = await syncBiliLedger(root, {})
  assert.equal(r3.added, 0)
  assert.equal(r3.why, 'partial-line')
  await writeFile(ledger, line(a) + line(b) + '{"t":"写了一半的观察","d":"2026-11-03 09:00"}\n', 'utf8')
  const r4 = await syncBiliLedger(root, {})
  assert.equal(r4.added, 1)
  ok('半行等下一轮，补全才入库')

  // 4. 同一句再抄一遍（正文 hash 命中）：不新建
  await writeFile(ledger, line(a) + line(b) + line({ t: '写了一半的观察' }) + line(a), 'utf8')
  const r5 = await syncBiliLedger(root, {})
  assert.equal(r5.added, 0)
  sc = await loadScope(root, 'public', 'web')
  assert.equal(sc.items.length, 3)
  ok('正文 hash 幂等')

  // 5. 账本被截短重写：水位归零，但不把旧的再写一遍
  const short = line({ t: '全新的观察，账本被重写了' })
  await writeFile(ledger, short, 'utf8')
  const r6 = await syncBiliLedger(root, {})
  assert.equal(r6.added, 1, JSON.stringify(r6))
  sc = await loadScope(root, 'public', 'web')
  assert.equal(sc.items.length, 4)
  ok('账本截断后按 hash 兜住重复')

  // 6. 状态文件记了水位
  const st = JSON.parse(await readFile(stateFile(root), 'utf8'))
  assert.equal(st.offset, Buffer.byteLength(short, 'utf8'))
  assert.ok(Array.isArray(st.keys) && st.keys.length >= 3)
  ok('水位落盘')

  // 7. 开关
  process.env.DSH_MEMORY_BILI_SYNC = 'off'
  await writeFile(ledger, short + line({ t: '关掉的时候不该进来' }), 'utf8')
  const r7 = await syncBiliLedger(root, {})
  assert.equal(r7.added, 0)
  assert.equal(r7.skipped, 'off')
  delete process.env.DSH_MEMORY_BILI_SYNC
  ok('开关可关')

  // 8. 账本不存在：安静跳过
  process.env.BILI_DUTY_HOME = join(root, 'no-such-dir')
  const r8 = await syncBiliLedger(root, {})
  assert.equal(r8.added, 0)
  assert.equal(r8.skipped, 'no-ledger')
  ok('没有账本不报错')

  // 9. 零代码接入：投递箱按文件名当来源，认通用字段
  const dropDir = join(root, 'drops')
  process.env.DSH_MEMORY_INBOX = dropDir
  await mkdir(dropDir, { recursive: true })
  const drop = join(dropDir, 'pond.jsonl')
  await writeFile(drop, [
    JSON.stringify({ text: '池塘水温 18 度。', quote: '传感器读数', refs: ['pond-3'], at: '2026-11-03 09:00', kind: 'event', conf: 0.8 }),
    '{坏行',
  ].join('\n') + '\n', 'utf8')
  const { syncInbound, listInboundProviders, registerInboundProvider, inboxDir } = await import('../lib/inbound.js')
  assert.equal(inboxDir(), dropDir, '投递箱路径没认 DSH_MEMORY_INBOX')
  const r9 = await syncInbound(root, {})
  const pond = r9.providers.find((p) => p.id === 'inbox')
  assert.equal(pond.added, 1, JSON.stringify(r9))
  sc = await loadScope(root, 'local', 'dsh')
  const it = sc.items.find((x) => x.text.includes('池塘水温'))
  assert.ok(it, '投递箱的条目没入库')
  assert.equal(it.source, 'pond')
  assert.equal(it.kind, 'event')
  assert.equal(it.sourceQuote, '传感器读数')
  assert.deepEqual(it.refs, ['pond-3'])
  assert.equal(it.conf, 0.8)
  assert.ok(it.observedAt.startsWith('2026-11-03'), it.observedAt)
  ok('投递箱：文件名当来源，通用字段都认')

  // 10. 写代码接入：自定义 provider + 注销
  const custom = join(root, 'custom.jsonl')
  await writeFile(custom, JSON.stringify({ msg: '自定义账本的一行', note: '测试', when: '2026-11-04 10:00' }) + '\n', 'utf8')
  const off = registerInboundProvider({
    id: 'custom-test',
    label: '自定义',
    files: () => [{ file: custom, token: 'a' }],
    defaults: { kind: 'fact', conf: 0.4 },
    parse: (row, { toIso }) => ({ text: row.msg, quote: row.note, at: toIso(row.when) }),
  })
  assert.ok(listInboundProviders().some((p) => p.id === 'custom-test'))
  const r10 = await syncInbound(root, { id: 'custom-test' })
  assert.equal(r10.added, 1, JSON.stringify(r10))
  sc = await loadScope(root, 'local', 'dsh')
  assert.ok(sc.items.find((x) => x.text === '自定义账本的一行' && x.source === 'custom-test'))
  const r10b = await syncInbound(root, { id: 'custom-test' })
  assert.equal(r10b.added, 0, '自定义 provider 不幂等')
  off()
  assert.ok(!listInboundProviders().some((p) => p.id === 'custom-test'))
  ok('provider 注册/取数/注销')

  // 11. 总开关：别的 provider 照停
  process.env.DSH_MEMORY_INBOUND = 'off'
  await writeFile(drop, JSON.stringify({ text: '关掉时不该进' }) + '\n', 'utf8')
  const r11 = await syncInbound(root, {})
  assert.equal(r11.skipped, 'off')
  assert.equal(r11.added, 0)
  delete process.env.DSH_MEMORY_INBOUND
  ok('总开关可关')

  console.log(`\n${pass} 项通过`)
} finally {
  await rm(root, { recursive: true, force: true }).catch(() => {})
  await rm(ledgerHome, { recursive: true, force: true }).catch(() => {})
}
