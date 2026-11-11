/**
 * import-history.mjs —— 把 DSH 里存着的旧会话补进记忆库
 *
 * 用法：
 *   node tools/import-history.mjs                       # 预演，不写盘
 *   node tools/import-history.mjs --apply               # 规则抽取，真正写入
 *   node tools/import-history.mjs --apply --llm         # 允许调模型（更慢、更花 token）
 *   node tools/import-history.mjs --rollback imp-...    # 整批回滚
 *
 * 默认只导最近规则能抽出来的东西：
 *   · 只认当前绑定表里有的 QQ 会话；没绑定的历史会话要显式 --map/--scope，
 *     身份不从聊天文本里猜。
 *   · 过期的计划类事件（几个月前的「明天交作业」）默认丢掉，--events 才带上。
 *   · 每个分片导入上限默认 320 条，本次最多新增 200 条；到顶停下，下次可续。
 *
 * 写盘期间要求 DSH 关闭（避免插件进程和本工具同时改分片）。
 * 实在关不掉：DSH_MEMORY_IMPORT_FORCE=1 node tools/import-history.mjs --apply
 */
import { execFileSync } from 'node:child_process'

import { rootDir } from '../lib/store.js'
import {
  importHistory, rollbackImport, defaultSessionsDir,
  IMPORT_CAP, IMPORT_MAX_ADD, IMPORT_MAX_MESSAGES,
} from '../lib/importer.js'

const USAGE = `
用法：
  node tools/import-history.mjs [选项]

选项：
  --apply                 真正写入（默认只预演）
  --sessions <目录>       DSH 会话目录，默认 $DSH_HOME/sessions
  --root <目录>           记忆库根，默认 $DSH_MEMORY_HOME 或 $DSH_HOME/dsh-memory
  --since <日期>          只导该日期之后创建的会话（2026-01-01）
  --until <日期>          只导该日期之前创建的会话
  --scope <分片>          未绑定/本地会话的兜底落点（private:<QQ> / group:<群号> / local:dsh）
  --map <sid>=<分片>      给某个历史会话显式指定落点，可重复
  --max-sessions <N>      最多处理 N 个会话，0 = 不限（默认 0）
  --max-messages <N>      每个会话最多取最近 N 条用户消息（默认 ${IMPORT_MAX_MESSAGES}）
  --max-add <N>           本次最多新增 N 条，0 = 不限（默认 ${IMPORT_MAX_ADD}）
  --cap <N>               每个分片生效记忆上限（默认 ${IMPORT_CAP}，低于全局容量门）
  --llm                   允许调模型；默认只走规则，不花 token
  --events                连过期计划一起导（默认丢）
  --force                 重导已经导过的会话
  --rollback <run-id>     回滚一次导入（只删那一批新造、且没被改过的条目）
  --help                  显示这份说明
`.trim()

function die(msg, code = 2) {
  console.error(msg)
  process.exit(code)
}

function parseArgs(argv) {
  const out = { _: [], maps: [] }
  const flags = new Set(['apply', 'llm', 'events', 'force', 'help'])
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (!a.startsWith('--')) { out._.push(a); continue }
    const eq = a.indexOf('=')
    let key = eq >= 0 ? a.slice(2, eq) : a.slice(2)
    let val
    if (eq >= 0) val = a.slice(eq + 1)
    else if (flags.has(key)) val = true
    else {
      val = argv[i + 1]
      i += 1
      if (val === undefined || String(val).startsWith('--')) die(`--${key} 缺参数\n\n${USAGE}`)
    }
    if (key === 'map') out.maps.push(val)
    else out[key] = val
  }
  return out
}

function num(value, fallback, min = 0) {
  if (value === undefined || value === '') return fallback
  const n = Number(value)
  if (!Number.isFinite(n) || n < min) die(`参数不是有效数字：${value}`)
  return Math.floor(n)
}

function dshRunning() {
  try {
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq DeepSeek Harness.exe'], { encoding: 'utf8' })
    return out.includes('DeepSeek Harness.exe')
  } catch {
    return false
  }
}

const args = parseArgs(process.argv.slice(2))
if (args.help) {
  console.log(USAGE)
  process.exit(0)
}

