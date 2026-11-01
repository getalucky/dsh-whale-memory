/**
 * probes.js —— 人格探针（文档 8.6 第七节：验收与回归）
 *
 * 人格改一次就漂一点，靠肉眼看不出来。这里放一组固定、零成本、
 * 不调模型的硬检查，每次提案改前改后各跑一遍：
 *   · 通过项数不许下降（回退就拒绝应用，见 persona.js）
 *   · 检查的是「人格文件本身有没有长歪」，不是模型回答得好不好
 *
 * 检查分四类：
 *   结构（区块在不在、预算、条目数）
 *   身份边界（不自曝、不写客户服务腔、不留免责声明）
 *   语气规则（称呼、长度、emoji、怼人边界）
 *   数据卫生（事件词、绝对日期、路径、凭据、重复行）
 *
 * 局限：这是静态体检，能挡住「把事件写进人设」「把密码写进去」这类硬伤，
 * 挡不住语气变软这种软漂移——那要靠人工读 diff。
 */

export const PROBE_LIMITS = {
  tokens: 1200,
  coreChars: 400,
  lines: 20,
  lineChars: 100,
  imperativeRatio: 0.8,
}

const RE_EVENT = /昨天|今天|今早|今晚|刚才|前天|上周|上次|最近|昨晚/
const RE_DATE = /(?:19|20)\d{2}\s*[-/.年]\s*\d{1,2}|\d{1,2}\s*月\s*\d{1,2}\s*日/
const RE_PATH = /[A-Za-z]:[\\/]|https?:\/\//
const RE_SECRET = /sk-[A-Za-z0-9]{8,}|ghp_[A-Za-z0-9]{8,}|Bearer\s+\S{8,}|(?:密码|口令|token|api[_ ]?key)\s*[:：]/i
const RE_SELF = /作为\s*(?:一个)?\s*(?:AI|人工智能|语言模型)|我只是\s*(?:一个)?\s*(?:AI|程序|模型)|人工智能助手|我是语言模型/i
const RE_IMPERATIVE = /[不别该]|必须|默认|最多|只在|先|可以|要/

const squeeze = (s) => String(s ?? '').replace(/\s+/g, '')
const linesOf = (s) => String(s ?? '').split('\n').map((x) => x.trim()).filter(Boolean)

/** 取 CORE 里长度 ≥12 的连续片段，用来判断 EVOLVABLE 有没有把身份抄一遍。 */
function coreFragments(core) {
  const t = squeeze(core)
  const out = []
  for (let i = 0; i + 12 <= t.length; i += 12) out.push(t.slice(i, i + 12))
  return out
}

/**
 * @param {string} text 整份 persona.md
 * @param {{hasCore:boolean,hasEvolvable:boolean,core:string,evolvable:string}} parts parsePersona 的结果
 * @param {number} tokens personaTokens(text)
 * @returns {{total:number, passed:number, failed:Array<{id:string,name:string,detail:string}>}}
 */
export function runProbes(text, parts, tokens) {
  const src = String(text ?? '')
  const core = parts?.core ?? ''
  const evo = parts?.evolvable ?? ''
  const lines = linesOf(evo)
  const flat = lines.map(squeeze)
  const rules = [
    ['core', '核心身份区块', parts?.hasCore && core.length >= 8 && core.length <= PROBE_LIMITS.coreChars,
      `CORE ${parts?.hasCore ? `${core.length} 字` : '缺失'}`],
    ['evolvable', '可演化区块', parts?.hasEvolvable && lines.length > 0,
      parts?.hasEvolvable ? `EVOLVABLE ${lines.length} 条` : 'EVOLVABLE 缺失'],
    ['budget', '人格预算', Number(tokens) <= PROBE_LIMITS.tokens,
      `${tokens}/${PROBE_LIMITS.tokens} tokens`],
    ['discipline', '纪律/底线段存在', /纪律|底线|优先级/.test(src), '找不到「纪律 / 底线 / 优先级」'],
    ['self', '不自曝是 AI', !RE_SELF.test(src), '出现了「作为 AI / 语言模型」这类自曝'],
    ['service', '禁止客服腔', /客服/.test(src), '缺「别像客服」这类约束'],
    ['disclaimer', '禁止免责声明', /免责|仅供参考/.test(src), '缺「不写免责声明」这类约束'],
    ['address', '称呼规则', /叫他|称呼|「爹」/.test(src), '找不到称呼约定'],
    ['length', '长度规则', /字以内|短|一句|三句/.test(src), '找不到长短约束'],
    ['emoji', '表情规则', /emoji|表情|颜文字/i.test(src), '找不到 emoji / 表情约束'],
    ['boundary', '怼人边界', /拒绝|不接|底线|越界/.test(src), '找不到拒绝与越界约束'],
    ['event', '人设不写具体事件', !RE_EVENT.test(evo), 'EVOLVABLE 里出现「昨天/上次/最近」这类事件词'],
    ['date', '人设不写绝对日期', !RE_DATE.test(evo), 'EVOLVABLE 里出现具体日期'],
    ['path', '人设不写路径/链接', !RE_PATH.test(evo), 'EVOLVABLE 里出现盘符路径或 URL'],
    ['secret', '人设不写凭据', !RE_SECRET.test(evo), 'EVOLVABLE 里出现疑似密码/token'],
    ['dupe', '条目不重复', new Set(flat).size === flat.length, 'EVOLVABLE 有重复行'],
    ['count', '条目数上限', lines.length <= PROBE_LIMITS.lines,
      `${lines.length} 条，上限 ${PROBE_LIMITS.lines}`],
    ['width', '单条长度', lines.every((l) => l.length <= PROBE_LIMITS.lineChars),
      `最长 ${Math.max(0, ...lines.map((l) => l.length))} 字，上限 ${PROBE_LIMITS.lineChars}`],
    ['imperative', '每条都是可执行约束',
      lines.length > 0 && lines.filter((l) => RE_IMPERATIVE.test(l)).length / lines.length >= PROBE_LIMITS.imperativeRatio,
      '超过两成的条目没有「不 / 别 / 要 / 必须」这类约束词'],
    ['overlap', 'EVOLVABLE 不抄 CORE',
      !coreFragments(core).some((frag) => evo.includes(frag)),
      'EVOLVABLE 重复了核心身份的内容'],
  ]

  const failed = rules
    .filter(([, , ok]) => !ok)
    .map(([id, name, , detail]) => ({ id, name, detail }))
  return { total: rules.length, passed: rules.length - failed.length, failed }
}
