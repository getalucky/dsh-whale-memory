/**
 * test/recall.mjs —— L2 检索自检
 *
 * 重点验：换说法能撞上、少打几个字能撞上、不相干的不硬凑。
 *   node test/recall.mjs
 */

import { tokens, rankItems, similarity } from '../lib/recall.js'

let pass = 0
let fail = 0
const t = (name, fn) => {
  try { fn(); pass += 1; console.log('  ok  ' + name) }
  catch (e) { fail += 1; console.log('  !!  ' + name + ' —— ' + String(e?.message ?? e)) }
}
const ok = (v, m) => { if (!v) throw new Error(m || '断言失败') }

const 库 = [
  { id: 'a', text: '老爹今天下午3点上班，明天8:30上班。' },
  { id: 'b', text: '老爹最喜欢吃烤鱼' },
  { id: 'c', text: '老爹住在杭州' },
  { id: 'd', text: '大肥鱼是鲸鱼' },
]

t('tokenize 切成 bigram', () => {
  ok(tokens('明天上班').includes('明天'), '丢了大 token')
  ok(tokens('明天上班').includes('天上'), '没切出跨词 bigram')
  ok(tokens('8:30 上班').includes('8'), '数字标点没清干净')
})

t('原句能撞上', () => {
  const r = rankItems('明天几点上班', 库)
  ok(r.length > 0, '一条都没召回')
  ok(r[0].item.id === 'a', '排第一的是 ' + r[0].item.id)
})

t('换说法也能撞上', () => {
  const r = rankItems('啥时候去上班', 库)
  ok(r.length > 0, '换个说法就找不着了')
  ok(r[0].item.id === 'a', '排第一的是 ' + r[0].item.id)
})

t('少打几个字能撞上', () => {
  const r = rankItems('烤鱼', 库)
  ok(r[0]?.item.id === 'b', '排第一的是 ' + r[0]?.item.id)
})

t('地点能撞上', () => {
  const r = rankItems('住哪儿', 库)
  ok(r.some((x) => x.item.id === 'c'), '没召回住址那条')
})

t('完全不相干的不要硬凑', () => {
  const r = rankItems('量子力学的波函数坍缩', 库)
  ok(r.length === 0 || r[0].score < 0.2, '硬凑出了 ' + r[0]?.score)
})

t('空 query 返回空', () => {
  ok(rankItems('', 库).length === 0, '空 query 不该有结果')
})

t('相似度：改标点/换称呼也算像', () => {
  ok(similarity('明天8:30上班', '明天8：30上班') > 0.8, '同义改写相似度太低')
  ok(similarity('明天上班', '今天下雨') < 0.35, '不相干的相似度太高')
})

console.log(`\n${pass} 通过 · ${fail} 失败`)
process.exit(fail ? 1 : 0)