const root = String(args.root || rootDir())
const mapTable = {}
for (const raw of args.maps) {
  for (const part of String(raw).split(',').map((x) => x.trim()).filter(Boolean)) {
    const i = part.lastIndexOf('=')
    if (i <= 0) die(`--map 要写成 <session-id>=<分片>：${part}`)
    mapTable[part.slice(0, i)] = part.slice(i + 1)
  }
}

const writing = Boolean(args.apply || args.rollback)
if (writing && dshRunning() && process.env.DSH_MEMORY_IMPORT_FORCE !== '1') {
  die('DSH 正在运行。先关掉再导入/回滚，避免两个进程同时改分片。\n'
    + '实在关不掉：DSH_MEMORY_IMPORT_FORCE=1 node tools/import-history.mjs ...')
}

try {
  if (args.rollback) {
    const r = await rollbackImport(root, args.rollback, { log: console.log })
    console.log(`\n回滚完成：删除 ${r.removed} 条${r.kept.length ? `，保留 ${r.kept.length} 条（后来被改过）` : ''}`)
    console.log(`清单：${r.manifestFile}`)
  } else {
    const dryRun = !args.apply
    const r = await importHistory({
      root,
      dir: String(args.sessions || defaultSessionsDir()),
      since: String(args.since || ''),
      until: String(args.until || ''),
      scope: String(args.scope || ''),
      maps: mapTable,
      maxSessions: num(args['max-sessions'], 0),
      maxMessages: num(args['max-messages'], IMPORT_MAX_MESSAGES, 1),
      maxAdd: num(args['max-add'], IMPORT_MAX_ADD),
      cap: num(args.cap, IMPORT_CAP),
      llm: Boolean(args.llm),
      includePastEvents: Boolean(args.events),
      force: Boolean(args.force),
      dryRun,
      log: console.log,
    })

    if (r.dryRun) {
      console.log(`\n[历史导入 · 预演] ${r.sessionsDir}`)
      console.log(`扫描 ${r.totals.scanned} 个会话，可导 ${r.totals.eligible} 个，本次选中 ${r.totals.picked} 个（${r.totals.messages} 条用户消息）`)
      const cap = num(args.cap, IMPORT_CAP)
      for (const [sk, row] of Object.entries(r.scopes)) {
        const limit = cap > 0 ? ` / 上限 ${cap}` : ''
        console.log(`  ${sk.padEnd(22)} 会话 ${String(row.sessions).padStart(3)} · 消息 ${String(row.messages).padStart(4)} · 预估候选 ${String(row.candidates).padStart(3)} · 现有 ${row.live}${limit} · 预计再导 ${row.wouldAdd}`)
      }
      const why = {}
      for (const s of r.skipped) why[s.why] = (why[s.why] || 0) + 1
      const whyText = Object.entries(why).map(([k, v]) => `${k} ${v}`).join(' · ')
      if (whyText) console.log(`跳过 ${r.totals.skipped} 个：${whyText}`)
      const unbound = r.skipped.filter((s) => s.why === 'unbound-qq')
      if (unbound.length) {
        console.log('\n有历史 QQ 会话不在当前绑定表里（身份不猜）：')
        for (const s of unbound.slice(0, 8)) {
          console.log(`  ${s.id || s.file}`)
        }
        if (unbound.length > 8) console.log(`  ……还有 ${unbound.length - 8} 个`)
        console.log('确认归属后：--map <session-id>=private:<QQ>（或 group:<群号>）')
      }
      console.log(`\n合计：预估新增 ${r.totals.wouldAdd} 条（本次上限 ${IMPORT_MAX_ADD} 条，可用 --max-add 调）`)
      console.log('这是预演，没有写盘。确认后加 --apply 执行。')
    } else {
      console.log(`\n[历史导入 · 完成] ${r.run}`)
      console.log(`新增 ${r.totals.added} 条 · 合并 ${r.totals.merged} 条 · 处理 ${r.totals.sessions} 个会话`)
      for (const [sk, row] of Object.entries(r.scopes)) {
        console.log(`  ${sk.padEnd(22)} +${row.added}${row.merged ? ` ~${row.merged}` : ''}`)
      }
      if (r.budgetHit) console.log('到本次上限就停了；再跑一次（加 --force 才会重看已完成的会话）可以继续。')
      console.log(`清单：${r.manifestFile}`)
      console.log(`回滚：node tools/import-history.mjs --rollback ${r.run}`)
    }
  }
} catch (e) {
  die(String(e?.message ?? e), 1)
}
