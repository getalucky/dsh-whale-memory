/**
 * itemstate.mjs —— 记忆条目存活判断
 *
 * 锁住 lib/itemstate.js 的默认集合和三个开关：
 * 默认把归档 / 被取代 / 待确认 / 过期当死，merged 只在显式要求时当死。
 * 各模块迁移到统一判断时，靠这些选项保留原来的不同语义。
 */
import assert from 'node:assert'

import { DEAD_STATES, DEAD_STATES_WITH_MERGED, isLive, isDead, liveItems, deadSet } from '../lib/itemstate.js'

let pass = 0
const ok = (name) => { pass += 1; console.log('  ok', name) }
const at = (state) => ({ id: 'm_' + state, state })

// ---- 基本状态 ----
assert.equal(isLive(null), false)
assert.equal(isLive(undefined), false)
assert.equal(isLive(at('active')), true)
assert.equal(isLive(at('warm')), true)
assert.equal(isLive(at('cold')), true)
for (const s of DEAD_STATES) assert.equal(isLive(at(s)), false, `${s} 默认应当是死的`)
ok('默认死状态')

// ---- 三个开关 ----
assert.equal(isLive(at('suggested'), { suggestedDead: false }), true)
assert.equal(isLive(at('expired'), { expiredDead: false }), true)
assert.equal(isLive(at('merged')), true, 'merged 默认不算死')
assert.equal(isLive(at('merged'), { mergedDead: true }), false)
assert.equal(isLive(at('archived'), { mergedDead: true, expiredDead: false, suggestedDead: false }), false, '归档不能被开关放活')
assert.equal(isLive(at('superseded'), { mergedDead: true, expiredDead: false, suggestedDead: false }), false, '被取代不能被开关放活')
ok('开关只影响对应状态')

// ---- 集合和过滤 ----
assert.deepEqual([...deadSet()].sort(), [...DEAD_STATES].sort())
assert.deepEqual([...DEAD_STATES_WITH_MERGED], [...DEAD_STATES, 'merged'])
const list = [at('active'), at('suggested'), at('expired'), at('merged'), at('archived')]
assert.deepEqual(liveItems(list).map((x) => x.state), ['active', 'merged'])
assert.deepEqual(liveItems({ items: list }).map((x) => x.state), ['active', 'merged'])
assert.deepEqual(liveItems(list, { mergedDead: true }).map((x) => x.state), ['active'])
assert.deepEqual(liveItems(list, { suggestedDead: false, expiredDead: false }).map((x) => x.state), ['active', 'suggested', 'expired', 'merged'])
assert.equal(isDead(at('archived')), true)
assert.equal(isDead(at('active')), false)
ok('集合与过滤')

console.log(`\n${pass} 通过`)
