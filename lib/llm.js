/**
 * llm.js —— 可选的 OpenAI 兼容端点（蒸馏 / 向量）
 *
 * 默认全关：没配 base 就返回 null，调用方回退规则蒸馏和词法检索。
 * 不猜宿主的 llm 接口（没核实过），走标准 /chat/completions 与 /embeddings，
 * 本地 Ollama、one-api、官方 API 都能接。
 *
 * 环境变量：
 *   DSH_MEMORY_LLM_BASE / _KEY / _MODEL      蒸馏
 *   DSH_MEMORY_EMBED_BASE / _KEY / _MODEL    向量（Ollama 是 /v1）
 *
 * 任何失败（超时、非 200、JSON 不合规）都返回 null，绝不把半截结果写进库。
 */

const KINDS = new Set(['fact', 'pref', 'event', 'relation'])

function envCfg(kind) {
  const p = kind === 'embed' ? 'DSH_MEMORY_EMBED' : 'DSH_MEMORY_LLM'
  const base = String(process.env[`${p}_BASE`] ?? '').trim().replace(/\/+$/, '')
  const model = String(process.env[`${p}_MODEL`] ?? '').trim()
  const key = String(process.env[`${p}_KEY`] ?? '').trim()
  return { base, model, key, ok: Boolean(base && model) }
}

/** 人格审查模型：独立配置优先，没配就退回主 LLM（仍然单独一次调用、独立提示词）。 */
function reviewCfg() {
  const base = String(process.env.DSH_MEMORY_REVIEW_BASE ?? process.env.DSH_MEMORY_LLM_BASE ?? '').trim().replace(/\/+$/, '')
  const model = String(process.env.DSH_MEMORY_REVIEW_MODEL ?? process.env.DSH_MEMORY_LLM_MODEL ?? '').trim()
  const key = String(process.env.DSH_MEMORY_REVIEW_KEY ?? process.env.DSH_MEMORY_LLM_KEY ?? '').trim()
  return { base, model, key, ok: Boolean(base && model), separate: Boolean(process.env.DSH_MEMORY_REVIEW_MODEL) }
}

export const llmReady = () => envCfg('llm').ok
export const embedReady = () => envCfg('embed').ok
export const reviewReady = () => reviewCfg().ok
export const reviewSeparate = () => reviewCfg().separate

async function postJson(url, key, body, fetchImpl, timeoutMs) {
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
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** 从模型回复里抠 JSON 数组（容忍 ```json 围栏和前后废话）。 */
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
    if (seen.has(text)) continue
    seen.add(text)
    out.push({ text, kind, conf: Number.isFinite(conf) ? Math.min(0.95, Math.max(0.3, conf)) : 0.6 })
    if (out.length >= 12) break
  }
  return out.length ? out : null
}

/**
 * 一次会话调一次，别按消息调。
 * @param {{at:string,speaker?:string,text:string}[]} messages
 * @returns {Promise<{text:string,kind:string,conf:number}[]|null>}
 */
export async function distillMessages(messages, { fetchImpl = globalThis.fetch, timeoutMs = 20000 } = {}) {
  const c = envCfg('llm')
  if (!c.ok || typeof fetchImpl !== 'function') return null
  const lines = (messages || [])
    .filter((m) => m && m.text)
    .slice(-40)
    .map((m) => `${m.at || ''} ${m.speaker ? `${m.speaker}：` : ''}${m.text}`)
    .join('\n')
  if (!lines.trim()) return null

  const sys = [
    '你是记忆蒸馏器。从对话里提取值得长期记住的内容，只保留关于用户或群友的稳定事实、偏好、约定、关系。',
    '不要记：问句、寒暄、玩笑、临时情绪、机器人自己说的话、密码和密钥。',
    '每条一句话，把「我」改成说话人的昵称；不要把两件事并成一句。',
    '只输出 JSON 数组，不要解释，格式：[{"text":"...","kind":"fact|pref|event|relation","conf":0.6}]',
  ].join('\n')

  const j = await postJson(`${c.base}/chat/completions`, c.key, {
    model: c.model,
    temperature: 0.1,
    max_tokens: 700,
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: lines.slice(0, 6000) },
    ],
  }, fetchImpl, timeoutMs)
  if (!j) return null
  return parseCandidates(j?.choices?.[0]?.message?.content)
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
  const c = envCfg('llm')
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
export async function embedTexts(texts, { fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
  const c = envCfg('embed')
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
