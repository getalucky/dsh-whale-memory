/**
 * kinds.mjs —— 记忆类型扩展（文档 4.9）
 *
 * 验的是三类特殊记忆的硬约束：
 *   · lesson     缺 trigger / trigger 不是「当……时」/ 缺 anti_pattern → 拒写
 *   · topic      同一目标句重复写入只改状态与 last_touched，不分裂成两条
 *   · commitment 到期检查在会话首轮做一次：逾期 / 今天到期 / 一周内会提醒，远期不打扰
 *   · suggested  待确认的承诺不进首轮提醒
 *   · 主库/检索/read_memory 都带得上扩展字段，不能只活在内存里
 */
import assert from 'node:assert'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { registerTools } from '../lib/tools.js'
import { createHarness } from './eval/harness.mjs'
import { renderSkeleton } from '../lib/skeleton.js'
import { vaultPaths, loadVault } from '../lib/vault.js'

let pass = 0
const ok = (name) => { pass += 1; console.log('  ok', name) }

/** 本地日期偏移，和 dueState 的日界一致。 */
const day = (offset) => {
  const d = new Date()
  d.setDate(d.getDate() + offset)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** 只取首轮提醒那一段：目录骨架里也会出现条目摘要，不能拿来判断「有没有提醒」。 */
const reminderOf = (skeleton) => {
  const m = /【提醒 · 会话开头先看】\n([\s\S]*?)(?=\n▸ |\n查具体内容|$)/.exec(skeleton)
  return m ? m[1] : ''
}

const h = await createHarness([{ id: 'k1', turns: ['我在改记忆插件，先记一下进度'] }])
const tools = new Map()
try {
  registerTools({ tools: { register(spec) { tools.set(spec.name, spec); return () => {} } } }, { root: h.root, log: () => {} })
  assert.ok(tools.has('memory_update'), [...tools.keys()].join(','))

  const src = h.src.get('k1')
  const p = vaultPaths(h.root, src.kind, src.id)
  await h.feed({ id: 'k1', turns: ['我在改记忆插件，先记一下进度'] })

  // 1. 教训的必填字段
  const save = (args) => tools.get('memory_save').execute(args)
  const noTrigger = await save({
    text: '改完 lib 要跑 deploy 再重启',
    kind: 'lesson',
    anti_pattern: '改完直接重启 DSH',
    source_quote: '记住，改完 lib 一定要跑 deploy 再重启',
  })
  assert.equal(noTrigger.ok, false)
  assert.ok(/trigger/.test(noTrigger.why), noTrigger.why)

  const badTrigger = await save({
    text: '改完 lib 要跑 deploy 再重启',
    kind: 'lesson',
    trigger: '改完 lib 之后',
    anti_pattern: '改完直接重启 DSH',
    source_quote: '记住，改完 lib 一定要跑 deploy 再重启',
  })
  assert.equal(badTrigger.ok, false)
  assert.ok(/当……时/.test(badTrigger.why), badTrigger.why)

  const noAnti = await save({
    text: '改完 lib 要跑 deploy 再重启',
    kind: 'lesson',
    trigger: '当改完 lib/ 目录时',
    source_quote: '记住，改完 lib 一定要跑 deploy 再重启',
  })
  assert.equal(noAnti.ok, false)
  assert.ok(/anti_pattern/.test(noAnti.why), noAnti.why)
  ok('lesson：缺 trigger / 句式不对 / 缺 anti_pattern 都拒写')

  // 2. 正常写入 + 落主库 + 带父标签
  const les = await save({
    text: '改完 lib 要跑 deploy 再重启 DSH',
    kind: 'lesson',
    trigger: '当改完 lib/ 目录时',
    anti_pattern: '改完直接重启 DSH',
    source_quote: '记住，改完 lib 一定要跑 deploy 再重启 DSH',
  })
  assert.ok(les.ok && les.status === 'active', JSON.stringify(les))
  let sc = await h.scopeOf('k1')
  const lesson = sc.items.find((x) => x.id === les.id)
  assert.equal(lesson.kind, 'lesson')
  assert.equal(lesson.trigger, '当改完 lib/ 目录时')
  assert.equal(lesson.antiPattern, '改完直接重启 DSH')
  assert.ok((lesson.parentTags || []).includes('教训'), JSON.stringify(lesson.parentTags))

  const md = await readFile(join(p.full, les.id + '.md'), 'utf8')
  assert.ok(md.includes('trigger: 当改完 lib/ 目录时'), md.slice(0, 400))
  assert.ok(md.includes('anti_pattern: 改完直接重启 DSH'))
  assert.ok(md.includes('## 要点'), '主库正文里要能直接看到触发条件')

  // 从磁盘强制重读：字段必须能原样解析回来，不能只活在内存里
  const reloaded = await loadVault(h.root, src.kind, src.id, { force: true })
  const reLesson = reloaded.items.find((x) => x.id === les.id)
  assert.equal(reLesson.trigger, '当改完 lib/ 目录时')
  assert.equal(reLesson.antiPattern, '改完直接重启 DSH')
  ok('lesson：字段进主库 frontmatter 和「要点」，重读能还原')

  // 3. read_memory 默认能读到「要点」，不是只给摘要
  const read = await tools.get('read_memory').execute({ id: les.id })
  assert.ok(read.ok && read.text.includes('触发：'), read.text)
  ok('read_memory 默认带「要点」')

  // 4. 话题：同一目标句只更新，不新建
  const t1 = await save({
    text: '在修记忆插件的 4.9 类型扩展',
    kind: 'topic',
    goal: '把教训/话题/承诺三类记忆补齐',
    source_quote: '记住，我们正在做记忆插件的 4.9',
  })
  assert.ok(t1.ok && t1.status === 'active', JSON.stringify(t1))

  const t2 = await save({
    text: '记忆插件 4.9 又推进了一步',
    kind: 'topic',
    goal: '把教训/话题/承诺三类记忆补齐',
    source_quote: '记忆插件 4.9 又推进了一步',
  })
  assert.ok(t2.ok, JSON.stringify(t2))
  assert.equal(t2.id, t1.id, '同一目标句不该新建条目')
  assert.equal(t2.status, 'merged', JSON.stringify(t2))
  sc = await h.scopeOf('k1')
  assert.equal(sc.items.filter((x) => x.kind === 'topic').length, 1, '话题分裂了')
  assert.ok(reminderOf(renderSkeleton(sc)).includes('把教训/话题/承诺三类记忆补齐'), renderSkeleton(sc))
  ok('topic：同一目标句合并，只改状态与 last_touched')

  // 5. 话题收尾：memory_update 只改进展，不新建
  const before = (await h.scopeOf('k1')).items.length
  const upd = await tools.get('memory_update').execute({ id: t1.id, status: '已完成' })
  assert.ok(upd.ok, JSON.stringify(upd))
  sc = await h.scopeOf('k1')
  assert.equal(sc.items.length, before, 'memory_update 不该新建条目')
  const topic = sc.items.find((x) => x.id === t1.id)
  assert.equal(topic.progress, 'done')
  assert.ok(topic.lastTouched, 'last_touched 必须落下来')
  assert.equal((await loadVault(h.root, src.kind, src.id, { force: true })).items.find((x) => x.id === t1.id).progress, 'done')
  assert.ok(!reminderOf(renderSkeleton(sc)).includes('把教训/话题/承诺三类记忆补齐'), '已完成的话题不该再进首轮提醒')

  // 没给状态就又提了一句：不能把已完成的话题重新点亮
  const again = await save({
    text: '记忆插件 4.9 收尾了，回头再看看',
    kind: 'topic',
    goal: '把教训/话题/承诺三类记忆补齐',
    source_quote: '记忆插件 4.9 收尾了，回头再看看',
  })
  assert.equal(again.id, t1.id, JSON.stringify(again))
  assert.equal((await h.scopeOf('k1')).items.find((x) => x.id === t1.id).progress, 'done',
    '没给状态不该把已完成的话题改回进行中')
  ok('memory_update：话题标记完成，不再进提醒')

  // 6. 承诺到期：今天 / 逾期 / 远期
  const today = await save({
    text: '给老爹交这周的周报',
    kind: 'commitment',
    due: day(0),
    to_whom: '老爹',
    source_quote: '记住，今天得把周报交了',
  })
  assert.ok(today.ok, JSON.stringify(today))
  sc = await h.scopeOf('k1')
  let sk = renderSkeleton(sc)
  assert.ok(reminderOf(sk).includes('今天到期'), sk)
  assert.ok(reminderOf(sk).includes('周报'), sk)

  const late = await save({
    text: '给群里发这周的更新',
    kind: 'commitment',
    due: day(-2),
    to_whom: '群里',
    source_quote: '记住，上周就该发的更新拖到现在',
  })
  assert.ok(late.ok, JSON.stringify(late))
  sk = renderSkeleton(await h.scopeOf('k1'))
  assert.ok(reminderOf(sk).includes('逾期 2 天'), sk)

  const far = await save({
    text: '年底前把旧库迁完',
    kind: 'commitment',
    due: '2099-01-01',
    to_whom: '自己',
    source_quote: '记住，年底前把旧库迁完',
  })
  assert.ok(far.ok, JSON.stringify(far))
  sk = renderSkeleton(await h.scopeOf('k1'))
  assert.ok(!reminderOf(sk).includes('旧库迁完'), '远期承诺不该天天提醒')
  ok('commitment：今天到期 / 逾期会提醒，远期不打扰')

  // 7. 条件型承诺算不出日期，但照样列出来
  const badDue = await save({
    text: '年底前把旧库迁完',
    kind: 'commitment',
    due: '月底',
    to_whom: '自己',
    source_quote: '记住，月底前要把旧库迁完',
  })
  assert.equal(badDue.ok, false)
  assert.ok(/due 认不出来/.test(badDue.why), badDue.why)

  const cond = await save({
    text: '下次部署前提醒跑 verify',
    kind: 'commitment',
    due: '下次提到部署时',
    to_whom: '你',
    source_quote: '记住，下次提到部署的时候提醒我跑 verify',
  })
  assert.ok(cond.ok, JSON.stringify(cond))
  sk = renderSkeleton(await h.scopeOf('k1'))
  assert.ok(reminderOf(sk).includes('条件：下次提到部署时'), sk)
  ok('commitment：条件型（下次提到 X 时）进提醒')

  // 8. 待确认的承诺不进首轮提醒
  const guess = await save({
    text: '下周给老爹买鱼竿',
    kind: 'commitment',
    due: day(3),
    to_whom: '老爹',
    source_quote: '下周给他买鱼竿吧',
  })
  assert.equal(guess.status, 'suggested', JSON.stringify(guess))
  assert.ok(!reminderOf(renderSkeleton(await h.scopeOf('k1'))).includes('鱼竿'), '待确认不该进提醒')
  ok('suggested 承诺不进首轮提醒')

  // 9. 检索结果带类型，模型能一眼分出教训
  const s = await tools.get('search_memory').execute({ query: 'deploy' })
  assert.ok(s.ok && s.count >= 1, JSON.stringify(s))
  const hit = s.results.find((x) => x.id === les.id)
  assert.ok(hit, JSON.stringify(s.results))
  assert.equal(hit.kind, 'lesson')
  assert.ok(s.text.includes('[教训]'), s.text)
  ok('search_memory：结果带 kind，行首标类型')

  console.log(`\n${pass} 通过 · 0 失败`)
} finally {
  await h.dispose()
}
