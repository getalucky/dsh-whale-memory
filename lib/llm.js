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
 *   DSH_MEMORY_SEARCH_BASE / _KEY / _MODEL   直连搜索（带联网能力的模型）
 *   DSH_MEMORY_EMBED_BASE / _KEY / _MODEL    向量（Ollama 是 /v1）
 *
 * 任何失败（超时、非 200、JSON 不合规）都返回 null，绝不把半截结果写进库。
 */

import { loadSettings } from './settings.js'
import { cleanOwnerName } from './source.js'
import { APPRAISE_PROMPT, parseAppraisal } from './affect/appraise.js'

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

const 环境前缀 = { llm: 'DSH_MEMORY_LLM', search: 'DSH_MEMORY_SEARCH', embed: 'DSH_MEMORY_EMBED', review: 'DSH_MEMORY_REVIEW' }

function ownCfg(kind) {
  const p = 环境前缀[kind]
  const f = 文件配置()[kind] || {}
  const env = (k) => String(process.env[`${p}_${k}`] ?? '').trim()
  const base = (String(f.base ?? '').trim() || env('BASE')).replace(/\/+$/, '')
  const model = String(f.model ?? '').trim() || env('MODEL')
  const key = String(f.key ?? '').trim() || env('KEY')
  return { base, model, key, ok: Boolean(base && model) }
}

function cfgOf(kind) {
  const own = ownCfg(kind)
  // 向量端点和蒸馏通常是同一个网关：base/key 不填就跟着蒸馏走，只单独填模型名。
  // 但 embed 显式换了 base 又没填 key 时，绝不能再把蒸馏的 key 顺手发到新地址。
  if (kind !== 'embed') return own
  const chat = ownCfg('llm')
  const base = own.base || chat.base
  const sameBase = !own.base || !chat.base || own.base === chat.base
  const key = own.key || (sameBase ? chat.key : '')
  return { ...own, base, key, ok: Boolean(base && own.model), inherit: !own.base }
}

/** 人格审查模型：单独配了就用它，否则继承主 LLM（仍然单独一次调用、独立提示词）。 */
function reviewCfg() {
  const own = cfgOf('review')
  return own.ok ? { ...own, separate: true } : { ...cfgOf('llm'), separate: false }
}

export const llmReady = () => cfgOf('llm').ok
export const searchReady = () => cfgOf('search').ok
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
  // 合法的 [] 表示「这轮没有值得记的」，不是端点故障；返回空数组让调用方
  // 正常收尾，别把一次空转记成失败冷却十分钟。
  if (!arr.length) return []
  const out = []
  const seen = new Set()
  for (const x of arr) {
    const text = String(x?.text ?? '').replace(/\s+/g, ' ').trim()
    if (text.length < 4 || text.length > 240) continue
    const kind = KINDS.has(x?.kind) ? x.kind : 'fact'
    const conf = Number(x?.conf)
    const src = Number(x?.src)
    // 模型自己报的发言人；最终还要拿输入里的昵称表校验一遍才认
    const speaker = String(x?.speaker ?? '').replace(/\s+/g, ' ').trim().slice(0, 24)
    const scene = String(x?.scene ?? '').replace(/\s+/g, ' ').trim().slice(0, 200)
    const mergeId = String(x?.merge_id ?? x?.mergeId ?? '').trim().slice(0, 40)
    if (seen.has(text)) continue
    seen.add(text)
    out.push({
      text,
      kind,
      conf: Number.isFinite(conf) ? Math.min(0.95, Math.max(0.3, conf)) : 0.6,
      src: Number.isInteger(src) && src >= 0 ? src : -1,
      speaker,
      scene,
      mergeId,
    })
    if (out.length >= 12) break
  }
  return out.length ? out : null
}

