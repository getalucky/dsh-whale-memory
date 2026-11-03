/**
 * cleanup-20261102-fragments.mjs —— 清理 2026-11-02 规则蒸馏切出来的碎句
 *
 * 背景：promiseRe 原来在逗号处断句（`[^，。！？!?；;]`），群里一句「以后我在
 * 群里找人，就说杂口杂口」被腰斩成「以后我在群里找人」；一条消息里几个「以后」
 * 就切出几条。十五个条目里十条是同一句话的碎片。私聊还混进了把模型推理、
 * 注入列表当记忆的污染条目。
 *
 * 处理方式：
 *   1. 残句按 id 归档（走 archiveItem，正文进 archive/，能翻回来）
 *   2. 群里同一件事补一条完整的，别让信息真的丢了
 *   3. 重建图谱和画像
 *
 * 要求和 deploy 一样：DSH 必须关掉，否则和插件的写队列抢文件。
 *
 * 用法：node tools/cleanup-20261102-fragments.mjs [记忆库根目录]
 */
import { execFileSync } from 'node:child_process'

import {
  rootDir, ensureDirs, listScopes, saveScope, archiveItem, logLine, addItem,
} from '../lib/store.js'
import { buildGraph, saveGraph } from '../lib/graph.js'
import { buildProfile, buildMembers } from '../lib/profile.js'

/**
 * 要清理的两个分片，按实际数据填：群是「同一句话被切成碎片」的那个群，
 * 私聊是「模型推理 / 注入列表被当成用户消息收进来」的那个私聊。
 * 号码不进仓库，跑的时候现给：
 *   MEM_CLEAN_GROUP=group:xxx MEM_CLEAN_PRIVATE=private:xxx node tools/cleanup-20261102-fragments.mjs
 */
const 群碎 = process.env.MEM_CLEAN_GROUP || ''
const 私聊脏 = process.env.MEM_CLEAN_PRIVATE || ''
if (!群碎 || !私聊脏) {
  console.error('缺分片：先设 MEM_CLEAN_GROUP=group:xxx 和 MEM_CLEAN_PRIVATE=private:xxx 再跑。')
  process.exit(1)
}

/** key 是 scope 的目录名，值是要归档的条目 id → 原因 */
const 要归档 = {
  [群碎]: {
    m_mvyxhsib01: '与 ib02 重复，且缺「用什么当暗号」',
    m_mvyxhsib02: '缺后半句，由补写的完整条目代替',
    m_mvyxhsic03: '逗号处截断的残句',
    m_mvyxhsic05: '逗号处截断的残句',
    m_mvyxhsid06: '只有语气，没有事实',
    m_mvyxhsid07: '正文带「了。」前缀，由补写的完整条目代替',
    m_mvyxhsid08: '逗号处截断的残句',
    m_mvz6ou9n01: '「才能不烧心」是被切剩的半句',
    m_mvwads5e02: '「回头看一眼的」残句',
    m_mvwads5e03: '「回头的余地」残句',
  },
  [私聊脏]: {
    m_mvz9wn7d01: '「以后就出现个问题」残句',
    m_mvz9wn7e02: '模型 reasoning 被当成用户消息收进来了',
    m_mvz9wn7e03: '注入的记忆列表被当成用户消息收进来了',
    m_mvz9wn7f04: '画像摘要被当成用户消息收进来了',
  },
}

/** 归档之后补的完整条目 */
const 要补 = {
  [群碎]: [
    { text: '群里以后要 @ 人或者找人，就用「杂口杂口」当暗号', kind: 'fact', conf: 0.8 },
    { text: '有人欺负小鲸鱼米米，就喊他「杂种」，不喊杂口', kind: 'fact', conf: 0.8 },
  ],
}

const DSH在跑 = () => {
  try {
    const 出 = execFileSync('tasklist', ['/FI', 'IMAGENAME eq DeepSeek Harness.exe'], { encoding: 'utf8' })
    return 出.includes('DeepSeek Harness.exe')
  } catch {
    return false
  }
}

if (DSH在跑() && process.env.DSH_MEMORY_CLEANUP_FORCE !== '1') {
  console.error('\nDSH 正在运行。先把它完全退出，再跑这个脚本。')
  process.exit(1)
}

const root = process.argv[2] || process.env.DSH_MEMORY_HOME || rootDir()
await ensureDirs(root)

let 归档数 = 0
let 补写数 = 0
const 动过 = new Set()

for (const sc of await listScopes(root)) {
  const 表 = 要归档[sc.scope]
  if (!表) continue
  let 改了 = false

  for (const it of [...sc.items]) {
    if (!it || it.state === 'archived') continue
    const why = 表[it.id]
    if (!why) continue
    await archiveItem(root, sc, it, 'fragment-cleanup-20261102')
    sc.items = sc.items.filter((x) => x.id !== it.id)
    console.log(`归档  ${sc.scope}  ${it.id}  ${it.text}`)
    归档数 += 1
    改了 = true
  }

  for (const c of 要补[sc.scope] || []) {
    const it = addItem(sc, { ...c, source: 'session:cleanup-20261102', sourceQuote: '' })
    if (!it) continue
    console.log(`补写  ${sc.scope}  ${it.id}  ${it.text}`)
    补写数 += 1
    改了 = true
  }

  if (改了) {
    动过.add(sc.scope)
    // 先存一份，避免后面重建图谱时读到旧文件
    await saveScope(root, sc)
  }
}

if (动过.size) {
  const 全部分片 = await listScopes(root)
  const 新 = 全部分片.filter((s) => 动过.has(s.scope))
  const 旧 = 全部分片.filter((s) => !动过.has(s.scope))
  const g = buildGraph([...旧, ...新])
  for (const sc of 新) {
    sc.profile = buildProfile(sc, g)
    sc.members = buildMembers(sc)
    await saveScope(root, sc)
  }
  await saveGraph(root, g)
  await logLine(root, `cleanup 20261102 · 归档 ${归档数} · 补写 ${补写数} · 分片 ${动过.size}`).catch(() => {})
}

console.log(`\n完成：归档 ${归档数} 条，补写 ${补写数} 条。`)
if (!归档数 && !补写数) console.log('没有匹配的条目，可能已经清过了。')
