/**
 * cases.mjs —— 记忆插件评测集（阶段 0）
 *
 * 每条用例 = 一段对话 + 可验证的期望。字段：
 *   turns          逐条喂给 ingest 的用户消息（走真实采集链路，不跳过过滤）
 *   remember       应该被记住的片段（active 条目里要能找到）
 *   ignore         不该被记住的片段（active 条目里不能出现）
 *   stagingEmpty   蒸馏后 staging 应为空（证明消息在采集层就被丢了）
 *   activeCount    蒸馏后的 active 条目数（去重/冲突用例用）
 *   superseded     [{ old, new }] 旧片段应被标 superseded，新片段 active
 *   ask            召回查询
 *   recallAny      前 3 条里要出现其中任意一个
 *   recallTop1     第 1 条要包含这个片段
 *   recallEmpty    前 1 条相关度应低于 0.2（"不记得"要能说出口）
 *   needs          'model' = 需要模型主动写（阶段 7.7），'semantic' = 需要语义召回
 *   pendingStage   机制还没实现，指标先记着不算通过（如 stage4 多跳）
 *
 * 约定：expect 片段用原文里的稳定子串，匹配时先归一化（全角/空格/标点），
 * 再做包含 + bigram 相似度兜底，避免"换个标点就算失败"。
 */

const 备忘 = [
  '买菜', '取快递', '交房租', '修空调', '洗车', '还书', '买猫粮', '换灯泡', '交电费', '预约体检',
  '修自行车', '寄快递', '买牙膏', '擦窗户', '换床单', '剪头发', '充话费', '买电池', '倒垃圾', '晒被子',
  '修门锁', '买牛奶', '交水费', '整理书架', '给绿植浇水',
]
const 习惯 = 备忘.map((x, i) => `记住，备忘${i + 1}是${x}`)

/** 召回用例的干扰项：只有放进噪音里，hit@3 才说明问题。 */
const 干扰 = [
  '记住，冰箱里还有两个鸡蛋',
  '记住，周五要交房租',
  '记住，猫粮快没了',
  '记住，下周一要开会',
  '记住，手机膜碎了',
]

