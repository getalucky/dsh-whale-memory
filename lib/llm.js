/**
 * llm.js —— 可选的 OpenAI 兼容端点（蒸馏 / 向量）
 *
 * 配置来源：设置页写的 <root>/settings.json 优先，没填的字段回落到环境变量。
 * 默认全关：一处都没配就返回 null，调用方回退规则蒸馏和词法检索。
 * 不猜宿主的 llm 接口（没核实过），走标准 /chat/completions 与 /embeddings，
 * 本地 Ollama、one-api、官方 API 都能接。
 *
 * 环境变量：
 *   DSH_MEMORY_LLM_BASE / _KEY / _MODEL      蒸馏
 *   DSH_MEMORY_EMBED_BASE / _KEY / _MODEL    向量（Ollama 是 /v1）
 *
 * 任何失败（超时、非 200、JSON 不合规）都返回 null，绝不把半截结果写进库。
 */

import { loadSettings } from './settings.js'

const KINDS = new Set(['fact', 'pref', 'event', 'relation'])

/** 配置根由 index.js 启动时告诉这里；设置页写的就是这个目录下的 settings.json。 */
let 配置根 = ''
let 缓存 = { root: '', at: 0, data: {} }

export function setConfigRoot(root) {
  配置根 = String(root ?? '')
  resetSettingsCache()
}

/** 设置页保存后调一下，别让 1 秒缓存把「保存完马上测试」读到旧值。 */
export function resetSettingsCache() {
  缓存 = { root: '', at: 0, data: {} }
}

function 文件配置() {
  if (!配置根) return {}
  const now = Date.now()
  if (缓存.root === 配置根 && now - 缓存.at < 1000) return 缓存.data
  const data = loadSettings(配置根)
  缓存 = { root: 配置根, at: now, data }
  return data
}

const 环境前缀 = { llm: 'DSH_MEMORY_LLM', embed: 'DSH_MEMORY_EMBED', review: 'DSH_MEMORY_REVIEW' }

function cfgOf(kind) {
  const p = 环境前缀[kind]
  const f = 文件配置()[kind] || {}
  const env = (k) => String(process.env[`${p}_${k}`] ?? '').trim()
  const base = (String(f.base ?? '').trim() || env('BASE')).replace(/\/+$/, '')
  const model = String(f.model ?? '').trim() || env('MODEL')
  const key = String(f.key ?? '').trim() || env('KEY')
  return { base, model, key, ok: Boolean(base && model) }
}

/** 人格审查模型：单独配了就用它，否则继承主 LLM（仍然单独一次调用、独立提示词）。 */
function reviewCfg() {
  const own = cfgOf('review')
  return own.ok ? { ...own, separate: true } : { ...cfgOf('llm'), separate: false }
}

export const llmReady = () => cfgOf('llm').ok
export const embedReady = () => cfgOf('embed').ok
export const reviewReady = () => reviewCfg().ok
export const reviewSeparate = () => reviewCfg().separate

/** 端点挂了就别每轮都等 8 秒，冷十分钟再用。设置页保存新配置时清掉。 */
let 冷却到 = 0

export const llmCoolingDown = () => Date.now() < 冷却到
export const markLlmFailure = () => { 冷却到 = Date.now() + 10 * 60 * 1000 }
export const resetLlmCooldown = () => { 冷却到 = 0 }

/**
 * Qwen3 系是思考模型：reasoning_content 先吃 token、再吐正文。
 * 实测 Qwen3.8-Flash 开着思考时，一句蒸馏要 5.5 秒，700 token 常被推理吃满，
 * content 返回空串 → parseCandidates 拿不到数组 → 判定 LLM 挂了 → 冷却十分钟
 * → 这一整段时间全走规则兜底（残句就是这么来的）。
 * 关掉思考后同一条请求 1.2 秒返回，正文直接是 JSON。
 * 只对明确认识的思考模型加这个字段；别的端点不认识 chat_template_kwargs 会忽略，
 * 但没必要拿兼容性冒险。
 */
