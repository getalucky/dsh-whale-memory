/**
 * persona.js —— 人格沉淀与闸门（阶段 6 / 文档 8.6）
 *
 * 记忆是原料，人格是沉淀物，中间必须有闸门：
 *   候选记忆 → 规则蒸馏出候选 patch → 人工 apply → 版本归档，可回滚。
 * 模型没有直接改 persona.md 的权限；本模块只改 EVOLVABLE 区块，
 * 区块外的身份、权限、底线一律不碰。
 *
 * 目前蒸馏是规则版（不调 LLM）：只认"说话方式"类的明确偏好/纠正，
 * 够 2 条证据，或者出现"以后都/别再"这种明确指令才提案。
 */

import { appendFile, copyFile, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { listScopes } from './store.js'
import { refreshTrustStamp } from './trust.js'
import { runProbes } from './probes.js'
import { samplePersona, reviewRule } from './personadistill.js'
import { llmReady, personaPatch, reviewReady, reviewSeparate, personaVerdicts } from './llm.js'

export const PERSONA = {
  tokenLimit: 1200,
  meta: 'persona_meta.json',
  archiveDir: 'persona_archive',
  proposal: 'persona_proposal.json',
  changelog: 'persona_changelog.md',
}

const RE_CORE = /<!-- PERSONA:CORE:START -->[\s\S]*?<!-- PERSONA:CORE:END -->/
const RE_EVO = /<!-- PERSONA:EVOLVABLE:START -->([\s\S]*?)<!-- PERSONA:EVOLVABLE:END -->/

/** 注入前去掉区块注释：它们只给蒸馏器看，不该占 system prompt 预算。 */
export function stripMarkers(text) {
  return String(text ?? '')
    .replace(/^\s*<!-- PERSONA:(?:CORE|EVOLVABLE):(?:START|END) -->\s*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function estimateTokens(text) {
  const t = String(text ?? '')
  const cjk = (t.match(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) || []).length
  return Math.ceil(cjk + (t.length - cjk) / 3.5)
}

export function personaTokens(text) {
  return estimateTokens(stripMarkers(text))
}

export function parsePersona(text) {
  const src = String(text ?? '')
  const evo = RE_EVO.exec(src)
  return {
    hasCore: RE_CORE.test(src),
    hasEvolvable: Boolean(evo),
    core: (RE_CORE.exec(src)?.[0] || '').replace(/<!--[^>]*-->/g, '').trim(),
    evolvable: evo ? evo[1].trim() : '',
  }
}

export function hashOf(text) {
  return createHash('sha1').update(String(text ?? ''), 'utf8').digest('hex').slice(0, 16)
}

async function readText(file, fallback = '') {
  try { return await readFile(file, 'utf8') } catch { return fallback }
}

async function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmp, text, 'utf8')
  await rename(tmp, file)
}

export async function readMeta(root) {
  try {
    return JSON.parse(await readText(join(root, PERSONA.meta), '{}'))
  } catch {
    return {}
  }
}

async function writeMeta(root, meta) {
  await writeAtomic(join(root, PERSONA.meta), JSON.stringify(meta, null, 2))
}

export async function readPersona(root) {
  return readText(join(root, 'persona.md'), '')
}

/**
 * 从记忆里挑人格候选。规则版，只认"说话方式"的明确信号。
 * @returns {{themes:object[], sources:number}}
 */
export async function collectCandidates(root) {
  const scopes = await listScopes(root)
  const themes = new Map()
  let sources = 0

  const push = (key, rule, item, scope, explicit) => {
    if (!themes.has(key)) themes.set(key, { key, rule, evidence: [], explicit: false })
    const t = themes.get(key)
    if (t.evidence.length < 5) t.evidence.push({ id: item.id, scope, text: String(item.text).slice(0, 90) })
    if (explicit) t.explicit = true
  }

  for (const sc of scopes) {
    for (const it of sc.items || []) {
      if (!it || it.state === 'archived' || it.state === 'superseded' || it.state === 'expired') continue
      const text = String(it.text || '')
      if (!text) continue
      sources += 1
      const explicit = /以后都|别再|以后别|不要再用|一律/.test(text)

      if (/别用\s*(emoji|表情)|不要表情|少发\s*emoji|表情太多/i.test(text)) {
        push('emoji', '少用 emoji 和颜文字，一条最多一个，正事时不用。', it, sc.scope, explicit)
      }
      if (/先给结论|别绕|说重点|话太多|太长|啰嗦/.test(text) && !/作业|文章/.test(text)) {
        push('concise', '回答先给结论，别绕弯；聊天窗口别写长。', it, sc.scope, explicit)
      }
      if (/免责声明|别道歉|不用道歉|别解释那么多/.test(text)) {
        push('no-disclaimer', '不要加免责声明和多余铺垫。', it, sc.scope, explicit)
      }
      const m = /(?:以后)?叫我([^\s，。！？]{1,6})/.exec(text)
      if (m && m[1] && !/爹|老爹/.test(m[1])) {
        push(`address:${m[1]}`, `称呼：可以叫他「${m[1]}」。`, it, sc.scope, explicit)
      }
    }
  }

  const out = []
  for (const t of themes.values()) {
    if (t.evidence.length >= 2 || t.explicit) out.push(t)
  }
  return { themes: out, sources }
}

/**
 * 生成候选 patch（只写文件，不生效）。
 *
 * 生成 / 审查分离（文档 8.6）：生成阶段只看脱敏后的结构化样本；
 * 审查阶段先跑确定性检查，再可选地调独立审查模型，两关都过才进提案。
 * 没配 LLM 就退回规则候选，行为跟旧版一致。
 *
 * @returns {Promise<object>} proposal
 */
export async function propose(root, { fetchImpl } = {}) {
  const text = await readPersona(root)
  if (!text) throw new Error('没有 persona.md')
  const blocks = parsePersona(text)
  if (!blocks.hasEvolvable) throw new Error('persona.md 缺少 EVOLVABLE 区块，先加标记')

  // 采样门：命令 / 日志 / 凭据 / 无关闲聊不进样本，按分片轮转防偏
  const { samples, knownIds, stats } = await samplePersona(root).catch(() => ({
    samples: [], knownIds: new Set(), stats: { scopes: 0, skipped: 0, total: 0 },
  }))

  const { themes, sources } = await collectCandidates(root)
  let generator = 'rules'
  const raw = themes.map((t) => ({
    key: t.key,
    rule: t.rule,
    evidence: t.evidence.map((e) => ({ id: e.id, scope: e.scope, text: String(e.text).slice(0, 80) })),
  }))

  // 生成阶段：只看样本 id + 脱敏摘要，不看原始聊天、不看 source_quote
  if (llmReady() && samples.length) {
    const patch = await personaPatch(samples, blocks.evolvable, { fetchImpl })
    if (patch?.length) {
      generator = 'llm'
      const byId = new Map(samples.map((s) => [s.id, s]))
      for (const a of patch) {
        raw.push({
          key: a.rule.slice(0, 8),
          rule: a.rule,
          evidence: a.evidence.map((id) => ({ id, scope: byId.get(id)?.scope || '', text: byId.get(id)?.text || '' })),
        })
      }
    } else {
      generator = 'rules(fallback)'
    }
  }

  // 确定性审查：证据在库里、不写事件/日期/号码/路径/凭据、不重复、不超预算
  const seen = new Set()
  const accepted = []
  const rejected = []
  let tokens = personaTokens(text)
  for (const a of raw) {
    if (seen.has(a.rule.slice(0, 8))) continue
    seen.add(a.rule.slice(0, 8))
    const ids = (a.evidence || []).map((e) => e.id)
    const rv = reviewRule(a.rule, {
      evidence: ids, knownIds, current: blocks.evolvable, tokens, limit: PERSONA.tokenLimit,
    })
    if (!rv.ok) {
      rejected.push({ rule: a.rule, why: rv.why, evidence: ids.length })
      continue
    }
    tokens += estimateTokens(rv.rule)
    accepted.push({ ...a, rule: rv.rule })
  }

  // 独立审查模型（可选）：只收到候选 + 结构化证据，不看原始聊天
  let reviewer = 'rules'
  if (reviewReady() && accepted.length) {
    const verdicts = await personaVerdicts(accepted, samples, { fetchImpl })
    if (verdicts) {
      reviewer = reviewSeparate() ? 'llm(separate)' : 'llm(fallback)'
      const byRule = new Map(verdicts.map((v) => [v.rule.slice(0, 12), v]))
      for (const a of [...accepted]) {
        const v = byRule.get(a.rule.slice(0, 12))
        if (v && !v.approve) {
          accepted.splice(accepted.indexOf(a), 1)
          rejected.push({ rule: a.rule, why: `审查模型：${v.why || '不通过'}`, evidence: (a.evidence || []).length })
        }
      }
    }
  }

  const proposal = {
    schema: 2,
    at: new Date().toISOString(),
    baselineHash: hashOf(text),
    version: (await readMeta(root)).version ?? 0,
    sources,
    samples: { count: samples.length, scopes: stats.scopes, skipped: stats.skipped, total: stats.total },
    generator,
    reviewer,
    budget: { tokens: personaTokens(text), limit: PERSONA.tokenLimit },
    additions: accepted,
    rejected,
    warnings: [
      accepted.length ? '' : '没有新的候选；现有区块已覆盖，或证据不足',
      personaTokens(text) > PERSONA.tokenLimit ? '当前人格已超预算，先压缩再追加' : '',
      rejected.length ? `${rejected.length} 条被审查拦下，原因见 rejected` : '',
    ].filter(Boolean),
  }
  await writeAtomic(join(root, PERSONA.proposal), JSON.stringify(proposal, null, 2))
  return proposal
}

/**
 * 应用提案（人工确认后调用）。只改 EVOLVABLE 区块，超预算或基线变了就拒绝。
 * 写盘前跑一遍人格探针：通过项数比改前少，说明这条规则把人设改坏了，直接拒绝。
 */
export async function applyProposal(root, file = join(root, PERSONA.proposal)) {
  let proposal
  try { proposal = JSON.parse(await readText(file, '')) } catch { throw new Error('提案文件读不了') }
  if (!Array.isArray(proposal.additions)) throw new Error('提案格式不对')

  const text = await readPersona(root)
  if (hashOf(text) !== proposal.baselineHash) {
    throw new Error('冲突：提案生成后 persona.md 被改过，请重新 propose')
  }
  const m = RE_EVO.exec(text)
  if (!m) throw new Error('persona.md 缺少 EVOLVABLE 区块')
  if (!proposal.additions.length) return { applied: 0, version: (await readMeta(root)).version ?? 0 }

  const known = m[1]
  const lines = proposal.additions
    .map((a) => String(a.rule || '').trim())
    .filter((x) => x && !known.includes(x.slice(0, 8)))
  if (!lines.length) return { applied: 0, version: (await readMeta(root)).version ?? 0 }

  const nextEvo = `${m[1].trimEnd()}\n${lines.join('\n')}\n`
  const next = text.replace(RE_EVO, `<!-- PERSONA:EVOLVABLE:START -->\n${nextEvo}<!-- PERSONA:EVOLVABLE:END -->`)

  const tokens = personaTokens(next)
  if (tokens > PERSONA.tokenLimit) throw new Error(`超出人格预算：${tokens}/${PERSONA.tokenLimit} tokens`)

  const before = runProbes(text, parsePersona(text), personaTokens(text))
  const after = runProbes(next, parsePersona(next), tokens)
  if (after.passed < before.passed) {
    const why = after.failed.filter((f) => !before.failed.some((b) => b.id === f.id)).map((f) => f.name)
    throw new Error(`人格探针回退：${after.passed}/${after.total} < 改前 ${before.passed}/${before.total}（${why.join('、')}）`)
  }

  const meta = await readMeta(root)
  const version = (meta.version ?? 0) + 1
  const dir = join(root, PERSONA.archiveDir)
  await mkdir(dir, { recursive: true })
  await copyFile(join(root, 'persona.md'), join(dir, `v${version - 1 || 0}.md`))

  await writeAtomic(join(root, 'persona.md'), next)
  await writeMeta(root, {
    version,
    updatedAt: new Date().toISOString(),
    hash: hashOf(next),
    source: proposal.at || '',
    applied: lines,
    probes: { passed: after.passed, total: after.total },
  })
  await appendChangelog(root, {
    version,
    at: new Date().toISOString(),
    applied: lines,
    evidence: [...new Set(proposal.additions.flatMap((a) => (a.evidence || []).map((e) => e.id)))].filter(Boolean),
    source: proposal.at || '',
    probes: `${after.passed}/${after.total}`,
  }).catch(() => {})
  await refreshTrustStamp(root).catch(() => {})
  return { applied: lines.length, version, tokens, probes: after }
}

/** 人格变更日志：追加式，一条变更一段，谁都能翻。 */
export async function appendChangelog(root, entry) {
  const file = join(root, PERSONA.changelog)
  const fresh = !existsSync(file)
  const block = [
    fresh ? '# 人格变更日志\n' : '',
    `## v${entry.version} · ${entry.at}`,
    `- 探针：${entry.probes}`,
    ...entry.applied.map((r) => `- 新增：${r}`),
    entry.evidence?.length ? `- 依据：${entry.evidence.join('、')}` : '- 依据：（无）',
    `- 提案生成于：${entry.source || '（未知）'}`,
    '',
  ].join('\n')
  await appendFile(file, `${block}\n`, 'utf8')
}

/** 回滚到指定版本（默认上一版），回滚本身也留档。 */
export async function rollback(root, version) {
  const meta = await readMeta(root)
  const cur = meta.version ?? 0
  const target = Number.isFinite(Number(version)) ? Number(version) : cur - 1
  if (target < 0) throw new Error('没有可回滚的版本')
  const file = join(root, PERSONA.archiveDir, `v${target}.md`)
  if (!existsSync(file)) throw new Error(`归档里没有 v${target}`)
  const text = await readText(file, '')
  if (!text) throw new Error(`v${target} 是空的`)

  const dir = join(root, PERSONA.archiveDir)
  await copyFile(join(root, 'persona.md'), join(dir, `v${cur}-before-rollback.md`))
  await writeAtomic(join(root, 'persona.md'), text)
  await writeMeta(root, {
    version: target,
    updatedAt: new Date().toISOString(),
    hash: hashOf(text),
    rolledBackFrom: cur,
  })
  await refreshTrustStamp(root).catch(() => {})
  return { version: target, tokens: personaTokens(text) }
}

/** 单独跑一遍探针（给 CLI 的 probe 命令和设置页用）。 */
export async function probePersona(root) {
  const text = await readPersona(root)
  if (!text) throw new Error('没有 persona.md')
  return runProbes(text, parsePersona(text), personaTokens(text))
}

/** 状态：预算、版本、区块、归档、探针。 */
export async function status(root) {
  const text = await readPersona(root)
  const blocks = parsePersona(text)
  const meta = await readMeta(root)
  let archive = []
  try { archive = (await readdir(join(root, PERSONA.archiveDir))).sort() } catch { archive = [] }
  const probes = text ? runProbes(text, blocks, personaTokens(text)) : { passed: 0, total: 0, failed: [] }
  return {
    exists: Boolean(text),
    tokens: personaTokens(text),
    limit: PERSONA.tokenLimit,
    overBudget: personaTokens(text) > PERSONA.tokenLimit,
    version: meta.version ?? 0,
    hasCore: blocks.hasCore,
    hasEvolvable: blocks.hasEvolvable,
    archive,
    probes,
  }
}
