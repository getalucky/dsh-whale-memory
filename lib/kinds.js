/**
 * kinds.js —— 记忆类型扩展：教训 / 进行中话题 / 承诺（文档 4.9）
 *
 * v2 只有 fact / pref / event / relation 一档，实际会漏三类特别有用的东西：
 *   · lesson     纠正过一次就别再犯，最容易被忘、代价最大
 *   · topic      跨会话的「我们正在做什么」，没有目标句就退化成流水账
 *   · commitment 「我答应过你的事」，到期不提醒就是失信
 *
 * 三类各带必填字段，缺了就不许入库 —— 存成一条普通事实比不收更糟：
 * 召回时没人知道它在什么条件下适用。
 *
 * 规矩（照抄文档 4.9 的实现要点）：
 *   · lesson 的 trigger 必须写成「当……时」，写不出来就不是教训，是牢骚
 *   · topic 更新只改状态与 last_touched，不新建条目，否则一个话题会分裂成十条
 *   · commitment 的到期检查放在会话首轮做一次，零 LLM，纯日期比较
 */

export const EXTENDED = ['lesson', 'topic', 'commitment']

export const KINDS = ['fact', 'pref', 'event', 'relation', 'knowledge', ...EXTENDED]

export const PROGRESS = {
  active: '进行中',
  paused: '暂停',
  done: '已完成',
}

/** trigger 只认「当……时」这种句式；「改完 lib 后」不算。 */
const TRIGGER_RE = /^当.+?(时|时候)$/

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ]\d{2}:\d{2})?$/

function oneLine(s) {
  return String(s ?? '').replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim()
}

/** 去首尾标点：「当改完 lib 时。」和「当改完 lib 时」是同一条。 */
function clean(s) {
  return oneLine(s).replace(/^[，,。.、；;：:！!？?\s]+|[，,。.、；;：:！!？?\s]+$/g, '')
}

function short(s, n) {
  const v = oneLine(s)
  return v.length > n ? `${v.slice(0, n - 1)}…` : v
}

/** 校验日期真的存在（2026-02-30 不算）。 */
function isDate(s) {
  const m = ISO_DATE.exec(String(s ?? ''))
  if (!m) return false
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  return d.getFullYear() === Number(m[1]) && d.getMonth() === Number(m[2]) - 1 && d.getDate() === Number(m[3])
}

/** 中文/英文的状态说法 → 内部值；认不出来返回空。 */
export function mapProgress(v) {
  const s = String(v ?? '').trim().toLowerCase()
  if (!s) return ''
  if (['active', '进行中', '进行', '在做', '继续'].includes(s)) return 'active'
  if (['paused', '暂停', '搁置', '放着'].includes(s)) return 'paused'
  if (['done', '完成', '已完成', '搞定', '结束', '做完了'].includes(s)) return 'done'
  return ''
}

/**
 * 校验并归一化扩展字段。
 * 非扩展类型直接放过（多给的字段也不收，免得普通事实混进半截属性）。
 * @returns {{ok:boolean, why?:string, fields:object}}
 */
export function normalizeExtras(kind, raw = {}, now = new Date()) {
  const src = raw || {}
  const fail = (why) => ({ ok: false, why, fields: {} })
  const pass = (fields) => ({ ok: true, fields })

  if (!EXTENDED.includes(kind)) return pass({})

  if (kind === 'lesson') {
    const trigger = clean(src.trigger)
    const antiPattern = clean(src.antiPattern ?? src.anti_pattern)
    if (!trigger) return fail('教训必须带 trigger：在什么情况下适用，写成「当……时」')
    if (!TRIGGER_RE.test(trigger)) return fail(`trigger 要写成「当……时」，现在是「${short(trigger, 20)}」`)
    if (!antiPattern) return fail('教训必须带 anti_pattern：这次踩的坑、以后别再怎么做')
    return pass({ trigger, antiPattern })
  }

  if (kind === 'topic') {
    const goal = clean(src.goal)
    if (!goal) return fail('话题必须带 goal：一句话说清这件事要做成什么')
    // 没给状态就留空：合并时才知道「这次没改状态」，别把已完成的话题重新点亮
    const progress = mapProgress(src.progress ?? src.status)
    return pass({ goal, progress, lastTouched: now.toISOString() })
  }

  // commitment
  const due = clean(src.due)
  if (!due) return fail('承诺必须带 due：一个日期，或「下次提到 X 时」这样的条件')
  if (!isDate(due) && !/时|之前|以前|之后|以后/.test(due)) {
    return fail('due 认不出来：写绝对日期（2026-11-05），或「下次提到 X 时」这样的条件')
  }
  const toWhom = clean(src.toWhom ?? src.to_whom) || '对方'
  return pass({ due, toWhom })
}

/**
 * 承诺的到期状态。纯日期比较，零 LLM。
 * 条件型（「下次提到 X 时」）算不出天数，只标 kind=condition。
 * @returns {{kind:'date'|'condition', days:number|null, text:string, label:string}|null}
 */
export function dueState(item, now = Date.now()) {
  const raw = clean(item?.due)
  if (!raw) return null
  if (!isDate(raw)) return { kind: 'condition', days: null, text: raw, label: `条件：${short(raw, 24)}` }

  const m = ISO_DATE.exec(raw)
  const dueDay = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  const today = new Date(now)
  today.setHours(0, 0, 0, 0)
  dueDay.setHours(0, 0, 0, 0)
  const days = Math.round((dueDay.getTime() - today.getTime()) / 86400000)

  let label
  if (days < 0) label = `逾期 ${-days} 天`
  else if (days === 0) label = '今天到期'
  else if (days === 1) label = '明天到期'
  else label = `${days} 天后到期`
  return { kind: 'date', days, text: `${m[1]}-${m[2]}-${m[3]}`, label }
}

/** 到期短格式（主副库/检索用）：11-05 到期。 */
export function dueText(item) {
  const st = dueState(item)
  if (!st) return ''
  return st.kind === 'date' ? `${st.text.slice(5)} 到期` : `条件：${short(st.text, 20)}`
}

/**
 * 一行短描述，主库要点、副库目录、骨架提醒都用它，免得三处各写一套格式。
 */
export function describeExtra(item) {
  if (!item) return ''
  if (item.kind === 'lesson') {
    return [
      item.trigger ? `触发：${item.trigger}` : '',
      item.antiPattern ? `别再：${item.antiPattern}` : '',
    ].filter(Boolean).join(' · ')
  }
  if (item.kind === 'topic') {
    const st = PROGRESS[item.progress] || PROGRESS.active
    const last = String(item.lastTouched || '').slice(5, 10)
    return [
      `目标：${short(item.goal, 40)}`,
      st,
      last ? `上次 ${last}` : '',
    ].filter(Boolean).join(' · ')
  }
  if (item.kind === 'commitment') {
    return [
      dueText(item),
      item.toWhom ? `对${item.toWhom}` : '',
    ].filter(Boolean).join(' · ')
  }
  return ''
}