function noThinking(model) {
  return /qwen3|qwen-3|qwq|deepseek-r1|thinking/i.test(String(model ?? ''))
    ? { chat_template_kwargs: { enable_thinking: false } }
    : {}
}

/** 最近一次请求为什么失败。蒸馏日志拿它说清楚是 429、超时还是空回复。 */
let lastError = ''
export const lastLlmError = () => lastError

const clip = (s, n = 120) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n)

/**
 * 一次 POST，失败留痕、瞬时可恢复的错误重试一次。
 * 401/404 这种重试也没用，直接返回；5xx、429、超时、连不上才重试。
 */
async function postJson(url, key, body, fetchImpl, timeoutMs, tries = 2) {
  for (let n = 1; n <= tries; n += 1) {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), timeoutMs)
    timer.unref?.()
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(key ? { authorization: `Bearer ${key}` } : {}),
        },
        body: JSON.stringify(body),
        signal: ac.signal,
      })
      if (!res.ok) {
        let detail = ''
        try { if (typeof res.text === 'function') detail = clip(await res.text()) } catch { /* 读不出来就算了 */ }
        lastError = `HTTP ${res.status}${detail ? ` · ${detail}` : ''}`
        if (!(n < tries && (res.status === 429 || res.status >= 500))) return null
      } else {
        try {
          const j = await res.json()
          lastError = ''
          return j
        } catch {
          lastError = ac.signal.aborted ? `超时 ${timeoutMs}ms` : '返回不是 JSON'
          return null
        }
      }
    } catch (e) {
      lastError = e?.name === 'AbortError' ? `超时 ${timeoutMs}ms` : `连不上：${clip(e?.message ?? e)}`
      if (!(n < tries)) return null
    } finally {
      clearTimeout(timer)
    }
    await sleep(500)
  }
  return null
}

/**
 * 从模型回复里抠 JSON 数组（容忍 ```json 围栏和前后废话）。
 *
 * `src` 是这句话的来源消息下标（distillMessages 传进来那一批里的位置）。
 * 没有它，相对时间（「明天」「下周」）只能按会话最后一句锚，会漂一天；
 * 模型编出来的越界下标一律当没有（-1），调用方回退到最后一句的时间。
 */
export function parseCandidates(content) {
  const s = String(content ?? '')
  const a = s.indexOf('[')
  const b = s.lastIndexOf(']')
  if (a < 0 || b <= a) return null
  let arr
  try { arr = JSON.parse(s.slice(a, b + 1)) } catch { return null }
  if (!Array.isArray(arr)) return null
  const out = []
  const seen = new Set()
  for (const x of arr) {
    const text = String(x?.text ?? '').replace(/\s+/g, ' ').trim()
    if (text.length < 4 || text.length > 120) continue
    const kind = KINDS.has(x?.kind) ? x.kind : 'fact'
    const conf = Number(x?.conf)
    const src = Number(x?.src)
    if (seen.has(text)) continue
    seen.add(text)
    out.push({
      text,
      kind,
      conf: Number.isFinite(conf) ? Math.min(0.95, Math.max(0.3, conf)) : 0.6,
      src: Number.isInteger(src) && src >= 0 ? src : -1,
    })
    if (out.length >= 12) break
  }
  return out.length ? out : null
}

/**
 * 一次会话调一次，别按消息调。
 * 输入消息带 `[n]` 行号，模型返回的 `src` 就是这个 n，最终映射回传入数组的下标。
 * @param {{at:string,speaker?:string,text:string}[]} messages
 * @returns {Promise<{text:string,kind:string,conf:number,src:number}[]|null>}
 */
