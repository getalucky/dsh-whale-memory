/**
 * client-build.mjs —— 检查 lib/client.js 和 client-src/ 没漂移
 *
 * 改了 client-src/ 却忘了跑 `node tools/build-client.mjs` 时，这个测试会报错；
 * 反向也防：直接手改 lib/client.js 会在下次构建时被覆盖。
 */
import assert from 'node:assert'
import { readFileSync } from 'node:fs'

import { buildClientSource, clientOutputPath, CLIENT_PARTS } from '../tools/build-client.mjs'

const built = buildClientSource()
const actual = readFileSync(clientOutputPath(), 'utf8')

assert.equal(actual, built, 'lib/client.js 和 client-src/ 不一致：先跑 node tools/build-client.mjs')
assert.ok(CLIENT_PARTS.length >= 2, '客户端片段太少')
assert.ok(built.includes('window.__ModuleLoader__.load('), '构建产物缺少宿主注册格式')
assert.ok(built.trimEnd().endsWith('})'), '构建产物结尾不完整')
assert.doesNotThrow(() => new Function(built), '构建产物语法不通')

console.log(`  ok  lib/client.js 与 client-src/ 一致（${CLIENT_PARTS.length} 个片段，${built.length} 字符）`)
console.log('\n1 通过 · 0 失败')
