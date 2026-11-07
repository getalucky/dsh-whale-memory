#!/usr/bin/env node
/**
 * beat.mjs —— 主动行为层 CLI
 *
 *   node tools/beat.mjs status
 *   node tools/beat.mjs why
 *   node tools/beat.mjs materials [--all] [--source=chat]
 *   node tools/beat.mjs tick [--send]     # 默认预演；--send 也要宿主 ctx 才能真投
 *   node tools/beat.mjs gc
 *   node tools/beat.mjs focus <分钟> | focus off
 *
 * 只读命令不碰 agent；tick 无宿主时只拉公共池、过闸门、打印素材包。
 * 配了「闲聊搜索」模型时，CLI 也能直接联网补素材（不需要宿主 agent）。
 */

import { rootDir } from '../lib/store.js'
import { loadConfig, ensureBeatDirs, saveConfig } from '../lib/beat/config.js'
import { loadState, runOnce } from '../lib/beat/index.js'
import { materialCounts, materialList } from '../lib/beat/material.js'
import { maintain } from '../lib/beat/maintain.js'
import { loadSessions } from '../lib/beat/session.js'
import { burnSensitive, sensitiveFiles, vaultInfo } from '../lib/secure/vault.js'
import { profileStatus, rebuildProfile } from '../lib/person/rebuild.js'
import { saveState } from '../lib/beat/index.js'
import { setConfigRoot } from '../lib/llm.js'

const root = process.env.DSH_MEMORY_HOME || rootDir()
setConfigRoot(root)
const args = process.argv.slice(2)
const cmd = args[0] || 'status'
const has = (x) => args.includes(x)
const kv = (x) => {
  const hit = args.find((a) => a.startsWith(`--${x}=`))
  return hit ? hit.slice(x.length + 3) : ''
}

async function main() {
  await ensureBeatDirs(root)
  const config = await loadConfig(root)

  if (cmd === 'init') {
    const c = await saveConfig(root, { enabled: true, dryRun: true })
    console.log(`已写 beat/config.json：enabled=${c.enabled} dryRun=${c.dryRun}。先跑 tick 预演，确认素材像人话再关 dryRun。`)
    return
  }

  if (cmd === 'status') {
    const state = await loadState(root)
    const counts = await materialCounts(root)
    const sessions = await loadSessions(root)
    console.log(`记忆库：${root}`)
    console.log(`beat：${config.enabled ? '开' : '关'} · ${config.dryRun ? '预演' : '可投递'} · 窗口 ${(config.windows || []).map((w) => `${w.start}-${w.end}`).join(' / ')}`)
    console.log(`素材：active ${counts.active}（chat ${counts.bySource.chat} / web ${counts.bySource.web} / public ${counts.bySource.public}）· 总 ${counts.total}`)
    console.log(`上次闸门：${state.lastGate || '—'}${state.lastGateAt ? ` · ${state.lastGateAt}` : ''}`)
    console.log(`上次跳：${state.lastTickAt || '—'}`)
    console.log(`专用会话：${sessions.sessionId ? sessions.sessionId.slice(0, 18) : '（还没建）'}`)
    const ps = await profileStatus(root)
    console.log(`画像：${ps.ok ? `i${ps.counts.interest || 0} / p${ps.counts.projects || 0} / c${ps.counts.comm || 0} · ${ps.hash}` : '（还没建）'}`)
    if (state.lastGateDetail && Object.keys(state.lastGateDetail).length) {
      console.log(`闸门细节：${JSON.stringify(state.lastGateDetail)}`)
    }
    return
  }

  if (cmd === 'why') {
    const state = await loadState(root)
    console.log(`上次闸门：${state.lastGate || '—'}${state.lastGateAt ? ` · ${state.lastGateAt}` : ''}`)
    console.log(`细节：${JSON.stringify(state.lastGateDetail || {})}`)
    return
  }

  if (cmd === 'materials') {
    const all = has('--all')
    const rows = await materialList(root, { state: all ? '' : 'active', source: kv('source'), limit: 50 })
    if (!rows.length) { console.log('没有素材。'); return }
    for (const it of rows) {
      console.log(`${it.id} · ${it.state} · ${it.source} · w=${Number(it.weight || 0).toFixed(2)} · used=${it.usedCount || 0} · ${it.text}`)
    }
    return
  }

  if (cmd === 'tick') {
    const r = await runOnce({ root, config, dryRun: !has('--send'), log: (x) => console.log(x) })
    console.log(JSON.stringify({
      gate: r.gate?.reason,
      material: r.material,
      wander: r.wander?.skipped || r.wander?.why || 'run',
      delivery: r.delivery?.dryRun ? 'dry' : r.delivery?.delivered ? 'sent' : r.delivery?.why || 'none',
    }, null, 2))
    if (has('--send')) console.log('CLI 没有宿主 ctx，--send 仍按预演处理；真正投递要在 DSH 进程里开 beat。')
    return
  }

  if (cmd === 'gc') {
    const r = await maintain(root, { config, log: (x) => console.log(x) })
    console.log(JSON.stringify(r, null, 2))
    return
  }

  if (cmd === 'profile') {
    if (args[1] === 'rebuild') {
      const p = await rebuildProfile(root, { log: (x) => console.log(x) })
      console.log(`画像已重建：${JSON.stringify(p.builtFrom)} · ${p.hash}`)
      return
    }
    console.log(JSON.stringify(await profileStatus(root), null, 2))
    return
  }

  if (cmd === 'burn') {
    const files = sensitiveFiles(root)
    if (!has('--yes')) {
      console.log('会删这些敏感文件（记忆与人格不动）：')
      for (const f of files) console.log('  ' + f)
      console.log('确认加 --yes；连密钥一起删加 --key。')
      return
    }
    const removed = await burnSensitive(root, { key: has('--key') })
    console.log(removed.length ? '已焚毁：' + removed.join('、') : '没有可删的敏感文件。')
    return
  }

  if (cmd === 'vault') {
    console.log(JSON.stringify(vaultInfo(root), null, 2))
    return
  }

  if (cmd === 'focus') {
    const v = args[1] || ''
    const state = await loadState(root)
    if (v === 'off' || v === '0') {
      state.focusUntil = ''
      await saveState(root, state)
      console.log('专注模式已关。')
      return
    }
    const min = Math.max(1, Math.min(1440, Number(v) || 0))
    if (!min) { console.log('用法：focus <1-1440 分钟> 或 focus off'); process.exitCode = 1; return }
    state.focusUntil = new Date(Date.now() + min * 60000).toISOString()
    await saveState(root, state)
    console.log(`专注模式到 ${state.focusUntil}。`)
    return
  }

  console.log('用法：init | status | why | materials [--all] [--source=chat] | tick [--send] | gc | profile [rebuild] | vault | burn [--yes] | focus <分钟|off>')
  process.exitCode = 1
}

main().catch((e) => {
  console.error(`失败：${String(e?.message ?? e)}`)
  process.exitCode = 1
})
