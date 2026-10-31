/**
 * tools.mjs —— 读侧工具契约验收（阶段 5）
 *
 * 验的是文档 7.2 / 7.3 / 7.7 的硬约束：
 *   · search_memory 只返回目录字段（id/摘要/标签/权重），不返回正文
 *   · read_memory 按 section 读主库，单次有 token 上限，读事件进 usage.jsonl
 *   · memory_recall 作为旧名仍然可用
 *   · memory_save 没有 source_quote 就拒写
 */
import assert from 'node:assert'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { registerTools } from '../lib/tools.js'
import { createHarness } from './eval/harness.mjs'
import { vaultPaths } from '../lib/vault.js'

let pass = 0
const ok = (name) => { pass += 1; console.log('  ok', name) }

const h = await createHarness([{ id: 't1', turns: [] }])
const tools = new Map()
try {
  registerTools({ tools: { register(spec) { tools.set(spec.name, spec); return () => {} } } }, { root: h.root, log: () => {} })

  assert.ok(tools.has('search_memory') && tools.has('read_memory') && tools.has('memory_recall'), [...tools.keys()].join(','))
  ok('工具注册：search_memory / read_memory / memory_recall')

  const c = {
    id: 't1',
    turns: [
      '记住，我住在杭州',
      '我特别喜欢喝冰美式',
      '记住，明天要交高数作业',
    ],
  }
  await h.feed(c)
  await h.distill(c)
  const sc = await h.scopeOf(c.id)
  const live = sc.items.filter((x) => x.state !== 'archived' && x.state !== 'superseded')
  assert.ok(live.length >= 3, JSON.stringify(live.map((x) => x.text)))

  // search_memory：只给目录字段
  const s = await tools.get('search_memory').execute({ query: '我住哪儿' })
  assert.ok(s.ok && s.count >= 1, JSON.stringify(s))
  assert.ok(s.results[0].id && s.results[0].summary, JSON.stringify(s.results[0]))
  assert.ok(Array.isArray(s.results[0].tags))
  assert.ok(!JSON.stringify(s.results).includes('## 完整记录'), '检索结果不该带正文段落')
  const hit = s.results.find((x) => x.summary.includes('杭州')) || s.results[0]
  ok('search_memory：返回 id/摘要/标签，不返回正文')

  // 旧名等价
  const old = await tools.get('memory_recall').execute({ query: '我住哪儿' })
  assert.ok(old.ok && old.count === s.count, `${old.count} vs ${s.count}`)
  ok('memory_recall 旧名仍可用')

  // read_memory：默认提炼+背景；指定 section
  const r = await tools.get('read_memory').execute({ id: hit.id })
  assert.ok(r.ok && r.tokens > 0 && r.text.length > 0, JSON.stringify(r))
  assert.equal(r.section, '提炼')
  const full = await tools.get('read_memory').execute({ id: hit.id, section: '完整记录' })
  assert.ok(full.ok && full.text.includes('杭州'), full.text)
  ok('read_memory：默认提炼+背景，可指定完整记录')

  // token 上限
  const cut = await tools.get('read_memory').execute({ id: hit.id, section: 'full', max_tokens: 200 })
  assert.ok(cut.tokens <= 200, `${cut.tokens}`)
  ok('read_memory：单次 token 上限生效')

  // 单回合读取配额（60 秒窗口近似）
  const blocked = await tools.get('read_memory').execute({ id: hit.id })
  assert.equal(blocked.ok, false)
  assert.ok(/3 条/.test(blocked.why), blocked.why)
  ok('read_memory：单回合 3 次上限')

  // usage 记录
  const p = vaultPaths(h.root, sc.kind, sc.id)
  const usage = await readFile(p.usage, 'utf8')
  assert.ok(usage.includes('read_memory'), usage.slice(0, 200))
  ok('读取事件写 usage.jsonl')

  // 读账：search / read / profile 统一落 audit/reads.jsonl，失败分支也要记
  await tools.get('profile_show').execute({ scope: sc.scope })
  const readsFile = join(h.root, 'audit', 'reads.jsonl')
  const rows = (await readFile(readsFile, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l))
  const kinds = rows.map((x) => x.kind)
  assert.ok(kinds.includes('search') && kinds.includes('read') && kinds.includes('profile'),
    '读账缺项：' + kinds.join(','))
  const sr = rows.find((x) => x.kind === 'search')
  assert.equal(sr.tool, 'search_memory')
  assert.equal(typeof sr.ms, 'number')
  assert.equal(typeof sr.empty, 'boolean')
  const rr = rows.find((x) => x.kind === 'read' && x.ok)
  assert.ok(rr.id === hit.id && rr.tokens > 0, JSON.stringify(rr))
  assert.ok(rows.some((x) => x.kind === 'read' && x.ok === false && /3 条/.test(x.why)),
    '被配额挡掉的那次也要留痕')
  ok('读账：search/read/profile 都落 reads.jsonl，失败分支也有')

  // memory_save：缺 source_quote 拒写
  const bad = await tools.get('memory_save').execute({ text: '用户喜欢深色主题' })
  assert.equal(bad.ok, false)
  assert.ok(/source_quote/.test(bad.why), bad.why)
  ok('memory_save：没有原话片段直接拒写')

  // 带原话：写成功并留存
  const good = await tools.get('memory_save').execute({
    text: '用户喜欢深色主题',
    kind: 'pref',
    source_quote: '记住，我这边一律用深色主题',
  })
  assert.ok(good.ok, JSON.stringify(good))
  const after = await h.scopeOf(c.id)
  const saved = after.items.find((x) => x.id === good.id)
  assert.ok(saved, '写进去的条目找不到')
  assert.equal(saved.sourceQuote, '记住，我这边一律用深色主题')
  ok('memory_save：带原话写入，source_quote 落到主库')

  console.log(`\n${pass} 通过 · 0 失败`)
} finally {
  await h.dispose()
}
