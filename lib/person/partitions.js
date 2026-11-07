/**
 * person/partitions.js —— 画像分区规则
 *
 * 画像只从记忆条目派生，不另建真源。分区：
 *   interest  反复出现的主题/标签
 *   projects  正在做的事、承诺、项目
 *   comm      说话方式偏好（语气/长度/emoji/时间/边界）
 *   psych     心理自述，单独加密，不进 profile.json
 *
 * 事件、单次评价、当下情绪不进 stable；素材永远不参与。
 */

const COMM = /(说话|语气|回复|回复我|别用|不要用|先给|结论|简短|详细|啰嗦|emoji|表情|称呼|叫我|闭嘴|道歉|免责声明|格式|列|字数|标点|频道|群聊|私聊)/

// 分类器的类型标签不是兴趣点：拿「事实」「聊天」去搜网页只会搜出噪声。
const GENERIC_KEYS = new Set([
  '事实', '偏好', '事件', '关系', '话题', '约定', '项目', '聊天', '测试',
  '未分类', '其他', '情绪', '心理', '生活', '工作', '学习', '娱乐', '日常',
  '随记', '重要', '一般', '杂项', '公共', '素材',
])

export function isGenericKey(key) {
  return GENERIC_KEYS.has(String(key ?? '').trim())
}

export function isUsableItem(item) {
  if (!item || !item.text) return false
  if (['archived', 'superseded', 'suggested', 'expired'].includes(item.state)) return false
  if (item.speaker === 'her' || item.speaker === '她') return false
  if (String(item.source || '').startsWith('wander:')) return false
  if (item.reply_to) return false
  return true
}

/** 这条记忆归哪个画像分区；返回空表示不进画像。 */
export function partitionOf(item) {
  if (!isUsableItem(item)) return ''
  if (item.kind === 'pref') return COMM.test(item.text) ? 'comm' : 'interest'
  if (item.kind === 'topic' || item.kind === 'commitment') return 'projects'
  if (item.kind === 'relation') return 'comm'
  if (item.kind === 'fact' || item.kind === 'event') return 'interest'
  return ''
}

/** 分区内的键：偏好用正文前 20 字，主题用首选非通用标签，项目用目标句。 */
export function keyOf(item, partition) {
  if (partition === 'projects') return String(item.goal || item.text || '').replace(/\s+/g, ' ').slice(0, 24)
  if (partition === 'comm') return String(item.text || '').replace(/\s+/g, ' ').slice(0, 24)
  const tag = (Array.isArray(item.tags) ? item.tags : [])
    .map((x) => String(x ?? '').trim())
    .find((x) => x && !isGenericKey(x))
  if (tag) return tag.slice(0, 16)
  // 事实条目通常只有「事实」这种类型标签，没有可用主题：宁可不进兴趣分区
  if (item.kind === 'fact' || item.kind === 'event') return ''
  return String(item.text || '').replace(/\s+/g, ' ').slice(0, 16)
}

/** 明说过的偏好比“出现三次”更硬；用于 stable 判定。 */
export function isExplicit(item) {
  return /(记住|以后都|以后别|别再|不要再用|一律|我喜欢|我讨厌|我不喜欢|叫我)/.test(String(item.text || ''))
}
