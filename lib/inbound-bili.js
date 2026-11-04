/**
 * inbound-bili.js —— B站鱼塘账本的适配器（inbound.js 的一个 provider）
 *
 * 历史：这套同步原来直接写在 inbound.js 里，路径、字段名、目标分片全写死。
 * 现在只留「怎么把 B站的一行翻译成通用条目」，其余的读取/水位/去重/落盘
 * 全交给 inbound.js。新插件照这个文件再写一份即可，不用碰引擎。
 *
 * bili-pond 跑在 headless profile 里，不装本插件，所以只能拉、不能推：
 * 它照旧写 $DSH_HOME/bili-duty/memory.jsonl，本插件按字节水位读新增行。
 *
 * 关闭：DSH_MEMORY_BILI_SYNC=off / 0 / false。
 * 账本位置：BILI_DUTY_HOME（优先）→ DSH_HOME/bili-duty。
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

export const SOURCE = 'bili-duty'
// B站观察是网上学到的公开内容，进公共池：群聊、私聊都能读，但只有本机能写
export const TARGET = { kind: 'public', id: 'web' }

function dshHome() {
  return String(process.env.DSH_HOME || join(homedir(), '.dsh')).replace(/\\/g, '/').replace(/\/+$/, '')
}

/** B站账本。bili-pond 用 BILI_DUTY_HOME 指向它的数据目录，优先认这个。 */
export function ledgerFile() {
  const home = String(process.env.BILI_DUTY_HOME || '').trim() || join(dshHome(), 'bili-duty')
  return join(home, 'memory.jsonl')
}

/** 水位 + 已见正文 hash。文件名保持旧值，升级后不会从头再读一遍。 */
export function stateFile(root) {
  return join(root, 'inbox', `${SOURCE}.json`)
}

/** 默认开；开关只关这一路，不影响别的 provider。 */
function enabled() {
  const v = String(process.env.DSH_MEMORY_BILI_SYNC ?? 'on').toLowerCase()
  return !(v === 'off' || v === '0' || v === 'false')
}

/**
 * provider 规格（由 inbound.js 消费）：
 *   parse 只负责「一行 JSON → 通用条目」，时间解析用引擎给的 toIso。
 *   返回 null = 这行不要（坏行/空行）。
 */
export function biliProvider({ target = TARGET } = {}) {
  return {
    id: 'bili',
    label: 'B站鱼塘',
    enabled,
    target,
    missing: 'no-ledger',
    files: () => [{ file: ledgerFile(), token: 'ledger' }],
    statePath: (root) => stateFile(root),
    defaults: {
      kind: 'fact',
      // 比模型主动记的（0.6）低一档：B站观察是外部情报，不该压过用户自己的事
      conf: 0.5,
      source: 'bili',
      state: 'active', // 外部观察不走 gate：gate 拦的是「把用户随口话当偏好」
    },
    parse(row, { toIso } = {}) {
      const text = String(row?.t ?? '').trim()
      if (!text) return null
      const bvid = String(row?.bv ?? '').trim()
      return {
        text,
        quote: String(row?.why ?? '').trim(),
        refs: bvid ? [`B站 ${bvid}`] : [],
        at: toIso?.(row?.d) ?? '',
        source: 'bili',
      }
    },
  }
}
