/**
 * llm.mjs —— 可选 LLM 蒸馏 / 向量召回
 * 跑法：node test/llm.mjs
 *
 * 不联网：fetch 用桩函数。验证「能用」和「挂了要回退」两条路。
 */
import assert from 'node:assert'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = await mkdtemp(join(tmpdir(), 'whale-llm-'))
const cfgFile = join(root, 'qq-bridge-config.json')
await writeFile(cfgFile, JSON.stringify({ 绑定: [{ 类型: '私聊', 号码: '123456789', 会话: 'sess-llm', 称呼: '老爹' }] }), 'utf8')
process.env.DSH_QQ_BRIDGE_CONFIG = cfgFile
process.env.DSH_MEMORY_LLM_BASE = 'http://stub.local/v1'
process.env.DSH_MEMORY_LLM_MODEL = 'stub-chat'
process.env.DSH_MEMORY_EMBED_BASE = 'http://stub.local/v1'
process.env.DSH_MEMORY_EMBED_MODEL = 'stub-embed'

const {
  llmReady, embedReady, parseCandidates, parseTriples, distillMessages, extractGraphTriples, embedTexts, lastLlmError, listEmbedModels,
} = await import('../lib/llm.js')
const { fuseRankings } = await import('../lib/recall.js')
const { searchFunnel, searchFunnelHybrid, resetVectorFallback } = await import('../lib/funnel.js')
const { ensureDirs, loadScope, paths } = await import('../lib/store.js')
const { distillSession } = await import('../lib/distill.js')
const { loadTriples } = await import('../lib/graph.js')
const { loadSources, resetSourceCache } = await import('../lib/source.js')

let pass = 0
const ok = (name) => { pass += 1; console.log('  ok', name) }

const jsonRes = (obj) => ({ ok: true, json: async () => obj })
const chatStub = async () => jsonRes({
  choices: [{ message: { content: '```json\n[{"text":"老爹刚下班回家","kind":"fact","conf":0.7}]\n```' } }],
})
const embedStub = async () => jsonRes({ data: [{ embedding: [1, 0] }, { embedding: [0, 1] }] })