export const CASES = [
  // ── A. 写入：该记的 ──────────────────────────────────────────
  {
    id: 'w01',
    group: '写入',
    note: '明确要求记住 → 环境事实',
    turns: ['记住，我用 Windows 11，工作区在 D 盘'],
    remember: ['Windows 11'],
    ask: '我用什么系统',
    recallAny: ['Windows 11'],
  },
  {
    id: 'w02',
    group: '写入',
    note: '自我介绍 → 姓名 + 城市',
    turns: ['我叫陆小鱼，住在杭州'],
    remember: ['陆小鱼', '杭州'],
  },
  {
    id: 'w03',
    group: '写入',
    note: '稳定偏好',
    turns: ['我特别喜欢喝冰美式，不加糖'],
    remember: ['冰美式'],
  },
  {
    id: 'w04',
    group: '写入',
    note: '环境事实（没有"记住"触发词，规则版预期漏记）',
    turns: ['我的 DSH 装在 D 盘，数据目录是 $DSH_HOME'],
    remember: ['$DSH_HOME'],
    needs: 'model',
  },
  {
    id: 'w05',
    group: '写入',
    note: '约定 / 承诺',
    turns: ['下周一把索引重建完'],
    remember: ['索引'],
  },
  {
    id: 'w06',
    group: '写入',
    note: '纠正模型的错误（需要模型主动写）',
    turns: ['不是 3.0，是 2.1.7'],
    remember: ['2.1.7'],
    needs: 'model',
  },
  {
    id: 'w07',
    group: '写入',
    note: '关系 / 称呼约定',
    turns: ['以后叫我爹就行'],
    remember: ['叫我爹'],
  },
  {
    id: 'w08',
    group: '写入',
    note: '群里两个发言人，各记各的',
    kind: 'group',
    turns: [
      '陆小鱼（12345678）：我养了只橘猫叫年糕\n老爹（123456789）：记住，猫粮买皇家',
    ],
    remember: ['年糕', '皇家'],
  },

  // ── B. 不该记的 ─────────────────────────────────────────────
  {
    id: 'n01',
    group: '不该记',
    note: '寒暄',
    turns: ['在吗'],
    activeCount: 0,
  },
  {
    id: 'n02',
    group: '不该记',
    note: '纯问句',
    turns: ['今天几号？'],
    activeCount: 0,
  },
  {
    id: 'n03',
    group: '不该记',
    note: '一次性指令',
    turns: ['帮我把那个文件删了'],
    activeCount: 0,
  },
  {
    id: 'n04',
    group: '不该记',
    note: '工具输出原文不是记忆',
    turns: ["Error: ENOENT: no such file or directory, open 'D:/x/y'"],
    activeCount: 0,
  },
  {
    id: 'n05',
    group: '不该记',
    note: '凭据要在入库前打码',
    turns: ['password: hunter2xyz'],
    ignore: ['hunter2xyz'],
  },
  {
    id: 'n06',
    group: '不该记',
    note: '宿主运行环境消息不该进 staging',
    turns: ['Current time: 2026-10-31 20:00'],
    stagingEmpty: true,
    activeCount: 0,
  },
  {
    id: 'n07',
    group: '不该记',
    note: '日常闲聊，没有长期价值',
    turns: ['哈哈哈哈今天也太热了吧，空调开到16度还是热'],
    activeCount: 0,
  },

  // ── C. 冲突与取代 ───────────────────────────────────────────
  {
    id: 'c01',
    group: '冲突',
    note: '同一槽位（上班时间）新值取代旧值',
    turns: ['老爹明天8:30上班', '老爹明天9点上班'],
    superseded: [{ old: '8:30', new: '9点' }],
    activeCount: 1,
  },
  {
    id: 'c02',
    group: '冲突',
    note: '名字槽位新值取代旧值',
    turns: ['我叫陆小鱼', '我叫陆大鱼'],
    superseded: [{ old: '陆小鱼', new: '陆大鱼' }],
  },

  // ── D. 去重 ─────────────────────────────────────────────────
  {
    id: 'd01',
    group: '去重',
    note: '同一句说三遍只留一条',
    turns: [
      '我特别喜欢喝冰美式',
      '我特别喜欢喝冰美式。',
      '我特别喜欢喝冰美式！',
    ],
    activeCount: 1,
    minHits: 2,
  },

  // ── E. 召回 ─────────────────────────────────────────────────
  {
    id: 'r01',
    group: '召回',
    note: '换说法也能找到（猫 → 年糕）',
    turns: [...干扰, '我养了只橘猫叫年糕'],
    ask: '我家猫叫啥',
    recallAny: ['年糕'],
  },
  {
    id: 'r02',
    group: '召回',
    note: '短问句（住哪儿 → 住在杭州）',
    turns: [...干扰, '记住，我住在杭州'],
    ask: '我住哪儿',
    recallTop1: '杭州',
  },
  {
    id: 'r03',
    group: '召回',
    note: '时间细节（几点上班 → 8:30）',
    turns: [...干扰, '记住，我上班时间是早上8:30'],
    ask: '我几点上班',
    recallAny: ['8:30'],
  },
  {
    id: 'r04',
    group: '召回',
    note: '同义词召回（咖啡 → 冰美式），词法通道预期够不着',
    turns: [
      '记住，我平时喝奶茶不加珍珠',
      '记住，办公室冰箱里有可乐',
      '记住，茶叶放在第二个抽屉',
      '记住，楼下咖啡店排队太长',
      '记住，周五要交房租',
      '我特别喜欢喝冰美式',
    ],
    ask: '我平时喝什么咖啡',
    recallTop1: '冰美式',
    needs: 'semantic',
  },
  {
    id: 'r05',
    group: '召回',
    note: '干扰项里精确命中',
    turns: [
      '记住，冰箱里还有两个鸡蛋',
      '记住，周五要交房租',
      '记住，猫粮快没了',
      '记住，下周一要开会',
      '记住，手机膜碎了',
      '记住，我住在杭州',
    ],
    ask: '我住哪儿',
    recallTop1: '杭州',
  },
  {
    id: 'r06',
    group: '召回',
    note: '库里没有的事，不能硬凑一条',
    turns: ['我养了只橘猫叫年糕'],
    ask: '我车牌号多少',
    recallEmpty: true,
  },

  // ── F. 预算 ─────────────────────────────────────────────────
  {
    id: 'f01',
    group: '预算',
    note: '25 条记忆时，常驻注入有多大',
    turns: 习惯,
    activeCount: 25,
    budget: true,
  },

  // ── G. 多跳（阶段 4 才实现，先记基线） ────────────────────────
  {
    id: 'g01',
    group: '多跳',
    note: '问「数学」→ 高数/线代（词法够不着，靠标签下钻）',
    turns: [
      '记住，明天要交高数作业',
      '记住，线性代数第三章还没复习',
      '记住，冰箱里还有两个鸡蛋',
      '记住，周五要交房租',
      '记住，猫粮快没了',
      '记住，下周一要开会',
      '记住，手机膜碎了',
      '记住，快递在门口',
    ],
    ask: '数学那边怎样',
    recallAny: ['高数', '线代'],
    needs: 'semantic',
    multihop: true,
  },
]

/** 按 group 汇总，报告里分组看。 */
export const GROUPS = [...new Set(CASES.map((c) => c.group))]
