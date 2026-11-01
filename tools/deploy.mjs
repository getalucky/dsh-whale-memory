/**
 * deploy.mjs —— 把工作区的鲸鱼记忆打包进 desktop profile
 *
 * 为什么要打包：以前 profile 用 `link:` 直接读仓库目录。
 * 工作区里的 lib/client.js 一旦被挪走、改名或写到一半，DSH 下一次启动就会
 * 因为 client bundle 缺失整个起不来（2026-10-30 连崩三次就是这个）。
 * 现在改成 tarball：profile 里是解压后的真实副本，工作区怎么改都影响不到启动。
 *
 * 用法：
 *   node tools/deploy.mjs        （或双击 tools/deploy.cmd）
 *
 * 要求：先关掉 DSH。安装会重写 profile/node_modules，运行中装容易触发同类崩溃。
 * 装完再打开 DSH；以后每次改完 lib/ 都跑一次，不跑就还是旧代码。
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const 根 = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DSH家 = process.env.DSH_HOME
if (!DSH家) {
  console.error('需要 DSH_HOME 环境变量（指向 DSH 安装目录）')
  process.exit(2)
}
const profile = join(DSH家, 'profiles', 'desktop')
const vendor = join(profile, 'vendor')
const 装机 = join(profile, 'node_modules', 'dsh-whale-memory')
const pnpm = join(DSH家, 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.cjs')

const 跑 = (cmd, args, opts = {}) => {
  console.log('> ' + cmd + ' ' + args.join(' '))
  execFileSync(cmd, args, { stdio: 'inherit', ...opts })
}

// Windows 上裸名 'npm' spawn 不到（没有 npm.exe；.cmd 又会被 EINVAL 拦下），改走 node 自带的 npm-cli.js。
const npmCli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
const 跑npm = (args, opts = {}) =>
  existsSync(npmCli) ? 跑(process.execPath, [npmCli, ...args], opts) : 跑('npm', args, opts)

const DSH在跑 = () => {
  try {
    const 出 = execFileSync('tasklist', ['/FI', 'IMAGENAME eq DeepSeek Harness.exe'], { encoding: 'utf8' })
    return 出.includes('DeepSeek Harness.exe')
  } catch {
    return false
  }
}

const 摘要 = (文件) => createHash('sha256').update(readFileSync(文件)).digest('hex')

if (DSH在跑()) {
  console.error('\nDSH 正在运行。先把它关掉，再跑这个脚本；装完再打开。')
  console.error('（运行中替换 node_modules 就是 2026-10-30 那几次崩溃的成因。）')
  process.exit(1)
}

const 包 = JSON.parse(readFileSync(join(根, 'package.json'), 'utf8'))
const 时间 = new Date().toLocaleString('sv-SE').replace(/[-: ]/g, '').slice(0, 14)
const 临时 = join(根, '.pack')
rmSync(临时, { recursive: true, force: true })
mkdirSync(临时, { recursive: true })

console.log('\n[1/4] 打包');
跑npm(['pack', '--pack-destination', 临时], { cwd: 根 })
const 打出来的 = readdirSync(临时).find((名) => 名.endsWith('.tgz'))
if (!打出来的) {
  console.error('npm pack 没产出 tgz')
  process.exit(1)
}
const 包名 = `dsh-whale-memory-${包.version}-${时间}.tgz`
mkdirSync(vendor, { recursive: true })
const 包路径 = join(vendor, 包名)
renameSync(join(临时, 打出来的), 包路径)
rmSync(临时, { recursive: true, force: true })
console.log('      ' + 包路径)

const 配置路径 = join(profile, 'package.json')
const 锁路径 = join(profile, 'pnpm-lock.yaml')
copyFileSync(配置路径, 配置路径 + '.bak-before-deploy')
if (existsSync(锁路径)) copyFileSync(锁路径, 锁路径 + '.bak-before-deploy')

console.log('\n[2/4] 改 profile 依赖');
const 配置 = JSON.parse(readFileSync(配置路径, 'utf8'))
配置.dependencies ??= {}
配置.dependencies['dsh-whale-memory'] = 'file:vendor/' + 包名
// 只写 dependencies 不会自动加载，profile 的 bundles 里必须有这个包名
配置.dsh ??= {}
配置.dsh.profile ??= {}
配置.dsh.profile.bundles ??= []
if (!配置.dsh.profile.bundles.includes('dsh-whale-memory')) 配置.dsh.profile.bundles.push('dsh-whale-memory')
writeFileSync(配置路径, JSON.stringify(配置, null, 2) + '\n', 'utf8')

console.log('\n[3/4] 安装');
try {
  跑(process.execPath, [pnpm, 'install', '--dir', profile, '--prefer-offline'])
} catch (错) {
  console.error('\n安装失败，恢复 package.json / pnpm-lock.yaml')
  copyFileSync(配置路径 + '.bak-before-deploy', 配置路径)
  if (existsSync(锁路径 + '.bak-before-deploy')) copyFileSync(锁路径 + '.bak-before-deploy', 锁路径)
  process.exit(1)
}

console.log('\n[4/4] 校验');
const 装机client = join(装机, 'lib', 'client.js')
if (!existsSync(装机client)) {
  console.error('装完没找到 ' + 装机client + '，先别开 DSH。')
  process.exit(1)
}
if (摘要(装机client) !== 摘要(join(根, 'lib', 'client.js'))) {
  console.error('装机的 client.js 和工作区不一致，先别开 DSH。')
  process.exit(1)
}
跑(process.execPath, [join(根, 'tools', 'verify-client.mjs')], { cwd: 根 })

console.log('\n好了：' + 包名)
console.log('现在可以打开 DSH。以后改完 lib/，再跑一次这个脚本 + 重启 DSH 才生效。')
