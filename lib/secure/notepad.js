/**
 * secure/notepad.js —— 心事匣
 *
 * 一格加密便签：她留给下一跳的自己。投递包有内容才带；写新覆盖旧；
 * 照原样再写一遍视为保留（年龄不重算）；什么都不做，下一跳维护时自动清空。
 */

import { unlink } from 'node:fs/promises'

import { notepadPath, readEncrypted, writeEncrypted } from './vault.js'

function parse(raw) {
  try {
    const o = JSON.parse(raw)
    return {
      text: String(o?.text ?? '').trim().slice(0, 500),
      at: String(o?.at ?? ''),
      beat: Number(o?.beat) || 0,
    }
  } catch {
    return { text: String(raw ?? '').trim().slice(0, 500), at: '', beat: 0 }
  }
}

export async function readNotepad(root) {
  const raw = await readEncrypted(root, notepadPath(root), '')
  return raw ? parse(raw) : { text: '', at: '', beat: 0 }
}

export async function writeNotepad(root, text, { now = new Date(), beat = 0 } = {}) {
  const t = String(text ?? '').trim().slice(0, 500)
  if (!t) {
    await clearNotepad(root)
    return { ok: true, cleared: true }
  }
  const body = JSON.stringify({ text: t, at: now.toISOString(), beat: Number(beat) || 0 })
  await writeEncrypted(root, notepadPath(root), body)
  return { ok: true, text: t, at: now.toISOString() }
}

export async function clearNotepad(root) {
  try { await unlink(notepadPath(root)) } catch { /* 已经没了 */ }
  return { ok: true }
}

/**
 * 只清“自己读到的那一版”：投递期间可能被并发改写。
 * expected 传字符串只比文本；传 {text, at} 时连时间戳一起比。
 */
export async function clearNotepadIf(root, expected) {
  const cur = await readNotepad(root)
  const wantText = typeof expected === 'string' ? expected : String(expected?.text ?? '')
  const wantAt = expected && typeof expected === 'object' ? String(expected.at ?? '') : ''
  if (!wantText) return { ok: true, kept: true }
  if (String(cur.text || '') !== wantText) return { ok: true, kept: true }
  if (wantAt && String(cur.at || '') !== wantAt) return { ok: true, kept: true }
  return clearNotepad(root)
}

export async function notepadText(root) {
  return (await readNotepad(root)).text
}