export async function distillMessages(messages, { fetchImpl = globalThis.fetch, timeoutMs = 20000 } = {}) {
  lastError = ''
  const c = cfgOf('llm')
  if (!c.ok) { lastError = '端点和模型名没填全'; return null }
  if (typeof fetchImpl !== 'function') { lastError = '当前环境没有 fetch'; return null }
  // 保留原始下标：模型看到的是紧凑后的 [n]，返回的 src 也得能找回调用方那条消息
  const list = (messages || [])
    .map((m, i) => ({ m, i }))
    .filter(({ m }) => m && m.text)
    .slice(-40)
  if (!list.length) { lastError = '没有可蒸馏的消息'; return null }
  const lines = list
    .map(({ m }, n) => `[${n}] ${m.at || ''} ${m.speaker ? `${m.speaker}：` : ''}${m.text}`)
    .join('\n')

  const sys = [
    '你是记忆蒸馏器。从对话里提取值得长期记住的内容，只保留关于用户或群友的稳定事实、偏好、约定、关系。',
    '对话里机器人也在场，每行「昵称：」是发言人。「你」一律指机器人自己，不是任何群友；名单里出现的人都不是「你」。',
    '不要记：问句、寒暄、玩笑、临时情绪、机器人自己说的话、密码和密钥。',
    '每条一句话，把「我」改成说话人的昵称；不要把两件事并成一句。',
    '有人对「你」提要求、约定、提醒时，记成「我」是对象的那句，例如「爹：你要多跟姐姐聊天」→「爹要求我多跟姐姐聊天」，绝不换成一个群友的名字。',
    'src 必填：这句话是从哪条消息里读出来的，填输入行首的方括号编号；跨多条合成的一句填最早那条。',
    '只输出 JSON 数组，不要解释，格式：[{"text":"...","kind":"fact|pref|event|relation","conf":0.6,"src":0}]',
  ].join('\n')

  const j = await postJson(`${c.base}/chat/completions`, c.key, {
    model: c.model,
    temperature: 0.1,
    max_tokens: 1200,
    ...noThinking(c.model),
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: lines.slice(0, 6000) },
    ],
  }, fetchImpl, timeoutMs)
  if (!j) return null
  const content = j?.choices?.[0]?.message?.content
  if (typeof content !== 'string' || !content.trim()) {
    lastError = '返回空 content（思考吃掉 token 或模型拒答）'
    return null
  }
  const out = parseCandidates(content)
  if (!out) {
    lastError = `返回内容不是候选 JSON · ${clip(content, 80)}`
    return null
  }
  // 显示编号 n → 调用方数组下标；越界的 src 留 -1，交给调用方回退
  const last = list.length - 1
  return out.map((x) => ({
    ...x,
    src: x.src >= 0 && x.src <= last ? list[x.src].i : -1,
  }))
}

/**
 * 连通性探测：设置页点「测试」时用。
 * 真发一次最小请求，把 401/404/地址少 /v1 这些错误分清楚，别只回一句「连不上」。
 */
