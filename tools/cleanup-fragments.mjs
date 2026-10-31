/**
 * cleanup-fragments.mjs —— 一次性清理规则蒸馏早期产出的残句
 *
 * 只动 2026-10-31 之前生成的那几条，按「ID + 原文」双重匹配：
 *   残句「回头看一眼的」「回头的余地」「名字叫你肉肉好吗」「明天要累细细道来」
 *   噪音「明天要累一点」
 *   重复「明天也是8:30上班」（它把带日期的那条顶成了 superseded）
 * 同时把被顶掉的「老爹11月1日（明天）也是8:30上班」恢复成 active。
 *
 * 所有删除都走 archiveItem，正文进 archive/，随时能翻回来。
 * 要求 DSH 关闭：运行中改分片会和插件的写队列抢文件。
 *
 * 用法：node tools/cleanup-fragments.mjs [记忆库根目录]
 *       不传根目录就用 $DSH_MEMORY_HOME 或默认路径。
 */
import { execFileSync } from 'node:child_process'

import {
  rootDir, ensureDirs, listScopes, saveScope, archiveItem, auditWrite, logLine, normalizeText,
} from '../lib/store.js'
import { buildGraph, saveGraph } from '../lib/graph.js'
import { buildProfile, buildMembers } from '../lib/profile.js'

const 要归档 = [
  '名字叫你肉肉好吗',
  '明天要累细细道来',
  '明天要累一点',
  '明天也是8:30上班',
  '回头看一眼的',
  '回头的余地',
]

const 要恢复 = {
  id: 'm_mvwi70si01',
  text: '老爹11月1日（明天）也是8:30上班',
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

const 目标 = new Set(要归档.map(normalizeText))
const 动过的 = []
let 归档数 = 0
let 恢复数 = 0

for (const sc of await listScopes(root)) {
  let 改了 = false

  for (const it of [...sc.items]) {
    if (!it || it.state === 'archived') continue
    if (!目标.has(normalizeText(it.text))) continue
    await archiveItem(root, sc, it, 'fragment-cleanup')
    await auditWrite(root, {
      kind: 'cleanup', scope: sc.scope, item: it.id, text: String(it.text).slice(0, 120), why: 'fragment',
    })
    sc.items = sc.items.filter((x) => x.id !== it.id)
    console.log(`归档  ${sc.scope}  ${it.text}`)
    归档数 += 1
    改了 = true
  }

  const r = sc.items.find((x) => x.id === 要恢复.id)
  if (r && (r.state === 'superseded' || r.state === 'archived' || r.validTo)) {
    r.state = 'active'
    r.validTo = ''
    r.supersededBy = ''
    r.lastHit = new Date().toISOString()
    console.log(`恢复  ${sc.scope}  ${r.text}`)
    恢复数 += 1
    改了 = true
  }

  if (改了) 动过的.push(sc)
}

if (动过的.length) {
  // 图谱和画像都按「改完的分片 + 其余分片」重建
  const 全部分片 = await listScopes(root)
  const 改过 = new Set(动过的.map((s) => s.scope))
  const 合并 = [...全部分片.filter((s) => !改过.has(s.scope)), ...动过的]
  const g = buildGraph(合并)
  for (const sc of 动过的) {
    sc.profile = buildProfile(sc, g)
    sc.members = buildMembers(sc)
    await saveScope(root, sc)
  }
  await saveGraph(root, g)
  await logLine(root, `cleanup fragments · 归档 ${归档数} · 恢复 ${恢复数} · 分片 ${动过的.length}`).catch(() => {})
}

console.log(`\n完成：归档 ${归档数} 条，恢复 ${恢复数} 条。`)
if (!归档数 && !恢复数) console.log('线上数据里没有匹配的条目，可能已经清过了。')
