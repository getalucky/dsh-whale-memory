/**
 * bridge-adapter.js —— 桥接适配口子
 *
 * 记忆层不直接认识某个桥的配置文件和消息头，只向 adapter 要三样：
 *   configFile()       桥接配置路径；空 = 这个桥没有配置
 *   parseConfig(json)  → { bySession, owner }；坏数据抛错，由 source.js 定缓存状态
 *   splitSenders(text) → [{ nick, qq, text }]；一条用户消息拆成发言人段落
 *
 * QQ 桥是第一个实现（qq-bridge-config.json + `昵称（号码）：` 消息头）。
 * 接第二家桥时注册一个实现即可，source/ingest/distill 不用改；通用身份字段
 * （平台 + 不可变用户ID）等第二家真来了再定，现在不预设。
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

const SPEAKER_RE = /^([^\s（(]{1,24})[（(](\d{5,12})[)）]\s*[:：]\s*(.*)$/

function qqConfigFile() {
  if (process.env.DSH_QQ_BRIDGE_CONFIG) return process.env.DSH_QQ_BRIDGE_CONFIG
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(dshHome, 'qq-bridge-config.json')
}

/**
 * 拥有者身份与称呼。QQ 是身份（谁说话算拥有者），称呼只是显示名。
 * 跟桥接端的归一化保持同一套兜底：拥有者QQ → 第一条私聊绑定 → 老字段私聊QQ。
 */
function qqParseConfig(j) {
  const bindings = Array.isArray(j?.绑定) ? j.绑定 : []
  const bySession = new Map()
  for (const b of bindings) {
    const sid = String(b?.会话 ?? '').trim()
    if (!sid) continue
    const type = String(b?.类型 ?? '').trim()
    const num = String(b?.号码 ?? '').trim()
    const kind = type.includes('群') ? 'group' : 'private'
    bySession.set(sid, {
      kind,
      id: num,
      label: kind === 'group' ? `群 ${num}` : `私聊 ${num}`,
      addr: String(b?.称呼 ?? '').trim(),
      bridge: true,
    })
  }
  const privateRow = bindings.find((b) => String(b?.类型 ?? '').includes('私聊')) || null
  return {
    bySession,
    owner: {
      qq: String(j?.拥有者QQ ?? '').trim()
        || String(privateRow?.号码 ?? '').trim()
        || String(j?.私聊QQ ?? '').trim(),
      name: String(j?.拥有者称呼 ?? '').trim(),
    },
  }
}

/** 单行私聊 → 一条；群里多行 → 多段（各自带昵称和 QQ 号）。 */
function qqSplitSenders(text) {
  const lines = String(text ?? '').split('\n')
  const out = []
  let cur = null
  for (const line of lines) {
    const m = line.match(SPEAKER_RE)
    if (m) {
      cur = { nick: m[1].trim(), qq: m[2], text: m[3] }
      out.push(cur)
    } else if (cur) {
      cur.text = `${cur.text}\n${line}`
    } else {
      out.push({ nick: '', qq: '', text: line })
    }
  }
  return out
    .map((x) => ({ ...x, text: String(x.text ?? '').trim() }))
    .filter((x) => x.text)
}

export const qqBridgeAdapter = {
  id: 'qq',
  label: 'QQ 桥',
  configFile: qqConfigFile,
  parseConfig: qqParseConfig,
  splitSenders: qqSplitSenders,
}

let active = qqBridgeAdapter

/** 当前生效的 adapter。 */
export function bridgeAdapter() {
  return active
}

/** 注册一个 adapter，返回注销函数（只撤销自己）。 */
export function registerBridgeAdapter(adapter) {
  if (!adapter || typeof adapter.id !== 'string' || !adapter.id.trim()) {
    throw new Error('bridge adapter 需要 id')
  }
  if (typeof adapter.configFile !== 'function'
    || typeof adapter.parseConfig !== 'function'
    || typeof adapter.splitSenders !== 'function') {
    throw new Error(`bridge adapter ${adapter.id} 需要 configFile / parseConfig / splitSenders`)
  }
  const prev = active
  active = adapter
  return function unregister() {
    if (active === adapter) active = prev
  }
}
