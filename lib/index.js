/**
 * index.js —— dsh-whale-memory 入口
 *
 * 做什么：
 *   1. 固定人格（persona.md）挂进所有会话的 system prompt（persona.scope=bridge 可只挂桥接）
 *   2. 对话按 sessionId 收进 staging
 *   3. 空闲蒸馏成记忆条目，按 QQ 号/群号分片
 *   4. 每小时算一次遗忘/归档
 *   5. 三个工具：memory_recall / profile_show / memory_save
 *
 * 不做什么：不建会话、不刷 B 站、不主动说话。人格是固定的，记忆会淡。
 */

import { copyFile, stat } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { rootDir, ensureDirs, logLine, listScopes, paths, saveScope, saveScopeMeta, auditWrite } from './store.js'
import { registerInjection, startMemoryRefresh } from './inject.js'
import { registerIngest } from './ingest.js'
import { registerTools } from './tools.js'
import { registerWebApi } from './webapi.js'
import { setConfigRoot } from './llm.js'
import { refreshGraph } from './graph.js'
import { buildProfile, buildMembers } from './profile.js'
import { startDistillLoop } from './distill.js'
import { startInboundLoop } from './inbound.js'
import { startForgetLoop } from './forget.js'
import { startDeepenLoop } from './deepen.js'
import { sourceCacheInfo, preloadSources } from './source.js'
import { verifyScope } from './vault.js'
import { preloadTrust } from './trust.js'
import { startPersonaLoop } from './personaloop.js'
import { gateMode } from './gate.js'

export const name = 'dsh-whale-memory'

/**
 * 版本号只认 package.json。
 * 以前这里写死 '0.3.0'，包升到 0.4.0 了日志和总览页还报旧号——
 * 「新代码上没上」反而看不出来。读不到就报 unknown，别再编一个。
 */
function 读包版本() {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    return pkg.version || 'unknown'
  } catch {
    return 'unknown'
  }
}

export const VERSION = 读包版本()

// 数组，别拆成对象（宿主会把后者覆盖前者）
export const inject = ['tools']

const here = dirname(fileURLToPath(import.meta.url))

