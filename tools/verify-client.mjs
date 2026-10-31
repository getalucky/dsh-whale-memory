/**
 * verify-client.mjs —— 重启前的「不会把 DSH 搞崩」体检
 *
 * 宿主的客户端模块加载器很挑，写错了不是界面坏，是整个 DSH 起不来
 * （2026-10-30 崩过两次：一次工具缺 output，一次客户端入口不是 loader 格式）。
 * 这里把宿主的校验规则复刻一遍，本地先跑：
 *
 *   node tools/verify-client.mjs
 *
 * 退出码 0 = 可以重启；非 0 = 别重启，按提示改。
 */

import { readFileSync, existsSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const fails = []
const oks = []
const 过 = (m) => oks.push(m)
const 挂 = (m) => fails.push(m)

const pkgPath = join(pkgRoot, 'package.json')
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))

// 1. dsh.client 声明
const decl = pkg.dsh?.client
if (!decl) {
  挂('package.json 没有 dsh.client，宿主不会认为它是客户端插件')
} else {
  if (decl.platform !== 'web') 挂(`dsh.client.platform 必须是 "web"，现在是 ${JSON.stringify(decl.platform)}`)
  else 过('dsh.client.platform = web')
  for (const f of ['inject', 'external']) {
    if (decl[f] !== undefined && (!Array.isArray(decl[f]) || decl[f].some((x) => typeof x !== 'string'))) {
      挂(`dsh.client.${f} 必须是字符串数组`)
    }
  }
  if (decl.immediately !== undefined && typeof decl.immediately !== 'boolean') 挂('dsh.client.immediately 必须是 boolean')
}

// 2. exports["./client"] 能被解析（宿主只认这个字段，不认别的路径约定）
const ex = pkg.exports?.['./client']
const rel = typeof ex === 'string' ? ex : ex && typeof ex === 'object' ? ex.default : undefined
if (typeof rel !== 'string') {
  挂('exports["./client"] 缺失或不是字符串 —— 宿主会抛 "declares dsh.client but exports no ./client bundle"')
} else {
  const clientPath = join(pkgRoot, rel)
  if (!existsSync(clientPath)) {
    挂(`exports["./client"] 指向的文件不存在：${rel}`)
  } else {
    过(`客户端入口存在：${rel} (${statSync(clientPath).size} 字节)`)
    const src = readFileSync(clientPath, 'utf8')

    // 3. 必须是 loader 注册格式
    if (!/window\.__ModuleLoader__\s*\.\s*load\s*\(/.test(src)) {
      挂('客户端入口没有 window.__ModuleLoader__.load({...}) —— 宿主会 ClientModuleRegistry.flush 失败')
    } else 过('是 __ModuleLoader__.load 注册格式')

    if (!/factory\s*[:=]/.test(src)) 挂('没有 factory，模块无法物化')

    // 4. 不能有顶层 import/export（factory 是 CJS 上下文）
    const bad = src.split('\n').filter((l) => /^\s*(import|export)\s+(?![.(])/.test(l) && !/^\s*\/\//.test(l))
    if (bad.length) 挂(`有 ${bad.length} 行顶层 import/export，必须删掉：\n    ${bad.slice(0, 3).join('\n    ')}`)
    else 过('没有顶层 import/export')

    // 5. 语法必须能整体解析（语法错 = 页面白屏 / 启动崩）
    try {
      new Function(src)
      过('整体语法可解析')
    } catch (e) {
      挂(`语法错误：${String(e?.message ?? e)}`)
    }

    // 6. 注册的 id 要和包名一致，否则模块图对不上
    const m = /__ModuleLoader__\s*\.\s*load\s*\(\s*\{[\s\S]{0,200}?id\s*:\s*['"]([^'"]+)['"]/.exec(src)
    if (!m) 挂('读不到注册的 id')
    else if (m[1] !== pkg.name) 挂(`注册 id "${m[1]}" ≠ 包名 "${pkg.name}"`)
    else 过(`注册 id 与包名一致：${m[1]}`)
  }
}

// 7. 宿主侧入口必须是 ESM 且能被导入
const main = pkg.main || './lib/index.js'
try {
  const mod = await import('file://' + join(pkgRoot, main).replace(/\\/g, '/'))
  if (typeof mod.apply !== 'function') 挂('宿主入口没有导出 apply()')
  else 过('宿主入口 apply() 可导入')
  if (!Array.isArray(mod.inject)) 挂('宿主入口的 inject 不是数组')
  else 过(`宿主 inject = [${mod.inject.join(', ')}]`)
} catch (e) {
  挂(`宿主入口导入失败：${String(e?.message ?? e)}`)
}

console.log(oks.map((x) => '  ok  ' + x).join('\n'))
if (fails.length) {
  console.log('\n' + fails.map((x) => '  !!  ' + x).join('\n'))
  console.log(`\n体检不过（${fails.length} 项），别重启。`)
  process.exit(1)
}
console.log('\n体检通过，可以重启 DSH。')
