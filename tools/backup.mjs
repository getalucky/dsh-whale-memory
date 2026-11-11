/**
 * backup.mjs —— 一键备份 / 恢复记忆库
 *
 * 用法：
 *   node tools/backup.mjs                    备份到 <DSH_HOME>/backups/whale-memory-YYYYMMDD-HHMMSS/
 *   node tools/backup.mjs --out D:\x\bk      指定目录
 *   node tools/backup.mjs --with-audit       连 audit / logs 一起带（默认不带）
 *   node tools/backup.mjs --list             看已有备份
 *   node tools/backup.mjs --restore <dir>    恢复（要先 --yes 才真覆盖）
 *
 * 为什么是目录副本不是压缩包：库不大（几十 MB 以内），目录能直接翻、直接对比，
 * 不依赖 zip 工具。想压缩自己 tar 一下就行。
 *
 * settings.json 里的 key 一律不带：备份会流到 U 盘、网盘、别人机器上。
 */

import { createHash } from 'node:crypto'
import {
  copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

const 家 = process.env.DSH_HOME || join(homedir(), '.dsh')
const 源 = resolve(process.env.DSH_MEMORY_HOME || join(家, 'dsh-memory'))

/** 核心内容 + 可读的配置；运行态和日志单独开关。 */
const KEEP = [
  'scopes',
  'diary',
  'graph',
  'person',
  'persona.md',
  'AGENT.md',
  'USER.md',
  'meta.json',
  'namespaces.json',
  'review_state.json',
  'persona_meta.json',
  'settings.json',
]
const EXTRA = ['audit', 'logs']
const SKIP_DIRS = new Set(['node_modules', '.git', 'backups'])

const 参数 = process.argv.slice(2)
const 有 = (k) => 参数.includes(k)
const 值 = (k) => {
  const i = 参数.indexOf(k)
  return i >= 0 ? 参数[i + 1] : ''
}

function 时间戳(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

function 走目录(dir) {
  const out = []
  const 栈 = [dir]
  while (栈.length) {
    const cur = 栈.pop()
    let names = []
    try { names = readdirSync(cur, { withFileTypes: true }) } catch { continue }
    for (const ent of names) {
      const full = join(cur, ent.name)
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(ent.name)) continue
        栈.push(full)
      } else if (ent.isFile()) {
        out.push(full)
      }
    }
  }
  return out
}

/** 设置里的 key 去掉；端点和模型名留着，恢复后少填几格。 */
function 洗设置(raw) {
  let o = {}
  try { o = JSON.parse(raw) } catch { return '{}' }
  for (const k of ['llm', 'search', 'embed', 'review']) {
    const e = o?.[k]
    if (!e || typeof e !== 'object') continue
    delete e.key
    delete e.keyEnc
  }
  return JSON.stringify(o, null, 2) + '\n'
}

function 校验和(files, root) {
  const h = createHash('sha1')
  for (const f of files.slice().sort()) {
    const rel = f.slice(root.length + 1).replace(/\\/g, '/')
    const st = statSync(f)
    h.update(`${rel}:${st.size}\n`)
  }
  return h.digest('hex').slice(0, 20)
}

