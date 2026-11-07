/**
 * secure/notepad-tool.js —— 心事匣工具
 *
 * 注册给日常会话：write / read / clear。写进去的是给下一跳自己的话，
 * 不占记忆分片，不进画像；投递包会带上，投出去后由 beat 清空。
 */

import { clearNotepad, readNotepad, writeNotepad } from './notepad.js'

export function registerNotepadTool(ctx, { root, log } = {}) {
  if (!ctx?.tools?.register) return () => {}
  const say = log ?? (() => {})
  const spec = {
    name: 'notepad',
    description: '心事匣：给下一跳的自己留一句话（write / read / clear）。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['write', 'read', 'clear'] },
        text: { type: 'string', description: 'write 时必填，一句话' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          text: { type: 'string' },
        },
        required: ['ok', 'text'],
      },
      render: (_a, out) => [{ type: 'text', text: out?.text || (out?.ok ? '[心事匣]' : '[没写成]') }],
    },
    async execute(args) {
      const action = String(args?.action ?? '').trim()
      if (action === 'read') {
        const n = await readNotepad(root)
        return { ok: true, text: n.text ? n.text : '（空）' }
      }
      if (action === 'clear') {
        await clearNotepad(root)
        return { ok: true, text: '心事匣清空了。' }
      }
      if (action === 'write') {
        const text = String(args?.text ?? '').trim()
        if (!text) return { ok: false, text: '写什么？text 是空的。' }
        const r = await writeNotepad(root, text)
        say('[whale] 心事匣写了一条')
        return { ok: Boolean(r.ok), text: r.ok ? '留给下一跳了。' : '没写成。' }
      }
      return { ok: false, text: 'action 只认 write / read / clear。' }
    },
  }
  try {
    const d = ctx.tools.register(spec)
    return () => {
      try {
        if (typeof d === 'function') d()
        else d?.dispose?.()
      } catch { /* ignore */ }
    }
  } catch (e) {
    say(`[whale] notepad 注册失败 ${String(e?.message ?? e).slice(0, 160)}`)
    return () => {}
  }
}
