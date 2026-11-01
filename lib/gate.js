/**
 * gate.js —— 确认闸门的灰度三态（文档 4.6）
 *
 *   off     只记录、不拦截：所有写入直接生效，审计里留门记录
 *   warn    记录会拦什么，但暂不拦：写入生效，条目标 gate=warn
 *   enforce 正式阻断：原话没有「记住 / 纠正 / 长期偏好」信号就进 suggested
 *
 * 先跑 warn 看拒绝率，再切 enforce；出事故一键退回 warn，不用改代码。
 * 开关：env DSH_MEMORY_GATE，或配置里的 gate.mode；认不出来一律 enforce。
 */

export const GATES = ['off', 'warn', 'enforce']
export const GATE_DEFAULT = 'enforce'

export function gateMode(cfg = {}) {
  const raw = String(cfg?.mode ?? process.env.DSH_MEMORY_GATE ?? GATE_DEFAULT).trim().toLowerCase()
  return GATES.includes(raw) ? raw : GATE_DEFAULT
}

/**
 * 一次写入该走哪个状态。
 * @param {'off'|'warn'|'enforce'} mode
 * @param {boolean} direct 用户原话里有没有明确信号
 * @returns {{state:string, gate:string, why:string}}
 */
export function gateDecision(mode, direct) {
  if (mode === 'off') {
    return { state: 'active', gate: 'off', why: '' }
  }
  if (mode === 'warn') {
    return {
      state: 'active',
      gate: direct ? '' : 'warn',
      why: direct ? '' : 'warn：原话里没有「记住 / 纠正 / 长期偏好」的信号，enforce 模式下会先放待确认',
    }
  }
  return {
    state: direct ? 'active' : 'suggested',
    gate: direct ? '' : 'blocked',
    why: direct ? '' : '原话里没有「记住 / 纠正 / 长期偏好」的信号，先放待确认',
  }
}
