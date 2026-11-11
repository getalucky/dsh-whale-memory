/**
 * backup.mjs —— 一键备份 / 恢复
 *
 * 验的是：备份带 scopes/persona、设置里不留 key、manifest 校验对得上；
 * 恢复会先存一份现在的库；校验不通过时拒绝恢复。
 */
import assert from 'node:assert'
import { execFileSync } from 'node:child_process'
import { mkdirSync, existsSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('..', import.meta.url))
const script = join(here, 'tools', 'backup.mjs')

let pass = 0
const ok = (name) => { pass += 1; console.log('  ok', name) }

const 家 = await mkdtemp(join(tmpdir(), 'whale-backup-'))
const 库 = join(家, 'dsh-memory')
const 备 = join(家, 'bk')
const 环境 = { ...process.env, DSH_HOME: 家, DSH_MEMORY_HOME: 库 }

const 跑 = (...args) => execFileSync(process.execPath, [script, ...args], { env: 环境, encoding: 'utf8' })

try {
  // 造一个小库
  mkdirSync(join(库, 'scopes', 'private-1', 'memory_full'), { recursive: true })
  writeFileSync(join(库, 'scopes', 'private-1', 'meta.json'), '{"scope":"private:1","kind":"private","id":"1"}\n')
  writeFileSync(join(库, 'scopes', 'private-1', 'memory_full', 'm_1.md'), '# 一条记忆\n')
  writeFileSync(join(库, 'persona.md'), '# 人格\n')
  writeFileSync(join(库, 'settings.json'), JSON.stringify({
    llm: { base: 'http://x', model: 'm', key: 'sk-secret' },
    review_question: '我们现在是什么关系',
  }))
  mkdirSync(join(库, 'logs'), { recursive: true })
  writeFileSync(join(库, 'logs', 'x.log'), '日志不该进备份\n')

  const 输出 = 跑('--out', 备)
  assert.ok(/备份好了/.test(输出), 输出)
  assert.ok(existsSync(join(备, 'manifest.json')))
  assert.ok(existsSync(join(备, 'scopes', 'private-1', 'meta.json')))
  assert.ok(existsSync(join(备, 'persona.md')))
  assert.ok(!existsSync(join(备, 'logs')), '日志默认不进备份')
  ok('备份：核心内容在，日志不在')

  const 设置 = readFileSync(join(备, 'settings.json'), 'utf8')
  assert.ok(!设置.includes('sk-secret'), '设置里的 key 不能带出去')
  assert.ok(设置.includes('review_question'), '非敏感配置要留着')
  ok('设置去掉 key，其余保留')

  const manifest = JSON.parse(readFileSync(join(备, 'manifest.json'), 'utf8'))
  assert.equal(manifest.format, 'whale-memory-backup')
  assert.ok(manifest.files >= 4)
  assert.ok(manifest.checksum)

  // 恢复预演：不加 --yes 不动手
  const 预演 = 跑('--restore', 备)
  assert.ok(/还没动手/.test(预演), 预演)
  ok('恢复预演不覆盖')

  // 改掉一份内容，恢复后应当回到备份里的版本
  writeFileSync(join(库, 'scopes', 'private-1', 'meta.json'), '{"scope":"private:1","broken":true}\n')
  const 恢复 = 跑('--restore', 备, '--yes')
  assert.ok(/恢复完成/.test(恢复), 恢复)
  assert.ok(readFileSync(join(库, 'scopes', 'private-1', 'meta.json'), 'utf8').includes('private:1'))
  ok('恢复：内容回到备份版本')

  const 备份根 = join(家, 'backups')
  assert.ok(existsSync(备份根))
  assert.ok(readdirSync(备份根).some((n) => n.startsWith('pre-restore-')), '恢复前要先存一份现在的库')
  ok('恢复前自动留档')

  // 损坏的备份要拒绝
  writeFileSync(join(备, 'persona.md'), '# 被改过\n')
  let 失败 = ''
  try { 跑('--restore', 备, '--yes') } catch (e) { 失败 = String(e.stdout || '') + String(e.stderr || '') }
  assert.ok(/校验不通过/.test(失败), 失败)
  ok('校验不通过拒绝恢复')

  console.log(`\n全部通过：${pass} 项`)
} finally {
  rmSync(家, { recursive: true, force: true })
}
