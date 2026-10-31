/**
 * funnel.mjs —— 两级漏斗验收（阶段 4）
 *
 * 验的是文档第六章：
 *   · 只在副库字段上检索，不碰正文
 *   · 无命中不硬凑（单字兜底不算命中）
 *   · 一跳/二跳标签展开，0.7 衰减，候选 ≤2K
 *   · 过期条目不进候选
 *   · 权重/新近度参与重排
 */
import assert from 'node:assert'
import { emptyScope } from '../lib/store.js'
import { enrichItem } from '../lib/enrich.js'
import { extractConcepts, childrenOf } from '../lib/taxonomy.js'
import { searchFunnel, FUNNEL } from '../lib/funnel.js'

let pass = 0
const ok = (name) => { pass += 1; console.log('  ok', name) }

function item(id, text, { kind = 'fact', weight = 0.5, conf = 0.6, expiresAt = '', hits = 0, lastHit } = {}) {
  const it = enrichItem({
    id, text, kind, conf, hits, expiresAt,
    created: lastHit || '2026-10-01T00:00:00.000Z',
    lastHit: lastHit || '2026-10-01T00:00:00.000Z',
    state: 'active',
  })
  it.weight = weight
  return it
}

// 1. 词表上下位
assert.deepEqual(childrenOf('数学'), ['高数', '线代', '概率论'])
assert.ok(extractConcepts('数学那边怎样').some((c) => c.tag === '数学'))
ok('词表：数学的下位标签齐全')

const sc = emptyScope('private', '1')
sc.items = [
  item('m_math', '明天要交高数作业', { weight: 0.55 }),
  item('m_lin', '线性代数第三章还没复习', { weight: 0.54 }),
  item('m_rent', '周五要交房租', { weight: 0.5 }),
  item('m_cat', '猫粮快没了', { weight: 0.4 }),
]
sc.items[0].lastHit = '2026-10-30T00:00:00.000Z'
sc.items[1].lastHit = '2026-10-29T00:00:00.000Z'

// 2. 词法够不着，但标签能下钻
const off = searchFunnel([sc], { query: '数学那边怎样', hops: false })
const on = searchFunnel([sc], { query: '数学那边怎样', hops: true })
assert.equal(off.length, 0, JSON.stringify(off.map((x) => x.summary)))
assert.ok(on.length >= 2, JSON.stringify(on.map((x) => x.summary)))
assert.ok(on.some((x) => x.summary.includes('高数')) && on.some((x) => x.summary.includes('线性代数')), JSON.stringify(on))
assert.ok(on.every((x) => x.hop >= 1), JSON.stringify(on.map((x) => x.hop)))
ok('多跳：问「数学」能找到高数/线代，关掉就找不到')

// 3. 无关查询不硬凑
assert.equal(searchFunnel([sc], { query: '我车牌号多少' }).length, 0)
ok('无关查询返回空，不拿最近的记忆凑数')

// 4. 标签过滤
const tagged = searchFunnel([sc], { query: '', tags: ['高数'] })
assert.ok(tagged.length === 1 && tagged[0].summary.includes('高数'), JSON.stringify(tagged))
ok('标签过滤')

// 5. 过期条目剔除
sc.items.push(item('m_old', '过期的临时安排', { expiresAt: '2020-01-01' }))
assert.ok(!searchFunnel([sc], { query: '过期' }).some((x) => x.id === 'm_old'))
ok('过期条目不进候选')

// 6. 权重 / 新近度参与重排：同句话、权重不同
const sc2 = emptyScope('private', '2')
sc2.items = [
  item('m_hi', '用户喜欢冰美式', { weight: 0.9, lastHit: '2026-10-31T00:00:00.000Z' }),
  item('m_lo', '用户喜欢冰美式', { weight: 0.1, lastHit: '2026-10-31T00:00:00.000Z' }),
]
const w = searchFunnel([sc2], { query: '冰美式', hops: false })
assert.equal(w[0].id, 'm_hi', JSON.stringify(w.map((x) => [x.id, x.score])))
ok('重排：权重高的排前面')

// 7. 候选上限 ≤2K
const sc3 = emptyScope('private', '3')
for (let i = 0; i < 40; i += 1) {
  sc3.items.push(item(`m_${i}`, `数学作业第${i}题`, { weight: 0.5, lastHit: `2026-10-${String((i % 28) + 1).padStart(2, '0')}T00:00:00.000Z` }))
}
const many = searchFunnel([sc3], { query: '数学作业', hops: true, topK: 8 })
assert.ok(many.length <= Math.min(FUNNEL.maxCandidates, 16), String(many.length))
ok('候选上限：≤2K')

// 8. 正文不参与检索：摘要里没有的正文词，不该被命中
const sc4 = emptyScope('private', '4')
const deep = item('m_deep', '一句摘要')
deep.text = '一句摘要；正文里藏着蓝鲸协议四个字'
sc4.items = [deep]
assert.equal(searchFunnel([sc4], { query: '蓝鲸协议' }).length, 0)
ok('检索只看副库字段，不读正文')

console.log(`\n${pass} 通过 · 0 失败`)
