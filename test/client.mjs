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
  useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
  useEffect: () => {},
  useRef: (v) => ({ current: v }),
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
  let Comp = null
  const ctx = {
    get: (n) => (n === 'slots' ? {
      inject: (slot, fn) => { calls.push(slot); fn() },
      register: (meta, C) => { calls.push(meta.id); Comp = C; ok(typeof C === 'function', '组件不是函数'); return () => {} },
    } : undefined),
  }
  exportsObj.apply(ctx)
  ok(calls.includes('settings.section'), '没往 settings.section 注册')
  ok(calls.includes('whale-memory'), '注册的 id 不对：' + calls.join(','))
  const tree = Comp()
  ok(tree && tree.type === 'div', 'Section 没生成元素树')
})

t('没 slots 服务时安静退出', () => {
  exportsObj.apply({ get: () => undefined })
})

// 页面组件是函数内部声明，正常不导出；测试时从源码尾巴补一个出口，
// 用带状态的样例把每页真跑一遍——只在 Section 层看树，抓不到页面自己的引用错误。
t('各页面带数据能渲染（不引用外部未定义变量）', () => {
  const pageSrc = src.replace('exports.apply = apply', 'exports.__pages = { 总览页, 运行页, 记忆页, 审计页, 图谱页, 模型页 }\n    exports.apply = apply')
  ok(pageSrc !== src, '没找到导出标记')
  vm.runInContext(pageSrc, sandbox, { filename: 'client-pages.js' })
  const def = registrations[registrations.length - 1]
  const pages = def.factory(requireStub).__pages

  const 态 = {
    ok: true,
    version: '0.18.0',
    label: 'v0.18.0+abc123',
    build: { commit: 'abc123', branch: 'main', builtAt: '2026-11-11T15:00:39.030Z', dirty: false },
    counts: { scopes: 1, items: 2 },
    audit: [],
    scopes: [{
      scope: 'local:dsh', kind: 'local', id: 'dsh', label: '本机', updatedAt: '',
      total: 2, active: 1, suggested: 1, archived: 0, superseded: 0,
      items: [
        { id: 'm1', text: '猫叫团子', kind: 'fact', conf: 0.8, hits: 1, merged: 0, state: 'active', score: 0.9, steps: [] },
        { id: 'm2', text: '下周三看牙医', kind: 'commitment', state: 'suggested', score: 0.5, due: '2026-11-18', toWhom: '自己', steps: [] },
      ],
    }],
  }
  const 观察 = {
    persona: {
      exists: true, version: 3, tokens: 800, limit: 1200,
      budget: { tokens: 1182, limit: 1200, headroom: 18, compactible: 15, effective: 33, basis: 1167 },
      audit: [
        { i: 0, text: '不分析：他没问「为什么」「怎么办」，就别解释原因。', chars: 98, flag: 'verbose', why: '偏长（98 字）', suggestion: '去掉不含约束词的解释尾巴' },
        { i: 1, text: '例：', chars: 2, flag: 'example', why: '示例行', suggestion: '可压成一条指引' },
      ],
      compressible: [{ old: '长句', rule: '短句', freed: 15, flag: 'verbose' }],
      auto: { pendingMessages: 25, minMessages: 100, streak: 0, minStreak: 3, waitReason: '还差 75 条新消息', nextPublishAt: '2026-11-16', lastRunAt: '' },
      recentRuns: [{ at: '2026-11-12T00:59:20.567Z', applied: 0, proposed: true, why: '没有新候选', samples: { count: 12, total: 324, skipped: 167 } }],
      proposal: {
        at: '2026-11-12T00:59:25.575Z', generator: 'rules(fallback)', reviewer: 'rules',
        samples: { count: 12, skipped: 167, skipReasons: { style: 120, command: 47 } },
        budget: { tokens: 1182, limit: 1200, headroom: 18, compactible: 15, reclaimable: 12, effective: 45, basis: 1167 },
        additions: [{ rule: '少用 emoji', evidence: 2, refs: [{ id: 'm_1', text: '以后别用 emoji' }] }],
        compressions: [{ old: '不分析：他没问「为什么」「怎么办」，就别解释。', rule: '不分析：他没问，就别解释。', why: '偏长；去掉不含约束词的举例列举', flag: 'verbose', freed: 15 }],
        replacements: [{ old: 'emoji 偶尔点缀，一条最多一种。', rule: 'emoji 一条最多一个，正事不用。', why: '同一主题「emoji」', freed: 12 }],
        audit: [
          { i: 0, text: '不分析：他没问「为什么」「怎么办」，就别解释原因。', chars: 98, flag: 'verbose', why: '偏长（98 字）', suggestion: '去掉不含约束词的解释尾巴' },
          { i: 1, text: '例：', chars: 2, flag: 'example', why: '示例行', suggestion: '可压成一条指引' },
          { i: 2, text: '说话短一点。', chars: 6, flag: 'keep', why: '精简、独立的一条约束', suggestion: '' },
        ],
        rejected: [{ rule: '别写日期', why: '含日期 / 号码 / 路径 / 凭据' }],
        warnings: ['人格预算只剩 18 tok'],
      },
      lastApplied: { at: '', rules: [], replaced: [{ old: '旧说法', rule: '新说法' }], compressed: [{ old: '长说法', rule: '短说法' }] },
      decisions: [{
        at: '2026-11-12T00:59:25.575Z',
        rows: [
          { rule: '采样跳过 120 条', action: 'dropped', stage: 'sample', why: '采样门：不是说「怎么说」的话', evidence: [] },
          { rule: '少用 emoji', action: 'accepted', stage: 'review', why: '确定性审查通过（证据 2 条）', evidence: [{ id: 'm_1', text: '以后别用 emoji' }] },
          { rule: 'emoji 一条最多一个', action: 'replaced', stage: 'replace', why: '替换旧规矩，腾出 12 tok', evidence: [] },
          { rule: '不分析：他没问，就别解释。', action: 'compressed', stage: 'compact', why: '偏长；写短 15 字', evidence: [] },
          { rule: '别写日期', action: 'dropped', stage: 'review', why: '含日期 / 号码 / 路径 / 凭据', evidence: [] },
        ],
      }],
      changelog: '',
    },
    trust: { origin: 'local', usable: true },
    vault: [], reads: {}, gate: {}, metrics: {}, searches: [], skips: [], deepens: [],
  }
  const 图 = { nodes: [{ name: '团子', type: 'thing', score: 0.9 }], edges: [] }
  const 体检 = { ok: true, totals: { errors: 0, warnings: 0, duplicates: 0, stale: 0 }, scopes: [] }

  // 只调用函数组件；hook 由假 React 兜底，effect 不跑。
  const render = (node) => {
    if (node == null || typeof node === 'boolean') return
    if (typeof node === 'string' || typeof node === 'number') return
    if (Array.isArray(node)) { node.forEach(render); return }
    if (typeof node === 'function') { render(node({})); return }
    if (node.type === 'F') { render(node.children); return }
    if (typeof node.type === 'function') { render(node.type(node.props)); return }
    render(node.children)
    if (node.props && node.props.children) render(node.props.children)
  }

  const 用例 = [
    ['总览页', { 态, 观察, 图, 体检 }],
    ['运行页', { 观察 }],
    ['记忆页', { 态, 删: () => {}, 确认: () => {} }],
    ['审计页', { 态, 账本: null }],
    ['图谱页', { 图, 态 }],
    ['模型页', {
      页签: '向量',
      向量: {
        态: { ready: true }, 表单: { base: '', model: '', key: '' },
        改表单: () => {}, 保存: () => {}, 测试: () => {}, 探测: () => {},
        候选: null, 探测中: false, 忙: false, 结果: null,
      },
    }],
  ]
  for (const [名, props] of 用例) {
    ok(typeof pages[名] === 'function', `没取到 ${名}`)
    try {
      render(pages[名](props))
    } catch (e) {
      throw new Error(`${名} 渲染失败：${String(e?.message ?? e)}`)
    }
  }
})

console.log(`\n${pass} 通过 · ${fail} 失败`)
process.exit(fail ? 1 : 0)
