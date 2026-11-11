/**
 * origin.mjs —— 原文指针与按需追溯
 *
 * 验的行为：
 *   · 蒸馏写条目时落坐标（sessionId/msgIndex/hash），主库里不出现原文副本
 *   · read_memory(section="原文") 能按指纹翻回旧会话，命中句打 ★，上下文带她那一句
 *   · 原会话不在时退回写入时保存的 source_quote；有缓存才读缓存
 *   · 原文里的 key 重新打码，不因为翻旧账又带出来
 */
import assert from 'node:assert'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'

import { registerTools } from '../lib/tools.js'
import { createHarness } from './eval/harness.mjs'
import { originOf, readOrigin, locateOrigin } from '../lib/origin.js'
import { vaultPaths } from '../lib/vault.js'

let pass = 0
const ok = (name) => { pass += 1; console.log('  ok', name) }

const h = await createHarness([{ id: 'o1' }, { id: 'o2' }, { id: 'o3' }])
const sessionsRoot = join(h.base, 'sessions')
process.env.DSH_MEMORY_SESSIONS_DIR = sessionsRoot
process.env.DSH_MEMORY_ORIGIN_CACHE = ''
delete process.env.DSH_MEMORY_ORIGIN_CACHE_DAYS
delete process.env.DSH_MEMORY_ORIGIN_CACHE_MB

const tools = new Map()
try {
  registerTools({ tools: { register(spec) { tools.set(spec.name, spec); return () => {} } } }, { root: h.root, log: () => {} })

  const c1 = { id: 'o1', turns: ['记住，我的猫叫团子，住在海边，门禁码 sk-abcdefghijklmnop1234'] }
  await h.feed(c1)
  await h.distill(c1)
  const sc1 = await h.scopeOf('o1')
  const cat = sc1.items.find((x) => x.text.includes('团子'))
  assert.ok(cat, JSON.stringify(sc1.items.map((x) => x.text)))
  assert.ok(cat.origin && cat.origin.sessionId === h.src.get('o1').sid, JSON.stringify(cat.origin))
  assert.ok(cat.origin.hash && Number.isInteger(cat.origin.msgIndex), JSON.stringify(cat.origin))
  assert.ok(!JSON.stringify(cat.origin).includes('团子'), '指针里不能存正文')
  const md = await readFile(join(vaultPaths(h.root, sc1.kind, sc1.id).full, `${cat.id}.md`), 'utf8')
  assert.ok(md.includes('origin_json:'), md.slice(0, 400))
  assert.ok(!md.includes('sk-abcdefghijklmnop1234'), '主库不能留明文 key')
  ok('蒸馏落原文坐标，主库不复制原文')

  // 假造 DSH 会话文件，放在 sessions/<workspace>/<sid>/session.v4.jsonl.zstd
  const sid = h.src.get('o1').sid
  const dir = join(sessionsRoot, '--tmp--', sid)
  await mkdir(dir, { recursive: true })
  const now = Date.now()
  const events = [
    { type: 'session', version: 4, id: sid, createdAt: now - 60000, cwd: 'D:/tmp' },
    { type: 'user/message', seq: 1, time: now - 60000, data: { content: '今天风很大', source: { kind: 'qq' } } },
    { type: 'assistant/message', seq: 2, time: now - 59000, data: { content: [{ type: 'text', text: '是呀，窗户都在响' }] } },
    { type: 'user/message', seq: 3, time: now, data: { content: '记住，我的猫叫团子，住在海边，门禁码 sk-abcdefghijklmnop1234', source: { kind: 'qq' } } },
    { type: 'assistant/message', seq: 4, time: now + 1000, data: { content: [{ type: 'text', text: '记下了，团子在海边' }] } },
  ]
  await writeFile(
    join(dir, 'session.v4.jsonl.zstd'),
    zstdCompressSync(Buffer.from(events.map((x) => JSON.stringify(x)).join('\n') + '\n', 'utf8')),
  )

  let r = await tools.get('read_memory').execute({ id: cat.id, section: '原文' })
  assert.ok(r.ok && r.origin && r.origin.found === true, JSON.stringify(r))
  assert.ok(r.text.includes('团子') && r.text.includes('海边'), r.text)
  assert.ok(r.text.includes('★'), r.text)
  assert.ok(r.text.includes('她：') && r.text.includes('记下了'), '上下文要带她那一句')
  assert.ok(!r.text.includes('sk-abcdefghijklmnop1234'), '翻原文也要打码')
  assert.ok(r.text.includes('[密钥已隐藏]'), r.text)
  ok('read_memory(section=原文)：按指纹定位、带前后文、重新打码')

  // memory_save 的原话常只是片段：哈希对不上整条，也得能靠包含关系找到
  const frag = locateOrigin(events, { origin: originOf('猫叫团子', { sessionId: sid }), sourceQuote: '猫叫团子' })
  assert.ok(frag && frag.text.includes('团子') && frag.how === 'quote-contains', JSON.stringify(frag))
  ok('原话片段：归一化包含即可定位')

  // 原会话不在：退回写入时保存的原话
  const c3 = { id: 'o3', turns: ['今天天气不错'] }
  await h.feed(c3)
  await h.distill(c3)
  const saved = await tools.get('memory_save').execute({
    text: '下周三要去看牙医',
    kind: 'event',
    source_quote: '记住，我下周三要去看牙医',
    mode: 'direct',
  })
  assert.ok(saved.ok, JSON.stringify(saved))
  const sc3 = await h.scopeOf('o3')
  const dental = sc3.items.find((x) => x.id === saved.id)
  assert.ok(dental?.origin && dental.sourceQuote, JSON.stringify(dental))
  process.env.DSH_MEMORY_SESSIONS_DIR = join(h.base, 'empty-sessions')
  const miss = await tools.get('read_memory').execute({ id: saved.id, section: '原文' })
  assert.ok(miss.ok && miss.origin && miss.origin.found === false, JSON.stringify(miss))
  assert.ok(miss.text.includes('写入这条时保存的原话') && miss.text.includes('牙医'), miss.text)
  ok('原会话缺失：退回 source_quote，不报错')

  // 可选缓存：成功追溯一次后，会话被清理也能读
  process.env.DSH_MEMORY_SESSIONS_DIR = sessionsRoot
  process.env.DSH_MEMORY_ORIGIN_CACHE = '1'
  const fresh = (await h.scopeOf('o1')).items.find((x) => x.id === cat.id)
  const first = await readOrigin(h.root, fresh)
  assert.ok(first.found && !first.cached, JSON.stringify(first))
  await rm(sessionsRoot, { recursive: true, force: true })
  const second = await readOrigin(h.root, fresh)
  assert.ok(second.found && second.cached === true, JSON.stringify(second))
  assert.ok(second.text.includes('原文缓存') && second.text.includes('团子'), second.text)
  assert.ok(!second.text.includes('sk-abcdefghijklmnop1234'), second.text)
  ok('可选原文缓存：30 天口径，会话没了仍可追溯')

  // 指针归一化：缺会话号 / 空文本不造指针
  assert.equal(originOf('', { sessionId: 's' }), null)
  assert.equal(originOf('有字', { sessionId: '' }), null)
  ok('原文指针：缺会话号或正文就不写')

  console.log(`\n${pass} 通过 · 0 失败`)
} finally {
  delete process.env.DSH_MEMORY_SESSIONS_DIR
  delete process.env.DSH_MEMORY_ORIGIN_CACHE
  await h.dispose()
}