export async function probeLlm({ fetchImpl = globalThis.fetch, timeoutMs = 8000 } = {}) {
  const c = cfgOf('llm')
  if (!c.ok) return { ok: false, why: '端点和模型名都要填' }
  if (typeof fetchImpl !== 'function') return { ok: false, why: '当前环境没有 fetch' }

  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  timer.unref?.()
  const t0 = Date.now()
  try {
    const res = await fetchImpl(`${c.base}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(c.key ? { authorization: `Bearer ${c.key}` } : {}),
      },
      body: JSON.stringify({
        model: c.model,
        temperature: 0,
        max_tokens: 8,
        messages: [{ role: 'user', content: '回复 ok' }],
      }),
      signal: ac.signal,
    })
    const text = await res.text()
    if (!res.ok) return { ok: false, status: res.status, why: `${res.status} · ${text.slice(0, 140)}` }
    let j = null
    try { j = JSON.parse(text) } catch { /* 下面统一判 */ }
    if (!j || !Array.isArray(j?.choices)) {
      return { ok: false, status: res.status, why: '返回不是 chat/completions 格式，端点地址可能少了 /v1' }
    }
    return {
      ok: true,
      status: res.status,
      ms: Date.now() - t0,
      sample: String(j.choices[0]?.message?.content ?? '').slice(0, 40),
    }
  } catch (e) {
    return { ok: false, why: `连不上：${String(e?.message ?? e).slice(0, 140)}` }
  } finally {
    clearTimeout(timer)
  }
}

/** 从回复里抠 JSON 对象（容忍 ``` 围栏）。 */
function parseJsonObject(content) {
  const s = String(content ?? '')
  const a = s.indexOf('{')
  const b = s.lastIndexOf('}')
  if (a < 0 || b <= a) return null
  try {
    const o = JSON.parse(s.slice(a, b + 1))
    return o && typeof o === 'object' ? o : null
  } catch {
    return null
  }
}

/**
 * 人格候选生成（文档 8.6 第三步）。
 * 只收到脱敏后的结构化样本：id + 摘要 + 来源分片，没有原始聊天、没有 source_quote。
 * @param {{id:string,scope:string,text:string}[]} samples
 * @param {string} current 现有 EVOLVABLE 区块
 * @returns {Promise<{rule:string,evidence:string[]}[]|null>}
 */
export async function personaPatch(samples, current, { fetchImpl = globalThis.fetch, timeoutMs = 30000 } = {}) {
  const c = cfgOf('llm')
  if (!c.ok || typeof fetchImpl !== 'function') return null
  const ids = new Set((samples || []).map((s) => s.id))
  if (!ids.size) return null

  const sys = [
    '你是人格蒸馏器。只根据给出的脱敏样本，提炼最多 3 条「跨场景、跨 30 天仍成立」的说话方式规则。',
    '只收：称呼、语气、句长、怼人尺度、忌口雷区、长期偏好。',
    '不收：具体事件、当下情绪、阶段性状态、项目名、路径、日期、号码、任何隐私。',
    '不要重复现有规则。rule 不超过 60 字；evidence 只能从样本 id 里选，至少 1 个。',
    '只输出 JSON，不要解释：{"additions":[{"rule":"...","evidence":["m_x"]}]}',
  ].join('\n')
  const j = await postJson(`${c.base}/chat/completions`, c.key, {
    model: c.model,
    temperature: 0.2,
    max_tokens: 700,
    ...noThinking(c.model),
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: JSON.stringify({ current: String(current || '').slice(0, 1500), samples: (samples || []).slice(0, 40) }) },
    ],
  }, fetchImpl, timeoutMs)
  if (!j) return null
  const o = parseJsonObject(j?.choices?.[0]?.message?.content)
  const list = Array.isArray(o?.additions) ? o.additions : []
  const out = []
  for (const x of list) {
    const rule = String(x?.rule ?? '').replace(/\s+/g, ' ').trim()
    if (rule.length < 4 || rule.length > 80) continue
    // 证据只认这次真的发给它的样本 id，模型编出来的 id 一律丢掉
    const ev = (Array.isArray(x?.evidence) ? x.evidence : []).map(String).filter((id) => ids.has(id))
    if (!ev.length) continue
    out.push({ rule, evidence: ev })
    if (out.length >= 3) break
  }
  return out.length ? out : null
}

/**
 * 独立审查（文档 8.6 第六步）：只看结构化证据 + 候选规则，不看原始聊天。
 * @returns {Promise<{rule:string, approve:boolean, why:string}[]|null>}
 */
export async function personaVerdicts(candidates, samples, { fetchImpl = globalThis.fetch, timeoutMs = 30000 } = {}) {
  const c = reviewCfg()
  if (!c.ok || typeof fetchImpl !== 'function') return null
  if (!Array.isArray(candidates) || !candidates.length) return null

  const sys = [
    '你是独立审查员，不负责生成，只负责否掉不该进人格的规则。',
    '逐条判断：是否只描述说话方式；是否跨场景、跨 30 天成立；证据是否支撑；是否与现有规则重复或冲突。',
    '出现具体事件、日期、项目名、隐私、自曝 AI、单次评价，一律不通过。拿不准就不通过。',
    '只输出 JSON：{"verdicts":[{"rule":"...","approve":true,"why":"不通过时一句话说明"}]}',
  ].join('\n')
  const j = await postJson(`${c.base}/chat/completions`, c.key, {
    model: c.model,
    temperature: 0,
    max_tokens: 600,
    ...noThinking(c.model),
    messages: [
      { role: 'system', content: sys },
      {
        role: 'user',
        content: JSON.stringify({
          candidates: candidates.map((x) => ({ rule: x.rule, evidence: x.evidence })),
          samples: (samples || []).slice(0, 40),
        }),
      },
    ],
  }, fetchImpl, timeoutMs)
  if (!j) return null
  const o = parseJsonObject(j?.choices?.[0]?.message?.content)
  const list = Array.isArray(o?.verdicts) ? o.verdicts : []
  const out = []
  for (const v of list) {
    const rule = String(v?.rule ?? '').trim()
    if (!rule) continue
    out.push({ rule, approve: v?.approve === true, why: String(v?.why ?? '').slice(0, 120) })
  }
  return out.length ? out : null
}

/**
 * 批量向量。返回与输入等长的数组；任何异常返回 null。
 * @param {string[]} texts
 * @returns {Promise<number[][]|null>}
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 从上游错误体里抠一句能给用户看的原因。 */
function whyOf(json, text) {
  const m = json?.error?.message ?? json?.message ?? json?.error
  const s = typeof m === 'string' ? m : (text || '')
  return String(s).replace(/\s+/g, ' ').slice(0, 120)
}

/**
 * GET /models：列表接口本身失败就整批失败，不逐条猜。
 * 有的端点不支持这个接口，返回 ok:false 让界面提示手填。
 */
async function fetchModelIds(base, key, fetchImpl, timeoutMs) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  timer.unref?.()
  try {
    const res = await fetchImpl(`${base}/models`, {
      method: 'GET',
      headers: key ? { authorization: `Bearer ${key}` } : {},
      signal: ac.signal,
    })
    const text = await res.text()
    let j = null
    try { j = JSON.parse(text) } catch { /* 下面统一判 */ }
    if (!res.ok) {
      const hint = res.status === 404 || res.status === 405 ? '；模型名可以手填' : ''
      return { ok: false, status: res.status, why: `${res.status} · ${whyOf(j, text)}${hint}` }
    }
    const arr = Array.isArray(j?.data) ? j.data : (Array.isArray(j?.models) ? j.models : null)
    if (!arr) return { ok: false, status: res.status, why: '端点没返回模型列表，可能不支持 /models；模型名可以手填' }
    const ids = [...new Set(arr.map((x) => String(x?.id ?? x?.model ?? x?.name ?? '').trim()).filter(Boolean))]
    if (!ids.length) return { ok: false, status: res.status, why: '模型列表是空的' }
    return { ok: true, ids }
  } catch (e) {
    const timeout = String(e?.name ?? '') === 'AbortError'
    return { ok: false, why: timeout ? '拉模型列表超时' : `连不上：${String(e?.message ?? e).slice(0, 120)}` }
  } finally {
    clearTimeout(timer)
  }
}

