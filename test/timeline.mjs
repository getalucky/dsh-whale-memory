/**
 * timeline.mjs —— 最近三天时间线
 *
 * 验的是「碎片按说话时间归日」：
 *   · 今天 / 昨天 / 前天各归各的，四天前不出现
 *   · lastHit 被刷新到今天的旧事，仍按 observedAt 算昨天
 *   · 未来时间的条目不算「最近三天」
 *   · 提醒里已经点过名的条目不在时间线里重复
 *   · 时间线进速览，且不撑破预算
 */
import assert from 'node:assert'

import { addItem, emptyScope } from '../lib/store.js'
import { collectTimeline, renderSkeleton } from '../lib/skeleton.js'

let pass = 0
const ok = (name) => { pass += 1; console.log('  ok', name) }

const at = (days, h, m = 0) => {
  const d = new Date()
  d.setDate(d.getDate() - days)
  d.setHours(h, m, 0, 0)
  return d.toISOString()
}
const find = (lines, text) => lines.find((l) => l.includes(text)) || ''

// 用「今天 23:59」当基准：中午 12 点的样本在中午前跑测试时不能算未来。
const 今天末 = new Date()
今天末.setHours(23, 59, 0, 0)
const NOW = 今天末.getTime()

const scope = emptyScope('private', '9', '私聊 9')
addItem(scope, { text: '今天中午吃了面', kind: 'event', observedAt: at(0, 12) })
const moved = addItem(scope, { text: '昨天讨论了投递阈值', kind: 'event', observedAt: at(1, 9) })
moved.lastHit = at(0, 9)
addItem(scope, { text: '昨天把目录折叠了', kind: 'fact', observedAt: at(1, 20) })
addItem(scope, { text: '前天说记忆碎片前后串不起来', kind: 'event', observedAt: at(2, 10) })
addItem(scope, { text: '四天前换了键盘', kind: 'event', observedAt: at(4, 10) })
addItem(scope, { text: '明天去取快递', kind: 'event', observedAt: at(-1, 9) })

const tl = collectTimeline(scope, { now: NOW })
assert.ok(find(tl.lines, '中午吃了面').startsWith('- 今天'), tl.lines.join('\n'))
assert.ok(find(tl.lines, '目录折叠').startsWith('- 昨天'), tl.lines.join('\n'))
assert.ok(find(tl.lines, '碎片前后串不起来').startsWith('- 前天'), tl.lines.join('\n'))
assert.ok(!find(tl.lines, '换了键盘'), '四天前的事不该进时间线')
assert.ok(!find(tl.lines, '取快递'), '未来时间不算最近三天')
ok('按说话时间归到 今天 / 昨天 / 前天，四天前和未来不出现')

// lastHit 是今天，但这句话是昨天说的：必须还在昨天，不能漂到今天
assert.ok(find(tl.lines, '投递阈值').startsWith('- 昨天'), 'lastHit 不该把旧事顶到新的日期：' + find(tl.lines, '投递阈值'))
ok('lastHit 漂移不改归日')

// 提醒里已经有的条目，不在时间线重复
const dup = collectTimeline(scope, { now: NOW, exclude: new Set([moved.id]) })
assert.ok(!find(dup.lines, '投递阈值'))
ok('提醒里点过名的条目不在时间线重复')

// 群里带说话人
const grp = emptyScope('group', '1', '群 1')
addItem(grp, { text: '周末去钓鱼', kind: 'event', speaker: '陆小鱼', observedAt: at(1, 15) })
const gtl = collectTimeline(grp, { now: NOW })
assert.ok(find(gtl.lines, '钓鱼').includes('陆小鱼：'), gtl.lines.join('\n'))
ok('群时间线带说话人')

// 进速览且守预算
const sk = renderSkeleton(scope, { now: NOW, maxChars: 700 })
assert.ok(sk.includes('▸ 最近三天'), sk)
assert.ok(sk.length <= 700, `超预算：${sk.length}`)
ok('时间线进速览，且不撑破预算')

console.log(`\n${pass} 通过 · 0 失败`)
