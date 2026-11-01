/**
 * resume.js —— 压缩后恢复包（阶段 8 / 文档 7.9）
 *
 * 压缩会把"我们正在做什么"和"刚读过哪条记忆"一起压扁。恢复包只补最少的指针：
 * 目标 / 画像 / 最近的高权重条目 / 本会话读过写过哪些 id，≤500 tokens。
 *
 * 只在宿主发 compaction/end 事件后注入一次，10 分钟后自动消失；
 * 不重放历史，不重新注入正文。
 */

export const RESUME = {
  maxChars: 420,
  ttlMs: 10 * 60 * 1000,
}

function short(s, n) {
  const v = String(s ?? '').replace(/\s+/g, ' ').trim()
  return v.length > n ? `${v.slice(0, n - 1)}…` : v
}

/**
 * @param {object} scope
 * @param {{goal?:string, readIds?:string[], writtenIds?:string[], now?:number}} opts
 */
export function buildResumePack(scope, opts = {}) {
  if (!scope) return ''
  const items = (scope.items || [])
    .filter((x) => x && x.state !== 'archived' && x.state !== 'superseded' && x.state !== 'suggested' && x.state !== 'expired')
    .sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0))
    .slice(0, 3)

  const lines = ['【压缩后恢复】']
  if (opts.goal) lines.push(`当前任务：${short(opts.goal, 60)}`)
  if (scope.profile?.summary) lines.push(`画像：${short(scope.profile.summary, 90)}`)
  if (items.length) {
    lines.push('优先记得：')
    for (const it of items) lines.push(`- ${it.id}｜${short(it.summary || it.text, 30)}`)
  }
  const read = (opts.readIds || []).slice(-5)
  const wrote = (opts.writtenIds || []).slice(-5)
  if (read.length) lines.push(`本会话已读：${read.join('、')}`)
  if (wrote.length) lines.push(`本会话已写：${wrote.join('、')}`)
  lines.push('接着做手上的事；要细节用 read_memory(id)，不要重放历史。')

  let text = lines.join('\n')
  if (text.length > RESUME.maxChars) text = `${text.slice(0, RESUME.maxChars - 1)}…`
  return text
}
