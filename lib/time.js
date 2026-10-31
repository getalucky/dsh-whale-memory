/**
 * time.js —— 把「明天 / 下周三 / 下午3点」锚成绝对时间
 *
 * 为什么必须锚：
 *   蒸馏时把「明天8:30上班」原样存进去，三天后注入的还是「明天」，
 *   她会拿一个早就过期的相对时间当真话讲，而且自己毫无察觉。
 *   记忆里的时间只有换成绝对日期才可长期使用。
 *
 * 只做确定性规则，不调 LLM：
 *   基准时间是这条消息的 `at`（不是蒸馏时刻），所以空闲十分钟再蒸也不漂。
 *   认不出来就返回 null —— 宁可不锚，也不要瞎猜一个日期。
 *
 * 已知不认：中文数字（下午三点）、「半小时后」「月底」这类模糊说法。
 */

const DAY_OFFSETS = [
  ['大后天', 3], ['大前天', -3],
  ['后天', 2], ['前天', -2],
  ['明天', 1], ['明日', 1],
  ['今天', 0], ['今日', 0],
  ['昨天', -1], ['昨日', -1],
]

const WEEKDAY = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7, 七: 7 }

const pad = (n) => String(n).padStart(2, '0')

function toDate(v) {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? new Date() : v
  const d = new Date(v ?? '')
  return Number.isNaN(d.getTime()) ? new Date() : d
}

/** 已经是绝对日期（带年份）就不锚，避免把 2026-10-31 再算一遍。 */
function hasAbsoluteDate(s) {
  return /\d{4}\s*[-/年]\s*\d{1,2}\s*[-/月]\s*\d{1,2}/.test(s)
}

/**
 * 解析相对时间。
 * @param {string} text 一句话
 * @param {string|Date} baseISO 这句话是什么时候说的
 * @returns {{abs:string,label:string}|null} abs 形如 2026-10-31T08:30（本地时间，不带时区）
 */
export function resolveRelativeTime(text, baseISO) {
  const src = String(text ?? '')
  if (!src || hasAbsoluteDate(src)) return null

  const base = toDate(baseISO)
  let year = base.getFullYear()
  let month = base.getMonth()
  let day = base.getDate()
  let dayTouched = false

  // 1. 明确写了「X月Y日」：年份沿用基准年，跨年就近取下一次
  const md = /(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?/.exec(src)
  if (md) {
    const m = Number(md[1]) - 1
    const d = Number(md[2])
    if (m >= 0 && m <= 11 && d >= 1 && d <= 31) {
      month = m
      day = d
      if (month < base.getMonth()) year += 1
      dayTouched = true
    }
  }

  // 2. 昨天/今天/明天/后天…（先长后短，别让「后天」抢了「大后天」）
  if (!dayTouched) {
    const hit = DAY_OFFSETS.find(([w]) => src.includes(w))
    if (hit) {
      day += hit[1]
      dayTouched = true
    }
  }

  // 3. 周几：「下周三」「这周五」「周日」
  if (!dayTouched) {
    const w = /(下下|下|这|本)?(?:个)?(?:周|星期|礼拜)([一二三四五六日天七])/.exec(src)
    if (w) {
      const target = WEEKDAY[w[2]]
      const cur = base.getDay() || 7 // 周日算 7，跟上表的 1–7 对齐
      const prefix = w[1] ?? ''
      let delta
      if (prefix === '下' || prefix === '下下') {
        // 下周一是「离下周一还有几天」，再加目标日偏移
        delta = (8 - cur) % 7
        if (delta === 0) delta = 7
        delta += target - 1
        if (prefix === '下下') delta += 7
      } else {
        // 这周/本周/裸写：取最近一次未来的那一天（今天算今天）
        delta = (target - cur + 7) % 7
      }
      day += delta
      dayTouched = true
    }
  }

  // 4. 几号：「下个月3号」「本月15号」「3号」
  if (!dayTouched) {
    const dm = /(下个?月|下月|这个?月|本月)?\s*(\d{1,2})\s*[号日](?![楼线院门窗房])/.exec(src)
    if (dm) {
      const n = Number(dm[2])
      if (n >= 1 && n <= 31) {
        const prefix = dm[1] ?? ''
        if (prefix.includes('下')) month += 1
        else if (!prefix && n < base.getDate()) month += 1 // 裸写「3号」在今天之后才指本月
        day = n
        dayTouched = true
      }
    }
  }

  // 5. 几点：「下午3点」「8:30」「晚上八点半」（中文数字不认）
  let hasTime = false
  let hh = 0
  let mm = 0
  const tm = /(凌晨|早上|上午|中午|下午|傍晚|晚上|夜里|半夜)?\s*(\d{1,2})\s*[:：点时]\s*(\d{1,2})?\s*(分|半)?/.exec(src)
  if (tm) {
    const period = tm[1] ?? ''
    let h = Number(tm[2])
    const mi = tm[3] !== undefined ? Number(tm[3]) : (tm[4] === '半' ? 30 : 0)
    if (h >= 0 && h <= 24 && mi >= 0 && mi < 60) {
      if (['下午', '傍晚', '晚上', '夜里', '半夜'].includes(period) && h < 12) h += 12
      if (period === '中午' && h < 11) h += 12
      if (period === '凌晨' && h === 12) h = 0
      if (h < 24) {
        hh = h
        mm = mi
        hasTime = true
      }
    }
  }

  if (!dayTouched && !hasTime) return null

  // 只说了钟点、而且今天这个点已经过了 → 指的是明天早上
  if (!dayTouched && hasTime) {
    const cand = new Date(year, month, day, hh, mm, 0, 0)
    if (cand.getTime() <= base.getTime()) day += 1
  }

  const d = new Date(year, month, day, hh, mm, 0, 0)
  const datePart = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  // 没说钟点就只存日期，注入时不会平白多出一个 00:00
  const abs = hasTime ? `${datePart}T${pad(hh)}:${pad(mm)}` : datePart
  const label = hasTime
    ? `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(hh)}:${pad(mm)}`
    : `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  return { abs, label }
}

/** 把存的 abs 格式成注入用的短标签（不经过 Date，避免时区偏一天）。 */
export function formatAbs(abs) {
  const s = String(abs ?? '')
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(s)
  if (m) return `${m[2]}-${m[3]} ${m[4]}:${m[5]}`
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (d) return `${d[2]}-${d[3]}`
  return ''
}