/** 发一次最小对话请求；超时/网络错误不抛，统一回 { status: 0 }。 */
async function postChat(base, key, model, fetchImpl, timeoutMs) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  timer.unref?.()
  try {
    const res = await fetchImpl(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(key ? { authorization: `Bearer ${key}` } : {}),
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 8,
        messages: [{ role: 'user', content: 'ok' }],
      }),
      signal: ac.signal,
    })
    const text = await res.text()
    let json = null
    try { json = JSON.parse(text) } catch { /* 非 JSON 也照样归类 */ }
    return { status: res.status, json, text }
  } catch (e) {
    const timeout = String(e?.name ?? '') === 'AbortError'
    return { status: 0, timeout, error: String(e?.message ?? e).slice(0, 120) }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 探测一个模型能不能真的对话。
 * 429 和超时都重试一次：ModelScope 的 429 是瞬时限流，一次就判死会误伤。
 */
async function probeOne(base, key, model, { fetchImpl, timeoutMs }) {
  const t0 = Date.now()
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const r = await postChat(base, key, model, fetchImpl, timeoutMs)
    const ms = Date.now() - t0
    if (r.status === 200 && Array.isArray(r.json?.choices)) return { id: model, state: 'ok', status: 200, ms }
    if (r.timeout) {
      if (attempt === 0) continue
      return { id: model, state: 'timeout', ms, why: '请求超时' }
    }
    if (r.status === 429) {
      if (attempt === 0) { await sleep(800); continue }
      return { id: model, state: 'limited', status: 429, ms, why: '限流' }
    }
    if (r.status === 401) {
      // 别拿一个 401 判死整批：ModelScope 对没开通的单个模型也回 401「令牌无效」
      return { id: model, state: 'auth', status: 401, ms, why: whyOf(r.json, r.text) }
    }
    if (r.status === 403) {
      // 403 通常只是这个模型没开通/无权访问，别连累其它模型
      return { id: model, state: 'denied', status: 403, ms, why: whyOf(r.json, r.text) }
    }
    if (r.status === 200) return { id: model, state: 'unusable', status: 200, ms, why: '返回不是对话格式' }
    if (r.status === 0) return { id: model, state: 'error', ms, why: r.error || '连不上' }
    return { id: model, state: 'unusable', status: r.status, ms, why: whyOf(r.json, r.text) }
  }
  return { id: model, state: 'error', ms: Date.now() - t0, why: '重试后仍失败' }
}

