/**
 * check.mjs —— 重启后一键体检
 * 跑法：node tools/check.mjs
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const root = process.env.DSH_MEMORY_HOME || '$DSH_HOME/dsh-memory'
const dshHome = process.env.DSH_HOME || '$DSH_HOME'

const say = (s = '') => console.log(s)
const line = () => say('─'.repeat(48))

say(`记忆库：${root}`)
say(`存在：${existsSync(root) ? '是' : '否'}`)
if (!existsSync(root)) process.exit(1)

line()
say('【人格】')
const pf = join(root, 'persona.md')
if (existsSync(pf)) {
  const t = readFileSync(pf, 'utf8')
  say(`  文件 ${t.length} 字 · 含「爹」：${t.includes('爹') ? '是' : '否'} · 含纪律层：${t.includes('纪律层') ? '是' : '否'}`)
} else {
  say('  缺失')
}

line()
say('【桥接绑定 → 会话】')
const cfg = join(dshHome, 'qq-bridge-config.json')
if (existsSync(cfg)) {
  try {
    const j = JSON.parse(readFileSync(cfg, 'utf8'))
    for (const b of j.绑定 || []) {
      say(`  ${b.类型} ${b.号码} → ${b.会话}`)
    }
  } catch (e) {
    say(`  解析失败：${e.message}`)
  }
} else {
  say('  找不到 qq-bridge-config.json')
}

line()
say('【分片】')
const scopesDir = join(root, 'scopes')
let files = []
try { files = readdirSync(scopesDir).filter((n) => n.endsWith('.json')) } catch { /* 空 */ }
if (!files.length) say('  还没有（等她跟人聊过、蒸馏跑过之后会出现）')
for (const f of files) {
  try {
    const j = JSON.parse(readFileSync(join(scopesDir, f), 'utf8'))
    say(`  ${j.scope} · ${j.items.length} 条 · 画像：${j.profile?.summary ? '有' : '空'}`)
  } catch { say(`  ${f} 读取失败`) }
}

line()
say('【待蒸馏】')
const stDir = join(root, 'staging')
let st = []
try { st = readdirSync(stDir).filter((n) => n.endsWith('.jsonl')) } catch { /* 空 */ }
if (!st.length) say('  空')
for (const f of st) {
  const n = readFileSync(join(stDir, f), 'utf8').split('\n').filter(Boolean).length
  say(`  ${f} · ${n} 条消息`)
}

line()
say('【隔离区】')
const orDir = join(stDir, 'orphan')
let orf = []
try { orf = readdirSync(orDir).filter((n) => n.endsWith('.jsonl') && n !== 'index.jsonl') } catch { /* 空 */ }
if (!orf.length) say('  空')
for (const f of orf) {
  const n = readFileSync(join(orDir, f), 'utf8').split('\n').filter(Boolean).length
  say(`  ${f} · ${n} 条（认不出来源，已停用，不会再被蒸馏）`)
}

line()
say('【最近账本】')
const wf = join(root, 'audit', 'writes.jsonl')
if (existsSync(wf)) {
  const lines = readFileSync(wf, 'utf8').split('\n').filter(Boolean).slice(-5)
  for (const l of lines) {
    try { const j = JSON.parse(l); say(`  ${j.at} ${j.kind} ${j.scope || ''} ${j.added ?? ''} ${j.text ?? ''}`) } catch { /* skip */ }
  }
} else {
  say('  还没有写入记录')
}
line()