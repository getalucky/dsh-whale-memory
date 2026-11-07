/**
 * ingest.js —— 把对话收进 staging，等蒸馏
 *
 * 宿主事件签名（踩过）：`ctx.on('session/event', (session, event) => ...)`。
 * 是两个参数，不是 `({ sessionId, event })` 那种解构。
 * 会话 id 在 `session.header.id`，消息在 `event.data.content`。
 *
 * 只收两类事件：user/message（谁说了什么）、assistant/message（她回了什么）。
 * 群里一条 user/message 可能塞了多个发言人（每行一个），按行拆开分别记，
 * 这样蒸馏不会把 A 说的话算到 B 头上。
 *
 * 说话人从消息头解析：`某人（12345678）：...` → { nick, qq }
 *
 * 来源判定（踩过）：
 *   第一版用启动时预热的同步缓存判断「是不是桥接会话」。绑定表改了以后缓存
 *   不刷新，非桥接的 Web 会话就被当成桥接收了进来——盘上真出现过 10 条。
 *   现在每次落盘前 await sourceOfSession()，它按文件 mtime 决定要不要重读，
 *   一次多余的 readFile 而已，比串分片便宜。
 */

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { paths, loadScope, withWriteLock } from './store.js'
import { sourceOfSession } from './source.js'
import { projectOf } from './namespace.js'
import { rankItems } from './recall.js'
import { setRelevance, setResumePack, sessionTraceOf } from './inject.js'
import { buildResumePack } from './resume.js'
import { redactText, hasSecret } from './redact.js'
import { bumpMessages } from './personaloop.js'
import { noteUserMessage } from './beat/feedback.js'
import { loadConfig as loadBeatConfig } from './beat/config.js'
import { loadState } from './beat/state.js'
import { addChatMaterial } from './beat/sources/chat.js'

const KEEP = 300

/**
 * 宿主/桥接往里塞的、不是人说的话。它们在 user/message 里，长得和用户发言一样，
 * 收进来会挤掉 KEEP 名额，蒸馏时还可能被当事实。
 */
const META_PREFIXES = [
  'Time sampled while',
  'Browser time zone for this request',
  'Elapsed since the preceding model-visible message',
  'Current time:',
  "Today's date:",
  'Runtime context:',
  // 宿主每轮/重启后附加的运行环境说明（2026-10-30 实盘出现：6 条全部漏进 staging）
  'Current runtime context',
  'Current working directory:',
  'Current DSH file policy:',
  'Approval policy:',
  'Current DeepSeek Harness implementation checkout:',
  'Current DeepSeek Harness Web GUI URL:',
]

/**
 * 宿主自己塞进来的 user/message（本地会话里很常见）：
 * 它们带 `data.source.kind`，不是人说的。按 kind 拦比按文本前缀稳。
 * 桥接消息一般没有 source 或 kind 不在这张表里，不受影响。
 */
const META_SOURCE_KINDS = new Set([
  'runtime-context', 'system', 'developer', 'tool', 'title', 'compaction',
  // 2026-11-04 实盘：下面这些也套着 user/message 的壳，但都不是人说的。
  // 技能目录一条能拆出十几行，心跳每两小时来一次，不拦会挤掉 KEEP 名额。
  'skill-catalog', 'time-context', 'heartbeat', 'model-selection',
  'compact-checkpoint', 'agent-instructions', 'agent-message',
  'subagent-settled', 'repeat-tool-reminder', 'tool-jobs', 'user-approval',
  'goal', 'tool-goal',
  // 记忆插件自己的投递包：走 user/message 的壳，但不是用户说的话。
  'memory-beat',
])

export function isMetaMessage(text) {
  const t = String(text ?? '').trim()
  if (!t) return true
  if (t.startsWith('<system-reminder')) return true
  return META_PREFIXES.some((p) => t.startsWith(p))
}