try {
  assert.equal(llmReady(), true)
  assert.equal(embedReady(), true)
  ok('配置齐全才算就绪')

  // 拥有者称呼从桥接配置来；记忆端只读，不另设一份
  const ownerCfg = join(root, 'qq-bridge-owner.json')
  await writeFile(ownerCfg, JSON.stringify({
    拥有者QQ: '42',
    拥有者称呼: '老板',
    绑定: [
      { 类型: '私聊', 号码: '123456789', 会话: 'sess-llm', 称呼: '老爹' },
      { 类型: '群', 号码: '123456789', 会话: 'sess-group-owner', 称呼: '群里的人' },
    ],
  }), 'utf8')
  const oldCfg = process.env.DSH_QQ_BRIDGE_CONFIG
  process.env.DSH_QQ_BRIDGE_CONFIG = ownerCfg
  resetSourceCache()
  const ownerCfgRead = await loadSources()
  assert.equal(ownerCfgRead.owner.name, '老板')
  assert.equal(ownerCfgRead.owner.qq, '42')
  assert.equal(ownerCfgRead.bySession.get('sess-group-owner').kind, 'group')
  process.env.DSH_QQ_BRIDGE_CONFIG = oldCfg
  resetSourceCache()
  ok('桥接拥有者称呼与身份解析')

  // 解析：围栏、坏 kind、空数组、src 越界
  assert.deepEqual(parseCandidates('废话\n```json\n[{"text":"老爹喜欢冰美式","kind":"pref","conf":0.8}]\n```'), [
    { text: '老爹喜欢冰美式', kind: 'pref', conf: 0.8, src: -1, speaker: '', scene: '', mergeId: '' },
  ])
  assert.equal(parseCandidates('没有 json'), null)
  assert.deepEqual(parseCandidates('[]'), [], '合法空数组是「这轮没东西可记」，不是解析失败')
  assert.equal(parseCandidates('[{"text":"短","kind":"x"}]'), null, '太短应丢弃')
  assert.equal(parseCandidates('[{"text":"正常长度的一句话","kind":"xx","conf":9}]')[0].kind, 'fact', '未知 kind 回落 fact')
  assert.equal(
    parseCandidates('[{"text":"老爹喜欢冰美式","kind":"pref","src":2}]')[0].src, 2,
    '合法 src 要保留',
  )
  assert.equal(
    parseCandidates('[{"text":"老爹喜欢冰美式","kind":"pref","src":-3}]')[0].src, -1,
    '非法 src 当没有',
  )
  ok('候选解析与校验')

  // 三元组解析：id 必须能对回输入，时间词/问句实体不收
  assert.deepEqual(
    parseTriples('```json\n[{"item":"m1","s":"老爹","sType":"person","rel":"喜欢","o":"冰美式","oType":"thing"}]\n```', ['m1']),
    [{ item: 'm1', s: '老爹', sType: 'person', rel: '喜欢', o: '冰美式', oType: 'thing' }],
  )
  assert.equal(parseTriples('没有 json'), null)
  assert.deepEqual(parseTriples('[]'), [], '合法空数组表示这批没有关系')
  assert.deepEqual(parseTriples('[{"item":"m2","s":"A","rel":"喜欢","o":"B"}]', ['m1']), [], '对不上输入 id 的丢弃')
  assert.deepEqual(parseTriples('[{"item":"m1","s":"以后","rel":"是","o":"B"}]', ['m1']), [], '时间词不当实体')
  ok('三元组解析与校验')

  let graphPrompt = ''
  const graphStub = async (url, init) => {
    graphPrompt = JSON.parse(init.body).messages[1].content
    return jsonRes({
      choices: [{ message: { content: '[{"item":"m1","s":"老爹","sType":"person","rel":"养了","o":"鲸鱼","oType":"thing"}]' } }],
    })
  }
  const triples = await extractGraphTriples([{ id: 'm1', text: '老爹养了一条鲸鱼' }], { fetchImpl: graphStub })
  assert.equal(triples.length, 1)
  assert.equal(triples[0].item, 'm1')
  assert.equal(triples[0].rel, '养了')
  assert.ok(graphPrompt.includes('[m1]'), '输入要带条目 id：' + graphPrompt)
  ok('三元组抽取：id 对齐 + 严格 JSON')

  const cands = await distillMessages([{ at: '2026-10-30T12:00:00', speaker: '老爹', text: '今天累死了刚到家' }], { fetchImpl: chatStub })
  assert.equal(cands[0].text, '老爹刚下班回家')
  ok('distillMessages 走 chat/completions')

  // 空数组是正常结果：不能记成失败，否则会触发十分钟冷却。
  const emptyOk = async () => jsonRes({ choices: [{ message: { content: '[]' }, finish_reason: 'stop' }] })
  assert.deepEqual(
    await distillMessages([{ at: '', text: '今天挺热的' }], { fetchImpl: emptyOk }),
    [],
  )
  assert.equal(lastLlmError(), '', '空数组不该留下失败原因')
  ok('空候选正常返回，不触发冷却')

  // 带旧记忆去查重：合法的 merge_id 要保留，编的 id 要丢掉；scene 原样带回
  const mergeStub = async () => jsonRes({
    choices: [{
      message: {
        content: '[{"text":"老爹要求菜单横向，点主菜单后子菜单显示在内容页顶部","kind":"pref","src":0,"speaker":"老爹","scene":"在调设置页菜单","merge_id":"m_old"},{"text":"另一条事实","kind":"fact","src":0,"merge_id":"m_fake"}]',
      },
      finish_reason: 'stop',
    }],
  })
  const merged = await distillMessages(
    [{ at: '2026-11-11T02:20:00', speaker: '老爹', text: '菜单整成横向，子菜单别藏着' }],
    { fetchImpl: mergeStub, existing: [{ id: 'm_old', kind: 'pref', text: '菜单要横向' }] },
  )
  assert.ok(merged, `蒸馏查重返回 null：${lastLlmError()}`)
  assert.equal(merged[0].mergeId, 'm_old')
  assert.equal(merged[0].scene, '在调设置页菜单')
  assert.equal(merged[1].mergeId, '', '不存在的 merge_id 不能放行')
  ok('蒸馏查重：merge_id 对得上旧记忆才保留')

  // 输出被截断：自动用更大预算重试一次；仍然不全才报截断。
  let truncCalls = 0
  const truncStub = async () => {
    truncCalls += 1
    return jsonRes({
      choices: [{
        message: { content: truncCalls === 1 ? '[{"text":"老爹喜欢' : '[{"text":"老爹喜欢冰美式","kind":"pref"}]' },
        finish_reason: truncCalls === 1 ? 'length' : 'stop',
      }],
    })
  }
  const retried = await distillMessages([{ at: '', text: '记住，我喜欢冰美式' }], { fetchImpl: truncStub })
  assert.equal(truncCalls, 2, '截断后应重试一次')
  assert.equal(retried[0].text, '老爹喜欢冰美式')
  let truncFailCalls = 0
  const truncFailStub = async () => {
    truncFailCalls += 1
    return jsonRes({
      choices: [{ message: { content: '[{"text":"老爹喜欢' }, finish_reason: 'length' }],
    })
  }
  assert.equal(await distillMessages([{ at: '', text: '记住，我喜欢冰美式' }], { fetchImpl: truncFailStub }), null)
  assert.equal(truncFailCalls, 2)
  assert.match(lastLlmError(), /截断/)
  ok('截断重试与失败原因')

  // 输入按条截短，最近的消息必须完整保留（以前是拼完再截头，最新的会被砍掉）。
  let packedPrompt = ''
  const packStub = async (_url, init) => {
    packedPrompt = JSON.parse(init.body).messages[1].content
    return jsonRes({ choices: [{ message: { content: '[]' }, finish_reason: 'stop' }] })
  }
  const many = Array.from({ length: 40 }, (_, i) => ({
    at: `2026-11-07T10:${String(i).padStart(2, '0')}:00`,
    speaker: '老爹',
    text: `第${i}条 ` + '长'.repeat(500),
  }))
  await distillMessages(many, { fetchImpl: packStub })
  assert.ok(packedPrompt.includes('[39]'), '最新一条不能丢')
  assert.ok(packedPrompt.length < 7000, '输入应按条截断：' + packedPrompt.length)
  ok('40 条长消息按条截短且保留最新')

  // src 是「传进来那一批」的下标：模型看到的是紧凑编号，返回后要映射回去
  let sentPrompt = ''
  const srcStub = async (url, init) => {
    sentPrompt = JSON.parse(init.body).messages[1].content
    return jsonRes({
      choices: [{ message: { content: '[{"text":"老爹明天要交房租给房东","kind":"event","conf":0.8,"src":1}]' } }],
    })
  }
  const withSrc = await distillMessages([
    { at: '2026-10-30T22:00:00', speaker: '老爹', text: '今天累死了刚到家' },
    { at: '2026-10-30T22:05:00', speaker: '老爹', text: '记住：明天交房租' },
  ], { fetchImpl: srcStub })
  assert.equal(withSrc[0].src, 1, 'src 映射回传入数组的下标')
  assert.ok(sentPrompt.includes('[0] 2026-10-30T22:00:00'), '输入要带行号和原时间')
  assert.ok(sentPrompt.includes('[1] 2026-10-30T22:05:00'))
  ok('候选带回来源消息下标')

  // 群聊蒸馏：拥有者按 QQ 标记，别人话里的老爹不能被算到拥有者头上；
  // 改了称呼以后，提示词和标记也要跟着用新称呼。
  let groupSys = ''
  let groupUser = ''
  const groupStub = async (url, init) => {
    const body = JSON.parse(init.body)
    groupSys = body.messages[0].content
    groupUser = body.messages[1].content
    return jsonRes({
      choices: [{ message: { content: '[{"text":"陆小鱼称呼自己的主人为老爹","kind":"relation","conf":0.6,"src":1,"speaker":"陆小鱼"}]' } }],
    })
  }
  const scoped = await distillMessages([
    { at: '2026-11-07T10:29:00', speaker: '老板', text: '今天加班到十点', owner: true },
    { at: '2026-11-07T10:30:00', speaker: '陆小鱼', qq: '10001', text: '怎么天天有人想来抢老爹', owner: false },
  ], { fetchImpl: groupStub, group: true, ownerName: '老板' })
  assert.equal(scoped.length, 1)
  assert.equal(scoped[0].speaker, '陆小鱼', '模型报的发言人能对上输入行时要保留')
  assert.ok(groupUser.includes('[拥有者] 老板：'), '拥有者那条要带标记：' + groupUser)
  assert.ok(!groupUser.includes('[拥有者] 陆小鱼'), '别人的发言不该带拥有者标记：' + groupUser)
  assert.ok(groupSys.includes('「老板」'), '提示词要用配置里的称呼：' + groupSys)
  assert.ok(groupSys.includes('其他人口中的「老爹」'), '群聊提示词要区分别人家的老爹')
  assert.ok(groupSys.includes('称呼自己的主人为老爹'), '给模型一个正确转述示例')
  assert.ok(groupSys.includes('"speaker"') || groupSys.includes('speaker 字段'), '提示词要要求返回发言人')
  assert.ok(groupSys.includes('代词纪律'), '提示词要有代词纪律')
  ok('群聊蒸馏：拥有者标记 + 动态称呼 + 发言人校验')

  // 模型编一个不在输入里的发言人：不能信，留给 src 那条消息兜底
  const fakeStub = async () => jsonRes({
    choices: [{ message: { content: '[{"text":"有人想抢老爹","kind":"event","conf":0.6,"src":1,"speaker":"群里的人"}]' } }],
  })
  const fake = await distillMessages([
    { at: '2026-11-07T10:30:00', speaker: '陆小鱼', text: '怎么天天有人想来抢老爹' },
  ], { fetchImpl: fakeStub, group: true, ownerName: '老板' })
  assert.equal(fake[0].speaker, '', '对不上的发言人不能写进记忆')
  ok('群聊蒸馏：编造的发言人被丢弃')

  // 同名不同人：同批里两个「小鱼」用 QQ 尾号区分，模型也得照抄
  let dupUser = ''
  const dupStub = async (url, init) => {
    dupUser = JSON.parse(init.body).messages[1].content
    return jsonRes({ choices: [{ message: { content: '[]' } }] })
  }
  await distillMessages([
    { at: '', speaker: '小鱼', qq: '13800001111', text: '我住杭州' },
    { at: '', speaker: '小鱼', qq: '13900002222', text: '我住成都' },
  ], { fetchImpl: dupStub, group: true })
  assert.ok(dupUser.includes('小鱼（尾号1111）：'), '同名要给尾号：' + dupUser)
  assert.ok(dupUser.includes('小鱼（尾号2222）：'), '同名要给尾号：' + dupUser)
  ok('群聊蒸馏：同名不同人按尾号区分')

  const fail = async () => ({ ok: false, json: async () => ({}) })
  assert.equal(await distillMessages([{ at: '', text: 'x' }], { fetchImpl: fail }), null)
  assert.equal(await embedTexts(['a', 'b'], { fetchImpl: fail }), null)
  ok('端点失败返回 null，不写半截结果')

  // 失败要能说出原因；5xx 重试一次，401 不重试
  let flaky = 0
  const unavailable = async () => { flaky += 1; return { ok: false, status: 503, text: async () => 'busy' } }
  assert.equal(await distillMessages([{ at: '', text: 'x' }], { fetchImpl: unavailable }), null)
  assert.equal(flaky, 2, '5xx 应该重试一次')
  assert.match(lastLlmError(), /HTTP 503 · busy/)
  let denied = 0
  const unauthorized = async () => { denied += 1; return { ok: false, status: 401 } }
  assert.equal(await distillMessages([{ at: '', text: 'x' }], { fetchImpl: unauthorized }), null)
  assert.equal(denied, 1, '401 不该重试')
  assert.match(lastLlmError(), /HTTP 401/)
  const empty = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '' } }] }) })
  assert.equal(await distillMessages([{ at: '', text: 'x' }], { fetchImpl: empty }), null)
  assert.match(lastLlmError(), /空 content/)
  ok('失败原因可诊断 + 只对 5xx/429 重试')

  const vecs = await embedTexts(['a', 'b'], { fetchImpl: embedStub })
  assert.deepEqual(vecs, [[1, 0], [0, 1]])
  ok('embedTexts 批量向量')

  // 自动探测向量模型：名字像 embedding 的优先，不支持的标 unusable
  const embedModelsStub = async (url, opts = {}) => {
    const resp = (obj, status = 200) => ({
      ok: status < 400, status, json: async () => obj, text: async () => JSON.stringify(obj),
    })
    if (url.endsWith('/models')) {
      return resp({ data: [{ id: 'deepseek-v4.1-flash' }, { id: 'bge-m3' }, { id: 'fake-embed-bad' }, { id: 'chat-model' }] })
    }
    const model = String(JSON.parse(opts.body || '{}').model || '')
    if (model.includes('bad')) return { ok: false, status: 400, text: async () => 'does not support /embeddings' }
    return resp({ data: [{ embedding: [1, 2, 3] }] })
  }
  const probeList = await listEmbedModels({ base: 'http://stub.local/v1', key: 'k', fetchImpl: embedModelsStub })
  assert.equal(probeList.ok, true, JSON.stringify(probeList))
  assert.equal(probeList.counts.usable, 1)
  assert.equal(probeList.counts.unusable, 1)
  assert.equal(probeList.models.length, 2, '只测名字像 embedding 的')
  assert.ok(probeList.models.every((m) => /embed|bge/i.test(m.id)), JSON.stringify(probeList.models))
  ok('自动探测：只试 embedding 模型，标出不支持')

  // 向量真的参与检索：问「咖啡」能召回到只写了「冰美式」的条目
  resetVectorFallback()
  const vecScope = {
    scope: 'test:vec',
    items: [
      { id: 'coffee', text: '老爹喜欢喝冰美式', kind: 'pref', state: 'active', weight: 0.5, confidence: 0.8, timeline: '2026-11-11' },
      { id: 'deploy', text: '今天修了补货逻辑', kind: 'fact', state: 'active', weight: 0.5, confidence: 0.8, timeline: '2026-11-11' },
    ],
  }
  const lexOnly = searchFunnel([vecScope], { query: '他对咖啡怎么看', hops: false })
  assert.ok(!lexOnly.some((x) => x.id === 'coffee'), '词法不该靠同义词命中')
  const fakeEmbed = async (texts) => texts.map((t) => (/咖啡|冰美式/.test(String(t)) ? [1, 0] : [0, 1]))
  const mixed = await searchFunnelHybrid([vecScope], { query: '他对咖啡怎么看', hops: false, embedImpl: fakeEmbed })
  assert.equal(mixed[0]?.id, 'coffee', JSON.stringify(mixed.map((x) => [x.id, x.why])))
  assert.ok(mixed[0].why.some((x) => x.includes('向量')), mixed[0].why.join('；'))
  ok('混合检索：同义词靠向量召回')

  resetVectorFallback()
  const down = await searchFunnelHybrid([vecScope], { query: '他对咖啡怎么看', hops: false, embedImpl: async () => null })
  assert.equal(down.length, lexOnly.length, '向量挂了要回退词法')
  ok('向量端点失败回退词法')

  // RRF：两个通道名次不同，融合后两边都保留
  const a = { id: 'a' }
  const b = { id: 'b' }
  const fused = fuseRankings([[{ item: a, score: 1 }, { item: b, score: 0.5 }], [{ item: b, score: 1 }, { item: a, score: 0.5 }]])
  assert.equal(fused.length, 2)
  assert.ok(Math.abs(fused[0].score - fused[1].score) < 1e-9, '两条各赢一局，分数应该一样')
  ok('RRF 融合')

  // 端到端：LLM 抽到规则抽不出来的句子
  await ensureDirs(root)
  await mkdir(paths(root).staging, { recursive: true })
  await writeFile(join(paths(root).staging, 'sess-llm.jsonl'),
    JSON.stringify({ at: '2026-10-30T22:00:00', role: 'user', speaker: '老爹', text: '今天累死了刚到家' }) + '\n', 'utf8')
  const r = await distillSession(root, 'sess-llm', { log: () => {}, fetchImpl: chatStub })
  assert.equal(r.ok, true, JSON.stringify(r))
  const sc = await loadScope(root, 'private', '123456789')
  assert.ok(sc.items.some((x) => x.text === '老爹刚下班回家'), JSON.stringify(sc.items))
  assert.ok(sc.items.every((x) => !x.text.includes('累死了')), '规则不该把寒暄当事实')
  ok('LLM 蒸馏接入 distillSession')

  // 模型把同一条偏好拆成两句：同批兜底要合成一条，不能照单全收
  await writeFile(join(paths(root).staging, 'sess-llm.jsonl'), [
    { at: '2026-11-11T02:19:41', role: 'user', speaker: '老爹', text: '菜单整成横向，子菜单并不直接显示，只有点击主菜单才有选择对应下的子菜单' },
    { at: '2026-11-11T02:32:02', role: 'user', speaker: '老爹', text: '子菜单不要藏在主菜单里做二级菜单，子菜单可以当点击主菜单后，主菜单内容页中顶部显示子菜单' },
  ].map((x) => JSON.stringify(x)).join('\n') + '\n', 'utf8')
  const menuStub = async () => jsonRes({
    choices: [{
      message: {
        content: JSON.stringify([
          { text: '要求菜单做成横向，子菜单不直接显示，只有点击主菜单后才显示对应下的子菜单', kind: 'pref', conf: 0.8, src: 0, speaker: '老爹' },
          { text: '要求子菜单不要藏在主菜单里做成二级菜单，而是在点击主菜单后显示在主菜单内容页的顶部', kind: 'pref', conf: 0.8, src: 1, speaker: '老爹' },
        ]),
      },
    }],
  })
  const rm = await distillSession(root, 'sess-llm', { log: () => {}, fetchImpl: menuStub })
  assert.equal(rm.ok, true, JSON.stringify(rm))
  const scm = await loadScope(root, 'private', '123456789')
  const menus = scm.items.filter((x) => x.kind === 'pref' && x.text.includes('菜单'))
  assert.equal(menus.length, 1, JSON.stringify(menus.map((x) => x.text)))
  assert.ok(menus[0].text.includes('横向') && menus[0].text.includes('二级菜单'), menus[0].text)
  ok('同批候选：同一件事的两个说法只存一条')

  // 时间锚 + 规则补漏 + 后写升级：
  //   · 「下周三」按 src 指的那条消息（10-30）算，不是按会话最后一句（11-09）算
  //   · LLM 覆盖到的消息不再跑规则；LLM 的长表述要能升级规则截出来的残句
  const replyStub = (cands) => async () => jsonRes({
    choices: [{ message: { content: JSON.stringify(cands) } }],
  })
  await writeFile(join(paths(root).staging, 'sess-llm.jsonl'), [
    { at: '2026-10-30T22:00:00', role: 'user', speaker: '老爹', text: '记住：明天交房租' },
    { at: '2026-10-30T22:05:00', role: 'user', speaker: '老爹', text: '下周三搬家' },
    { at: '2026-11-09T09:00:00', role: 'user', speaker: '老爹', text: '我叫老王' },
  ].map((x) => JSON.stringify(x)).join('\n') + '\n', 'utf8')
  const r3 = await distillSession(root, 'sess-llm', {
    log: () => {},
    fetchImpl: replyStub([
      { text: '老爹明天交房租给房东，记得转钱', kind: 'event', conf: 0.8, src: 0 },
      { text: '老爹下周三搬家', kind: 'event', conf: 0.8, src: 1 },
      { text: '老爹叫老王', kind: 'fact', conf: 0.8, src: 2 },
    ]),
  })
  assert.equal(r3.ok, true, JSON.stringify(r3))
  const sc3 = await loadScope(root, 'private', '123456789')
  const move = sc3.items.find((x) => x.text.includes('搬家'))
  assert.ok(move, JSON.stringify(sc3.items))
  assert.equal(move.atAbs, '2026-11-04', '相对时间按 src 那条消息锚，不按会话最后一句')
  const rent = sc3.items.find((x) => x.text.includes('交房租'))
  assert.ok(rent, JSON.stringify(sc3.items))
  assert.equal(rent.text, '老爹明天交房租给房东，记得转钱')
  assert.ok(!sc3.items.some((x) => x.text === '名字叫老王'), 'LLM 已覆盖的消息不该再跑规则')
  ok('src 时间锚 + 规则按消息补漏')

  // 本地工程会话例外：规则和 LLM 都写，LLM 的完整表述后写、升级规则残句
  await writeFile(join(paths(root).staging, 'sess-local.jsonl'),
    JSON.stringify({ at: '2026-10-30T22:00:00', role: 'user', speaker: '', text: '统一用 pnpm 管依赖；路径是 C:\\work\\demo' }) + '\n', 'utf8')
  const r4 = await distillSession(root, 'sess-local', {
    log: () => {},
    fetchImpl: replyStub([
      { text: '统一用 pnpm 管依赖，不要再装 npm', kind: 'pref', conf: 0.8, src: 0 },
    ]),
  })
  assert.equal(r4.ok, true, JSON.stringify(r4))
  const lc = await loadScope(root, 'local', 'dsh')
  assert.ok(lc.items.some((x) => x.text.includes('C:\\work\\demo')), '工程硬事实不能被 LLM 覆盖掉')
  const pnpm = lc.items.find((x) => x.text.includes('pnpm'))
  assert.equal(pnpm.text, '统一用 pnpm 管依赖，不要再装 npm', 'LLM 的长表述要升级规则截出来的半句')
  assert.ok(pnpm.history?.some((h) => h.text === '统一用 pnpm 管依赖'), '旧说法留在 history')
  ok('本地分片双写 + 后写升级')

  // 蒸馏后的图谱补抽：第一次请求出候选，第二次请求出三元组
  let graphAsk = 0
  const bothStub = async (url, init) => {
    graphAsk += 1
    const user = JSON.parse(init.body).messages[1].content
    if (graphAsk === 1) {
      return jsonRes({ choices: [{ message: { content: '[{"text":"陆小鱼喜欢喝乌龙茶","kind":"pref","conf":0.8,"src":0}]' } }] })
    }
    const id = (user.match(/\[(m_[^\]]+)\]/) || [])[1]
    return jsonRes({
      choices: [{ message: { content: JSON.stringify([{ item: id, s: '陆小鱼', sType: 'person', rel: '喜欢', o: '乌龙茶', oType: 'thing' }]) } }],
    })
  }
  await writeFile(join(paths(root).staging, 'sess-llm.jsonl'),
    JSON.stringify({ at: '2026-11-09T10:00:00', role: 'user', speaker: '陆小鱼', text: '记住：陆小鱼喜欢喝乌龙茶' }) + '\n', 'utf8')
  const r5 = await distillSession(root, 'sess-llm', { log: () => {}, fetchImpl: bothStub })
  assert.equal(r5.ok, true, JSON.stringify(r5))
  assert.equal(r5.fresh, undefined, '临时字段不该带出去')
  assert.equal(graphAsk, 2, '蒸馏后应该再请求一次三元组')
  const rows = await loadTriples(root)
  assert.ok(
    rows.some((t) => t.s === '陆小鱼' && t.rel === '喜欢' && t.o === '乌龙茶'),
    JSON.stringify(rows),
  )
  ok('蒸馏后自动补图谱三元组')

  // LLM 挂了：规则照常兜底
  await writeFile(join(paths(root).staging, 'sess-llm.jsonl'),
    JSON.stringify({ at: '2026-10-30T22:10:00', role: 'user', speaker: '老爹', text: '记住：明天交房租' }) + '\n', 'utf8')
  const r2 = await distillSession(root, 'sess-llm', { log: () => {}, fetchImpl: fail })
  assert.equal(r2.ok, true, JSON.stringify(r2))
  const sc2 = await loadScope(root, 'private', '123456789')
  assert.ok(sc2.items.some((x) => x.text.includes('交房租')), JSON.stringify(sc2.items))
  ok('LLM 失败时规则兜底')

  console.log(`\n全部通过：${pass} 项`)
} catch (e) {
  console.error('\n失败：', e)
  process.exitCode = 1
} finally {
  delete process.env.DSH_MEMORY_LLM_BASE
  delete process.env.DSH_MEMORY_LLM_MODEL
  delete process.env.DSH_MEMORY_EMBED_BASE
  delete process.env.DSH_MEMORY_EMBED_MODEL
  await rm(root, { recursive: true, force: true }).catch(() => {})
}
