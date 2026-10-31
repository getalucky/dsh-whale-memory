/**
 * time.mjs —— 相对时间锚定 + 注入输出的 {{ 守卫
 * 跑法：node test/time.mjs
 *
 * 两条都是 2026-10-30 对照 iris/shoucang 找出来的：
 *   · 「明天」不锚，三天后还在说明天
 *   · 记忆里带 {{ 会让宿主 system prompt 插值 throw，会话永久不可用
 */
import assert from 'node:assert'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = await mkdtemp(join(tmpdir(), 'whale-time-'))
const cfgFile = join(root, 'qq-bridge-config.json')
await writeFile(cfgFile, JSON.stringify({ 绑定: [{ 类型: '私聊', 号码: '123456789', 会话: 'sess-time-1', 称呼: '老爹' }] }), 'utf8')
process.env.DSH_QQ_BRIDGE_CONFIG = cfgFile

const { resolveRelativeTime, formatAbs } = await import('../lib/time.js')
const { guardPromptText, renderMemory } = await import('../lib/inject.js')
const { ensureDirs, loadScope, paths } = await import('../lib/store.js')
const { distillSession } = await import('../lib/distill.js')

let pass = 0
const ok = (name) => { pass += 1; console.log('  ok', name) }

const at = (text, base) => resolveRelativeTime(text, base)

try {
  // 2026-10-30 是周五
  assert.equal(at('明天8:30上班', '2026-10-30T23:10:00')?.abs, '2026-10-31T08:30')
  assert.equal(at('明天8:30上班', '2026-10-30T23:10:00')?.label, '10-31 08:30')
  ok('明天 + 钟点')

  assert.equal(at('后天下午3点出发', '2026-10-30T09:00:00')?.abs, '2026-11-01T15:00')
  assert.equal(at('下午3点上班', '2026-10-30T09:00:00')?.abs, '2026-10-30T15:00')
  ok('后天 / 下午换算')

  // 只说钟点、今天已过 → 明天
  assert.equal(at('8:30上班', '2026-10-30T09:00:00')?.abs, '2026-10-31T08:30')
  ok('钟点已过顺延到明天')

  // 周五说「下周三」= 11-04，不是 11-11
  assert.equal(at('记住：我下周三出差', '2026-10-30T12:00:00')?.abs, '2026-11-04')
  assert.equal(at('这周日打球', '2026-10-30T12:00:00')?.abs, '2026-11-01')
  ok('周几换算')

  assert.equal(at('下个月3号交房租', '2026-10-30T12:00:00')?.abs, '2026-11-03')
  assert.equal(at('10月31日开会', '2026-10-30T12:00:00')?.abs, '2026-10-31')
  ok('几号 / 几月几号')

  // 认不出来就别瞎锚
  assert.equal(at('我喜欢冰美式', '2026-10-30T12:00:00'), null)
  assert.equal(at('老爹住在杭州', '2026-10-30T12:00:00'), null)
  assert.equal(at('2026-10-31 08:30 开会', '2026-10-30T12:00:00'), null)
  assert.equal(at('下午三点', '2026-10-30T12:00:00'), null)
  ok('认不出来不硬猜')

  assert.equal(formatAbs('2026-10-31T08:30'), '10-31 08:30')
  assert.equal(formatAbs('2026-11-04T00:00'), '11-04 00:00')
  ok('formatAbs')

  // {{ 守卫
  assert.equal(guardPromptText('{{name}}'), '{ {name}}')
  assert.equal(guardPromptText('没有问题'), '没有问题')
  const dirtyScope = { scope: 'group:1', kind: 'group', id: '1', label: '群 1', profile: { summary: '' }, items: [{ id: 'm1', text: '她发了个模板 {{user}} 让我填', kind: 'fact', conf: 1, created: new Date().toISOString(), lastHit: new Date().toISOString() }] }
  const rendered = renderMemory(dirtyScope)
  assert.ok(rendered.includes('{ {user}}'), rendered)
  assert.ok(!rendered.includes('{{'), '注入段里还留着 {{')
  ok('注入出口拆开 {{')

  // 端到端：staging 里的「明天」按消息时间锚，不按蒸馏时间
  await ensureDirs(root)
  const sid = 'sess-time-1'
  await mkdir(paths(root).staging, { recursive: true })
  await writeFile(join(paths(root).staging, `${sid}.jsonl`), [
    JSON.stringify({ at: '2026-10-30T23:10:00', role: 'user', speaker: '老爹', qq: '123456789', text: '记住：明天8:30上班' }),
  ].join('\n') + '\n', 'utf8')
  const r = await distillSession(root, sid, { log: () => {} })
  assert.equal(r.ok, true, JSON.stringify(r))
  const sc = await loadScope(root, 'private', '123456789')
  const it = sc.items.find((x) => x.text.includes('8:30'))
  assert.ok(it, JSON.stringify(sc.items))
  assert.equal(it.atAbs, '2026-10-31T08:30', JSON.stringify(it))
  assert.equal(it.observedAt, '2026-10-30T23:10:00')
  const out = renderMemory(sc)
  assert.ok(out.includes('10-31 08:30'), out)
  ok('蒸馏按消息时间锚定')

  console.log(`\n全部通过：${pass} 项`)
} catch (e) {
  console.error('\n失败：', e)
  process.exitCode = 1
} finally {
  await rm(root, { recursive: true, force: true }).catch(() => {})
}
