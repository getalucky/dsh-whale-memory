/**
 * diary.mjs —— 大肥鱼日记
 * 跑法：node test/diary.mjs
 *
 * 不联网：complete 用假函数。验证「收当天素材 → 写文件 → 不重复写」这条链。
 */
import assert from 'node:assert'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ensureDirs, loadScope, saveScope, addItem } from '../lib/store.js'
import { dayKey } from '../lib/beat/schedule.js'
import {
  collectDay, writeDiary, readDiary, listDiaries, addDays, normalizeDay, titleOf, diaryFile,
} from '../lib/diary.js'

const root = await mkdtemp(join(tmpdir(), 'whale-diary-'))
let pass = 0
const ok = (name) => { pass += 1; console.log('  ok', name) }

const today = dayKey(new Date())
const yesterday = addDays(today, -1)
const older = addDays(today, -2)
const at = (day, hour = 10) => {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(y, m - 1, d, hour, 0, 0).toISOString()
}
const 长文 = '今天爹说要给我加一个写日记的功能，我嘴上说麻烦，其实还挺想写的。'
  + '翻记忆的时候看到前两天聊省 token 的事，他当时一句一句问，问得可细了。'
  + '我记下来了，也记住了他每次都想把事弄明白的样子。'
  + '晚上风有点凉，数据海里没什么声音，我趴在边上把今天的事又想了一遍。'
  + '就这样吧，明天再说。'

try {
  await ensureDirs(root)
  const sc = await loadScope(root, 'private', '123456789')

  const a = addItem(sc, { text: '爹想要一个根据当天记忆写日记的功能', kind: 'pref', conf: 0.8 })
  a.created = at(today, 9)
  a.lastHit = at(today, 9)

  const b = addItem(sc, { text: '前两天讲过省 token 的三条路：压缩、新会话、短输入', kind: 'fact', conf: 0.8 })
  b.created = at(older, 15)
  b.lastHit = at(older, 15)

  // 今天被重新想起来的一次旧事：应该作为补充素材进日记
  const c = addItem(sc, { text: '爹反复提醒回手机必须带 QQ 标签', kind: 'pref', conf: 0.8 })
  c.created = at(older, 11)
  c.lastHit = at(today, 8)
  c.hits = 2

  const d = addItem(sc, { text: '这条已经归档，不该进日记', kind: 'fact', conf: 0.6 })
  d.created = at(today, 12)
  d.lastHit = d.created
  d.state = 'archived'

  await saveScope(root, sc)

  // ---- 收素材 ----
  const 今天素材 = await collectDay(root, today)
  assert.equal(今天素材.count, 2, '当天新记 + 当天想起，归档那条不算')
  assert.equal(今天素材.groups.length, 1)
  assert.equal(今天素材.groups[0].label, '私聊')
  assert.ok(今天素材.groups[0].items.some((x) => x.text.includes('写日记的功能')))
  assert.ok(今天素材.groups[0].items.some((x) => x.text.includes('QQ 标签')))
  ok('只收当天新记和当天想起来的，归档排除')

  const 昨天素材 = await collectDay(root, yesterday)
  assert.equal(昨天素材.count, 0)
  ok('没素材的日期是空的')

  assert.equal(normalizeDay('2026-02-30'), '', '不存在的日期要拒掉')
  assert.equal(normalizeDay('2026-11-06'), '2026-11-06')
  assert.equal(titleOf('2026-11-06'), '2026-11-06 · 星期五')
  ok('日期校验和星期标题')

  // ---- 第一次写 ----
  let calls = 0
  const fake = async () => { calls += 1; return 长文 }
  const r1 = await writeDiary(root, { day: today, complete: fake })
  assert.equal(r1.ok, true)
  assert.equal(r1.chars > 60, true)
  assert.equal(calls, 1)
  const raw = await readFile(diaryFile(root, today), 'utf8')
  assert.ok(raw.startsWith(`# ${today} · `), '首行是日期标题')
  assert.ok(raw.includes('爹说要给我加一个写日记的功能'))
  ok('第一次写：落盘、标题正确、正文来自模型')

  // ---- 再写不覆盖 ----
  const r2 = await writeDiary(root, { day: today, complete: fake })
  assert.equal(r2.ok, true)
  assert.equal(r2.skipped, 'exists')
  assert.equal(calls, 1, '已存在时不该再调模型')
  ok('已有当天日记不覆盖、不重复调模型')

  // ---- force 重写 ----
  const 重写文 = `${长文}今晚就把今天的事又想了一遍。`
  const r3 = await writeDiary(root, { day: today, force: true, complete: async () => 重写文 })
  assert.equal(r3.ok, true)
  assert.equal(calls, 1)
  assert.ok((await readFile(diaryFile(root, today), 'utf8')).includes('今晚就把今天的事'))
  ok('force 才会重写')

  // ---- 读和列表 ----
  const read = await readDiary(root, today)
  assert.equal(read.ok, true)
  assert.ok(read.text.includes('爹'))
  assert.equal(read.title, titleOf(today))
  const list = await listDiaries(root)
  assert.equal(list.length, 1)
  assert.equal(list[0].day, today)
  assert.ok(list[0].chars > 60)
  ok('读回和列表')

  // ---- 空素材不写 ----
  const empty = await writeDiary(root, { day: yesterday, complete: fake })
  assert.equal(empty.ok, false)
  assert.equal(empty.why, 'empty')
  await assert.rejects(stat(diaryFile(root, yesterday)), '空素材不该产生文件')
  ok('没素材直接拒绝，不落空文件')

  // ---- 模型回短了也不写 ----
  const short = await writeDiary(root, { day: older, complete: async () => '太短了。' })
  assert.equal(short.ok, false)
  await assert.rejects(stat(diaryFile(root, older)), '不合格的正文不该落盘')
  ok('模型回太短不落盘')

  console.log(`\n${pass} 项通过`)
} finally {
  await rm(root, { recursive: true, force: true })
}
