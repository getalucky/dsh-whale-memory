/**
 * test/build.mjs —— 构建指纹
 *
 * 测三件事：
 *   1. buildLabel 只在「版本对得上」时才拼 commit，旧指纹不能冒充新构建
 *   2. 版本号始终读 package.json，不再有写死的常量
 *   3. tools/build-info.mjs 在没有 git 的目录里也能写出文件，不阻塞打包
 *
 *   node test/build.mjs
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildLabel, readBuildInfo, readPackageVersion } from '../lib/build.js'
import { buildInfo, writeBuildInfo } from '../tools/build-info.mjs'

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

let pass = 0
let fail = 0
const t = (name, fn) => {
  try { fn(); pass += 1; console.log('  ok  ' + name) }
  catch (e) { fail += 1; console.log('  !!  ' + name + ' —— ' + String(e?.message ?? e)) }
}
const ok = (v, m) => { if (!v) throw new Error(m || '断言失败') }
const eq = (a, b, m) => { if (a !== b) throw new Error(`${m || '不相等'}：${JSON.stringify(a)} != ${JSON.stringify(b)}`) }

t('没有构建信息时退回纯版本号', () => {
  eq(buildLabel('0.18.0', null), 'v0.18.0')
  eq(buildLabel('0.18.0', { commit: '' }), 'v0.18.0')
  eq(buildLabel('', null), 'v?')
})

t('版本一致时拼短 commit', () => {
  const build = { version: '0.18.0', commit: '4e21dc1abcdef0123456', dirty: false }
  eq(buildLabel('0.18.0', build), 'v0.18.0+4e21dc1')
})

t('打包时工作区脏就带 .dirty', () => {
  const build = { version: '0.18.0', commit: '4e21dc1abcdef', dirty: true }
  eq(buildLabel('0.18.0', build), 'v0.18.0+4e21dc1.dirty')
})

t('指纹版本和当前版本对不上就不显示 commit', () => {
  const stale = { version: '0.17.1', commit: '4e21dc1abcdef', dirty: false }
  eq(buildLabel('0.18.0', stale), 'v0.18.0')
})

t('版本号读 package.json，不是写死的', () => {
  const pkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'))
  eq(readPackageVersion(), pkg.version)
  ok(readPackageVersion() !== 'unknown', '读不到 package.json')
})

t('buildInfo 取当前包版本；build-info.json 缺失时返回 null 而不是抛错', () => {
  const info = buildInfo(pkgRoot)
  eq(info.version, JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8')).version)
  eq(typeof info.commit, 'string')
  eq(typeof info.branch, 'string')
  eq(typeof info.builtAt, 'string')
  ok(!Number.isNaN(new Date(info.builtAt).getTime()), 'builtAt 不是合法时间')
  const now = readBuildInfo()
  ok(now === null || (typeof now.commit === 'string' && typeof now.dirty === 'boolean'), '读出来的形状不对')
})

t('非 git 目录也能写 build-info，commit 留空', () => {
  const dir = mkdtempSync(join(tmpdir(), 'whale-build-'))
  try {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '9.9.9' }))
    const out = join(dir, 'lib', 'build-info.json')
    const info = writeBuildInfo(dir, out)
    eq(info.version, '9.9.9')
    const saved = JSON.parse(readFileSync(out, 'utf8'))
    eq(saved.version, '9.9.9')
    eq(saved.commit, '')
    eq(saved.dirty, false)
    ok(!Number.isNaN(new Date(saved.builtAt).getTime()), 'builtAt 不是合法时间')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

console.log(`\n${pass} 通过 · ${fail} 失败`)
process.exit(fail ? 1 : 0)
