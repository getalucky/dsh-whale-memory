/**
 * test/docs.mjs —— AGENT.md / USER.md 自检（文档 4.8）
 *   node test/docs.mjs
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  DOC_LIMIT, DOC_INJECT, addEntry, parseDoc, readDoc, loadDocs,
  recordOutcome, promoteMemory, selectEntries, renderDocsBlock, docPath,
} from '../lib/agentdoc.js'
import { ensureDirs, emptyScope, addItem, saveScope } from '../lib/store.js'
import { confirmItem } from '../lib/confirm.js'

let pass = 0
let fail = 0
const t = async (name, fn) => {
  try { await fn(); pass += 1; console.log('  ok  ' + name) }
  catch (e) { fail += 1; console.log('  !!  ' + name + ' —— ' + String(e?.message ?? e)) }
}
const ok = (v, m) => { if (!v) throw new Error(m || '断言失败') }

const root = await mkdtemp(join(tmpdir(), 'whale-docs-'))

await t('手写条目也能解析：类型 / 指针 / 元数据', () => {
  const es = parseDoc('# x\n## 坑\n- [坑] 当改完 lib 时：忘了 deploy → m_1（11-01|验2|败1）\n- 普通一行', 'agent')
  ok(es.length === 2, '条数 ' + es.length)
  ok(es[0].type === '坑' && es[0].ref === 'm_1' && es[0].at === '11-01', JSON.stringify(es[0]))
  ok(es[1].type === '坑', '无类型行应取所在小节')
})

await t('普通括号不当元数据吃掉', () => {
  const es = parseDoc('## 原则\n- 先跑测试（不是可选项）', 'agent')
  ok(es[0].text === '先跑测试（不是可选项）', es[0].text)
})

await t('加一条经验会落盘', async () => {
  const r = await addEntry(root, 'agent', { type: '原则', text: '结果验证重实证', ref: 'm_a' })
  ok(r.ok, r.why)
  const text = await readFile(docPath(root, 'agent'), 'utf8')
  ok(text.includes('结果验证重实证') && text.includes('m_a'), text)
})

await t('同一条不重复写', async () => {
  await addEntry(root, 'agent', { type: '原则', text: '结果验证重实证', ref: 'm_a' })
  const { entries } = await readDoc(root, 'agent')
  ok(entries.filter((e) => e.text === '结果验证重实证').length === 1, '重复了')
})

await t('偏好沉淀进 USER.md，教训沉淀进 AGENT.md', async () => {
  const now = new Date().toISOString()
  await promoteMemory(root, { id: 'm_p', kind: 'pref', state: 'active', text: '老爹最喜欢吃烤鱼' })
  await promoteMemory(root, {
    id: 'm_l', kind: 'lesson', state: 'active',
    text: '改完 lib 忘了 deploy', trigger: '当改完 lib 时', antiPattern: '先跑 deploy 再验收',
  })
  const docs = await loadDocs(root)
  ok(docs.user.entries.some((e) => e.ref === 'm_p' && e.text.includes('吃烤鱼')), JSON.stringify(docs.user.entries))
  ok(docs.agent.entries.some((e) => e.ref === 'm_l' && e.at && e.text.includes('先跑 deploy')), JSON.stringify(docs.agent.entries))
})

await t('待确认（suggested）不沉淀', async () => {
  const r = await promoteMemory(root, { id: 'm_s', kind: 'pref', state: 'suggested', text: '我喜欢熬夜' })
  ok(!r.ok, 'suggested 不该进画像')
})

await t('连续两次失败标待复核，并退出注入', async () => {
  const one = await recordOutcome(root, { ref: 'm_l', ok: false })
  ok(one.ok && !one.review, '第一次不该复核')
  const two = await recordOutcome(root, { ref: 'm_l', ok: false })
  ok(two.review === true, '第二次该复核')

  const docs = await loadDocs(root)
  const block = renderDocsBlock(docs, { keywords: ['deploy'] })
  ok(!block.includes('先跑 deploy'), '待复核条目还在注入：' + block)

  const three = await recordOutcome(root, { ref: 'm_l', ok: true })
  ok(three.review === false, '成功一次应恢复')
  const back = renderDocsBlock(await loadDocs(root), { keywords: ['deploy'] })
  ok(back.includes('先跑 deploy'), '恢复后应重新注入：' + back)
})

await t('容量门：两份文件都不超过 3000 字符', async () => {
  for (let i = 0; i < 90; i += 1) {
    await addEntry(root, 'user', { type: '偏好', text: `偏好条目 ${i} ${'很长的说明'.repeat(3)}`, ref: `m_c${i}` })
  }
  const text = await readFile(docPath(root, 'user'), 'utf8')
  ok(text.length <= DOC_LIMIT, `USER.md ${text.length} 字符`)
  const parsed = parseDoc(text, 'user')
  ok(parsed.length > 0 && parsed.length < 90, `应该丢老的，剩 ${parsed.length} 条`)
})

await t('selectEntries 优先挑相关条目', () => {
  const entries = [
    { type: '坑', text: 'deploy 之前先关 DSH', ref: 'm_1', at: '11-01' },
    { type: '坑', text: '画图用深色背景', ref: 'm_2', at: '11-01' },
    { type: '坑', text: '待复核的不注入', ref: 'm_3', at: '11-01', review: true },
  ]
  const picked = selectEntries(entries, { keywords: ['deploy'], max: 1 })
  ok(picked.length === 1 && picked[0].includes('deploy'), JSON.stringify(picked))
})

await t('注入块有硬预算', () => {
  const many = Array.from({ length: 20 }, (_, i) => ({ type: '原则', text: `第${i}条 ${'经验'.repeat(40)}`, ref: `m_${i}`, at: '11-01' }))
  const block = renderDocsBlock({ agent: { entries: many }, user: { entries: many } }, { keywords: ['经验'] })
  ok(block.length <= DOC_INJECT.maxChars, `注入 ${block.length} 字符`)
})

await t('确认闸门转正后自动沉淀', async () => {
  await ensureDirs(root)
  const sc = emptyScope('private', '42', '用户 42')
  await saveScope(root, sc)
  const it = addItem(sc, { text: '我喜欢喝乌龙茶', kind: 'pref', state: 'suggested', conf: 0.5 })
  await saveScope(root, sc)
  const r = await confirmItem(root, 'private', '42', it.id)
  ok(r.ok, r.why)
  const text = await readFile(docPath(root, 'user'), 'utf8')
  ok(text.includes('喝乌龙茶') && text.includes(it.id), text)
})

await rm(root, { recursive: true, force: true }).catch(() => {})

console.log(`\n${pass} 通过 · ${fail} 失败`)
process.exit(fail ? 1 : 0)
