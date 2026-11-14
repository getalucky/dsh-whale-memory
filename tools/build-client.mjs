/**
 * build-client.mjs —— 把 client-src/ 里的源码片段拼成宿主认的 lib/client.js
 *
 * 宿主的客户端模块加载器只认一个入口：package.json 的 exports["./client"]，
 * 而且这个入口必须是单文件、`window.__ModuleLoader__.load({id, factory})` 格式。
 * 所以浏览器端源码按页面拆在 client-src/，构建时按固定顺序拼回单文件；
 * 产物 lib/client.js 必须原样提交，运行时不依赖本脚本。
 *
 *   node tools/build-client.mjs
 *
 * 改了 client-src/ 里任何文件都要重新跑一次；test/client-build.mjs 会检查漂移。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const CLIENT_PARTS = [
  '00-loader.js',
  '10-core.js',
  '20-graph-engine.js',
  '30-graph-page.js',
  '40-memory-pages.js',
  '45-overview-run.js',
  '50-model-pages.js',
  '55-proactive.js',
  '60-section.js',
  '90-tail.js',
]

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 读 client-src/ 的全部片段，按固定顺序拼成完整客户端入口。 */
export function buildClientSource(base = root) {
  return CLIENT_PARTS.map((name) => readFileSync(join(base, 'client-src', name), 'utf8')).join('')
}

/** 产物路径：lib/client.js。 */
export function clientOutputPath(base = root) {
  return join(base, 'lib', 'client.js')
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const out = clientOutputPath()
  const next = buildClientSource()
  writeFileSync(out, next, 'utf8')
  console.log(`client-src -> lib/client.js: ${next.length} chars, ${CLIENT_PARTS.length} parts`)
}