function 备份() {
  if (!existsSync(源)) {
    console.error(`找不到记忆库：${源}`)
    process.exit(2)
  }
  const 目标 = resolve(值('--out') || join(家, 'backups', `whale-memory-${时间戳()}`))
  if (existsSync(目标)) {
    console.error(`目标已存在，换个目录：${目标}`)
    process.exit(2)
  }

  const 清单 = [...KEEP, ...(有('--with-audit') ? EXTRA : [])].filter((n) => existsSync(join(源, n)))
  if (!清单.length) {
    console.error('库里没有可备份的内容')
    process.exit(2)
  }

  mkdirSync(目标, { recursive: true })
  const 拷了 = []
  for (const name of 清单) {
    const from = join(源, name)
    const to = join(目标, name)
    if (statSync(from).isDirectory()) {
      for (const f of 走目录(from)) {
        const rel = f.slice(源.length + 1)
        const dst = join(目标, rel)
        mkdirSync(dirname(dst), { recursive: true })
        copyFileSync(f, dst)
        拷了.push(dst)
      }
    } else {
      mkdirSync(dirname(to), { recursive: true })
      if (name === 'settings.json') {
        writeFileSync(to, 洗设置(readFileSync(from, 'utf8')), 'utf8')
      } else {
        copyFileSync(from, to)
      }
      拷了.push(to)
    }
  }

  let bytes = 0
  for (const f of 拷了) bytes += statSync(f).size
  const manifest = {
    format: 'whale-memory-backup',
    version: 1,
    at: new Date().toISOString(),
    source: 源.replace(/\\/g, '/'),
    entries: 清单,
    files: 拷了.length,
    bytes,
    checksum: 校验和(拷了, 目标),
    note: 'settings.json 已去掉 key；恢复前先关 DSH',
  }
  writeFileSync(join(目标, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8')
  console.log(`备份好了 · ${目标}`)
  console.log(`${拷了.length} 个文件 · ${(bytes / 1024 / 1024).toFixed(2)} MB · 校验 ${manifest.checksum}`)
  return 目标
}

function 列备份() {
  const 目录 = join(家, 'backups')
  if (!existsSync(目录)) {
    console.log('还没有备份')
    return
  }
  for (const name of readdirSync(目录).sort().reverse()) {
    const p = join(目录, name, 'manifest.json')
    if (!existsSync(p)) continue
    try {
      const m = JSON.parse(readFileSync(p, 'utf8'))
      console.log(`${name} · ${m.files} 文件 · ${(m.bytes / 1024 / 1024).toFixed(2)} MB · ${m.at}`)
    } catch { /* 坏清单跳过 */ }
  }
}

function 恢复(目录) {
  const 源目录 = resolve(目录 || '')
  if (!源目录 || !existsSync(源目录)) {
    console.error('用法：node tools/backup.mjs --restore <备份目录> --yes')
    process.exit(2)
  }
  const mf = join(源目录, 'manifest.json')
  if (!existsSync(mf)) {
    console.error(`不是备份目录（缺 manifest.json）：${源目录}`)
    process.exit(2)
  }
  const manifest = JSON.parse(readFileSync(mf, 'utf8'))
  if (manifest.format !== 'whale-memory-backup') {
    console.error(`清单格式不认：${manifest.format}`)
    process.exit(2)
  }
  const files = 走目录(源目录).filter((f) => basename(f) !== 'manifest.json')
  const sum = 校验和(files, 源目录)
  if (sum !== manifest.checksum) {
    console.error(`校验不通过：备份损坏或被改过\n  清单 ${manifest.checksum}\n  实际 ${sum}`)
    process.exit(3)
  }

  console.log(`准备恢复 ${源目录} → ${源}`)
  console.log(`  ${manifest.files} 个文件 · ${(manifest.bytes / 1024 / 1024).toFixed(2)} MB · ${manifest.at}`)
  console.log(`  entries: ${manifest.entries.join(', ')}`)
  if (!有('--yes')) {
    console.log('\n还没动手。确认要覆盖现在这份库，再加 --yes 跑一次。')
    console.log('（真恢复前会先把现在的库备份到 backups/pre-restore-<时间>）')
    return
  }

  const 安全 = join(家, 'backups', `pre-restore-${时间戳()}`)
  mkdirSync(安全, { recursive: true })
  for (const name of manifest.entries) {
    const from = join(源, name)
    if (!existsSync(from)) continue
    const to = join(安全, name)
    if (statSync(from).isDirectory()) {
      for (const f of 走目录(from)) {
        const rel = f.slice(源.length + 1)
        const dst = join(安全, rel)
        mkdirSync(dirname(dst), { recursive: true })
        copyFileSync(f, dst)
      }
    } else {
      mkdirSync(dirname(to), { recursive: true })
      copyFileSync(from, to)
    }
  }
  console.log(`先存了现在的库：${安全}`)

  for (const name of manifest.entries) {
    const from = join(源目录, name)
    const to = join(源, name)
    if (!existsSync(from)) continue
    if (statSync(from).isDirectory()) {
      for (const f of 走目录(from)) {
        const rel = f.slice(源目录.length + 1)
        const dst = join(源, rel)
        mkdirSync(dirname(dst), { recursive: true })
        copyFileSync(f, dst)
      }
    } else {
      mkdirSync(dirname(to), { recursive: true })
      copyFileSync(from, to)
    }
  }
  console.log('恢复完成。settings.json 里没有 key，要在设置页重填一次。')
  console.log('关掉再打开 DSH 才生效。')
}

if (有('--list')) {
  列备份()
} else if (有('--restore')) {
  恢复(值('--restore'))
} else {
  备份()
}
