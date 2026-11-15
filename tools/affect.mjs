#!/usr/bin/env node
/**
 * affect.mjs —— 情绪层 CLI（文档 14.10 / 14.11）
 *
 *   node tools/affect.mjs status
 *   node tools/affect.mjs why 委屈
 *   node tools/affect.mjs log [行数]
 *   node tools/affect.mjs reset --yes
 *
 * 只读三个命令；reset 会清状态和事件流水，必须显式 --yes。
 * 数值在 affect/state.json，想手改直接改文件，这里不开写口（14.9）。
 */

import { readFile, unlink } from 'node:fs/promises'

import { rootDir } from '../lib/store.js'
import { affectPaths, loadState, snapshot } from '../lib/affect/state.js'
import { bucketOf, stanceWord } from '../lib/affect/render.js'
import { EMOTIONS, EMOTION_NAMES, DEFAULT_TAU_HOURS } from '../lib/affect/lexicon.js'

const root = process.env.DSH_MEMORY_HOME || rootDir()
const args = process.argv.slice(2)
const cmd = args[0] || 'status'
const has = (x) => args.includes(x)

const WORDS = { 1: '轻', 2: '中', 3: '明显' }
const BUCKET_FLOOR = { 1: 0.1, 2: 0.35, 3: 0.65 }

function stamp(ts) {
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return ''
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 距离下一次降档还有多久（只按当前最大值估，够用了）。 */
function nextDrop(snap) {
  let best = Infinity
  for (const name of EMOTION_NAMES) {
    const v = snap.mood[name]
    const b = EMOTIONS[name].base || 0
    const bucket = bucketOf(v)
    if (!bucket) continue
    const floor = BUCKET_FLOOR[bucket]
    if (v <= b || b >= floor) continue
    const hours = DEFAULT_TAU_HOURS * Math.log2((v - b) / (floor - b))
    if (Number.isFinite(hours) && hours > 0) best = Math.min(best, hours)
  }
  if (!Number.isFinite(best)) return '—'
  const minutes = Math.round(best * 60)
  return minutes < 60 ? `约 ${minutes} 分钟后可能降档` : `约 ${(minutes / 60).toFixed(1)} 小时后可能降档`
}

async function readEvents(limit = 0) {
  let raw = ''
  try { raw = await readFile(affectPaths(root).events, 'utf8') } catch { return [] }
  const rows = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try { rows.push(JSON.parse(line)) } catch { /* 坏行跳过 */ }
  }
  return limit > 0 ? rows.slice(-limit) : rows
}

async function readPaint(limit = 0) {
  let raw = ''
  try { raw = await readFile(affectPaths(root).paint, 'utf8') } catch { return [] }
  const rows = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try { rows.push(JSON.parse(line)) } catch { /* 坏行跳过 */ }
  }
  return limit > 0 ? rows.slice(-limit) : rows
}

async function main() {
  if (cmd === 'status') {
    const snap = snapshot(await loadState(root), Date.now())
    const mood = EMOTION_NAMES
      .map((name) => ({ name, value: snap.mood[name], bucket: bucketOf(snap.mood[name]), lift: snap.mood[name] - (EMOTIONS[name].base || 0) }))
      .filter((x) => x.bucket > 0)
      .sort((a, b) => (b.lift - a.lift) || (b.value - a.value))
    const stances = Object.entries(snap.stance)
      .map(([peer, s]) => ({ peer, ...s }))
      .sort((a, b) => (b.at || 0) - (a.at || 0))
      .slice(0, 8)
    console.log(`记忆库：${root}`)
    if (!mood.length) console.log('心情：平静（只有底色）')
    else console.log(`心情：${mood.map((x) => `${x.name}（${WORDS[x.bucket]}，${x.value.toFixed(2)}）`).join(' · ')}`)
    console.log(`下次：${nextDrop(snap)}`)
    if (stances.length) {
      console.log('关系：')
      for (const s of stances) {
        console.log(`  ${s.peer} · 亲近 ${s.close.toFixed(2)} / 信任 ${s.trust.toFixed(2)} / 耐心 ${s.patience.toFixed(2)} · ${stamp(s.at)}`)
      }
    }
    console.log(`档位词：${stanceWord(snap, '')}`)
    return
  }

  if (cmd === 'why') {
    const name = String(args[1] || '').trim()
    if (!name || !EMOTIONS[name]) {
      console.log(`用法：node tools/affect.mjs why <分量>，可选：${EMOTION_NAMES.join(' / ')}`)
      return
    }
    const rows = (await readEvents()).filter((e) => e.kind === name).slice(-5).reverse()
    if (!rows.length) { console.log(`没有推动「${name}」的事件。`); return }
    for (const e of rows) {
      const ids = Array.isArray(e.evidenceIds) && e.evidenceIds.length ? ` · 证据 ${e.evidenceIds.join('、')}` : ''
      console.log(`${stamp(e.ts || Date.parse(e.at || ''))} · +${Number(e.i || 0).toFixed(2)} → ${Number(e.v || 0).toFixed(2)} · ${e.source || ''}${ids}`)
    }
    return
  }

  if (cmd === 'log') {
    const limit = Math.max(1, Math.min(200, Number(args[1]) || 30))
    // 优先给「档位变化」流水；还没重画过就退回事件流水。
    const paint = (await readPaint()).slice(-limit)
    if (paint.length) {
      for (const p of paint) console.log(`${stamp(Date.parse(p.at || ''))} · 重画 ${p.reason || ''} · ${p.sig || ''}`)
      return
    }
    const rows = (await readEvents()).slice(-limit)
    if (!rows.length) { console.log('还没有情绪事件。'); return }
    for (const e of rows) {
      console.log(`${stamp(e.ts || Date.parse(e.at || ''))} · ${e.kind} +${Number(e.i || 0).toFixed(2)} → ${Number(e.v || 0).toFixed(2)} · ${e.peer || ''}${e.source ? ` · ${e.source}` : ''}`)
    }
    return
  }

  if (cmd === 'reset') {
    if (!has('--yes')) {
      console.log('会清空 affect/state.json 和 affect/events.jsonl（记忆、人格、日记不动）。确认加 --yes。')
      return
    }
    await Promise.all([
      unlink(affectPaths(root).state).catch(() => {}),
      unlink(affectPaths(root).events).catch(() => {}),
      unlink(affectPaths(root).paint).catch(() => {}),
    ])
    console.log('情绪状态已回基线，事件流水已清空。')
    return
  }

  console.log('用法：status | why <分量> | log [行数] | reset --yes')
}

await main()