/**
 * 从模型回复里抠三元组数组。
 * 和 parseCandidates 一样容忍围栏和废话；id 必须对得上输入，类型不认识就留空，
 * 让 graph.js 用 guessType 兜底。返回 null 表示「这轮没拿到合法 JSON」，
 * 空数组表示「模型明确说这几条没有可抽的关系」。
 */
export function parseTriples(content, allowedIds = null) {
  const s = String(content ?? '')
  const a = s.indexOf('[')
  const b = s.lastIndexOf(']')
  if (a < 0 || b <= a) return null
  let arr
  try { arr = JSON.parse(s.slice(a, b + 1)) } catch { return null }
  if (!Array.isArray(arr)) return null
  if (!arr.length) return []
  const allow = allowedIds ? new Set(allowedIds.map(String)) : null
  const TYPES = new Set(['person', 'place', 'org', 'thing', 'event'])
  const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').trim()
  const BAD = /^(用户|某人|有人|对方|大家|众人|我|你|他|她|它)/
  const out = []
  const seen = new Set()
  for (const x of arr) {
    const item = clean(x?.item)
    if (!item || (allow && !allow.has(item))) continue
    const s0 = clean(x?.s).slice(0, 24)
    const o0 = clean(x?.o).slice(0, 24)
    const rel = clean(x?.rel).slice(0, 12)
    if (!s0 || !o0 || !rel) continue
    if (BAD.test(s0) || BAD.test(o0)) continue
    if (/^(以后|下次|这次|上次|是否|是不是)/.test(s0) || /^(以后|下次|这次|上次|是否|是不是)/.test(o0)) continue
    const key = `${item}|${s0}|${rel}|${o0}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      item,
      s: s0,
      sType: TYPES.has(x?.sType) ? x.sType : '',
      rel,
      o: o0,
      oType: TYPES.has(x?.oType) ? x.oType : '',
    })
    if (out.length >= 120) break
  }
  return out
}

/**
 * 批量把记忆条目抽成「实体 —关系→ 实体」。
 * 一次最多 24 条，给蒸馏和回填共用；失败返回 null，绝不写半截结果。
 * @param {{id:string,text:string}[]} items
 * @returns {Promise<{item:string,s:string,sType:string,rel:string,o:string,oType:string,at:string}[]|null>}
 */
export async function extractGraphTriples(items, { fetchImpl = globalThis.fetch, timeoutMs = 40000 } = {}) {
  lastError = ''
  const c = cfgOf('llm')
  if (!c.ok) { lastError = '端点和模型名没填全'; return null }
  if (typeof fetchImpl !== 'function') { lastError = '当前环境没有 fetch'; return null }
  const list = (items || [])
    .filter((x) => x && x.id && String(x.text ?? '').trim())
    .slice(0, 24)
  if (!list.length) return []
  const lines = list
    .map((x) => `[${x.id}] ${clip(x.text, 160)}`)
    .join('\n')

  const sys = [
    '你是知识图谱抽取器。把每条记忆拆成「实体 —关系→ 实体」三元组。',
    '只抽句子里明确写出的事实和稳定关系：身份、称呼、居住地、工作/上学地点、喜好、厌恶、养了什么、归属、明确的要求或约定。',
    '实体必须是名词短语（人、地点、组织、东西、事件），1-14 字；不要整句、不要代词、不要时间词。',
    '人、称呼、昵称一律用 person；不要拿「用户/某人/有人/对方/大家」当实体，句子里没有明确名字就不抽。',
    '关系要短，2-8 字，用动词或介词，比如 喜欢/不喜欢/住在/在X上班/养了/叫/是/认为/要求/属于/提到。',
    '问句、假设、玩笑、临时情绪不要抽；「以后/下次/是否」不是实体。',
    '拿不准就不抽。每条记忆最多 4 条三元组；没有可抽的就不要给它输出。',
    'item 必须照抄输入行首方括号里的 id，不许改写、不许编。',
    '只输出 JSON 数组，不要解释：[{"item":"m_xxx","s":"实体","sType":"person|place|org|thing|event","rel":"关系","o":"实体","oType":"..."}]',
  ].join('\n')

  const ask = (maxTokens) => postJson(`${c.base}/chat/completions`, c.key, {
    model: c.model,
    temperature: 0.1,
    max_tokens: maxTokens,
    ...noThinking(c.model),
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: lines },
    ],
  }, fetchImpl, timeoutMs)
  const contentOf = (x) => String(x?.choices?.[0]?.message?.content ?? '').trim()
  // 思考模型会先把 token 烧在 reasoning_content 上，content 空着回来。
  // 先按 4000 要，空回复或被截断就用 8000 再要一次；还空才算失败。
  let j = await ask(4000)
  if (j && (!contentOf(j) || j?.choices?.[0]?.finish_reason === 'length')) {
    const retry = await ask(8000)
    if (retry && contentOf(retry)) j = retry
  }
  if (!j) return null
  const content = j?.choices?.[0]?.message?.content
  if (typeof content !== 'string' || !content.trim()) {
    lastError = '返回空 content（思考吃掉 token 或模型拒答）'
    return null
  }
  const out = parseTriples(content, list.map((x) => x.id))
  if (!out) {
    lastError = j?.choices?.[0]?.finish_reason === 'length'
      ? '输出被 max_tokens 截断，三元组 JSON 不完整'
      : `返回内容不是三元组 JSON · ${clip(content, 80)}`
    return null
  }
  const at = new Date().toISOString()
  return out.map((x) => ({ ...x, at }))
}

/**
 * 一次会话调一次，别按消息调。
 * 输入消息带 `[n]` 行号，模型返回的 `src` 就是这个 n，最终映射回传入数组的下标。
 * @param {{at:string,speaker?:string,text:string,owner?:boolean}[]} messages
 * @param {{fetchImpl?:Function,timeoutMs?:number,group?:boolean,ownerName?:string,existing?:object[]}} [opts]
 * @returns {Promise<{text:string,kind:string,conf:number,src:number,scene:string,mergeId:string}[]|null>}
 */
export async function distillMessages(messages, { fetchImpl = globalThis.fetch, timeoutMs = 20000, group = false, ownerName = '爹', existing = [] } = {}) {
  lastError = ''
  const c = cfgOf('llm')
  if (!c.ok) { lastError = '端点和模型名没填全'; return null }
  if (typeof fetchImpl !== 'function') { lastError = '当前环境没有 fetch'; return null }
  const owner = cleanOwnerName(ownerName)
  // 保留原始下标：模型看到的是紧凑后的 [n]，返回的 src 也得能找回调用方那条消息
  const list = (messages || [])
    .map((m, i) => ({ m, i }))
    .filter(({ m }) => m && m.text)
    .slice(-40)
  if (!list.length) { lastError = '没有可蒸馏的消息'; return null }
  // 同一批里出现同名不同 QQ：给名字加尾号，免得模型把两个人当成一个。
  // 没有重名就只写昵称，不把号码塞进提示词。
  const byName = new Map()
  for (const { m } of list) {
    const name = String(m.speaker ?? '').trim()
    if (!name) continue
    if (!byName.has(name)) byName.set(name, new Set())
    const qq = String(m.qq ?? '').trim()
    if (qq) byName.get(name).add(qq)
  }
  const labelOf = (m) => {
    const name = String(m.speaker ?? '').trim()
    if (!name) return ''
    const qq = String(m.qq ?? '').trim()
    const set = byName.get(name)
    return qq && set && set.size > 1 ? `${name}（尾号${qq.slice(-4)}）` : name
  }
  // 模型返回的 speaker 必须能对回输入行；对不上就当没报。
  const speakers = new Map()
  for (const { m } of list) {
    const label = labelOf(m)
    if (label) speakers.set(label, String(m.speaker ?? '').trim())
  }
  // 拥有者标记只在群聊里给：私聊只有对面一个人，标了反而多占字。
  // 按条截断而不是把整段拼完再 slice(0, 6000)：后者砍掉的是最新的消息，
  // 而相对时间和 src 恰恰最依赖最近的发言。保证 40 条都还在，只是长句截短。
  const perLine = Math.max(120, Math.min(800, Math.floor(5600 / Math.max(1, list.length))))
  const lines = list
    .map(({ m }, n) => {
      const body = String(m.text ?? '')
      const text = body.length > perLine ? `${body.slice(0, perLine)}…` : body
      const who = labelOf(m)
      return `[${n}] ${m.at || ''} ${group && m.owner ? '[拥有者] ' : ''}${who ? `${who}：` : ''}${text}`
    })
    .join('\n')

  const sys = [
    '你是记忆蒸馏器。从对话里提取值得长期记住的内容，只保留关于对话里的人和本机拥有者的稳定事实、偏好、约定、关系。',
    '对话里机器人也在场，每行「昵称：」是发言人。「你」一律指机器人自己，不是任何群友；名单里出现的人都不是「你」。',
    '不要记：问句、寒暄、玩笑、临时情绪、机器人自己说的话、密码和密钥。',
    '每条一到两句，把「我」改成说话人的昵称：第一句是完整事实，第二句补当时在聊什么、为什么要记；禁止只写半句结论。不要把两件不相干的事并成一句。',
    '同一件事、同一条偏好的多个细节必须合成一条候选，宁可长一点，也不要拆成两条。',
    '每条必须带 scene：一句话写当时在聊什么、因何说起；不知道就写「日常聊天」。',
    '每条再带一个 speaker 字段：填这句话的发言人，照抄输入行首「昵称：」里的名字（有尾号就一起抄）；不许写成别人，也不许写「群里的人」「某人」。',
    '「我」只指这一行的发言人；别把别人的话、引用里的话算到这一行发言人头上。',
    '代词纪律：「你」只指机器人；「他/她/它/这个人/他们」如果前文没明确点过名字，就保留原称呼或写「某人」，禁止从说话人名单、群成员或上下文里挑一个名字补上。',
    '一句话要提到别人时，只能用输入里真实出现过的称呼；没出现过就写关系（「一个群友」），不要编名字。',
    '看到「[引用了一条消息]」只当标记：引用原文没给出来，不要把引用里的内容算到这一行发言人头上，也不要猜被引用的人是谁。',
    '有人对「你」提要求、约定、提醒时，记成「我」是对象的那句，例如「阿青：你要多跟姐姐聊天」→「阿青要求我多跟姐姐聊天」，绝不换成一个群友的名字。',
    ...(group ? [
      `这是群聊。标了 [拥有者] 的行是本机拥有者本人（你服务的人，称呼他「${owner}」），只有这些发言属于拥有者；没有标记的都不是。`,
      `如果整段对话没有任何 [拥有者] 标记，只有署名是「${owner}」的发言才是拥有者。`,
      '没有标记的其他人不是拥有者；其他人口中的「老爹」「老爸」「主人」「我妈」等，都是他们自己的家人或主人，不等于拥有者，也不等于「用户」；转述时写清归属，例如「阿青称呼自己的主人为老爹」，不要写成「称呼用户爹」「称呼爹」或「有人想抢老爹」。',
      `没有 [拥有者] 标记的行里出现「${owner}」这个称呼时，按那个人的家人/主人处理，不要记到拥有者头上。`,
    ] : []),
    ...(Array.isArray(existing) && existing.length ? [
      '下面是库里已有的相关记忆。新候选如果和其中一条是同一件事（换个说法、补个细节都算），不要新建：merge_id 填那条 id，text 写成合并后的完整版本，把新细节补进去；不是同一件就留空字符串。',
      ...existing.map((x) => `[${x.id}]（${x.kind || 'fact'}）${clip(x.text || x.summary, 120)}${x.scene ? `｜场景：${clip(x.scene, 60)}` : ''}`),
    ] : []),
    'src 必填：这句话是从哪条消息里读出来的，填输入行首的方括号编号；跨多条合成的一句填最早那条。',
    '只输出 JSON 数组，不要解释，格式：[{"text":"...","kind":"fact|pref|event|relation","conf":0.6,"src":0,"speaker":"发言人昵称","scene":"当时在聊什么","merge_id":""}]',
    APPRAISE_PROMPT,
  ].join('\n')

  const ask = (maxTokens) => postJson(`${c.base}/chat/completions`, c.key, {
    model: c.model,
    temperature: 0.1,
    max_tokens: maxTokens,
    ...noThinking(c.model),
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: lines },
    ],
  }, fetchImpl, timeoutMs)
  let j = await ask(2400)
  if (!j) return null
  // 输出被 max_tokens 截断时给一次更大的预算；直接当失败会白白冷却十分钟。
  if (j?.choices?.[0]?.finish_reason === 'length') {
    const retry = await ask(4000)
    if (retry) j = retry
  }
  const content = j?.choices?.[0]?.message?.content
  if (typeof content !== 'string' || !content.trim()) {
    lastError = '返回空 content（思考吃掉 token 或模型拒答）'
    return null
  }
  const out = parseCandidates(content)
  if (!out) {
    lastError = j?.choices?.[0]?.finish_reason === 'length'
      ? '输出被 max_tokens 截断，候选 JSON 不完整'
      : `返回内容不是候选 JSON · ${clip(content, 80)}`
    return null
  }
  // 显示编号 n → 调用方数组下标；越界的 src 留 -1，交给调用方回退。
  // 发言人同理：模型报的名字必须能在这一批的昵称里对上，对不上就留空。
  // merge_id 也必须真的在这批旧记忆里，防止模型顺手编一个 id。
  const last = list.length - 1
  const allowedMerge = new Set((existing || []).map((x) => String(x.id || '')).filter(Boolean))
  const shaped = out.map((x) => ({
    ...x,
    speaker: speakers.get(x.speaker) || '',
    mergeId: allowedMerge.has(String(x.mergeId || '')) ? x.mergeId : '',
    src: x.src >= 0 && x.src <= last ? list[x.src].i : -1,
  }))
  // 情绪旁路：同一个数组里那个没 text 的元素，parseCandidates 当空条目丢掉了，
  // 这里按同样的切片再读一遍。非枚举属性，调用方遍历 / JSON 化都看不见它。
  const appraisal = parseAppraisal(content)
  if (appraisal.length) Object.defineProperty(shaped, 'affect', { value: appraisal, enumerable: false })
  return shaped
}

/**
 * 连通性探测：设置页点「测试」时用。
 * 真发一次最小请求，把 401/404/地址少 /v1 这些错误分清楚，别只回一句「连不上」。
 */
export async function probeKind(kind, { fetchImpl = globalThis.fetch, timeoutMs = 8000 } = {}) {
  const c = cfgOf(kind)
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

export const probeLlm = (opts) => probeKind('llm', opts)

/**
 * 直连搜索：直接用配置的搜索模型发一次 chat/completions。
 * 这条路给带联网能力的模型用（Kimi / 智谱 / OpenRouter :online 之类）；
 * 模型不支持联网时仍会回一坨看似合理的 JSON，URL 协议校验是最后一道闸，
 * 所以界面要写清楚「这里要填真的能联网的模型」。
 * @returns {Promise<string|null>} 原始回复文本；失败返回 null
 */
export async function searchComplete(prompt, { fetchImpl = globalThis.fetch, timeoutMs = 180000 } = {}) {
  lastError = ''
  const c = cfgOf('search')
  if (!c.ok) { lastError = '搜索模型没配置'; return null }
  if (typeof fetchImpl !== 'function') { lastError = '当前环境没有 fetch'; return null }
  const j = await postJson(`${c.base}/chat/completions`, c.key, {
    model: c.model,
    temperature: 0.3,
    max_tokens: 2000,
    ...noThinking(c.model),
    messages: [
      {
        role: 'system',
        content: [
          '你是联网搜索助手。只根据你实际检索到的公开网页内容回答，不要凭记忆编造新闻或 URL。',
          '输出必须是严格 JSON，不要解释、不要 markdown 代码块。',
        ].join('\n'),
      },
      { role: 'user', content: String(prompt ?? '').slice(0, 4000) },
    ],
  }, fetchImpl, timeoutMs)
  if (!j) return null
  const content = j?.choices?.[0]?.message?.content
  if (typeof content !== 'string' || !content.trim()) {
    lastError = '搜索模型返回空 content'
    return null
  }
  return content
}

/**
 * 通用文本补全：不走 JSON 约束，只把模型回复原样带回来。
 * 日记这类「要人味」的生成用它；失败返回 null，调用方决定是否落盘。
 * @param {{role:string,content:string}[]} messages
 * @returns {Promise<string|null>}
 */
export async function completeText(messages, {
  fetchImpl = globalThis.fetch, timeoutMs = 60000, temperature = 0.7, maxTokens = 2500,
} = {}) {
  lastError = ''
  const c = cfgOf('llm')
  if (!c.ok) { lastError = '端点和模型名没填全'; return null }
  if (typeof fetchImpl !== 'function') { lastError = '当前环境没有 fetch'; return null }
  const list = (Array.isArray(messages) ? messages : [])
    .filter((m) => m && typeof m.content === 'string' && m.content.trim())
    .map((m) => ({ role: m.role === 'assistant' ? 'assistant' : m.role === 'system' ? 'system' : 'user', content: m.content }))
  if (!list.length) { lastError = '没有可发送的消息'; return null }
  const j = await postJson(`${c.base}/chat/completions`, c.key, {
    model: c.model,
    temperature,
    max_tokens: maxTokens,
    ...noThinking(c.model),
    messages: list,
  }, fetchImpl, timeoutMs)
  if (!j) return null
  const content = j?.choices?.[0]?.message?.content
  if (typeof content !== 'string' || !content.trim()) {
    lastError = '返回空 content（思考吃掉 token 或模型拒答）'
    return null
  }
  return content.trim()
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

const TRIAGE_ACTION = {
  keep: 'keep', 保留: 'keep', 必须保留: 'keep', 维持: 'keep', 原样: 'keep',
  shorten: 'shorten', 缩短: 'shorten', 压缩: 'shorten', 精简: 'shorten', 写短: 'shorten',
  replace: 'replace', 替换: 'replace', 改写: 'replace', 替代: 'replace', 换掉: 'replace',
}

function parseTriage(content) {
  const s = String(content ?? '').trim()
  const o = parseJsonObject(s)
  if (o) return Array.isArray(o.items) ? o.items : Array.isArray(o) ? o : null
  // 容忍直接返回裸数组
  const a = s.indexOf('[')
  const b = s.lastIndexOf(']')
  if (a < 0 || b <= a) return null
  try {
    const arr = JSON.parse(s.slice(a, b + 1))
    return Array.isArray(arr) ? arr : null
  } catch {
    return null
  }
}

/**
 * 人格逐行去留审查：必须保留 / 可缩短 / 可替换。
 * 只收到 EVOLVABLE 的逐行文本（本来就是人设，不含聊天原文 / 凭据）。
 * 这里只做解析和形状收口；文本是否合法由 personaaudit 校验。
 * @returns {Promise<Array<{i:number,action:'keep'|'shorten'|'replace',why:string,text:string}>|null>}
 */
export async function personaTriage(lines, { fetchImpl = globalThis.fetch, timeoutMs = 30000 } = {}) {
  const c = cfgOf('llm')
  if (!c.ok || typeof fetchImpl !== 'function') return null
  const rows = (lines || []).map((t, i) => ({ i, text: String(t) })).filter((x) => x.text.trim())
  if (!rows.length) return null

  const sys = [
    '你在给人格文件做逐行去留审查。只处理给出的 EVOLVABLE 行，逐行选一个动作：',
    'keep：必须保留。身份边界、称呼、底线、禁忌、已经很紧凑的约束，拿不准就选它。',
    'shorten：意思完全不变，但能用更少的字说清楚；至少短 10%。',
    'replace：这条说法已经不准、过时或和别的规则冲突，可以换成同一条约束的更准确说法；不能换主题、不能新增内容。',
    'why 不超过 20 字；shorten / replace 给完整新句子（保留「不 / 别 / 要 / 最多 / 先」这类约束词，不超过 100 字）。',
    '禁止写具体事件、日期、路径、链接、凭据、自曝 AI；不要产生重复行。',
    '只输出严格 JSON：{"items":[{"i":0,"action":"keep","why":"身份边界"},{"i":1,"action":"shorten","why":"举例可删","text":"..."},{"i":2,"action":"replace","why":"说法过时","text":"..."}]}',
  ].join('\n')
  const j = await postJson(`${c.base}/chat/completions`, c.key, {
    model: c.model,
    temperature: 0,
    max_tokens: 2400,
    ...noThinking(c.model),
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: JSON.stringify({ lines: rows }) },
    ],
  }, fetchImpl, timeoutMs)
  if (!j) return null
  const list = parseTriage(j?.choices?.[0]?.message?.content)
  if (!Array.isArray(list)) return null
  const out = new Map()
  for (const x of list) {
    const i = Number(x?.i)
    if (!Number.isInteger(i) || !rows.some((r) => r.i === i)) continue
    const raw = String(x?.action ?? '').trim()
    const action = TRIAGE_ACTION[raw] || TRIAGE_ACTION[raw.toLowerCase()]
    if (!action) continue
    const why = String(x?.why ?? '').replace(/\s+/g, ' ').trim().slice(0, 60)
    const text = String(x?.text ?? x?.compact ?? '').replace(/\s+/g, ' ').trim().slice(0, 300)
    const prev = out.get(i)
    // 同一行重复给动作时 keep 优先；其余保留第一次
    if (prev && (prev.action === 'keep' || action !== 'keep')) continue
    out.set(i, { i, action, why, text })
  }
  return out.size ? [...out.values()] : null
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
    'add 类型才看证据；replace 类型要看 old→new 是否仍是同一条约束、有没有丢内容或换主题、是不是确实更好。',
    '出现具体事件、日期、项目名、隐私、自曝 AI、单次评价，一律不通过。拿不准就不通过。',
    '只输出 JSON：{"verdicts":[{"rule":"...","approve":true,"why":"不通过时一句话说明"}]}',
  ].join('\n')
  const j = await postJson(`${c.base}/chat/completions`, c.key, {
    model: c.model,
    temperature: 0,
    max_tokens: 900,
    ...noThinking(c.model),
    messages: [
      { role: 'system', content: sys },
      {
        role: 'user',
        content: JSON.stringify({
          candidates: candidates.map((x) => ({
            kind: x.old ? 'replace' : 'add',
            rule: x.rule,
            old: x.old || '',
            evidence: x.evidence || [],
          })),
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

/**
 * 探测一个模型能不能真的做向量。
 * 400/404 通常是「这个模型不支持 /embeddings」，记成 unusable；401/403 是权限问题。
 */
async function postEmbed(base, key, model, fetchImpl, timeoutMs) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  timer.unref?.()
  try {
    const res = await fetchImpl(`${base}/embeddings`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(key ? { authorization: `Bearer ${key}` } : {}),
      },
      body: JSON.stringify({ model, input: ['ping'] }),
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

async function probeEmbedOne(base, key, model, { fetchImpl, timeoutMs }) {
  const t0 = Date.now()
  const r = await postEmbed(base, key, model, fetchImpl, timeoutMs)
  const ms = Date.now() - t0
  const v = r.json?.data?.[0]?.embedding
  if (r.status === 200 && Array.isArray(v) && v.length) {
    return { id: model, state: 'ok', status: 200, dim: v.length, ms }
  }
  if (r.timeout) return { id: model, state: 'timeout', ms, why: '请求超时' }
  if (r.status === 429) return { id: model, state: 'limited', status: 429, ms, why: '限流' }
  if (r.status === 401) return { id: model, state: 'auth', status: 401, ms, why: whyOf(r.json, r.text) }
  if (r.status === 403) return { id: model, state: 'denied', status: 403, ms, why: whyOf(r.json, r.text) }
  if (r.status === 400 || r.status === 404) {
    return { id: model, state: 'unusable', status: r.status, ms, why: whyOf(r.json, r.text) }
  }
  if (!r.status) return { id: model, state: 'error', ms, why: r.error || '请求失败' }
  return { id: model, state: 'error', status: r.status, ms, why: whyOf(r.json, r.text) || `HTTP ${r.status}` }
}

/**
 * 自动找支持向量的模型：拉 /models，优先测名字像 embedding 的，逐个发最小 /embeddings。
 * 名字不明显时退回测前 10 个，避免把 100 多个聊天模型全打一遍。
 */
export async function listEmbedModels({
  base,
  key = '',
  fetchImpl = globalThis.fetch,
  timeoutMs = 8000,
  budgetMs = 30000,
  concurrency = 4,
  limit = 24,
} = {}) {
  const b = String(base ?? '').trim().replace(/\/+$/, '')
  const k = String(key ?? '').trim()
  if (!b) return { ok: false, why: '端点不能为空' }
  if (typeof fetchImpl !== 'function') return { ok: false, why: '当前环境没有 fetch' }

  const listed = await fetchModelIds(b, k, fetchImpl, Math.max(timeoutMs, 12000))
  if (!listed.ok) return listed

  const isEmbed = (id) => /embed|bge|vector|text-embedding|embedding/i.test(String(id))
  const likely = listed.ids.filter(isEmbed)
  const ids = (likely.length ? likely : listed.ids).slice(0, limit)
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
      out[i] = await probeEmbedOne(b, k, ids[i], { fetchImpl, timeoutMs })
    }
  }
  const n = Math.min(Math.max(1, concurrency), ids.length)
  await Promise.all(Array.from({ length: n }, worker))

  const counts = {
    usable: 0, limited: 0, auth: 0, denied: 0, unusable: 0, timeout: 0, error: 0, skipped: 0,
  }
  for (const m of out) {
    if (m.state === 'ok') counts.usable += 1
    else if (counts[m.state] !== undefined) counts[m.state] += 1
  }
  return {
    ok: true,
    models: out,
    counts,
    truncated: listed.ids.length > ids.length,
    likelyOnly: likely.length > 0,
  }
}
/** 向量模型连通测试：和 chat 的 /chat/completions 分开，发一次最小 embeddings 请求。 */
export async function probeEmbed({ fetchImpl = globalThis.fetch, timeoutMs = 8000 } = {}) {
  const c = cfgOf('embed')
  if (!c.ok) return { ok: false, why: '端点和模型名都要填' }
  if (typeof fetchImpl !== 'function') return { ok: false, why: '当前环境没有 fetch' }
  const t0 = Date.now()
  const j = await postJson(`${c.base}/embeddings`, c.key, { model: c.model, input: ['ping'] }, fetchImpl, timeoutMs, 1)
  const v = j?.data?.[0]?.embedding
  if (!Array.isArray(v) || !v.length) {
    return { ok: false, why: lastLlmError() || '返回里没有向量' }
  }
  return { ok: true, ms: Date.now() - t0, dim: v.length, model: c.model }
}
