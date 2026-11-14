/**
 * health.js —— 记忆库体检
 *
 * 后台的 forget / maintain 只管「该忘的忘掉」，不告诉人库现在健不健康。
 * 这里出一份只读体检单：主副库对不对得上、画像数字有没有漂、待确认堆了多少、
 * 有没有说法几乎一样的重复条目、容量离上限还有多远。
 *
 * 只读，不改任何东西；修不修、怎么修由人决定。
 * 每个问题都带 level：error（会答错）/ warn（快到了）/ info（可以顺手清）。
 */

import { listScopes, similarity, MAX_ITEMS } from './store.js'
import { verifyScope } from './vault.js'
import { liveItems } from './itemstate.js'

const STALE_DAYS = 90
const DUP_THRESHOLD = 0.88
const MAX_SCAN = 300
const PENDING_WARN = 10
const CAPACITY_WARN = 0.9

const DAY = 24 * 60 * 60 * 1000

function ageDays(at, now) {
  const t = Date.parse(at || '')
  if (!Number.isFinite(t) || t <= 0) return null
  return Math.floor((now - t) / DAY)
}

/**
 * 说法几乎一样的条目，按组返回 id。
 * 只比前 MAX_SCAN 条活条目，两两比 bigram 相似度；几百条够用，再多就慢。
 */
export function findDuplicates(items, { maxScan = MAX_SCAN, threshold = DUP_THRESHOLD } = {}) {
  const list = (items || []).slice(0, maxScan)
  const used = new Set()
  const groups = []
  for (let i = 0; i < list.length; i += 1) {
    const a = list[i]
    if (!a || used.has(a.id)) continue
    const group = [a]
    for (let j = i + 1; j < list.length; j += 1) {
      const b = list[j]
      if (!b || used.has(b.id)) continue
      if (similarity(a.text, b.text) >= threshold) {
        group.push(b)
        used.add(b.id)
      }
    }
    if (group.length > 1) {
      used.add(a.id)
      groups.push(group)
    }
  }
  return groups
}

function issue(id, level, text, fix = '') {
  return { id, level, text, fix }
}

/**
 * 出体检单。
 * @param {string} root
 * @param {{scopes?: object[], now?: number}} opts 传 scopes 可复用已经扫过的列表
 */
export async function healthReport(root, { scopes, now = Date.now() } = {}) {
  const list = Array.isArray(scopes) ? scopes : await listScopes(root).catch(() => [])
  const totals = {
    scopes: list.length, items: 0, live: 0, pending: 0, duplicates: 0, stale: 0,
    errors: 0, warnings: 0, infos: 0,
  }
  const out = []

  for (const sc of list) {
    const items = Array.isArray(sc?.items) ? sc.items : []
    const live = liveItems(items)
    const pending = items.filter((x) => x.state === 'suggested')
    totals.items += items.length
    totals.live += live.length
    totals.pending += pending.length

    const issues = []

    // 1. 主库正文和条目表对不上：读正文会读空，或者留下孤儿文件
    const v = await verifyScope(root, sc.kind, sc.id, sc).catch(() => null)
    if (v && v.ok === false) {
      issues.push(issue(
        'vault', 'error',
        `正文 ${v.files} 篇 / 条目 ${v.items} 条，对不上`,
        '跑 node tools/rebuild-index.mjs',
      ))
    }

    // 2. 画像数字漂了：注入的「记得 N 件事」和实际差太多
    const pt = Number(sc.profile?.total)
    if (Number.isFinite(pt) && pt > 0) {
      const drift = Math.abs(pt - live.length)
      if (drift > Math.max(3, live.length * 0.2)) {
        issues.push(issue(
          'profile', 'warn',
          `画像写「记得 ${pt} 件」，实际 ${live.length} 件`,
          '设置页点一次刷新画像，或等 maintain 跑完',
        ))
      }
    }

    // 3. 待确认堆着：用户点过头的没转正，等于白记
    if (pending.length >= PENDING_WARN) {
      issues.push(issue(
        'pending', 'warn',
        `${pending.length} 条待确认堆着`,
        '用 memory_pending 看一眼，点头的用 memory_confirm 转正',
      ))
    }

    // 4. 说法几乎一样：检索会同时命中两条，注入重复占预算
    const dups = findDuplicates(live)
    if (dups.length) {
      totals.duplicates += dups.length
      const sample = dups.slice(0, 3).map((g) => g.map((x) => x.id).join(' / ')).join('；')
      issues.push(issue(
        'duplicate', 'info',
        `${dups.length} 组重复：${sample}`,
        'memory_update 合并成一条，或 memory_forget 删掉多余的',
      ))
    }

    // 5. 长期没被用过：不算毛病，顺手看看是不是记了废话
    let stale = 0
    for (const it of live) {
      if (Number(it.hits) > 0) continue
      const days = ageDays(it.created || it.validFrom || it.observedAt, now)
      if (days !== null && days >= STALE_DAYS) stale += 1
    }
    if (stale) {
      totals.stale += stale
      issues.push(issue(
        'stale', 'info',
        `${stale} 条超过 ${STALE_DAYS} 天没被用过`,
        '不一定要删；连着旧话题一起清更省容量',
      ))
    }

    // 6. 容量：超过九成就该清一轮了
    if (items.length >= MAX_ITEMS * CAPACITY_WARN) {
      issues.push(issue(
        'capacity', 'warn',
        `${items.length} / ${MAX_ITEMS} 条，快到上限`,
        '跑一次遗忘归档，或把旧话题标成 done',
      ))
    }

    if (issues.length) {
      for (const x of issues) {
        if (x.level === 'error') totals.errors += 1
        else if (x.level === 'warn') totals.warnings += 1
        else totals.infos += 1
      }
      out.push({
        scope: sc.scope || `${sc.kind}:${sc.id}`,
        label: sc.label || '',
        live: live.length,
        items: items.length,
        pending: pending.length,
        issues,
      })
    }
  }

  // 全局建议：先修会答错的，再修快满的，最后才是顺手清
  const advice = []
  if (totals.errors) advice.push('先修主副库不一致（rebuild-index），不然读正文会读空')
  if (totals.warnings) advice.push('看一眼待确认和容量，转正几条、归档几条')
  if (totals.duplicates) advice.push('合并重复说法，省检索名额和注入预算')

  return {
    ok: true,
    at: new Date(now).toISOString(),
    root,
    totals,
    healthy: totals.errors === 0 && totals.warnings === 0,
    scopes: out,
    advice,
  }
}

/** 每个分片一小行摘要，给总览页那种地方用。 */
export function healthLine(report) {
  if (!report?.ok) return '体检没跑成'
  const t = report.totals || {}
  if (!t.errors && !t.warnings) return `体检正常 · ${t.scopes} 个分片 / ${t.live} 条活记忆`
  return `体检：${t.errors} 个错误 · ${t.warnings} 个提醒 · ${t.duplicates} 组重复`
}
