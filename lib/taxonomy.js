/**
 * taxonomy.js —— 受控词表（阶段 3）
 *
 * 解决的问题：同一件事被写成「高数 / 高等数学 / 微积分」三个标签，
 * 副库里三分天下，多跳永远跳不到一起。
 *
 * 词表是「词条 → 上位标签链」的扁平表：
 *   高数   → 上级 数学 → 学习
 *   冰美式 → 上级 饮食 → 生活
 * 抽标签时按别名最长匹配，命中区间不再重复匹配（"高等数学"不会同时命中"数学"）。
 * 认不出来的词不硬造标签，退回类型标签（事实/偏好/…），宁可粗，不可乱。
 */

export const TYPE_LABEL = {
  fact: '事实',
  pref: '偏好',
  event: '事件',
  relation: '关系',
  knowledge: '知识',
  lesson: '教训',
  topic: '话题',
  commitment: '承诺',
  material: '素材',
}

const 城市 = ['杭州', '上海', '北京', '深圳', '广州', '成都', '南京', '武汉', '西安', '苏州', '重庆', '天津']

const TERMS = [
  // 学习
  { tag: '高数', parents: ['数学', '学习'], aliases: ['高数', '高等数学', '微积分'] },
  { tag: '线代', parents: ['数学', '学习'], aliases: ['线代', '线性代数'] },
  { tag: '概率论', parents: ['数学', '学习'], aliases: ['概率论', '概率统计'] },
  { tag: '数学', parents: ['学习'], aliases: ['数学'] },
  { tag: '英语', parents: ['学习'], aliases: ['英语', '单词', '雅思', '托福', '四六级'] },
  { tag: '考试', parents: ['学习'], aliases: ['考试', '考研', '期末', '期中'] },
  { tag: '复习', parents: ['学习'], aliases: ['复习', '刷题', '预习'] },
  { tag: '作业', parents: ['学习'], aliases: ['作业', '论文', '答辩'] },

  // 工作 / 技术
  { tag: '编程', parents: ['开发', '工作'], aliases: ['代码', '编程', '脚本', '接口', '插件'] },
  { tag: '项目', parents: ['工作'], aliases: ['项目', '需求', '排期', '上线', '发布', '部署'] },
  { tag: '会议', parents: ['工作'], aliases: ['开会', '会议', '周会', '例会'] },
  { tag: '文档', parents: ['工作'], aliases: ['文档', '索引', '笔记'] },
  { tag: 'DSH', parents: ['技术'], aliases: ['DSH', 'DeepSeek Harness'] },
  { tag: '桥接', parents: ['技术'], aliases: ['桥接', '机器人', 'QQ'] },
  { tag: 'Windows', parents: ['技术'], aliases: ['Windows', '系统'] },
  { tag: '数据盘', parents: ['技术'], aliases: ['D盘', 'C盘', 'D:\\dsh', '工作区'] },

  // 生活
  { tag: '咖啡', parents: ['饮食', '生活'], aliases: ['咖啡', '冰美式', '美式', '拿铁'] },
  { tag: '奶茶', parents: ['饮食', '生活'], aliases: ['奶茶', '珍珠'] },
  { tag: '吃饭', parents: ['饮食', '生活'], aliases: ['吃饭', '做饭', '外卖', '买菜', '零食'] },
  { tag: '牛奶', parents: ['饮食', '生活'], aliases: ['牛奶', '鸡蛋'] },
  { tag: '房租', parents: ['家务', '生活'], aliases: ['房租', '水电', '电费', '水费'] },
  { tag: '快递', parents: ['家务', '生活'], aliases: ['快递', '包裹'] },
  { tag: '宠物', parents: ['生活'], aliases: ['猫咪', '猫粮', '狗粮', '宠物'] },
  { tag: '睡觉', parents: ['作息', '生活'], aliases: ['睡觉', '熬夜', '失眠', '午睡', '起床'] },
  { tag: '天气', parents: ['生活'], aliases: ['天气', '下雨', '降温', '太热'] },
  { tag: '购物', parents: ['生活'], aliases: ['购物', '下单', '网购'] },

  // 关系 / 健康 / 娱乐 / 财务
  { tag: '家人', parents: ['关系'], aliases: ['老爹', '老爸', '家人', '老婆'] },
  { tag: '朋友', parents: ['关系'], aliases: ['朋友', '群友', '同学', '同事'] },
  { tag: '体检', parents: ['健康'], aliases: ['体检', '挂号'] },
  { tag: '生病', parents: ['健康'], aliases: ['生病', '感冒', '发烧', '医院', '吃药'] },
  { tag: '运动', parents: ['健康'], aliases: ['锻炼', '跑步', '健身'] },
  { tag: '游戏', parents: ['娱乐'], aliases: ['游戏', '王者', '原神'] },
  { tag: '影视', parents: ['娱乐'], aliases: ['电影', '电视剧', '动漫'] },
  { tag: '工资', parents: ['财务'], aliases: ['工资', '薪水', '发薪'] },
  { tag: '账单', parents: ['财务'], aliases: ['账单', '报销', '预算'] },

  // 环境
  { tag: '设备', parents: ['环境'], aliases: ['电脑', '手机', '键盘', '显示器', '硬盘'] },
  ...城市.map((c) => ({ tag: c, parents: ['位置', '环境'], aliases: [c] })),
]

/** 别名扁平表，长的在前，保证最长匹配。 */
const INDEX = TERMS
  .flatMap((t) => t.aliases.map((a) => ({ alias: a, tag: t.tag, parents: t.parents })))
  .sort((a, b) => b.alias.length - a.alias.length || a.alias.localeCompare(b.alias))

function overlaps(spans, start, end) {
  return spans.some(([s, e]) => start < e && end > s)
}

/**
 * 从一句话抽受控标签。
 * @returns {{tag:string, parents:string[]}[]} 最多 5 个，按出现顺序
 */
export function extractConcepts(text) {
  const s = String(text ?? '')
  if (!s) return []
  const spans = []
  const out = []
  const seen = new Set()
  for (const item of INDEX) {
    if (!item.alias) continue
    let from = 0
    for (;;) {
      const at = s.indexOf(item.alias, from)
      if (at < 0) break
      const end = at + item.alias.length
      from = end
      if (overlaps(spans, at, end)) continue
      spans.push([at, end])
      if (!seen.has(item.tag)) {
        seen.add(item.tag)
        out.push({ tag: item.tag, parents: item.parents })
      }
      if (out.length >= 5) return out
    }
  }
  return out
}

/** 标签 → 直接上位标签（取第一个父级），没有就返回空。 */
export function parentOf(tag) {
  const hit = TERMS.find((t) => t.tag === tag)
  return hit ? hit.parents[0] ?? '' : ''
}

/** 直接下位标签（多跳下行用）。 */
export function childrenOf(tag) {
  return TERMS.filter((t) => t.parents.includes(tag)).map((t) => t.tag)
}

/** 全部已登记标签（诊断/界面用）。 */
export function knownTags() {
  return TERMS.map((t) => ({ tag: t.tag, parents: t.parents, aliases: t.aliases }))
}

export function typeLabel(kind) {
  return TYPE_LABEL[kind] || '事实'
}
