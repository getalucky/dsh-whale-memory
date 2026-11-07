/**
 * beat/report.js —— material_report 工具
 *
 * 目标会话说完/决定不说后按投递编号报账。没有它，反馈层只能从回复里猜
 * “用了哪条”，归因会断。
 */

import { applyReport } from './feedback.js'

export function registerMaterialReport(ctx, { root, log } = {}) {
  if (!ctx?.tools?.register) return () => {}
  const say = log ?? (() => {})
  const spec = {
    name: 'material_report',
    description: '主动投递后报账：这次用了哪几条素材。说完或决定不说后调用。',
    parameters: {
      type: 'object',
      properties: {
        deliveryId: { type: 'string', description: '素材包里的投递编号，如 d-20261106-01' },
        usedIds: { type: 'array', items: { type: 'string' }, description: '用上的素材 id；一条没用就空数组' },
        mode: { type: 'string', enum: ['quote', 'improvise', 'none'], description: '引用素材 / 顺着发挥 / 决定不说' },
      },
      required: ['deliveryId'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          reported: { type: 'boolean' },
          text: { type: 'string' },
        },
        required: ['ok', 'reported', 'text'],
      },
      render: (_a, out) => [{ type: 'text', text: out?.text || (out?.ok ? '[报账了]' : '[没报上]') }],
    },
    async execute(args) {
      const deliveryId = String(args?.deliveryId ?? '').trim()
      if (!deliveryId) return { ok: false, reported: false, text: '缺 deliveryId' }
      const usedIds = (Array.isArray(args?.usedIds) ? args.usedIds : [])
        .map((x) => String(x).trim()).filter(Boolean).slice(0, 8)
      const mode = ['quote', 'improvise', 'none'].includes(args?.mode) ? args.mode : (usedIds.length ? 'quote' : 'none')
      try {
        const r = await applyReport(root, { deliveryId, usedIds, mode, log: say })
        if (!r.ok) return { ok: false, reported: false, text: r.why || '报账没写进去' }
        say(`[whale] 报账 ${deliveryId} · ${mode} · ${usedIds.length} 条`)
        return { ok: true, reported: true, text: `报账了：${mode}，${usedIds.length} 条` }
      } catch (e) {
        say(`[whale] 报账写入失败 ${String(e?.message ?? e).slice(0, 120)}`)
        return { ok: false, reported: false, text: '报账没写进去' }
      }
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
    say(`[whale] material_report 注册失败 ${String(e?.message ?? e).slice(0, 160)}`)
    return () => {}
  }
}
