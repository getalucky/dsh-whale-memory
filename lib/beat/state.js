/**
 * beat/state.js —— 主动行为层的运行状态
 *
 * 单独放一层，避免 feedback / env / maintain 反过来 import index.js 造成环。
 * 所有字段都给出默认值：老版本 state.json 缺字段时不用迁移。
 */

import { readJson, writeAtomic } from '../store.js'
import { ensureBeatDirs, statePath } from './config.js'

export function emptyState() {
  return {
    lastWanderAt: '',
    wanderDay: '',
    wanderCount: 0,
    lastRefillAt: '',
    lastFocus: '',
    // 焦点冷却：{ [focus]: ISO }，同一焦点 3 天内不重复选
    focusLastUsed: {},
    // 连续空结果：当天两次就收手
    wanderEmptyDay: '',
    wanderEmptyCount: 0,
    lastDeliveryAt: '',
    daily: { day: '', sent: 0 },
    recentMaterialIds: [],
    focusUntil: '',
    lastGate: '',
    lastGateAt: '',
    lastGateDetail: {},
    lastTickAt: '',
    lastMaintainAt: '',
    lastProfileAt: '',
    lastVaultCheckAt: '',
    // 敏感文件解不开时置位，beat 停跳，等修好后的下一次检查
    vaultError: null,
    // 真实用户活动：忙闲闸门与回复归因都用它
    lastUserAt: '',
    replyStats: { count: 0, avgChars: 0 },
    // 投递打标：等目标会话的下一条真实用户消息
    pendingDelivery: null,
    lastDeliveryInfo: null,
    deliveryFailed: null,
    deliveryBackoffUntil: '',
    noneStreak: 0,
    lastEnv: null,
  }
}

export async function loadState(root) {
  const s = await readJson(statePath(root), null)
  if (!s || typeof s !== 'object') return emptyState()
  const base = emptyState()
  return {
    ...base,
    ...s,
    wanderCount: Number(s.wanderCount) || 0,
    wanderEmptyCount: Number(s.wanderEmptyCount) || 0,
    wanderEmptyDay: String(s.wanderEmptyDay || ''),
    lastFocus: String(s.lastFocus || ''),
    focusLastUsed: s.focusLastUsed && typeof s.focusLastUsed === 'object' && !Array.isArray(s.focusLastUsed)
      ? { ...s.focusLastUsed }
      : {},
    focusUntil: String(s.focusUntil || ''),
    lastVaultCheckAt: String(s.lastVaultCheckAt || ''),
    vaultError: s.vaultError && typeof s.vaultError === 'object' ? s.vaultError : null,
    daily: s.daily && typeof s.daily === 'object'
      ? { day: String(s.daily.day || ''), sent: Number(s.daily.sent) || 0 }
      : { day: '', sent: 0 },
    recentMaterialIds: Array.isArray(s.recentMaterialIds) ? s.recentMaterialIds.slice(-20) : [],
    lastGateDetail: s.lastGateDetail && typeof s.lastGateDetail === 'object' ? s.lastGateDetail : {},
    lastUserAt: String(s.lastUserAt || ''),
    replyStats: s.replyStats && typeof s.replyStats === 'object'
      ? { count: Number(s.replyStats.count) || 0, avgChars: Number(s.replyStats.avgChars) || 0 }
      : { count: 0, avgChars: 0 },
    pendingDelivery: s.pendingDelivery && typeof s.pendingDelivery === 'object' ? s.pendingDelivery : null,
    lastDeliveryInfo: s.lastDeliveryInfo && typeof s.lastDeliveryInfo === 'object' ? s.lastDeliveryInfo : null,
    deliveryFailed: s.deliveryFailed && typeof s.deliveryFailed === 'object' ? s.deliveryFailed : null,
    deliveryBackoffUntil: String(s.deliveryBackoffUntil || ''),
    noneStreak: Number(s.noneStreak) || 0,
    lastEnv: s.lastEnv && typeof s.lastEnv === 'object' ? s.lastEnv : null,
  }
}

export async function saveState(root, state) {
  await ensureBeatDirs(root)
  await writeAtomic(statePath(root), JSON.stringify(state, null, 2))
  return state
}
