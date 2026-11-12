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

import { listScopes, withWriteLock } from './store.js'
import { refreshTrustStamp } from './trust.js'
import { runProbes } from './probes.js'
import { samplePersona, reviewRule } from './personadistill.js'
import { llmReady, personaPatch, personaCompact, reviewReady, reviewSeparate, personaVerdicts } from './llm.js'
import { similarity } from './recall.js'
import { estimateTokens, personaTokenLimit } from './personalimit.js'
import { collectCompressions, inspectEvolvable } from './personaaudit.js'

export { estimateTokens }

export const PERSONA = {
  tokenLimit: personaTokenLimit(),
  meta: 'persona_meta.json',
  archiveDir: 'persona_archive',
  proposal: 'persona_proposal.json',
  rejected: 'persona_rejected.jsonl',
  changelog: 'persona_changelog.md',
  runs: 'persona_runs.jsonl',
  decisions: 'persona_decisions.jsonl',
}

/** 自动发布的硬门槛（文档 8.6 第三、五节）。 */
export const AUTO = {
  minMessages: 100,
  minHours: 24,
  minSamples: 20,
  minStreak: 3,
}

const RE_CORE = /<!-- PERSONA:CORE:START -->[\s\S]*?<!-- PERSONA:CORE:END -->/
const RE_EVO = /<!-- PERSONA:EVOLVABLE:START -->([\s\S]*?)<!-- PERSONA:EVOLVABLE:END -->/

/** 采样门的原因码翻成给人看的话。 */
function 采样原因(why) {
  return ({
    length: '正文太短或太长（<4 或 >200 字）',
    command: '命令 / 日志 / 代码片段 / 链接，不是聊天原话',
    secret: '含凭据，打码后整条丢弃',
    style: '不是讲「怎么说」的话，也不是偏好/关系条目',
  })[why] || why
}