/**
 * 桥接层拼在群消息前后的一圈脚手架：身份块、前情标题、消息分隔、【现在】。
 *
 * 这些不是人说的话，进 staging 只会占名额，更大的问题是那份名单——
 * 2026-11-04 实盘：名单第一行是某个群友，爹紧接着说「你要多跟姐姐聊天」，
 * 蒸馏模型不知道「你」是谁，就从名单里挑了个名字补上，
 * 记成「爹要求那个群友多跟姐姐聊天」。名单不进蒸馏，模型才没得挑。
 */
const BRIDGE_SCAFFOLD = [
  /^【\s*群聊身份/,
  /^这一批（含前情）说话的人[:：]/,
  /^[（(]?这行名单是桥接层/,
  /^【以下是消息】$/,
  /^【你刚进群/,
  /^【现在】$/,
]

export function isBridgeScaffold(text) {
  const t = String(text ?? '').trim()
  return BRIDGE_SCAFFOLD.some((re) => re.test(t))
}

/** 前情块的收尾标记会黏在最后一句人话后面（「…？\n【现在】」），剥掉。 */
export function stripBridgeMarks(text) {
  return String(text ?? '').replace(/(?:^|\n)[ \t　]*【现在】[ \t　]*$/g, '').trim()
}

/**
 * 剥掉消息里夹带的整块 <system-reminder>…</system-reminder>。
 *
 * 有时人话和宿主说明拼在同一条事件里。按行过滤只能删掉带标签的首行，
 * 剩下的说明全会被当成人说的；整块匹配、整块删，才留得住正文。
 * 只认闭合的块：没闭合的多半是在聊这个标签本身，交给 isMetaMessage 判断。
 */
export function stripSystemBlocks(text) {
  return String(text ?? '')
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, '')
    .trim()
}

/** 最近一条桥接消息：工具靠它判断「现在在跟谁说话」。 */
export const lastActive = { sessionId: '', at: 0, scope: null }

/** 采集队列。flush() 等它，工具和测试才不会读到上一个会话。 */
let pending = Promise.resolve()

function textOf(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((p) => p && p.type === 'text')
      .map((p) => String(p.text ?? ''))
      .join('\n')
  }
  return ''
}

