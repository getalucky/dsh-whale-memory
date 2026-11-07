/**
 * secure/psych.js —— 心理画像（加密）
 *
 * 只收用户明确说过的压力/情绪/精力自述，不做推断。内容由一个扁平对象
 * 组成，读出来给画像重建与面板用；不写日志、不进提示词。
 */

import { createHash } from 'node:crypto'

import { readEncrypted, writeEncrypted, psychPath } from './vault.js'

// 明确的自我状态表述：必须带第一人称或「今天/最近」这类当下时间锚。
// 不做情绪推断，只摘用户自己说出口的句子。
const PSYCH_PATTERNS = [
  /(?:我|俺|咱)(?:最近|这几天|这两天|今天|现在|真的|一直|快|有点|很|特别|太|好|挺)*(?:累|疲惫|困|烦|焦虑|压力(?:很|好|特别|太)?大|崩溃|难受|不开心|开心|高兴|兴奋|低落|抑郁|失眠|睡不着|头疼|没精神|没动力|不想动|emo|撑不住|顶不住)/i,
  /(?:最近|这几天|这两天|今天|现在)(?:我)?(?:有点|很|特别|快|太|好|真的)*(?:累|困|烦|焦虑|难受|失眠|睡不着|开心|高兴|低落|崩溃|emo|撑不住|顶不住)/i,
  /(?:压力|工作|上班|学习|考试|项目)(?:有点|很|特别|好|太|快|真的)*(?:大|重|烦|累|压得我|压死我)/,
  /(?:最近|这几天|这两天|今天|现在)(?:我)?(?:压力|心情|状态|精神|情绪)(?:有点|很|特别|好|太|快|真的)*(?:大|重|差|不好|不错|挺好|很好)/,
  /(?:我|俺|咱)(?:有点|很|特别|快|太|好|真的)*(?:emo|崩了|裂开|麻了|破防)/i,
  /(?:最近|这几天|今天)(?:心情|状态|精神|情绪)(?:不太好|不好|很差|不错|挺好|很好)/,
]

const SPLIT = /[。！？!?；;\n]+/

function hashOf(text) {
  return createHash('sha1').update(String(text)).digest('hex').slice(0, 16)
}

/** 从一句话里摘出明确的心理自述；没有返回空数组。纯规则，不推断。 */
export function extractPsychStatements(text) {
  const raw = String(text ?? '').trim()
  if (raw.length < 4 || raw.length > 2000) return []
  const out = []
  for (const part of raw.split(SPLIT)) {
    const s = part.trim()
    if (s.length < 4 || s.length > 120) continue
    if (PSYCH_PATTERNS.some((re) => re.test(s))) out.push(s)
  }
  return [...new Set(out)].slice(0, 2)
}

export async function readPsych(root) {
  const raw = await readEncrypted(root, psychPath(root), '')
  if (!raw) return { entries: [], updatedAt: '' }
  try {
    const o = JSON.parse(raw)
    return {
      entries: Array.isArray(o?.entries) ? o.entries : [],
      updatedAt: String(o?.updatedAt ?? ''),
    }
  } catch {
    return { entries: [], updatedAt: '' }
  }
}

export async function writePsych(root, doc, { now = new Date() } = {}) {
  const body = {
    entries: Array.isArray(doc?.entries) ? doc.entries.slice(0, 50) : [],
    updatedAt: now.toISOString(),
  }
  await writeEncrypted(root, psychPath(root), JSON.stringify(body))
  return body
}

/**
 * 从一批用户消息里收心理自述。只收用户原话，按正文去重，最多留 50 条。
 * @param {Array<{text:string, at?:string}>} messages
 * @returns {Promise<{ok:boolean, added:number, updated:number}>}
 */
export async function capturePsych(root, messages, { now = new Date() } = {}) {
  const found = []
  for (const m of messages || []) {
    const at = String(m?.at || now.toISOString())
    for (const text of extractPsychStatements(m?.text)) {
      found.push({ text, quote: String(m.text).slice(0, 200), at, key: hashOf(text) })
    }
  }
  if (!found.length) return { ok: true, added: 0, updated: 0 }

  const doc = await readPsych(root)
  const entries = Array.isArray(doc.entries) ? [...doc.entries] : []
  const byKey = new Map(entries.map((e) => [String(e.key || hashOf(e.text)), e]))
  let added = 0
  let updated = 0
  for (const f of found) {
    const evidenceId = hashOf(`${f.at}|${f.text}`)
    const hit = byKey.get(f.key)
    if (hit) {
      const ids = Array.isArray(hit.evidenceIds) ? hit.evidenceIds : []
      if (!ids.includes(evidenceId)) hit.evidenceIds = [...ids, evidenceId].slice(-12)
      if (hit.at !== f.at || hit.quote !== f.quote) {
        hit.at = f.at
        hit.quote = f.quote
        hit.count = (Number(hit.count) || 1) + 1
        updated += 1
      }
      continue
    }
    const entry = {
      key: f.key,
      text: f.text,
      quote: f.quote,
      at: f.at,
      conf: 0.9,
      count: 1,
      source: 'conversation',
      evidenceIds: [evidenceId],
    }
    entries.push(entry)
    byKey.set(f.key, entry)
    added += 1
  }
  if (!added && !updated) return { ok: true, added: 0, updated: 0 }
  entries.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')))
  await writePsych(root, { entries }, { now })
  return { ok: true, added, updated }
}
