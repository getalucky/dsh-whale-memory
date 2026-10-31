/**
 * memory-trust.mjs —— 外部记忆库信任门 CLI（阶段 8 / 文档 4.10）
 *
 *   node tools/memory-trust.mjs status
 *   node tools/memory-trust.mjs trust
 *   node tools/memory-trust.mjs revoke
 *   node tools/memory-trust.mjs verify
 *
 * 只在外部库（clone / 导入 / 解压）上需要。本地库默认 origin=local，直接可用。
 */
import { rootDir } from '../lib/store.js'
import { trustState, trust, revoke, preloadTrust } from '../lib/trust.js'

const root = process.env.DSH_MEMORY_HOME || rootDir()
const cmd = process.argv[2] || 'status'

try {
  if (cmd === 'status') {
    const s = await trustState(root, { recheck: true })
    console.log(`记忆库：${root}`)
    console.log(`来源：${s.origin} · ${s.usable ? '可用' : '未信任'}`)
    console.log(`信任时间：${s.trustedAt || '—'}`)
    console.log(`指纹：${s.stored || '—'}${s.current ? `（当前 ${s.current}${s.drift ? '，已变化' : ''}）` : ''}`)
  } else if (cmd === 'trust') {
    const s = await trust(root)
    console.log(`已信任：${s.origin} · ${s.current}`)
    console.log('重启 DSH 后生效（人格/记忆注入与工具都会恢复）。')
  } else if (cmd === 'revoke') {
    const s = await revoke(root)
    console.log(`已撤销：${s.origin} · ${s.usable ? '仍可用' : '已停用'}`)
  } else if (cmd === 'verify') {
    const s = await preloadTrust(root)
    console.log(`校验：${s.usable ? '通过' : '未通过'}${s.drift ? '（指纹变化，已撤销信任）' : ''}`)
    process.exitCode = s.usable ? 0 : 1
  } else {
    console.log('用法：status | trust | revoke | verify')
    process.exitCode = 1
  }
} catch (e) {
  console.error(`失败：${String(e?.message ?? e)}`)
  process.exitCode = 1
}
