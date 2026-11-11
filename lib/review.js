/**
 * review.js —— 变更触发的一次性复审
 *
 * 机制借自 dsh-diary-relation-check：记忆一变，就把一个问题重新摆到模型面前，
 * 必须给结论、必须给理由；回写到状态文件之后提醒才消失，不写每轮都在。
 *
 * 和原插件的差别：
 *   · 按分片走：私聊只审自己的分片，群只审本群，不让私聊拿群里的记忆去判。
 *   · 指纹按「条目 id + 状态 + 正文」算，权重、命中、画像更新都不会误触发。
 *   · 状态在 <root>/review_state.json，不进分片目录（那里是给人看的内容）。
 *   · 结论四态 + relation 状态机：确认过之后，下一次只复核「断没断」。
 *
 * 默认只审 private / group；本机（local）是干活的地方，不主动弹关系问题。
 * 关闭：DSH_MEMORY_REVIEW=off。改范围：DSH_MEMORY_REVIEW_SCOPES=private,group,local
 * 改问题：DSH_MEMORY_REVIEW_QUESTION，或用 review_question 配置项。
 */

import { readFile, rename, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

import { withWriteLock } from './store.js'
import { loadSettings } from './settings.js'

export const REVIEW_STATE = 'review_state.json'
export const REVIEW_VERDICTS = ['yes', 'not-yet', 'broken', 'unsure']
export const DEFAULT_QUESTION = '我们现在是什么关系'

/** 条目少于这个数就不审：只有一两句话的关系判断，审了也是编。 */
export const MIN_ITEMS = 5

/**
 * 同一分片两次提醒的最小间隔。记忆在群里是每分钟都在长的，
 * 不设冷却就变成每轮都在催；冷却期内安静，过了还 dirty 就再出现。
 */
export const COOLDOWN_MS = 30 * 60 * 1000

const DEAD = new Set(['archived', 'superseded', 'suggested', 'expired'])

export function reviewStateFile(root) {
  return join(root, REVIEW_STATE)
}

const blank = () => ({ version: 1, scopes: {} })

/** 读状态。文件不在、坏了都当空，不抛。 */
export async function readReviewState(root) {
  try {
    const o = JSON.parse(await readFile(reviewStateFile(root), 'utf8'))
    if (o && typeof o === 'object' && o.scopes && typeof o.scopes === 'object') return o
  } catch { /* 第一次或写坏了 */ }
  return blank()
}

async function writeReviewState(root, state) {
  const file = reviewStateFile(root)
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8')
  await rename(tmp, file)
}

/** 复审范围：默认只审私聊。群是多人场合，问题指向谁说不清，要审得显式开。 */
export function reviewScopes() {
  const v = String(process.env.DSH_MEMORY_REVIEW_SCOPES ?? '').trim()
  const list = v ? v.split(',').map((x) => x.trim()).filter(Boolean) : ['private']
  return list.includes('all') ? ['private', 'group', 'local', 'public', 'project'] : list
}

export function reviewEnabled(kind) {
  const v = String(process.env.DSH_MEMORY_REVIEW ?? 'on').toLowerCase()
  if (v === 'off' || v === '0' || v === 'false') return false
  return reviewScopes().includes(String(kind ?? ''))
}

/** 要审的问题。设置页的 review_question 优先，其次环境变量，最后默认。 */
export function reviewQuestion(root) {
  const fromFile = String(loadSettings(root)?.review_question ?? '').trim()
  if (fromFile) return fromFile
  return String(process.env.DSH_MEMORY_REVIEW_QUESTION ?? '').trim() || DEFAULT_QUESTION
}

export function liveItems(scope) {
  return (scope?.items || []).filter((x) => !DEAD.has(x.state))
}

/**
 * 分片指纹：只看「有哪些条目、各自什么状态、正文写了什么」。
 * 排序后再算，条目顺序变化不算变更；权重/命中/画像更新也不算。
 */
export function scopeFingerprint(scope) {
  const rows = (scope?.items || [])
    .map((x) => `${x.id}|${x.state || 'active'}|${String(x.text ?? '').slice(0, 200)}`)
  rows.sort()
  return createHash('sha1').update(rows.join('\n')).digest('hex').slice(0, 16)
}

function scopeKeyOf(scope) {
  return String(scope?.scope || `${scope?.kind ?? ''}:${scope?.id ?? ''}`)
}

function dayOf(ms) {
  const d = new Date(Number(ms) || 0)
  if (!Number.isFinite(d.getTime()) || d.getTime() <= 0) return '（时间未记录）'
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/**
 * 这一轮该不该提醒，该说什么。'' = 不用提醒。
 * @param {object} scope 已加载的分片
 * @param {object} prev 该分片上次的复审记录（可空）
 * @param {number} now
 */
export function buildReviewText(scope, prev, question = DEFAULT_QUESTION, now = Date.now()) {
  if (!reviewEnabled(scope?.kind)) return ''
  if (liveItems(scope).length < MIN_ITEMS) return ''

  const stamp = scopeFingerprint(scope)
  if (prev?.stamp === stamp) return ''
  // 冷却：刚审完又进来一条，不马上再催
  if (prev?.at && now - Date.parse(prev.at) < COOLDOWN_MS) return ''

  // 只数活条目：归档/被取代的不算「新内容」，否则第一次就会报出比实际大的数
  const live = liveItems(scope).length
  const fresh = prev ? Math.max(0, live - (Number(prev.count) || 0)) : 0
  const change = !prev
    ? `这段记忆有 ${live} 条，还没复审过`
    : fresh > 0
      ? `比上次多了 ${fresh} 条`
      : '又有变化，但条数没变（可能改过说法）'

  const rel = prev?.relation
  if (rel?.status === 'confirmed' && rel.label) {
    return [
      '【记忆复审 · 关系复核】',
      `上次确认：${rel.label}（${dayOf(rel.since)} 确认）。${change}。`,
      '这次只判一件事：这段关系断没断。',
      '断了，写哪一次、哪句话让它断的；没断，写你还看见它成立的具体依据，不写「还和以前一样」。',
      '用 memory_review 回写（verdict + reason），写完这条提醒才消失；不写它每轮都在。',
    ].join('\n')
  }

  return [
    '【记忆复审 · 有新内容】',
    `${change}。先看下面的速览，需要对细节就 read_memory，然后重新判断一次，别沿用上次结论。`,
    `问题：${question}`,
    '先自问：现在是什么关系；还成不成立（还没到 / 成立 / 成立过又断了）；不成立的话，差什么、断在哪一次。',
    '结论四选一：还在(yes) / 还没到(not-yet) / 断了(broken) / 说不清(unsure)',
    '理由要具体：写哪一刻、哪句话、哪件事，不写「就是感觉」。',
    '用 memory_review 回写（verdict + reason），写完这条提醒才消失；不写它每轮都在。',
    '别为了让提醒闭嘴随便写一个——那样下一次触发就废了，而且你自己知道在糊弄。',
  ].join('\n')
}

/** 当前该不该提醒 + 提醒文本。注入层每轮调这个。 */
export async function reviewTextFor(root, scope) {
  if (!scope) return ''
  const state = await readReviewState(root)
  const prev = state.scopes?.[scopeKeyOf(scope)] || null
  return buildReviewText(scope, prev, reviewQuestion(root))
}

/**
 * 回写复审结论。写进去之后，同一份指纹就不再提醒。
 * @returns {{ok:boolean, why?:string, verdict?:string, relation?:object}}
 */
export async function markReviewed(root, { scope, verdict, reason, relationLabel = '' } = {}) {
  const v = String(verdict ?? '').trim()
  if (!REVIEW_VERDICTS.includes(v)) {
    return { ok: false, why: 'verdict 只能是 yes / not-yet / broken / unsure' }
  }
  const why = String(reason ?? '').replace(/\s+/g, ' ').trim()
  if (why.length < 6) {
    return { ok: false, why: '理由要具体，至少写一句话（六个字以上）' }
  }
  const key = scopeKeyOf(scope)
  if (!key || !scope?.kind) return { ok: false, why: '没有分片可以回写' }
  if (!reviewEnabled(scope.kind)) return { ok: false, why: '这个分片不做复审' }

  const now = Date.now()
  return withWriteLock(async () => {
    const state = await readReviewState(root)
    const prev = state.scopes[key] || {}
    let relation = prev.relation ?? null
    if (v === 'yes') {
      const label = String(relationLabel ?? '').trim() || prev.relation?.label || ''
      relation = { label, status: 'confirmed', since: now }
    } else if (v === 'broken') {
      // 断了的判定不覆盖第一次确认的时间；label 也保留，不然复核版认不出是哪段
      relation = relation ? { ...relation, status: 'broken' } : null
    }
    state.scopes[key] = {
      stamp: scopeFingerprint(scope),
      count: liveItems(scope).length,
      at: new Date(now).toISOString(),
      verdict: v,
      reason: why.slice(0, 300),
      relation,
    }
    await writeReviewState(root, state)
    return { ok: true, verdict: v, scope: key, relation }
  })
}

/** 诊断/设置页用：某个分片现在的复审状态。 */
export async function reviewStatus(root, scope) {
  const state = await readReviewState(root)
  const prev = state.scopes?.[scopeKeyOf(scope)] || null
  const due = Boolean(buildReviewText(scope, prev, reviewQuestion(root)))
  return {
    scope: scopeKeyOf(scope),
    due,
    stamp: scopeFingerprint(scope),
    items: liveItems(scope).length,
    last: prev,
  }
}
