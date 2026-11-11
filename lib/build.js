/**
 * build.js —— 版本号 + 构建指纹
 *
 * package.json 的 version 是「第几版」，build-info.json 是「哪一次构建」。
 * 两个一起看才能回答「现在跑的是不是我刚改的那份」：
 *   v0.18.0+4e21dc1        ← 打包时工作区干净
 *   v0.18.0+4e21dc1.dirty  ← 打包时还有没提交的改动
 *
 * build-info.json 由 tools/build-info.mjs 在 deploy 打包前写入，不进 git。
 * 开发目录里读不到、或版本对不上（改了 package.json 还没重新打包）就退化成纯版本号，
 * 宁可不显示 commit，也不拿旧指纹冒充新构建。
 */

import { readFileSync } from 'node:fs'

export function readPackageVersion() {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    return String(pkg.version || 'unknown')
  } catch {
    return 'unknown'
  }
}

/** @returns {{version:string,commit:string,branch:string,builtAt:string,dirty:boolean}|null} */
export function readBuildInfo() {
  try {
    const info = JSON.parse(readFileSync(new URL('./build-info.json', import.meta.url), 'utf8'))
    return {
      version: String(info.version || ''),
      commit: String(info.commit || ''),
      branch: String(info.branch || ''),
      builtAt: String(info.builtAt || ''),
      dirty: info.dirty === true,
    }
  } catch {
    return null
  }
}

/**
 * 拼接展示用的版本标签。
 * 指纹只有在「构建时的版本 == 当前版本」时才算数：手动改了 package.json
 * 却忘了重新 deploy，标签必须退回纯版本号，否则会误导成新构建。
 */
export function buildLabel(version, build) {
  const v = String(version || '?')
  const commit = String(build?.commit || '').slice(0, 7)
  if (!commit) return `v${v}`
  if (build?.version && build.version !== String(version || '')) return `v${v}`
  return `v${v}+${commit}${build?.dirty ? '.dirty' : ''}`
}