const SPEAKER_RE = /^([^\s（(]{1,24})[（(](\d{5,12})[)）]\s*[:：]\s*(.*)$/

/**
 * 剥掉 QQ 桥接往消息尾巴上追加的旁白。
 *
 * 桥接会把「（这条不是单独叫你的…）」这类提示用两个换行接在原话后面，
 * 那是给模型看的上下文，不是人说的话。不剥掉的话：
 *   · 蒸馏会把旁白当成事实记下来（2026-10-30 真发生过，
 *     群里那条记成了「明天几点上班（这条不是单独叫你的：顺着接话就行」）
 *   · 问句因为尾巴不是问号，逃过了「问句不记」的过滤
 *
 * 只认「两个换行 + 全角括号」这种桥接固定格式，别乱摘正文里的括号。
 */
export function stripBridgeNote(text) {
  const t = String(text ?? '')
  const i = t.indexOf('\n\n（')
  if (i > 0 && t.trimEnd().endsWith('）')) return t.slice(0, i).trimEnd()
  return t
}

/**
 * 把一条用户消息拆成若干发言人段落。
 * 单行私聊 → 一条；群里多行 → 多段（各自带昵称和 QQ 号）。
 */
export function splitSpeakers(text) {
  const raw = String(text ?? '')
  const lines = raw.split('\n')
  const out = []
  let cur = null
  for (const line of lines) {
    const m = line.match(SPEAKER_RE)
    if (m) {
      cur = { nick: m[1].trim(), qq: m[2], text: m[3] }
      out.push(cur)
    } else if (cur) {
      cur.text = `${cur.text}\n${line}`
    } else {
      out.push({ nick: '', qq: '', text: line })
    }
  }
  return out
    .map((x) => ({ ...x, text: String(x.text ?? '').trim() }))
    .filter((x) => x.text)
}

/** 兼容旧用法：从单条文本拿第一个发言人。 */
export function parseSpeaker(text) {
  const first = splitSpeakers(text)[0]
  return first ? { nick: first.nick, qq: first.qq, head: '' } : { nick: '', qq: '', head: '' }
}

async function readStaging(root, sid) {
  try {
    const raw = await readFile(join(paths(root).staging, `${sid}.jsonl`), 'utf8')
    return raw.split('\n').filter(Boolean)
  } catch {
    return []
  }
}

async function writeStaging(root, sid, lines) {
  const keep = lines.slice(-KEEP)
  const file = join(paths(root).staging, `${sid}.jsonl`)
  const tmp = `${file}.${process.pid}.tmp`
  await writeFile(tmp, keep.join('\n') + (keep.length ? '\n' : ''), 'utf8')
  await rename(tmp, file)
}

/**
 * 长会话不空闲，蒸馏等不到触发点：每 N 个真实用户回合抽一次会话素材。
 * 只做规则抽取，不额外调模型；重复内容由素材库按 originId 去重。
 */
const chatTurns = new Map()

async function maybeChatMaterial(root, sid, config, lines, turns, log) {
  if (config?.enabled !== true) return
  const every = Math.max(0, Number(config.chatTurnEvery) || 0)
  if (!every || turns <= 0) return
  const n = (Number(chatTurns.get(sid)) || 0) + turns
  if (n < every) {
    chatTurns.set(sid, n)
    return
  }
  chatTurns.set(sid, 0)
  const recent = []
  for (const line of (lines || []).slice(-Math.max(every * 2, 24))) {
    try {
      const m = JSON.parse(line)
      if (!m.text) continue
      // 她的上一句也要带上：会话素材只剪用户单句会缺上文，投出去就是半句话。
      if (m.role === 'her') recent.push({ text: m.text, at: m.at, role: 'her' })
      else if (m.role === 'user' && !m.reply_to && !isBridgeScaffold(m.text)) {
        recent.push({ text: m.text, at: m.at, speaker: m.speaker, role: 'user' })
      }
    } catch { /* 坏行跳过 */ }
  }
  if (!recent.some((m) => m.role === 'user')) return
  await addChatMaterial(root, recent, { config, log }).catch(() => {})
}

/**
 * 注册采集。
 * @returns {() => void}
 */
export function registerIngest(ctx, { root, log } = {}) {
  const say = log ?? (() => {})

  const onEvent = (session, event) => {
    try {
      const sid = String(session?.header?.id ?? session?.id ?? '')
      if (!sid) return
      const t = String(event?.type ?? '')

      // 宿主压缩完成：补一个恢复包（目标 / 画像 / 已读已写），只注入一次
      if (t === 'compaction/end') {
        pending = pending.then(async () => {
          const src = await sourceOfSession(sid).catch(() => null)
          if (!src) return
          const sc = await loadScope(root, src.kind, src.id).catch(() => null)
          if (!sc) return
          const lines = await readStaging(root, sid)
          let goal = ''
          for (let i = lines.length - 1; i >= 0; i -= 1) {
            try {
              const r = JSON.parse(lines[i])
              if (r.role === 'user' && r.text) { goal = r.text; break }
            } catch { /* 坏行跳过 */ }
          }
          const tr = sessionTraceOf(root, sid)
          const pack = buildResumePack(sc, { goal, readIds: tr.read, writtenIds: tr.wrote })
          if (pack) setResumePack(root, sid, pack)
        }).catch(() => {})
        return
      }

      if (t !== 'user/message' && t !== 'assistant/message') return
      const data = event?.data ?? {}
      // 运行环境快照、系统注入不是人说的话，整条丢
      const srcKind = String(data?.source?.kind ?? '')
      if (srcKind && META_SOURCE_KINDS.has(srcKind)) return
      const raw = textOf(data?.content ?? data?.message?.content ?? '')
      if (!raw.trim()) return
      // 整块提醒要先按块拦，不能等拆完行再逐行判断：
      // 技能清单只有首行带 <system-reminder>，拆开后每个 skill 一行，全像人话。
      if (t === 'user/message' && isMetaMessage(raw)) return
      const body = t === 'user/message' ? stripSystemBlocks(raw) : raw
      if (!body.trim()) return

      const at = new Date().toISOString()
      const recs = []
      if (t === 'user/message') {
        for (const sp of splitSpeakers(stripBridgeNote(body))) {
          if (isMetaMessage(sp.text) || isBridgeScaffold(sp.text)) continue
          // 凭据不落盘：QQ 里贴的 key / 密码在这里就被打码，后面蒸馏也就记不到
          const clean = redactText(stripBridgeMarks(sp.text))
          if (!clean) continue
          recs.push({
            at,
            role: 'user',
            speaker: sp.nick,
            qq: sp.qq,
            text: clean.slice(0, 2000),
            redacted: clean !== sp.text || undefined,
          })
        }
      } else {
        recs.push({ at, role: 'her', text: raw.slice(0, 2000) })
      }
      if (!recs.length) return

      pending = pending.then(async () => {
        // 真实用户消息：先记活动时间，再给上一跳投递做归因。
        // 投递包本身带 source.kind=memory-beat，在更上面就被拦掉了。
        let beatCfg = {}
        let reply = null
        const lastUserText = [...recs].reverse().find((r) => r.role === 'user' && r.text)?.text || ''
        if (lastUserText) {
          beatCfg = await loadBeatConfig(root).catch(() => ({}))
          // beat 关着就不写 state；打开后从下一条消息开始记活动。
          if (beatCfg?.enabled) {
            // 只认「投递 → 她回 → 用户回」：staging 里得有一条投递之后她的发言。
            let arm = true
            const st = await loadState(root).catch(() => null)
            const p = st?.pendingDelivery
            if (p) {
              const since = Date.parse(p.at || '') || 0
              const prior = await readStaging(root, sid)
              const hasHer = prior.some((line) => {
                try {
                  const r = JSON.parse(line)
                  return r.role === 'her' && (Date.parse(r.at || '') || 0) >= since
                } catch { return false }
              })
              arm = Boolean(hasHer) && (!p.sessionId || String(p.sessionId) === String(sid))
            }
            reply = await noteUserMessage(root, {
              sessionId: sid, text: lastUserText, at: new Date(at), armDelivery: arm,
            }).catch(() => null)
            if (reply?.repliedNow && reply.deliveryId) {
              for (let i = recs.length - 1; i >= 0; i -= 1) {
                if (recs[i].role === 'user' && recs[i].text === lastUserText) {
                  recs[i].reply_to = reply.deliveryId
                  break
                }
              }
            }
          }
        }

        // 来源每次现查：绑定表一改，这里立刻跟着改，不留启动时的旧快照
        const src = await sourceOfSession(sid).catch(() => null)
        if (!src) return

        // 仓库命名空间：工具拿不到会话 id，只能跟着「最近活跃」一起记下来。
        // cwd 只在这里读得到（session.header.cwd），过了这一轮就没地方找了。
        const cwd = String(session?.header?.cwd ?? session?.cwd ?? '')
        const ns = projectOf(cwd)

        // 工具调用紧跟在本轮消息之后，不能等异步落盘——先同步记「最近活跃」
        lastActive.sessionId = sid
        lastActive.at = Date.now()
        lastActive.scope = { kind: src.kind, id: src.id, label: src.label, addr: src.addr ?? '' }
        lastActive.ns = ns

        const lines = await withWriteLock(async () => {
          const cur = await readStaging(root, sid)
          for (const r of recs) cur.push(JSON.stringify(r))
          await writeStaging(root, sid, cur)
          return cur
        })

        // 人格自动迭代的门槛：只数真正的用户消息（元消息和工具输出上面已经丢了）。
        // 每条落一次小 JSON，写入量跟消息量同级，不值得为它再开一个内存计数器。
        const userCount = recs.filter((r) => r.role === 'user').length
        if (userCount) {
          await bumpMessages(root, userCount).catch(() => {})
          await maybeChatMaterial(root, sid, beatCfg, lines, userCount, say)
        }

        // 这一轮提到的旧记忆，标记给注入层优先展示。
        // 固定按衰减分取 topN 的话，一半内容跟当前话题无关，白占预算。
        const lastUser = [...recs].reverse().find((r) => r.role === 'user' && r.text)
        if (lastUser) {
          // 仓库会话要把仓库库一起排：只排个人库的话，刚记进仓库的条目永远轮不到
          const alive = (x) => x.state !== 'archived' && x.state !== 'superseded' && x.state !== 'suggested'
          const pool = []
          if (ns) {
            const ps = await loadScope(ns.root, ns.kind, ns.id).catch(() => null)
            if (ps) pool.push(...(ps.items || []).filter(alive))
          }
          const sc = await loadScope(root, src.kind, src.id).catch(() => null)
          if (sc) pool.push(...(sc.items || []).filter(alive))
          const rel = rankItems(lastUser.text, pool, { limit: 3, min: 0.05 })
          setRelevance(root, sid, rel.map((r) => r.item.id))
        }
      }).catch((e) => say(`[whale] staging 写失败 ${String(e?.message ?? e).slice(0, 120)}`))
    } catch { /* 采集失败不影响对话 */ }
  }

  const off = ctx.on?.('session/event', onEvent)
  return typeof off === 'function' ? off : () => {}
}

/** 等采集队列落盘（工具调用前 / 测试 / 关闭时用）。 */
export async function flush() {
  await pending.catch(() => {})
}

/** 读某个会话的 staging（蒸馏用）。 */
export async function readStagingLines(root, sid) {
  return readStaging(root, sid)
}

/**
 * 消费 staging 里「这一轮实际读过的那几行」，保留之后新追加的消息。
 *
 * 蒸馏是「先读 → 调 LLM（最长 8 秒）→ 最后清」。整文件清空会把中途进来的
 * 消息一起抹掉；按行消费就是水位断点：读了多少行，只划掉多少行。
 *
 * 按内容比对前缀，不是按行数硬切：万一两次蒸馏读了同一批行，后一次会发现
 * 前缀已经不匹配（被前一次划掉了），于是什么都不划，避免把新消息误吃掉。
 *
 * 调用方负责持锁（withWriteLock）；这里不再加锁，避免自锁。
 *
 * @param {string[]} taken 这一轮读到的原始行（JSON 字符串）
 * @returns {Promise<number>} 实际划掉的行数
 */
export async function consumeStaging(root, sid, taken) {
  const want = (Array.isArray(taken) ? taken : []).map(String)
  if (!want.length) return 0
  const file = join(paths(root).staging, `${sid}.jsonl`)
  let raw = ''
  try { raw = await readFile(file, 'utf8') } catch { return 0 }
  const lines = raw.split('\n').filter(Boolean)
  if (!lines.length) return 0

  let same = 0
  while (same < lines.length && same < want.length && lines[same] === want[same]) same += 1
  // 前缀对不上（被别的蒸馏先划掉了 / 超 KEEP 被截了）：宁可不动，下轮靠合并去重
  if (same === 0) return 0
  const rest = lines.slice(same)
  await writeStaging(root, sid, rest)
  return same
}

/**
 * 把认不出来源的 staging 挪进 staging/orphan/，别再每 5 分钟重试一次。
 * 不删数据：文件还在，只是不在 listStaging 的扫描范围里。
 * @returns {Promise<boolean>} 有没有搬成功
 */
export async function quarantineStaging(root, sid, why = 'unknown source') {
  const dir = join(paths(root).staging, 'orphan')
  try {
    await mkdir(dir, { recursive: true })
    await rename(join(paths(root).staging, `${sid}.jsonl`), join(dir, `${sid}.jsonl`))
    await writeFile(
      join(dir, 'index.jsonl'),
      JSON.stringify({ at: new Date().toISOString(), session: sid, why }) + '\n',
      { encoding: 'utf8', flag: 'a' },
    )
    return true
  } catch {
    return false
  }
}

/** 列出所有 staging 会话（不含 orphan/）。 */
export async function listStaging(root) {
  try {
    const { readdir } = await import('node:fs/promises')
    const names = await readdir(paths(root).staging)
    return names.filter((n) => n.endsWith('.jsonl')).map((n) => n.replace(/\.jsonl$/, ''))
  } catch {
    return []
  }
}
