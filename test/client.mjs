/**
 * test/client.mjs —— 网页半边的离线冒烟
 *
 * 用假的 window.__ModuleLoader__ + 假 React 把 lib/client.js 跑一遍：
 * 能不能被 factory 物化、能不能 apply、Section 能不能生成元素树。
 * 真浏览器行为测不了，但「一加载就抛错把 DSH 带崩」这类问题能提前抓出来。
 *
 *   node test/client.mjs
 */

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const src = readFileSync(join(pkgRoot, 'lib', 'client.js'), 'utf8')

let pass = 0
let fail = 0
const t = (name, fn) => {
  try { fn(); pass += 1; console.log('  ok  ' + name) }
  catch (e) { fail += 1; console.log('  !!  ' + name + ' —— ' + String(e?.message ?? e)) }
}
const ok = (v, m) => { if (!v) throw new Error(m || '断言失败') }

// 假 React：只要形状对，不真渲染
const React = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
  useState: (v) => [v, () => {}],
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
  useEffect: () => {},
}

const registrations = []
const sandbox = {
  window: { __ModuleLoader__: { load: (r) => registrations.push(r) } },
  console,
  fetch: () => Promise.resolve({ json: () => Promise.resolve(null) }),
  URL,
  Set,
  Map,
  Promise,
  JSON,
  Math,
  Date,
  Number,
  String,
  Object,
  Array,
  RegExp,
  Error,
}
sandbox.globalThis = sandbox
vm.createContext(sandbox)

t('脚本能执行并注册模块', () => {
  vm.runInContext(src, sandbox, { filename: 'client.js' })
  ok(registrations.length === 1, '注册次数不对：' + registrations.length)
  ok(registrations[0].id === 'dsh-whale-memory', 'id 不对：' + registrations[0].id)
  ok(typeof registrations[0].factory === 'function', 'factory 不是函数')
})

const requireStub = (spec) => {
  if (spec === 'react') return React
  throw new Error('客户端入口 require 了未知模块：' + spec)
}

let exportsObj = null
t('factory 能物化', () => {
  exportsObj = registrations[0].factory(requireStub)
  ok(exportsObj && typeof exportsObj.apply === 'function', '没导出 apply')
  ok(Array.isArray(exportsObj.inject), 'inject 不是数组')
})

t('apply 会注册设置页', () => {
  const calls = []
  const ctx = {
    get: (n) => (n === 'slots' ? {
      inject: (slot, fn) => { calls.push(slot); fn() },
      register: (meta, Comp) => { calls.push(meta.id); ok(typeof Comp === 'function', '组件不是函数'); return () => {} },
    } : undefined),
  }
  exportsObj.apply(ctx)
  ok(calls.includes('settings.section'), '没往 settings.section 注册')
  ok(calls.includes('whale-memory'), '注册的 id 不对：' + calls.join(','))
})

t('没 slots 服务时安静退出', () => {
  exportsObj.apply({ get: () => undefined })
})

console.log(`\n${pass} 通过 · ${fail} 失败`)
process.exit(fail ? 1 : 0)
