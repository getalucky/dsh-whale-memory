/**
 * namespace.js —— global / project 命名空间分层（文档 4.7）
 *
 * 两类命名空间，各有独立的 memory_index.md 与 memory_full/：
 *   · global  = 跨项目个人偏好，落在 DSH_HOME/dsh-memory（现有库，不搬家）
 *   · project = 跟仓库绑的共识，落在 <repo>/.dsh/storages/whale-memory，可随 git 提交分享
 *
 * 识别方式：会话 cwd 往上找仓库标记（.git / package.json / AGENTS.md /
 * pyproject.toml / Cargo.toml / go.mod），最多 6 层。找不到就不给 project
 * 命名空间——宁可只进个人库，也别把记忆写进用户家目录或盘符根目录。
 *
 * 写入口默认仍然是 global：自动蒸馏出来的对话摘要不该被提交进别人的仓库。
 * 只有明确 namespace=project 的手动写入才落仓库库，这也是「团队共识」的本意。
 *
 * 关闭：DSH_MEMORY_PROJECT_SCOPE=off（或 0 / false）。
 */

import { existsSync, statSync } from 'node:fs'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

export const PROJECT_KIND = 'project'
export const MARKERS = ['.git', 'package.json', 'AGENTS.md', 'pyproject.toml', 'Cargo.toml', 'go.mod']
export const MAX_DEPTH = 6

const cache = new Map()

/** 仓库命名空间开关：默认开；off 退回只有 global。 */
export function projectScopeEnabled() {
  const v = String(process.env.DSH_MEMORY_PROJECT_SCOPE ?? 'on').toLowerCase()
  return !(v === 'off' || v === '0' || v === 'false')
}

/** 归一化：统一正斜杠、去尾斜杠、相对路径按当前进程目录解析。 */
function normalize(p) {
  const s = String(p ?? '').trim()
  if (!s) return ''
  try { return resolve(s).replace(/\\/g, '/').replace(/\/+$/, '') } catch { return '' }
}

function dshHome() {
  return normalize(process.env.DSH_HOME || join(homedir(), '.dsh'))
}

/** 盘符根 / 家目录根：往上找到这里就停，别把整个盘当仓库。 */
function isBoundary(dir) {
  return dirname(dir) === dir
}

function insideDsh(dir) {
  const home = dshHome()
  if (!home) return false
  return dir === home || dir.startsWith(`${home}/`)
}

function describe(dir) {
  const base = basename(dir) || 'project'
  const slug = base
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32) || 'project'
  const hash = createHash('sha1').update(dir.toLowerCase()).digest('hex').slice(0, 6)
  return {
    dir,
    kind: PROJECT_KIND,
    id: `${slug}-${hash}`,
    label: `仓库 ${base}`,
    // 文档要求：project 库落在 cwd 下的 .dsh/storages，跟着仓库走
    // 统一用正斜杠：Windows 上同一个目录不能因为写法不同进两份读缓存
    root: join(dir, '.dsh', 'storages', 'whale-memory').replace(/\\/g, '/'),
    scope: `${PROJECT_KIND}:${slug}-${hash}`,
  }
}

function findRoot(start) {
  let dir = start
  let st = null
  try { st = statSync(dir) } catch { return null }
  if (!st.isDirectory()) dir = dirname(dir)
  if (insideDsh(dir)) return null

  for (let i = 0; i <= MAX_DEPTH; i += 1) {
    if (isBoundary(dir)) return null
    if (MARKERS.some((m) => existsSync(join(dir, m)))) return describe(dir)
    const parent = dirname(dir)
    if (!parent || parent === dir) return null
    dir = parent
  }
  return null
}

/**
 * 会话 cwd → project 命名空间。认不出来返回 null（调用方退回 global）。
 * @returns {null | {dir:string, kind:string, id:string, label:string, root:string, scope:string}}
 */
export function projectOf(cwd) {
  if (!projectScopeEnabled()) return null
  const key = normalize(cwd)
  if (!key) return null
  if (cache.has(key)) return cache.get(key)
  const found = findRoot(key)
  cache.set(key, found)
  // 缓存只是省几次 stat，别无限长
  if (cache.size > 64) cache.delete(cache.keys().next().value)
  return found
}

/**
 * 会话挂载的两个根：project 在前（更具体），global 在后。
 * 没有 project 时只有 global —— 调用方不用写分支。
 */
export function mountRoots(globalRoot, ns) {
  if (ns?.root && normalize(ns.root) !== normalize(globalRoot)) return [ns.root, globalRoot]
  return [globalRoot]
}

/** 测试用：清掉 cwd 缓存（临时目录会复用路径）。 */
export function resetNamespaceCache() {
  cache.clear()
}

// ---- 仓库库登记簿 ----
//
// 遗忘/深化循环要覆盖仓库库，但它们只拿到 global 根，不能靠 cwd 现推。
// 第一次往仓库写记忆时把根登记到 global 库的 namespaces.json，循环照单跑。
// 登记失败不影响写入，最多是那个仓库暂时不衰减。

function registryFile(globalRoot) {
  return join(globalRoot, 'namespaces.json')
}

async function readRegistry(globalRoot) {
  try {
    const j = JSON.parse(await readFile(registryFile(globalRoot), 'utf8'))
    return Array.isArray(j?.projects) ? j.projects : []
  } catch {
    return []
  }
}

export async function registerProject(globalRoot, ns) {
  if (!ns?.root || !ns?.dir) return false
  const list = await readRegistry(globalRoot)
  const at = new Date().toISOString()
  const i = list.findIndex((x) => normalize(x.root) === normalize(ns.root))
  const row = { root: ns.root, dir: ns.dir, scope: ns.scope, label: ns.label, at }
  if (i >= 0) list[i] = { ...list[i], ...row }
  else list.push(row)
  const file = registryFile(globalRoot)
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmp, JSON.stringify({ projects: list }, null, 2), 'utf8')
  await rename(tmp, file)
  return true
}

/** 已登记的仓库库根（去重、保持登记顺序）。 */
export async function listProjectRoots(globalRoot) {
  const list = await readRegistry(globalRoot)
  const out = []
  for (const p of list) {
    const r = normalize(p?.root)
    if (!r || out.includes(r)) continue
    out.push(r)
  }
  return out
}
