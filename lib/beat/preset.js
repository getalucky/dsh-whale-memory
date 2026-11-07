/**
 * beat/preset.js —— beat agent 预设安装/校验
 *
 * web_search 不是全局工具，是预设里的 tool-web 挂上去的。没有预设，
 * 闲逛 agent 是裸的，连搜索都看不见；这时 beat 应该保持关闭，而不是
 * 白烧 token。安装只写 .agent-presets/beat/，已有文件不覆盖。
 */

import { copyFile, mkdir, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const FILES = ['preset.yml', 'agent.cordis.yml']

export function dshHome() {
  return String(process.env.DSH_HOME || join(homedir(), '.dsh')).replace(/\\/g, '/').replace(/\/+$/, '')
}

export function presetRoot() {
  return join(dshHome(), '.agent-presets', 'beat')
}

function assetDir() {
  try {
    return fileURLToPath(new URL('../../assets/presets/beat/', import.meta.url))
  } catch {
    return ''
  }
}

export async function presetStatus() {
  const dir = presetRoot()
  const out = { dir, files: {}, ok: true }
  for (const f of FILES) {
    const file = join(dir, f)
    out.files[f] = existsSync(file)
    if (!out.files[f]) out.ok = false
  }
  return out
}

/**
 * 装预设。已有文件默认不覆盖；force 才还原成模板。
 * @returns {Promise<{ok:boolean, dir:string, installed:string[], skipped:string[], why?:string}>}
 */
export async function ensurePreset({ force = false, log } = {}) {
  const dir = presetRoot()
  const src = assetDir()
  if (!src || !existsSync(join(src, FILES[0]))) {
    log?.('[whale] beat 预设模板缺失，闲逛无法搜索；beat 保持关闭')
    return { ok: false, dir, installed: [], skipped: [], why: 'assets-missing' }
  }
  await mkdir(dir, { recursive: true })
  const installed = []
  const skipped = []
  for (const f of FILES) {
    const to = join(dir, f)
    if (!force && existsSync(to)) { skipped.push(f); continue }
    await copyFile(join(src, f), to)
    installed.push(f)
  }
  if (installed.length) log?.(`[whale] beat 预设已安装 · ${dir}`)
  return { ok: true, dir, installed, skipped }
}

/** 只读校验：给启动/CLI 用。 */
export async function verifyPreset() {
  const st = await presetStatus()
  if (!st.ok) return { ok: false, why: 'preset-missing', dir: st.dir }
  try {
    const n = (await readdir(st.dir)).length
    return { ok: n > 0, dir: st.dir }
  } catch {
    return { ok: false, why: 'preset-unreadable', dir: st.dir }
  }
}
