/**
 * build-info.mjs —— 打包前写 lib/build-info.json
 *
 * 记下这次包是从哪个 commit、哪个分支、什么时间、工作区脏不脏打出来的。
 * deploy.mjs 会在 npm pack 之前自动调用；也可以手动跑：
 *
 *   node tools/build-info.mjs
 *
 * 不是 git 仓库 / 没装 git 时照常写文件，commit 留空——界面退化成纯版本号，
 * 不阻塞打包。
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const 根 = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
}

export function buildInfo(root = 根) {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  let commit = ''
  let branch = ''
  let dirty = false
  try {
    commit = git(['rev-parse', 'HEAD'], root)
    branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], root)
    // 只看已跟踪文件的改动：打包内容由 files 白名单决定，未被跟踪的文件不会进包
    dirty = git(['status', '--porcelain', '--untracked-files=no'], root).length > 0
  } catch { /* 不是仓库就不带指纹 */ }
  return {
    version: String(pkg.version || '0.0.0'),
    commit,
    branch,
    builtAt: new Date().toISOString(),
    dirty,
  }
}

export function writeBuildInfo(root = 根, out = join(root, 'lib', 'build-info.json')) {
  const info = buildInfo(root)
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, JSON.stringify(info, null, 2) + '\n', 'utf8')
  return info
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const info = writeBuildInfo(根)
  const id = info.commit ? info.commit.slice(0, 7) + (info.dirty ? '.dirty' : '') : '(no commit)'
  console.log(`build-info: v${info.version}+${id}`)
}