/** 注入前去掉区块注释：它们只给蒸馏器看，不该占 system prompt 预算。 */
export function stripMarkers(text) {
  return String(text ?? '')
    .replace(/^\s*<!-- PERSONA:(?:CORE|EVOLVABLE):(?:START|END) -->\s*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
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

/**
 * 读-改-写 meta。采集侧的计数和发布侧的状态都写这一个文件，
 * 不串行就会互相覆盖（跟分片写入是同一个坑）。
 */
export async function updateMeta(root, fn) {
  return withWriteLock(async () => {
    const meta = await readMeta(root)
    const next = (await fn({ ...meta })) || meta
    await writeMeta(root, next)
    return next
  })
}

/** 自然周的周一（本地时间），用来卡「每周最多一个 revision」。 */
export function weekKey(date = new Date()) {
  const d = new Date(date)
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7))
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** 下一个可发布日（下周一零点）。 */
export function nextWeekStart(date = new Date()) {
  const d = new Date(date)
  d.setHours(0, 0, 0, 0)
  const delta = (7 - ((d.getDay() + 6) % 7)) % 7 || 7
  d.setDate(d.getDate() + delta)
  return d
}

function dayText(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * 自动发布资格。三道门，任意一道没过就只生成提案、等人工：
 *   1. 本周还没发布过（每周最多一个 revision）
 *   2. 确认闸门在 enforce（warn 观察期不自动发）
 *   3. 连续 3 次人工通过
 */
export async function autoGate(root, { gate = 'enforce' } = {}) {
  const meta = await readMeta(root)
  const streak = meta.approvals?.streak ?? 0
  if (meta.lastPublishedWeek === weekKey()) {
    return { ok: false, why: `本周已发布 v${meta.version ?? 0}，下次可发布 ${dayText(nextWeekStart())}`, streak }
  }
  if (gate !== 'enforce') return { ok: false, why: `确认闸门在 ${gate}，自动发布要求 enforce`, streak }
  if (streak < AUTO.minStreak) return { ok: false, why: `连续人工通过 ${streak}/${AUTO.minStreak}`, streak }
  return { ok: true, streak }
}

/** 最近 30 天被拒过的规则前缀：同一提案别每周回来烦人。 */
export async function rejectedRules(root, days = 30) {
  const raw = await readText(join(root, PERSONA.rejected), '')
  const since = Date.now() - days * 24 * 3600 * 1000
  const out = new Set()
  for (const line of raw.split('\n').filter(Boolean)) {
    try {
      const r = JSON.parse(line)
      if (Date.parse(r.at) < since) continue
      for (const rule of r.rules || []) out.add(String(rule).slice(0, 8))
    } catch { /* 坏行跳过 */ }
  }
  return out
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
    // 只从本人独占的分片学说话方式：公共池是抄来的，群里是别人的话，
    // 仓库分片还会随 git 分享出去，都不能拿来训练人设。
    if (sc.kind !== 'local' && sc.kind !== 'private') continue
    for (const it of sc.items || []) {
      if (!it || ['archived', 'superseded', 'expired', 'suggested'].includes(it.state)) continue
      // 她的发言、闲逛素材、投递反馈都不该教人设怎么说话。
      if (it.speaker === 'her' || it.speaker === '她') continue
      if (String(it.source || '').startsWith('wander:')) continue
      if (it.reply_to) continue
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

/** 规则主题：判断两条规矩是不是在说同一件事。 */
function themeOf(text) {
  const t = String(text || '')
  if (/emoji|表情|颜文字/i.test(t)) return 'emoji'
  if (/先给结论|别绕|说重点|话太多|啰嗦|别列|不列/.test(t)) return 'concise'
  if (/免责|道歉|铺垫|解释太多|不解释/.test(t)) return 'disclaimer'
  // 只看明确的称呼词：引用里出现「主人」「本小姐」不代表这条在讲称呼
  if (/称呼|自称|叫他|喊他|管他叫/.test(t)) return 'address'
  return ''
}

/** 同主题也要字面够像，否则「都带 emoji」就能顶掉一整段别的规矩。 */
const THEME_MIN_SIM = 0.25
/** 旧行比新话长太多时，说明不是换说法，而是该走压缩：必须更像才允许换。 */
const SHORTEN_RATIO = 3
const SHORTEN_MIN_SIM = 0.35

/**
 * 找现有 EVOLVABLE 里可以被这条新规矩替换的旧行。
 * 同一主题优先，其次字符 bigram 相似度；新规矩不能明显比旧的长，
 * 也不能用一句短话顶掉一大段旧规矩（那种交给压缩，别丢内容）。
 * 只返回候选，不写盘。
 */
export function findReplacement(rule, evolvable, { maxSim = 0.5 } = {}) {
  const lines = String(evolvable || '').split('\n').map((l) => l.trim()).filter(Boolean)
  const theme = themeOf(rule)
  const fresh = String(rule || '').trim()
  const newTok = estimateTokens(fresh)
  let best = null
  for (const old of lines) {
    if (old === fresh) return null
    const sameTheme = Boolean(theme) && theme === themeOf(old)
    const sim = similarity(rule, old)
    if (sameTheme ? sim < THEME_MIN_SIM : sim < maxSim) continue
    const oldTok = estimateTokens(old)
    if (newTok > oldTok + 6) continue
    if (oldTok > newTok * SHORTEN_RATIO && sim < SHORTEN_MIN_SIM) continue
    const score = sim + (sameTheme ? 0.15 : 0)
    if (!best || score > best.score) {
      best = { old, theme: sameTheme ? theme : 'similar', sim: Number(sim.toFixed(3)), score }
    }
  }
  return best ? { old: best.old, theme: best.theme, sim: best.sim } : null
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
export async function propose(root, { fetchImpl, manual = false } = {}) {
  const text = await readPersona(root)
  if (!text) throw new Error('没有 persona.md')
  const blocks = parsePersona(text)
  if (!blocks.hasEvolvable) throw new Error('persona.md 缺少 EVOLVABLE 区块，先加标记')

  // 采样门：命令 / 日志 / 凭据 / 无关闲聊不进样本，按分片轮转防偏
  const { samples, knownIds, stats } = await samplePersona(root).catch(() => ({
    samples: [], knownIds: new Set(), stats: { scopes: 0, skipped: 0, total: 0 },
  }))

  // 手动触发也要样本门：不够就明确说还差多少，别拿三条记忆硬蒸馏一个人格。
  // 门槛看库里的有效条目总数，不看采样数——采样每分片只取 6 条，
  // 拿采样数当门槛会让只有两三个分片的库永远够不着 20。
  const pool = stats.total || 0
  if (manual && pool < AUTO.minSamples) {
    throw new Error(`有效样本 ${pool} 条，手动蒸馏至少 ${AUTO.minSamples} 条，还差 ${AUTO.minSamples - pool} 条`)
  }

  const denied = await rejectedRules(root)
  const { themes, sources } = await collectCandidates(root)
  const decisions = []
  // 每条候选怎么判的，全部记下来；提案文件会被下一轮覆盖，这份台账不会。
  const decide = (rule, action, stage, why, evidence = []) => {
    decisions.push({
      rule: String(rule || '').slice(0, 120),
      action,
      stage,
      why: String(why || '').slice(0, 160),
      evidence: evidence.slice(0, 5).map((e) => ({ id: e.id || '', scope: e.scope || '', text: String(e.text || '').slice(0, 60) })),
    })
  }
  // 写入前先收拾旧人设：逐行审视，能安全写短的先压，腾出额度再谈追加。
  // 规则版一定跑；配了蒸馏模型再让它补更聪明的精简，谁短用谁。
  let llmCompact = null
  if (llmReady()) {
    llmCompact = await personaCompact(
      blocks.evolvable.split('\n').map((s) => s.trim()).filter(Boolean),
      { fetchImpl },
    ).catch(() => null)
  }
  const { audit, compressions } = collectCompressions(blocks.evolvable, { llmCompact })
  // 审查基准要等「哪几行会被替换」定下来才能算：压缩和替换不能对同一行重复扣额度。
  // 原本因超预算被丢的候选，整理完可能就放得下；apply 时还会用真实文本硬检查一次。
  // 采样门：把「为什么没拿它当样本」也算一份判决，界面才答得出「没候选」。
  for (const [why, n] of Object.entries(stats.skipReasons || {})) {
    if (n) decide(`采样跳过 ${n} 条`, 'dropped', 'sample', `采样门：${采样原因(why)}`, [])
  }
  if (!themes.length) {
    decide('（规则候选）', 'dropped', 'generator', '规则生成 0 条：只认 emoji / 简洁 / 免责声明 / 称呼 这 4 类明确说话信号，需 ≥2 条证据或「以后都/别再」', [])
  }

  let generator = 'rules'
  const raw = []
  for (const t of themes) {
    const a = {
      key: t.key,
      rule: t.rule,
      evidence: t.evidence.map((e) => ({ id: e.id, scope: e.scope, text: String(e.text).slice(0, 80) })),
    }
    if (denied.has(a.rule.slice(0, 8))) {
      decide(a.rule, 'dropped', 'blacklist', '这条 30 天内被人工拒过，不再提', a.evidence)
      continue
    }
    raw.push(a)
  }

  // 生成阶段：只看样本 id + 脱敏摘要，不看原始聊天、不看 source_quote
  if (llmReady() && samples.length) {
    const patch = await personaPatch(samples, blocks.evolvable, { fetchImpl })
    if (patch?.length) {
      generator = 'llm'
      const byId = new Map(samples.map((s) => [s.id, s]))
      for (const a of patch) {
        if (denied.has(String(a.rule).slice(0, 8))) {
          decide(a.rule, 'dropped', 'blacklist', '这条 30 天内被人工拒过，不再提', [])
          continue
        }
        raw.push({
          key: a.rule.slice(0, 8),
          rule: a.rule,
          evidence: a.evidence.map((id) => ({ id, scope: byId.get(id)?.scope || '', text: byId.get(id)?.text || '' })),
        })
      }
    } else {
      generator = 'rules(fallback)'
      decide('（LLM 候选）', 'dropped', 'generator', '蒸馏模型没返回可用候选（空回复 / JSON 不合法 / 全被拦），退回规则候选', [])
    }
  }

  // 确定性审查：证据在库里、不写事件/日期/号码/路径/凭据、不重复、不超预算
  const accepted = []
  const rejected = []
  const replacements = []
  // 替换只看候选和原文，跟预算无关。先把「要换掉哪几行」全定下来：
  // 这样审查基准才能按整理后的真实占用算，压缩也不会和替换对同一行重复扣额度。
  const prepares = new Map()
  const replacedOld = new Set()
  const seenKeys = new Set()
  for (const a of raw) {
    const key = a.rule.slice(0, 8)
    if (seenKeys.has(key)) continue
    seenKeys.add(key)
    const rep = findReplacement(a.rule, blocks.evolvable)
    if (!rep || replacedOld.has(rep.old)) continue
    const ids = (a.evidence || []).map((e) => e.id)
    // 替换不查「和现有重复 / 超预算」，其余确定性审查一项不少
    const rv = reviewRule(a.rule, { evidence: ids, knownIds, current: '', tokens: 0, limit: PERSONA.tokenLimit })
    if (!rv.ok) continue
    prepares.set(key, { rep, rule: rv.rule, freed: estimateTokens(rep.old) - estimateTokens(rv.rule) })
    replacedOld.add(rep.old)
  }
  // 同一行不既压缩又替换：替换已经把这条更新了，压缩让位
  const plannedCompressions = compressions.filter((c) => !replacedOld.has(c.old))
  const plannedFreed = plannedCompressions.reduce((n, r) => n + r.freed, 0)
  // 审查基准从「整理后」的占用算起，替换按整行净腾出继续往下扣
  let tokens = Math.max(0, personaTokens(text) - plannedFreed)
  for (const p of prepares.values()) tokens = Math.max(0, tokens - p.freed)

  const seen = new Set()
  for (const a of raw) {
    const key = a.rule.slice(0, 8)
    if (seen.has(key)) {
      decide(a.rule, 'dropped', 'dedupe', '和同批另一条候选重复', a.evidence)
      continue
    }
    seen.add(key)
    const ids = (a.evidence || []).map((e) => e.id)
    const p = prepares.get(key)
    if (p) {
      replacements.push({
        old: p.rep.old,
        rule: p.rule,
        why: `同一主题「${p.rep.theme}」的旧说法（相似度 ${p.rep.sim}）`,
        theme: p.rep.theme,
        sim: p.rep.sim,
        freed: p.freed,
        evidence: a.evidence,
      })
      decide(p.rule, 'replaced', 'replace',
        `替换旧规矩「${p.rep.old.slice(0, 30)}…」${p.freed > 0 ? `，腾出 ${p.freed} tok` : ''}`, a.evidence)
      continue
    }
    const rv = reviewRule(a.rule, {
      evidence: ids, knownIds, current: blocks.evolvable, tokens, limit: PERSONA.tokenLimit,
    })
    if (!rv.ok) {
      rejected.push({ rule: a.rule, why: rv.why, evidence: ids.length })
      decide(a.rule, 'dropped', 'review', rv.why, a.evidence)
      continue
    }
    tokens += estimateTokens(rv.rule)
    accepted.push({ ...a, rule: rv.rule })
    decide(rv.rule, 'accepted', 'review', `确定性审查通过（证据 ${ids.length} 条）`, a.evidence)
  }

  // 独立审查模型（可选）：只收到候选 + 结构化证据，不看原始聊天。
  // 追加和替换都要过这一关，不能因为「只是换个说法」就绕过审查。
  let reviewer = 'rules'
  if (reviewReady() && (accepted.length || replacements.length)) {
    const verdicts = await personaVerdicts([...accepted, ...replacements], samples, { fetchImpl })
    if (verdicts) {
      reviewer = reviewSeparate() ? 'llm(separate)' : 'llm(fallback)'
      // 模型回话里的空格 / 标点可能和候选对不齐，按去空白后的前缀匹配，少漏判
      const norm = (s) => String(s || '').replace(/\s+/g, '').slice(0, 24)
      const byRule = new Map(verdicts.map((v) => [norm(v.rule), v]))
      const drop = (list) => {
        for (const a of [...list]) {
          const v = byRule.get(norm(a.rule))
          if (v && !v.approve) {
            list.splice(list.indexOf(a), 1)
            rejected.push({ rule: a.rule, why: `审查模型：${v.why || '不通过'}`, evidence: (a.evidence || []).length })
            decide(a.rule, 'dropped', 'review-llm', `审查模型：${v.why || '不通过'}`, a.evidence)
          }
        }
      }
      drop(accepted)
      drop(replacements)
    }
  }

  // 审查模型可能否决替换：被否决的旧行重新参与压缩，别白白让位
  const finalOld = new Set(replacements.map((r) => r.old))
  const finalCompressions = compressions.filter((c) => !finalOld.has(c.old))
  const compactFreedFinal = finalCompressions.reduce((n, r) => n + r.freed, 0)
  const budgetTokens = personaTokens(text)
  const headroom = PERSONA.tokenLimit - budgetTokens
  const reclaimable = replacements.reduce((n, r) => n + Math.max(0, r.freed), 0)
  // 独立审查可能丢掉部分替换，最终可用的额度按留下来的算
  const netReclaim = replacements.reduce((n, r) => n + r.freed, 0)
  const basis = Math.max(0, budgetTokens - compactFreedFinal - netReclaim)
  for (const c of finalCompressions) {
    decide(c.rule, 'compressed', 'compact', `${c.why}；约腾出 ${c.freed} tok`, [])
  }
  const proposal = {
    schema: 2,
    at: new Date().toISOString(),
    baselineHash: hashOf(text),
    version: (await readMeta(root)).version ?? 0,
    sources,
    samples: { count: samples.length, scopes: stats.scopes, skipped: stats.skipped, skipReasons: stats.skipReasons || {}, total: stats.total },
    generator,
    reviewer,
    budget: {
      tokens: budgetTokens,
      limit: PERSONA.tokenLimit,
      headroom,
      // 压缩旧规矩能腾出多少
      compactible: compactFreedFinal,
      // 替换旧说法能腾出多少
      reclaimable,
      // 动态预算：先收拾旧人设之后，真正可用的额度
      effective: Math.max(0, PERSONA.tokenLimit - basis),
      // 生成候选时的审查基准（按承诺整理后的占用算）
      basis,
    },
    // 旧人设逐行审视报告：哪些偏长、哪些重复、哪些只是示例
    audit,
    // 建议写短的旧行（整行精确替换，apply 时执行）
    compressions: finalCompressions,
    additions: accepted,
    // 跟现有规矩说同一件事、建议「换掉旧的」而不是追加的候选
    replacements,
    rejected,
    decisions,
    warnings: [
      (accepted.length || replacements.length || finalCompressions.length) ? '' : '没有新候选，也没有可压缩 / 可替换的旧规矩',
      generator === 'rules(fallback)' ? '蒸馏模型没给出候选，这次只用了规则生成' : '',
      finalCompressions.length ? `旧人设有 ${finalCompressions.length} 行可写短（约腾出 ${compactFreedFinal} tok）` : '',
      replacements.length ? `${replacements.length} 条建议替换旧说法（合计腾出 ${reclaimable} tok）` : '',
      headroom < 30 && !finalCompressions.length && !replacements.length
        ? `人格预算只剩 ${headroom} tok，这次旧人设也没找到能收拾的地方；可考虑调大 DSH_MEMORY_PERSONA_TOKENS`
        : '',
      personaTokens(text) > PERSONA.tokenLimit ? '当前人格已超预算，先压缩再追加' : '',
      rejected.length ? `${rejected.length} 条被审查拦下，原因见 rejected` : '',
    ].filter(Boolean),
  }
  await writeAtomic(join(root, PERSONA.proposal), JSON.stringify(proposal, null, 2))
  await writeDecisions(root, proposal.at, decisions)
  // 这一批消息和样本已经消费掉：下次再攒够 100 条 / 24 小时才重跑，
  // 提案没人审也不每小时重写一遍。
  await updateMeta(root, (m) => ({
    ...m,
    lastRunAt: proposal.at,
    pendingMessages: 0,
  })).catch(() => {})
  return proposal
}

/**
 * 应用提案（人工确认后调用）。只改 EVOLVABLE 区块，超预算或基线变了就拒绝。
 * 写盘前跑一遍人格探针：通过项数比改前少，说明这条规则把人设改坏了，直接拒绝。
 * additions 是追加，replacements 是「用新说法顶掉同主题的旧行」；两者都要过探针。
 */
export async function applyProposal(root, file = join(root, PERSONA.proposal), { by = 'human', force = false } = {}) {
  let proposal
  try { proposal = JSON.parse(await readText(file, '')) } catch { throw new Error('提案文件读不了') }
  if (!Array.isArray(proposal.additions)) throw new Error('提案格式不对')
  // 提案文件可能被手改或模型写歪：条数、单条长度、证据数组都收口
  const additions = proposal.additions.slice(0, 40)
  const replacements = (Array.isArray(proposal.replacements) ? proposal.replacements : []).slice(0, 40)
  const compressions = (Array.isArray(proposal.compressions) ? proposal.compressions : []).slice(0, 40)

  const meta = await readMeta(root)
  const week = weekKey()
  if (!force && meta.lastPublishedWeek === week) {
    const hint = by === 'auto' ? '' : '；紧急用 --force'
    throw new Error(`本周已发布 v${meta.version ?? 0}，每周最多一个 revision，下次可发布 ${dayText(nextWeekStart())}${hint}`)
  }

  const text = await readPersona(root)
  if (hashOf(text) !== proposal.baselineHash) {
    throw new Error('冲突：提案生成后 persona.md 被改过，请重新 propose')
  }
  const m = RE_EVO.exec(text)
  if (!m) throw new Error('persona.md 缺少 EVOLVABLE 区块')
  const curVersion = (await readMeta(root)).version ?? 0
  if (!additions.length && !replacements.length && !compressions.length) {
    return { applied: 0, replaced: 0, compressed: 0, version: curVersion }
  }

  // 顺序：先「替换」再「压缩」，两者都按写入前的原始整行精确匹配。
  // 整行严格相等才动，找不到就说明提案和文件对不上，拒绝写盘。
  let body = m[1].trimEnd()
  const done = []
  const compacted = []
  for (const r of replacements) {
    const oldLine = String(r?.old || '').trim()
    const newLine = String(r?.rule || '').trim().slice(0, 300)
    if (!oldLine || !newLine) continue
    const arr = body.split('\n')
    const idx = arr.findIndex((l) => l.trim() === oldLine)
    if (idx < 0) throw new Error(`要替换的规矩不在 EVOLVABLE 里：${oldLine.slice(0, 30)}…（请重新 propose）`)
    arr[idx] = newLine
    body = arr.join('\n')
    done.push({ old: oldLine, rule: newLine })
  }
  for (const c of compressions) {
    const oldLine = String(c?.old || '').trim()
    const newLine = String(c?.rule || '').trim().slice(0, 300)
    if (!oldLine || !newLine) continue
    const arr = body.split('\n')
    const idx = arr.findIndex((l) => l.trim() === oldLine)
    if (idx < 0) {
      // 这行刚被「替换」动过，压缩自然不再适用；不算错误，也不该报错卡住整批
      if (done.some((d) => d.old === oldLine)) continue
      throw new Error(`要压缩的规矩不在 EVOLVABLE 里：${oldLine.slice(0, 30)}…（请重新 propose）`)
    }
    arr[idx] = newLine
    body = arr.join('\n')
    compacted.push({ old: oldLine, rule: newLine })
  }

  // 追加时对着整理后的文本去重，别把刚换进去的新说法又追加一遍
  const lines = additions
    .map((a) => String(a?.rule || '').trim().slice(0, 300))
    .filter((x) => x && !body.includes(x.slice(0, 8)))
  if (!lines.length && !done.length && !compacted.length) {
    return { applied: 0, replaced: 0, compressed: 0, version: curVersion }
  }

  const nextEvo = `${body}${lines.length ? `\n${lines.join('\n')}` : ''}\n`
  const next = text.replace(RE_EVO, `<!-- PERSONA:EVOLVABLE:START -->\n${nextEvo}<!-- PERSONA:EVOLVABLE:END -->`)

  const tokens = personaTokens(next)
  // 已经超预算时，压缩 / 替换哪怕还没压回线内，只要没让情况更糟就放行（只减不增）
  if (tokens > PERSONA.tokenLimit && tokens > personaTokens(text)) {
    throw new Error(`超出人格预算：${tokens}/${PERSONA.tokenLimit} tokens`)
  }

  const before = runProbes(text, parsePersona(text), personaTokens(text))
  const after = runProbes(next, parsePersona(next), tokens)
  if (after.passed < before.passed) {
    const why = after.failed.filter((f) => !before.failed.some((b) => b.id === f.id)).map((f) => f.name)
    throw new Error(`人格探针回退：${after.passed}/${after.total} < 改前 ${before.passed}/${before.total}（${why.join('、')}）`)
  }

  const meta0 = await readMeta(root)
  const version = (meta0.version ?? 0) + 1
  const dir = join(root, PERSONA.archiveDir)
  await mkdir(dir, { recursive: true })
  await copyFile(join(root, 'persona.md'), join(dir, `v${version - 1 || 0}.md`))

  const nowIso = new Date().toISOString()
  const streak = (meta0.approvals?.streak ?? 0) + (by === 'auto' ? 0 : 1)
  await writeAtomic(join(root, 'persona.md'), next)
  await writeMeta(root, {
    ...meta0,
    version,
    updatedAt: nowIso,
    hash: hashOf(next),
    source: proposal.at || '',
    applied: lines,
    replaced: done,
    compressed: compacted,
    probes: { passed: after.passed, total: after.total },
    lastPublishedWeek: week,
    lastPublishedAt: nowIso,
    lastRunAt: nowIso,
    pendingMessages: 0,
    approvals: {
      streak,
      history: [...(meta0.approvals?.history || []), { at: nowIso, by, version }].slice(-20),
    },
    autoPublished: (meta0.autoPublished ?? 0) + (by === 'auto' ? 1 : 0),
  })
  await appendChangelog(root, {
    version,
    at: nowIso,
    applied: lines,
    replaced: done,
    compressed: compacted,
    evidence: [...new Set([...additions, ...replacements].flatMap((a) => {
      const ev = Array.isArray(a?.evidence) ? a.evidence.slice(0, 20) : []
      return ev.map((e) => String(e?.id ?? e ?? '')).filter(Boolean)
    }))].slice(0, 100),
    source: proposal.at || '',
    probes: `${after.passed}/${after.total}`,
    by,
    streak,
  }).catch(() => {})
  await refreshTrustStamp(root).catch(() => {})
  return {
    applied: lines.length,
    replaced: done.length,
    compressed: compacted.length,
    version, tokens, probes: after, by, streak,
  }
}

/** 人格变更日志：追加式，一条变更一段，谁都能翻。 */
export async function appendChangelog(root, entry) {
  const file = join(root, PERSONA.changelog)
  const fresh = !existsSync(file)
  const how = entry.by === 'auto'
    ? `自动发布（连续人工通过 ${entry.streak ?? 0} 次）`
    : `人工确认（连续通过 ${entry.streak ?? 0} 次）`
  const block = [
    fresh ? '# 人格变更日志\n' : '',
    `## v${entry.version} · ${entry.at}`,
    `- 确认：${how}`,
    `- 探针：${entry.probes}`,
    ...entry.applied.map((r) => `- 新增：${r}`),
    ...(entry.replaced || []).map((r) => `- 替换：${r.old} → ${r.rule}`),
    ...(entry.compressed || []).map((r) => `- 压缩：${r.old} → ${r.rule}`),
    entry.evidence?.length ? `- 依据：${entry.evidence.join('、')}` : '- 依据：（无）',
    `- 提案生成于：${entry.source || '（未知）'}`,
    '',
  ].join('\n')
  await appendFile(file, `${block}\n`, 'utf8')
}

/**
 * 拒绝提案：记原因、清零连续通过计数、把提案文件挪走。
 * 不清零的话「连续 3 次通过」就变成「累计 3 次通过」，自动发布迟早放跑坏提案。
 */
export async function rejectProposal(root, { why = '', file = join(root, PERSONA.proposal) } = {}) {
  let proposal = null
  try { proposal = JSON.parse(await readText(file, '')) } catch { proposal = null }
  const at = new Date().toISOString()
  const entry = {
    at,
    why: String(why || '').slice(0, 200),
    baselineHash: proposal?.baselineHash || '',
    // 替换和新增一样都是候选规矩，拒过一次就都进 30 天黑名单，别下周原样再来
    rules: [...(proposal?.additions || []), ...(proposal?.replacements || [])]
      .map((a) => String(a?.rule || '').slice(0, 80))
      .filter(Boolean),
  }
  await appendFile(join(root, PERSONA.rejected), `${JSON.stringify(entry)}\n`, 'utf8')
  await updateMeta(root, (m) => ({
    ...m,
    approvals: {
      streak: 0,
      history: [...(m.approvals?.history || []), { at, by: 'reject', why: entry.why }].slice(-20),
    },
  }))
  if (file === join(root, PERSONA.proposal) && existsSync(file)) {
    await rename(file, `${file}.rejected`).catch(() => {})
  }
  return entry
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
  const at = new Date().toISOString()
  await writeMeta(root, {
    ...meta,
    version: target,
    updatedAt: at,
    hash: hashOf(text),
    rolledBackFrom: cur,
    // 回滚说明上一版出了问题，「连续人工通过」重新计数
    approvals: {
      streak: 0,
      history: [...(meta.approvals?.history || []), { at, by: 'rollback', version: target }].slice(-20),
    },
  })
  await refreshTrustStamp(root).catch(() => {})
  return { version: target, tokens: personaTokens(text) }
}

/**
 * 自动迭代每次真正跑过的结果：一行一次，给界面和 CLI 看「上次干了什么」。
 * 只记真正进了 propose 的轮次；「消息不够」「不到 24 小时」这种纯等待不记，
 * 否则每小时一行，很快就把有用的记录冲掉。
 */
/** 追加式台账的保留上限：/obs 每次都会整文件读，不设上限会一年长到十几 MB。 */
const LEDGER_KEEP = 300

async function trimJsonl(file, keep = LEDGER_KEEP) {
  try {
    const raw = await readFile(file, 'utf8')
    const rows = raw.split('\n').filter(Boolean)
    if (rows.length <= keep + 100) return
    await writeAtomic(file, `${rows.slice(-keep).join('\n')}\n`)
  } catch { /* 读不到 / 写不了就下次再说，不能影响主流程 */ }
}

export async function appendRun(root, entry) {
  const row = {
    at: entry.at || new Date().toISOString(),
    ran: entry.ran !== false,
    proposed: Boolean(entry.proposed),
    applied: entry.applied || 0,
    replaced: entry.replaced || 0,
    compressed: entry.compressed || 0,
    version: entry.version ?? null,
    why: String(entry.why || '').slice(0, 200),
    pending: entry.pending ?? null,
    samples: entry.samples ?? null,
    additions: entry.additions ?? null,
    replacements: entry.replacements ?? null,
    compressions: entry.compressions ?? null,
    rejected: entry.rejected ?? null,
  }
  await appendFile(join(root, PERSONA.runs), `${JSON.stringify(row)}\n`, 'utf8').catch(() => {})
  await trimJsonl(join(root, PERSONA.runs))
  return row
}

/** 最近几轮自动迭代，新的在后。 */
export async function readRuns(root, limit = 5) {
  const raw = await readText(join(root, PERSONA.runs), '')
  const rows = raw.split('\n').filter(Boolean).slice(-Math.max(1, limit))
  return rows
    .map((line) => { try { return JSON.parse(line) } catch { return null } })
    .filter(Boolean)
}

/**
 * 每条候选的判决都落盘：接受了哪条、在哪一关被拦、为什么、依据哪些记忆。
 * 提案文件会被下一轮覆盖，光看提案事后就说不清「为什么丢了」；这份是追加式台账。
 */
export async function writeDecisions(root, runId, rows) {
  const line = JSON.stringify({ runId, at: new Date().toISOString(), rows }) + '\n'
  const file = join(root, PERSONA.decisions)
  await appendFile(file, line, 'utf8').catch(() => {})
  await trimJsonl(file)
}

/** 最近 N 轮的判决明细，新的在后；每轮一行，row.why 直接给用户看。 */
export async function readDecisions(root, limit = 5) {
  const raw = await readText(join(root, PERSONA.decisions), '')
  return raw.split('\n').filter(Boolean).slice(-Math.max(1, limit))
    .map((line) => { try { return JSON.parse(line) } catch { return null } })
    .filter(Boolean)
    .reverse()
}

/**
 * 老版本提案（没有 decisions 字段）也能解释：从 samples / generator / rejected /
 * warnings 反推出一轮判决。这样升级后不用等下一轮迭代，界面上就有得看。
 */
async function legacyDecisions(root) {
  let p = null
  try { p = JSON.parse(await readText(join(root, PERSONA.proposal), '')) } catch { return [] }
  if (!p || Array.isArray(p.decisions)) return []
  const rows = []
  if (p.samples?.skipped) {
    rows.push({ rule: `采样跳过 ${p.samples.skipped} 条`, action: 'dropped', stage: 'sample', why: '采样门（旧提案未细分原因）', evidence: [] })
  }
  if (p.generator === 'rules(fallback)') {
    rows.push({ rule: '（LLM 候选）', action: 'dropped', stage: 'generator', why: '蒸馏模型没返回可用候选，退回规则候选', evidence: [] })
  }
  for (const r of p.rejected || []) rows.push({ rule: r.rule, action: 'dropped', stage: 'review', why: r.why, evidence: [] })
  for (const a of p.additions || []) {
    rows.push({
      rule: a.rule, action: 'accepted', stage: 'review', why: '确定性审查通过',
      evidence: (a.evidence || []).slice(0, 5).map((e) => ({ id: e.id || '', scope: e.scope || '', text: String(e.text || '').slice(0, 60) })),
    })
  }
  if (!rows.length || !(p.additions || []).length) {
    rows.push({
      rule: '（没有新候选）', action: 'dropped', stage: 'generator',
      why: (p.warnings || []).join('；') || '没有能加进人格的规则', evidence: [],
    })
  }
  if (p.budget && typeof p.budget.headroom !== 'number') p.budget.headroom = p.budget.limit - p.budget.tokens
  return [{ runId: p.at || '', at: p.at || '', rows, legacy: true }]
}

/** 台账优先；还没有台账时退回老提案反推的一轮。 */
export async function recentDecisions(root, limit = 3) {
  const real = await readDecisions(root, limit)
  return real.length ? real : legacyDecisions(root)
}

/**
 * 提案摘要：只带界面要显示的字段，样本正文不进 /obs。
 * 没有提案文件返回 null，界面据此说「还没生成过提案」。
 */
export async function proposalBrief(root) {
  try {
    const p = JSON.parse(await readText(join(root, PERSONA.proposal), ''))
    return {
      at: p.at || '',
      version: p.version ?? 0,
      generator: p.generator || '',
      reviewer: p.reviewer || '',
      samples: p.samples || null,
      budget: p.budget ? { ...p.budget, headroom: p.budget.headroom ?? (p.budget.limit - p.budget.tokens) } : null,
      sources: p.sources ?? null,
      additions: (p.additions || []).slice(0, 12).map((a) => ({
        rule: String(a?.rule || ''),
        evidence: Array.isArray(a?.evidence) ? a.evidence.length : 0,
        // 带上依据的记忆 id 和摘要：用户要能看出「哪条记忆把这条规则顶进来的」
        refs: (Array.isArray(a?.evidence) ? a.evidence : []).slice(0, 3).map((e) => ({
          id: String(e?.id || ''), scope: String(e?.scope || ''), text: String(e?.text || '').slice(0, 60),
        })),
      })),
      rejected: (p.rejected || []).slice(0, 12).map((r) => ({
        rule: String(r?.rule || ''),
        why: String(r?.why || ''),
      })),
      // 建议替换的旧规矩：界面要能看清「用哪句换掉哪句」
      replacements: (p.replacements || []).slice(0, 12).map((r) => ({
        old: String(r?.old || ''),
        rule: String(r?.rule || ''),
        why: String(r?.why || ''),
        freed: Number(r?.freed) || 0,
      })),
      // 建议写短的旧行（整行精确替换，apply 时执行）
      compressions: (p.compressions || []).slice(0, 12).map((c) => ({
        old: String(c?.old || ''),
        rule: String(c?.rule || ''),
        why: String(c?.why || ''),
        flag: String(c?.flag || ''),
        freed: Number(c?.freed) || 0,
      })),
      // 旧人设逐行审视：偏长 / 重复 / 示例，界面据此回答「有没有能收拾的」
      audit: (p.audit || []).slice(0, 40).map((r) => ({
        i: Number(r?.i) || 0,
        text: String(r?.text || '').slice(0, 120),
        chars: Number(r?.chars) || 0,
        flag: String(r?.flag || ''),
        why: String(r?.why || ''),
        suggestion: String(r?.suggestion || ''),
      })),
      decisions: (p.decisions || []).slice(0, 40),
      warnings: (p.warnings || []).map(String).slice(0, 6),
    }
  } catch {
    return null
  }
}

/** changelog 最后一段：只有真正发布过 revision 才有。 */
export async function changelogTail(root, limit = 1200) {
  const raw = await readText(join(root, PERSONA.changelog), '')
  if (!raw) return ''
  const i = raw.lastIndexOf('\n## v')
  return (i >= 0 ? raw.slice(i + 1) : raw).trim().slice(-limit)
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
  const nowMs = Date.now()
  const pending = meta.pendingMessages ?? 0
  const lastMs = Math.max(Date.parse(String(meta.lastRunAt || '')) || 0, Date.parse(String(meta.lastPublishedAt || '')) || 0)
  // 实时审视：不依赖提案文件（提案可能是旧的、甚至还没生成过），
  // 让用户随时能看到「旧人设哪里能收拾、整理后可用多少」。
  const liveAudit = inspectEvolvable(blocks.evolvable)
  const liveCompressions = collectCompressions(blocks.evolvable).compressions
  const liveFreed = liveCompressions.reduce((n, c) => n + c.freed, 0)
  const liveTokens = personaTokens(text)
  let waitReason = '门槛已满足，下一次巡检会生成提案'
  if (pending < AUTO.minMessages) {
    waitReason = `还差 ${AUTO.minMessages - pending} 条新消息（${pending}/${AUTO.minMessages}）`
  } else if (lastMs && nowMs - lastMs < AUTO.minHours * 3600 * 1000) {
    waitReason = `距上次迭代不足 ${AUTO.minHours} 小时，还差 ${((AUTO.minHours * 3600 * 1000 - (nowMs - lastMs)) / 3600000).toFixed(1)} 小时`
  }
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
    // 实时口径：当前余额 + 现在就能压缩出来的空间。提案里的 budget 是那一轮的历史快照。
    budget: {
      tokens: liveTokens,
      limit: PERSONA.tokenLimit,
      headroom: PERSONA.tokenLimit - liveTokens,
      compactible: liveFreed,
      effective: PERSONA.tokenLimit - liveTokens + liveFreed,
      basis: Math.max(0, liveTokens - liveFreed),
    },
    audit: liveAudit.map((r) => ({
      i: r.i, text: String(r.text).slice(0, 120), chars: r.chars,
      flag: r.flag, why: r.why, suggestion: r.suggestion,
    })),
    compressible: liveCompressions.map((c) => ({ old: c.old, rule: c.rule, freed: c.freed, flag: c.flag })),
    // 自动迭代（文档 8.6 第三节）：门槛进度、连续通过、本周是否已发布
    auto: {
      pendingMessages: pending,
      minMessages: AUTO.minMessages,
      streak: meta.approvals?.streak ?? 0,
      minStreak: AUTO.minStreak,
      lastRunAt: meta.lastRunAt || '',
      lastPublishedAt: meta.lastPublishedAt || '',
      week: weekKey(),
      publishedThisWeek: meta.lastPublishedWeek === weekKey(),
      nextPublishAt: dayText(nextWeekStart()),
      autoPublished: meta.autoPublished ?? 0,
      // 当前为什么还没迭代：把 autoTick 的早退理由实时算出来，不用等下一轮记日志
      waitReason,
    },
    // 上次真正发布了什么、提案现在长什么样、最近几轮跑了什么
    lastApplied: {
      at: meta.updatedAt || '',
      rules: (meta.applied || []).map(String).slice(0, 12),
      // 上次发布里「换掉旧说法」和「写短」的部分
      replaced: (meta.replaced || []).slice(0, 12),
      compressed: (meta.compressed || []).slice(0, 12),
      source: meta.source || '',
    },
    proposal: await proposalBrief(root),
    recentRuns: await readRuns(root, 5),
    // 每条候选的判决台账：提案会被覆盖，这里按轮次留着，能翻旧账
    decisions: await recentDecisions(root, 3),
    changelog: await changelogTail(root),
  }
}