/**
 * 拉模型列表 + 逐个实测能不能对话。
 * 列表里混着 embedding、图像模型，能不能用只能真发一次；探测不写冷却、不落盘。
 * @returns {Promise<{ok:boolean, status?:number, why?:string, models?:object[], counts?:object, truncated?:boolean}>}
 */
export async function listChatModels({
  base,
  key = '',
  fetchImpl = globalThis.fetch,
  timeoutMs = 6000,
  budgetMs = 30000,
  concurrency = 6,
  limit = 40,
} = {}) {
  const b = String(base ?? '').trim().replace(/\/+$/, '')
  const k = String(key ?? '').trim()
  if (!b) return { ok: false, why: '端点不能为空' }
  if (typeof fetchImpl !== 'function') return { ok: false, why: '当前环境没有 fetch' }

  const listed = await fetchModelIds(b, k, fetchImpl, Math.max(timeoutMs, 12000))
  if (!listed.ok) return listed

  const ids = listed.ids.slice(0, limit)
  const deadline = Date.now() + budgetMs
  const out = new Array(ids.length)
  let cursor = 0

  const worker = async () => {
    while (true) {
      const i = cursor
      cursor += 1
      if (i >= ids.length) return
      if (Date.now() > deadline) {
        out[i] = { id: ids[i], state: 'skipped', why: '超过探测时间' }
        continue
      }
      out[i] = await probeOne(b, k, ids[i], { fetchImpl, timeoutMs })
    }
  }
  const n = Math.min(Math.max(1, concurrency), ids.length)
  await Promise.all(Array.from({ length: n }, worker))

  const counts = { usable: 0, limited: 0, auth: 0, denied: 0, unusable: 0, timeout: 0, error: 0, skipped: 0 }
  for (const m of out) {
    if (m.state === 'ok') counts.usable += 1
    else if (counts[m.state] !== undefined) counts[m.state] += 1
  }
  return { ok: true, models: out, counts, truncated: listed.ids.length > ids.length }
}

export async function embedTexts(texts, { fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
  const c = cfgOf('embed')
  if (!c.ok || typeof fetchImpl !== 'function') return null
  const list = (texts || []).map((t) => String(t ?? '').slice(0, 1000))
  if (!list.length) return null

  const j = await postJson(`${c.base}/embeddings`, c.key, { model: c.model, input: list }, fetchImpl, timeoutMs)
  const data = j?.data
  if (!Array.isArray(data) || data.length !== list.length) return null
  const out = data.map((d) => d?.embedding)
  if (!out.every((v) => Array.isArray(v) && v.length && v.every((n) => typeof n === 'number'))) return null
  return out
}