export function apply(ctx, baseConfig = {}) {
  const root = baseConfig.root || process.env.DSH_MEMORY_HOME || rootDir()
  // 设置页写的模型配置和库在同一个目录，先把这个根告诉 llm.js
  setConfigRoot(root)
  const log = (...a) => {
    const msg = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')
    ctx?.logger?.info?.(msg)
    logLine(root, msg).catch(() => {})
  }
  const disposers = []
  let distill = null
  let forget = null
  let deepen = null
  let personaAuto = null
  let inbound = null

  async function boot() {
    await ensureDirs(root)
    // 人格文件：库里有就用库里的（可改），没有就把插件自带的复制过去
    const personaFile = paths(root).persona
    const repoPersona = join(here, '..', 'persona.md')
    if (!existsSync(personaFile)) {
      if (existsSync(repoPersona)) await copyFile(repoPersona, personaFile)
    } else if (existsSync(repoPersona)) {
      // 库里的优先（可以改），但插件那份更新时得喊一声，不然改了没生效还找不到原因
      const [a, b] = await Promise.all([
        stat(repoPersona).catch(() => null),
        stat(personaFile).catch(() => null),
      ])
      if (a && b && a.mtimeMs > b.mtimeMs + 1000) {
        log('[whale] 插件自带 persona.md 比库里新，但库里的优先，不会自动覆盖；要生效得手动拷过去')
      }
    }

    // 先把桥接绑定表读进缓存：agent/created 是同步回调，只能查缓存。
    // 必须在注册监听之前完成，否则启动瞬间创建的会话会被当成「非桥接」跳过。
    const trust = await preloadTrust(root).catch(() => ({ usable: true, origin: 'local' }))
    const pre = await preloadSources().catch(() => ({ ok: false, sessions: 0 }))
    log(`[whale] 桥接绑定预热 · ${pre.ok ? `${pre.sessions} 条` : '读不到'}`)

    const off = registerInjection(ctx, { root, log, persona: baseConfig.persona ?? {} })
    if (typeof off === 'function') disposers.push(off)

    // 记忆段巡检：分片文件一变就重渲染，别让长会话读着启动时的旧快照
    const refresh = startMemoryRefresh({ root, log })
    disposers.push(() => refresh.dispose())

    if (trust.usable) {
      const offIngest = registerIngest(ctx, { root, log })
      if (typeof offIngest === 'function') disposers.push(offIngest)
    } else {
      log('[whale] 外部记忆库未信任：跳过采集与整理；运行 node tools/memory-trust.mjs trust 后重启')
    }

    if (ctx.tools?.register) {
      const t = registerTools(ctx, { root, log, gate: baseConfig.gate ?? {} })
      if (t?.dispose) disposers.push(() => t.dispose())
    }

    // 界面接口：webServer 是可选服务，不能写进 inject（老宿主没有会整个 apply 卡住）。
    const mountApi = (c) => {
      try {
        const api = registerWebApi(c, { root, log, version: VERSION, gate: baseConfig.gate ?? {} })
        if (api) disposers.push(() => api.dispose())
      } catch (e) {
        log?.(`[whale] 界面接口挂载失败 ${String(e?.message ?? e).slice(0, 160)}`)
      }
    }
    try {
      if (typeof ctx.inject === 'function') ctx.inject(['webServer'], mountApi)
      else if (ctx.webServer) mountApi(ctx)
      else log?.('[whale] 没有 webServer 服务，界面接口跳过')
    } catch (e) {
      log?.(`[whale] 界面接口等待失败 ${String(e?.message ?? e).slice(0, 160)}`)
    }

    if (trust.usable) {
      distill = startDistillLoop({ root, log, ...(baseConfig.distill ?? {}) })
      forget = startForgetLoop({ root, log, cfg: baseConfig.forget ?? {} })
      deepen = startDeepenLoop({ root, log, listScopes, saveScope, auditWrite })
      // 外部账本（B站鱼塘、投递箱、其他插件注册的 provider）单向拉进来（见 inbound.js）
      inbound = startInboundLoop({ root, log, ...(baseConfig.inbound ?? {}) })
      // 人格自动迭代：只生成提案，自动发布要过 24h/100 条/每周一次/连续 3 次人工通过
      if (process.env.DSH_MEMORY_PERSONA_AUTO !== 'off' && baseConfig.persona?.auto !== false) {
        personaAuto = startPersonaLoop({
          root,
          log,
          cfg: typeof baseConfig.persona?.auto === 'object' ? baseConfig.persona.auto : {},
          gate: gateMode(baseConfig.gate ?? {}),
        })
      }
    }

    const scopes = await listScopes(root).catch(() => [])
    // 先把图谱按现有分片重建一次，界面打开就有东西看；顺带把画像算出来
    try {
      const g = await refreshGraph(root, scopes)
      let n = 0
      for (const sc of scopes) {
        const before = sc.profile?.summary ?? ''
        sc.profile = buildProfile(sc, g)
        sc.members = buildMembers(sc)
        if (sc.profile.summary !== before) {
          // 只写 meta：画像变了不代表条目变了，别顺带重写主库和副库
          await saveScopeMeta(root, sc)
          n += 1
        }
      }
      // 主副库一致性自检：文件数对不上就在日志里点名，并给出修复入口
      const bad = []
      for (const sc of scopes) {
        const v = await verifyScope(root, sc.kind, sc.id, sc).catch(() => ({ ok: false, files: -1, items: -1 }))
        if (!v.ok) bad.push(`${sc.scope}(主库${v.files}/条目${v.items})`)
      }
      log(`[whale] 图谱就绪 · 节点 ${g.nodes.length} · 边 ${g.edges.length} · 画像更新 ${n}${bad.length ? ` · 主副库不一致：${bad.join('、')}（跑 tools/rebuild-index.mjs）` : ''}`)
    } catch (e) {
      log(`[whale] 图谱重建失败 ${String(e?.message ?? e).slice(0, 120)}`)
    }
    const personaScope = String(baseConfig.persona?.scope || process.env.DSH_MEMORY_PERSONA_SCOPE || 'all').toLowerCase()
    log(`[whale] 启动 · ${VERSION} · 根 ${root} · 来源 ${trust.origin ?? 'local'}${trust.usable ? '' : '（未信任）'} · 分片 ${scopes.length} · 会话绑定 ${sourceCacheInfo().sessions} · 人格 ${personaScope === 'bridge' ? '仅桥接' : '全局'}`)
  }

  boot().catch((e) => {
    console.error('[whale] 启动失败', e)
    logLine(root, `启动失败 ${String(e?.stack ?? e).slice(0, 500)}`).catch(() => {})
  })

  const dispose = () => {
    try { distill?.dispose?.() } catch { /* ignore */ }
    try { forget?.dispose?.() } catch { /* ignore */ }
    try { inbound?.dispose?.() } catch { /* ignore */ }
    try { deepen?.dispose?.() } catch { /* ignore */ }
    try { personaAuto?.dispose?.() } catch { /* ignore */ }
    for (const d of disposers) { try { d() } catch { /* ignore */ } }
  }
  ctx.on?.('dispose', dispose)

  return { dispose }
}