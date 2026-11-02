/**
 * watermark.mjs —— 蒸馏的水位断点（文档 5.1 第 5 条 / 阶段 9）
 *
 * 蒸馏是「先读 staging → 调 LLM（可能 8 秒）→ 最后清」。旧版直接清空整个文件，
 * 这 8 秒里新进来的消息会被一起抹掉。现在改成按内容前缀消费：
 *   · 读了多少行，只划掉多少行，后追加的留着
 *   · 同一批行被第二次消费时不再动（避免把新消息当成旧的划掉）
 *   · 落盘失败重跑时，靠 addItem 的合并去重，不产生重复条目
 */
import assert from 'node:assert'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { createHarness } from './eval/harness.mjs'
import { readStagingLines, consumeStaging } from '../lib/ingest.js'
import { distillSession } from '../lib/distill.js'
import { paths } from '../lib/store.js'

let pass = 0
const ok = (name) => { pass += 1; console.log('  ok', name) }

const c = { id: 'w1', turns: ['记住，我下周三出差', '今天好热', '记住，我对花生过敏'] }
const h = await createHarness([c])

try {
  const sid = h.src.get('w1').sid
  const file = join(paths(h.root).staging, `${sid}.jsonl`)

  await h.feed(c)
  const first = await readStagingLines(h.root, sid)
  assert.equal(first.length, 3)
  ok('三条消息进了 staging')

  // 模拟蒸馏正在调 LLM 时，又进来两条
  const later = [
    { at: new Date().toISOString(), role: 'user', text: '记住，我的工位在 A3 区' },
    { at: new Date().toISOString(), role: 'user', text: '记住，周五下午开会' },
  ]
  await writeFile(file, [...first, ...later.map((x) => JSON.stringify(x))].join('\n') + '\n', 'utf8')

  // 这一轮只消费读过的 3 行
  const cut = await consumeStaging(h.root, sid, first)
  assert.equal(cut, 3)
  const left = await readStagingLines(h.root, sid)
  assert.equal(left.length, 2, `应该只剩后追加的两条，实际 ${left.length}`)
  assert.ok(left[0].includes('A3'), left[0])
  ok('只划掉读过的前缀，中途进来的消息保住')

  // 同一批行再消费一次：前缀已经不匹配，什么都不划
  const again = await consumeStaging(h.root, sid, first)
  assert.equal(again, 0)
  assert.equal((await readStagingLines(h.root, sid)).length, 2)
  ok('重复消费不会误吃新消息')

  // 剩下的两条正常蒸馏：进库、staging 清空
  const d = await distillSession(h.root, sid, { log: () => {} })
  assert.equal(d.ok, true, JSON.stringify(d))
  assert.equal(d.consumed, 2)
  assert.equal((await readStagingLines(h.root, sid)).length, 0)
  const sc = await h.scopeOf('w1')
  const texts = sc.items.map((x) => x.text).join(' | ')
  assert.ok(texts.includes('A3'), texts)
  assert.ok(texts.includes('开会'), texts)
  ok('剩下的消息下一轮正常蒸馏')

  // 模拟「写完库、还没来得及消费水位就崩了」：同样两条再跑一遍
  await writeFile(file, left.join('\n') + '\n', 'utf8')
  const retry = await distillSession(h.root, sid, { log: () => {} })
  assert.equal(retry.ok, true, JSON.stringify(retry))
  assert.equal(retry.added, 0, `重跑不该新增，实际 +${retry.added}`)
  assert.ok(retry.merged >= 1, '重跑应该走合并')
  assert.equal((await h.scopeOf('w1')).items.length, sc.items.length)
  ok('落盘后崩溃重跑：合并去重，不重复记')

  console.log(`\n全部通过：${pass} 项`)
} catch (e) {
  console.error('\n失败：', e)
  process.exitCode = 1
} finally {
  await h.dispose()
}
