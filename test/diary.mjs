/**
 * diary.mjs —— 大肥鱼日记
 * 跑法：node test/diary.mjs
 *
 * 不联网：complete 用假函数。验证「收当天素材 → 写文件 → 不重复写」这条链。
 */
import assert from 'node:assert'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ensureDirs, loadScope, saveScope, addItem } from '../lib/store.js'
import { dayKey } from '../lib/beat/schedule.js'
import {
  collectDay, writeDiary, readDiary, listDiaries, addDays, normalizeDay, titleOf, diaryFile, diaryDir,
  weekRange, weekKeyOf, buildRollup, readRollup, listRollups, dueRollups, diaryWorthy, buildPrompt,
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

  // 日记只收生活/关系：工程事实、公共池、半句计划不进素材
  assert.equal(diaryWorthy({ kind: 'fact', text: '在 D:\\DSH 下跑 npm test 和 deploy' }, 'local'), false)
  assert.equal(diaryWorthy({ kind: 'fact', text: '爹今天笑得很开心' }, 'private'), true)
  assert.equal(diaryWorthy({ kind: 'relation', text: '爹很在意我及时回消息' }, 'private'), true)
  assert.equal(diaryWorthy({ kind: 'pref', text: '爹喜欢清爽的水彩画风' }, 'public'), false)
  assert.equal(diaryWorthy({ kind: 'event', text: '以后会不会越来越多' }, 'private'), false)
  const prompt = buildPrompt(today, [{ label: '私聊', items: [{ at: '10:00', text: '爹今天笑了', kind: 'pref' }] }])
  assert.ok(prompt[0].content.includes('不是工作总结'), 'prompt 要明确是生活日记')
  assert.ok(prompt[0].content.includes('最多一句带过'), '技术内容要压到一句')
  ok('生活过滤：技术/公共池/碎片不进日记，prompt 不是工作总结')

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

  // ---- 周 / 月 / 年索引 ----
  assert.deepEqual(weekRange('2026-11-04'), { from: '2026-11-02', to: '2026-11-08' }, '周三应当归到本周一')
  assert.equal(weekKeyOf('2026-11-04'), '2026-W45')
  assert.equal(weekKeyOf('2027-01-01'), '2026-W53', '跨年那周归 ISO 年')
  ok('ISO 周：范围和周号')

  await mkdir(diaryDir(root), { recursive: true })
  for (const [day, text] of [
    ['2026-11-02', '爹说要给我加一个写日记的功能。我嘴上说麻烦，其实想写。'],
    ['2026-11-03', '把省 token 的三条路又翻出来讲了一遍。他问得很细。'],
    ['2026-11-04', '今天没什么正事，就在数据海里飘着。'],
  ]) {
    await writeFile(diaryFile(root, day), `# ${day} · 星期X\n\n${text}\n`, 'utf8')
  }

  const weekJob = { kind: 'week', key: '2026-W45', from: '2026-11-02', to: '2026-11-08' }
  const w1 = await buildRollup(root, weekJob, {
    complete: async () => '- 11-02：开始想写日记\n- 11-03：聊了省 token\n- 11-04：没什么正事',
  })
  assert.equal(w1.ok, true)
  assert.equal(w1.by, 'llm')
  assert.equal(w1.lines, 3)
  const wr = await readRollup(root, 'week', '2026-W45')
  assert.ok(wr.ok)
  assert.ok(wr.text.includes('- 11-02：开始想写日记'))
  assert.equal(wr.meta.days, '3', 'frontmatter 记下这几天')
  assert.equal(wr.meta.kind, 'week')
  ok('周索引：生成、frontmatter、条目格式')

  // 同一批日记不再重写
  const w2 = await buildRollup(root, weekJob, { complete: async () => { throw new Error('不该再调模型') } })
  assert.equal(w2.skipped, 'fresh')
  ok('日日记没变就跳过')

  // 日记变了：模型乱写格式时退回规则版（每篇第一句）
  await writeFile(diaryFile(root, '2026-11-05'), '# 2026-11-05 · 星期X\n\n第五天补了一篇新的日记。\n', 'utf8')
  const w3 = await buildRollup(root, weekJob, { complete: async () => '我随便写两句，不带日期' })
  assert.equal(w3.ok, true)
  assert.equal(w3.by, 'rule')
  const wr2 = await readRollup(root, 'week', '2026-W45')
  assert.ok(wr2.text.includes('第五天补了一篇新的日记'), wr2.text)
  assert.equal(wr2.meta.days, '4')
  ok('日记变了会重收，模型不合格式走规则版')

  // 注入用的索引列表
  const rolls = await listRollups(root)
  assert.ok(rolls.some((r) => r.kind === 'week' && r.key === '2026-W45'), JSON.stringify(rolls))

  // 该收哪几本：结构要对，不能抛
  const due = dueRollups(new Date())
  assert.ok(due.length >= 2)
  assert.ok(due.every((j) => j.kind && j.key && j.from && j.to))
  ok('索引列表与到期检查')

  console.log(`\n${pass} 项通过`)
} finally {
  await rm(root, { recursive: true, force: true })
}
