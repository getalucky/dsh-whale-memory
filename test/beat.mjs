/**
 * test/beat.mjs —— 主动行为层纯逻辑测试
 *
 * 不启宿主、不调模型：只测节律、闸门、素材库、三源解析与素材包。
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeFile, mkdir } from 'node:fs/promises'

import { DEFAULT_CONFIG, deliveriesPath, ensureBeatDirs, loadConfig, saveConfig } from '../lib/beat/config.js'
import { dayKey, inWindow, jitter, nextWindowStart, toMinutes, wanderDue } from '../lib/beat/schedule.js'
import { checkGate } from '../lib/beat/gate.js'
import {
  addMaterial, adjustMaterial, gcMaterial, loadMaterial, markUsed, materialCounts, resurface, scoreOf,
} from '../lib/beat/material.js'
import { pullPublic } from '../lib/beat/sources/public.js'
import { addChatMaterial, extractChatCandidates } from '../lib/beat/sources/chat.js'
import { parseWanderDetailed, parseWanderResponse, wander, wanderPrompt } from '../lib/beat/sources/web.js'
import { buildPack, deliver, estimatePackTokens, mixCandidates, ownerTarget } from '../lib/beat/delivery.js'
import {
  gateAllowsWander, lastAssistantText, runOnce, sessionEventCount, sessionEvents, startBeat, textOfEvent,
} from '../lib/beat/index.js'
import { loadState, saveState } from '../lib/beat/state.js'
import { applyReport, noteDelivery, noteUserMessage, settleUnreported } from '../lib/beat/feedback.js'
import { schedulerState } from '../lib/beat/scheduler.js'
import { loadSessions, rotateBeatSession, saveSessions } from '../lib/beat/session.js'
import {
  burnSensitive, checkSensitiveHealth, decryptText, encryptText, keyPath, notepadPath, readEncrypted, writeEncrypted,
} from '../lib/secure/vault.js'
import { clearNotepadIf, readNotepad, writeNotepad } from '../lib/secure/notepad.js'
import { capturePsych, extractPsychStatements, readPsych, writePsych } from '../lib/secure/psych.js'
import { loadProfile, profileInterests, rebuildProfile, profilePath } from '../lib/person/profile.js'
import { emptyScope, ensureDirs, loadScope, addItem, saveScope, paths } from '../lib/store.js'
import { flush, registerIngest } from '../lib/ingest.js'
import { resetSourceCache } from '../lib/source.js'
import { distillSession } from '../lib/distill.js'

const at = (h, m = 0) => new Date(2026, 10, 6, h, m, 0, 0)

async function main() {
  process.env.DSH_MEMORY_VAULT = 'plain'
  // 1. 时间窗
  assert.equal(toMinutes('11:30'), 690)
  assert.equal(toMinutes('24:00'), -1)
  assert.equal(inWindow(at(12), { start: '11:00', end: '15:00' }), true)
  assert.equal(inWindow(at(16), { start: '11:00', end: '15:00' }), false)
  assert.equal(inWindow(at(23), { start: '21:00', end: '02:00' }), true)
  assert.equal(inWindow(at(1), { start: '21:00', end: '02:00' }), true)
  assert.equal(inWindow(at(3), { start: '21:00', end: '02:00' }), false)
  assert.ok(nextWindowStart(at(16), DEFAULT_CONFIG.windows).getTime() > at(16).getTime())
  assert.ok(jitter(1000, 0) === 1000)

  // 2. 闲逛节律
  const cfg = { ...DEFAULT_CONFIG }
  assert.equal(wanderDue({ now: at(9), config: cfg, state: {}, materialCount: 0 }).reason, 'window')
  assert.equal(wanderDue({ now: at(12), config: cfg, state: {}, materialCount: 0 }).due, true)
  assert.equal(wanderDue({
    now: at(12), config: cfg, materialCount: 0,
    state: { lastWanderAt: new Date(at(11, 30)).toISOString() },
  }).reason, 'interval')
  assert.equal(wanderDue({
    now: at(12), config: cfg, materialCount: 0,
    state: { wanderDay: dayKey(at(12)), wanderCount: 2 },
  }).reason, 'daily_cap')

  // 3. 闸门
  const base = { ...DEFAULT_CONFIG, quietHours: { start: '01:00', end: '08:00' } }
  const state = { daily: { day: dayKey(at(12)), sent: 0 }, recentMaterialIds: [] }
  assert.equal(checkGate({ now: at(2), config: base, state, counts: { active: 3 } }).reason, 'quiet_hours')
  assert.equal(checkGate({ now: at(12), config: base, state: { ...state, focusUntil: at(13).toISOString() }, counts: { active: 3 } }).reason, 'focus_mode')
  assert.equal(checkGate({ now: at(12), config: base, state, counts: { active: 3 }, env: { idleMinutes: 31 } }).reason, 'token_saver')
  assert.equal(checkGate({ now: at(12), config: base, state, counts: { active: 3 }, env: { busy: true } }).reason, 'busy')
  assert.equal(checkGate({ now: at(12), config: base, state: { ...state, daily: { day: dayKey(at(12)), sent: 10 } }, counts: { active: 3 } }).reason, 'daily_cap')
  assert.equal(checkGate({ now: at(12), config: base, state: { ...state, lastDeliveryAt: at(11, 45).toISOString() }, counts: { active: 3 } }).reason, 'cooldown')
  assert.equal(checkGate({ now: at(12), config: base, state, counts: { active: 0 } }).reason, 'no_material')
  assert.equal(checkGate({
    now: at(12), config: base, counts: { active: 3 }, candidates: ['m1'],
    state: { ...state, recentMaterialIds: [{ id: 'm1', at: at(11, 50).toISOString() }] },
  }).reason, 'duplicate')
  assert.equal(checkGate({ now: at(12), config: base, state, counts: { active: 3 }, candidates: ['m1'] }).ok, true)

  // 4. 配置热加载
  const root = await mkdtemp(join(tmpdir(), 'whale-beat-'))
  try {
    await ensureDirs(root)
    await ensureBeatDirs(root)
    const d = await loadConfig(root)
    assert.equal(d.enabled, false)
    assert.equal(d.engine, 'agent')
    const saved = await saveConfig(root, { enabled: true, dryRun: false })
    assert.equal(saved.enabled, true)
    assert.equal(saved.dryRun, false)
    assert.equal((await saveConfig(root, { engine: 'search' })).engine, 'search')
    assert.equal((await loadConfig(root, { reload: true })).enabled, true)

    // 5. 素材库
    const web = await addMaterial(root, {
      text: '隔壁市开了家 24 小时书店', refs: ['https://example.com/a'],
      source: 'web:city', focus: '城市', conf: 0.4,
    }, { config: saved, now: at(12) })
    assert.equal(web.ok, true)
    assert.equal(web.item.state, 'active')
    assert.ok(scoreOf(web.item, at(12).getTime()) > 0)
    const dup = await addMaterial(root, {
      text: '完全不同的说法', refs: ['https://example.com/a'],
      source: 'web:city', focus: '城市',
    }, { config: saved, now: at(12) })
    assert.equal(dup.duplicate, true)
    const bad = await addMaterial(root, { text: '没来源', source: 'web' }, { config: saved, now: at(12) })
    assert.equal(bad.ok, false)
    const chatBad = await addMaterial(root, { text: '聊天素材', source: 'chat' }, { config: saved, now: at(12) })
    assert.equal(chatBad.ok, false)
    const scaffold = await addMaterial(root, {
      text: '你在帮「大肥鱼」找下次聊天可以自然带出的素材', source: 'chat', originId: 'scaffold',
    }, { config: saved, now: at(12) })
    assert.equal(scaffold.ok, false)
    assert.equal(scaffold.why, 'scaffold-text')

    const top = await resurface(root, { limit: 3, now: at(12) })
    assert.equal(top.length, 1)
    const used = await markUsed(root, [web.item.id], 'd-test', { now: at(12) })
    assert.equal(used.used, 1)
    assert.equal((await loadMaterial(root)).items[0].state, 'used')
    const after = await resurface(root, { limit: 3, now: at(12) })
    assert.equal(after.length, 0)

    // 消费一次后 48 小时没人接：先降冷；正向反馈可以拉回 active；再投一次即退役
    const db = await loadMaterial(root)
    db.items[0].lastUsedAt = new Date(at(12).getTime() - 49 * 3600000).toISOString()
    db.items[0].graceUntil = ''
    await (await import('../lib/beat/material.js')).saveMaterial(root, db)
    await gcMaterial(root, { config: saved, now: at(12) })
    assert.equal((await loadMaterial(root)).items[0].state, 'cooling')
    const revived = await adjustMaterial(root, web.item.id, 0.3, { now: at(12) })
    assert.equal(revived.item.state, 'active')
    await markUsed(root, [web.item.id], 'd-test-2', { now: at(12) })
    await gcMaterial(root, { config: saved, now: at(12) })
    assert.equal((await loadMaterial(root)).items[0].state, 'retired')

    // 6. 公共池
    const pubRoot = await mkdtemp(join(tmpdir(), 'whale-pub-'))
    try {
      await ensureDirs(pubRoot)
      const sc = emptyScope('public', 'web')
      addItem(sc, { text: '公共池里的近期话题', kind: 'fact', conf: 0.5, source: 'test' })
      sc.items[0].summary = '公共池里的近期…'
      sc.items[0].weight = 0.6
      sc.items[0].state = 'active'
      sc.items[0].observedAt = at(12).toISOString()
      // 真实现场：公共池条目会按时间从 active 落到 warm，不能因此整池跳过
      addItem(sc, { text: '公共池里已经变 warm 的旧话题', kind: 'fact', conf: 0.5, source: 'test' })
      sc.items[1].weight = 0.48
      sc.items[1].state = 'warm'
      sc.items[1].observedAt = at(11).toISOString()
      await saveScope(pubRoot, sc)
      const pulled = await pullPublic(pubRoot, { config: saved, now: at(12), limit: 4 })
      assert.equal(pulled.added, 2)
      assert.equal((await loadScope(pubRoot, 'public', 'web')).items.length, 2)
      // 素材正文应取完整一条，不是索引层的半句摘要。
      assert.ok((await loadMaterial(pubRoot)).items.some((x) => x.text === '公共池里的近期话题'))
    } finally {
      await rm(pubRoot, { recursive: true, force: true })
    }

    // 7. 会话素材
    const messages = [
      { m: { text: '下次给我看看那个书店', at: at(12).toISOString(), speaker: '爹' } },
      { m: { text: '这个真受不了，太离谱了', at: at(12, 1).toISOString(), speaker: '爹' } },
      { m: { text: '今天天气不错', at: at(12, 2).toISOString(), speaker: '爹' } },
    ]
    const cs = extractChatCandidates(messages, { max: 3 })
    assert.ok(cs.length >= 2)
    // 会话素材要带上她上一句，否则单句剪出来缺上文。
    const withContext = [
      { m: { text: '你要不要换新会话？', at: at(12).toISOString(), speaker: '大肥鱼', role: 'her' } },
      { m: { text: '以后跟我吧', at: at(12, 1).toISOString(), speaker: '爹', role: 'user' } },
    ]
    const ctxCands = extractChatCandidates(withContext)
    assert.equal(ctxCands.length, 1)
    assert.equal(ctxCands[0].text, '以后跟我吧')
    assert.equal(ctxCands[0].context, '你要不要换新会话？')
    const addedChat = await addChatMaterial(root, messages, { config: saved, now: at(12) })
    assert.ok(addedChat.added >= 2)
    const counts = await materialCounts(root)
    assert.ok(counts.bySource.chat >= 2)

    // 8. 闲逛 JSON 解析
    const parsed = parseWanderResponse('```json\n{"items":[{"text":"一条新素材","url":"https://example.com/b","why":"能接话","focus":"城市"},{"text":"坏链接","url":"javascript:alert(1)"}]}\n```')
    assert.equal(parsed.length, 1)
    assert.equal(parsed[0].refs[0], 'https://example.com/b')

    // 8.5 一跳 dry-run：公共池 → 闸门 → 预演投递
    {
      const runRoot = await mkdtemp(join(tmpdir(), 'whale-run-'))
      try {
        await ensureDirs(runRoot)
        const pub = emptyScope('public', 'web')
        addItem(pub, { text: '跳到公共池的一条', kind: 'fact', conf: 0.5, source: 'test' })
        pub.items[0].weight = 0.6
        pub.items[0].observedAt = at(12).toISOString()
        await saveScope(runRoot, pub)
        await saveConfig(runRoot, { enabled: true, dryRun: false })
        const cfg2 = await loadConfig(runRoot, { reload: true })
        const r = await runOnce({ root: runRoot, config: cfg2, now: at(12) })
        assert.equal(r.gate.ok, true)
        assert.equal(r.delivery.dryRun, true)
        assert.ok(r.material.active >= 1)
      } finally {
        await rm(runRoot, { recursive: true, force: true })
      }
    }

    // 8.45 跨天的投递失败记录：下一跳自动清掉
    {
      const sRoot = await mkdtemp(join(tmpdir(), 'whale-stale-'))
      try {
        await ensureDirs(sRoot)
        await ensureBeatDirs(sRoot)
        await saveState(sRoot, {
          deliveryFailed: { day: '2026-11-05', at: at(12).toISOString(), why: 'delivery-failed' },
        })
        const sCfg = await saveConfig(sRoot, {
          enabled: true, dryRun: true, quietHours: { start: '11:00', end: '13:00' }, interests: ['城市'],
        })
        await runOnce({ root: sRoot, config: sCfg, now: at(12), dryRun: true })
        assert.equal((await loadState(sRoot)).deliveryFailed, null, '跨天的失败记录不该留在 state 里')
      } finally {
        await rm(sRoot, { recursive: true, force: true })
      }
    }

    // 8.51 闸门拦截时零模型调用；dryRun 仍然允许闲逛补素材
    {
      const qRoot = await mkdtemp(join(tmpdir(), 'whale-quiet-'))
      try {
        await ensureDirs(qRoot)
        await ensureBeatDirs(qRoot)
        const qCfg = await saveConfig(qRoot, {
          enabled: true, dryRun: true, busyMinutes: 0, tokenSaverIdleMinutes: 100000,
          quietHours: { start: '11:00', end: '13:00' }, interests: ['城市'],
        })
        let calls = 0
        const r = await runOnce({
          root: qRoot, config: qCfg, now: at(12), dryRun: true,
          turn: async () => { calls += 1; return '{"items":[]}' },
        })
        assert.equal(calls, 0, '闸门拦截时不得调模型')
        assert.equal(r.wander.ran, false)
        assert.equal(r.wander.skipped, 'gate:quiet_hours')
        assert.equal(gateAllowsWander(r.gate), false)
      } finally {
        await rm(qRoot, { recursive: true, force: true })
      }
    }
    {
      const dRoot = await mkdtemp(join(tmpdir(), 'whale-drywander-'))
      try {
        await ensureDirs(dRoot)
        await ensureBeatDirs(dRoot)
        const dCfg = await saveConfig(dRoot, {
          enabled: true, dryRun: true, busyMinutes: 0, tokenSaverIdleMinutes: 100000,
          quietHours: { start: '01:00', end: '08:00' }, interests: ['城市'],
        })
        let calls = 0
        const r = await runOnce({
          root: dRoot, config: dCfg, now: at(12), dryRun: true,
          turn: async () => {
            calls += 1
            return '{"items":[{"text":"dry run 闲逛素材","url":"https://example.com/dry"}]}'
          },
        })
        assert.equal(calls, 1, 'dryRun 只跳过投递，不跳过补素材')
        assert.equal(r.wander.ran, true)
        assert.equal(r.wander.added, 1)
        assert.equal(r.delivery.dryRun, true)
        assert.ok(r.material.active >= 1)
      } finally {
        await rm(dRoot, { recursive: true, force: true })
      }
    }

    // 8.52 闲逛坏 JSON 重试一次；坏 URL 单条丢弃
    {
      const wRoot = await mkdtemp(join(tmpdir(), 'whale-wander-'))
      try {
        await ensureDirs(wRoot)
        await ensureBeatDirs(wRoot)
        let calls = 0
        const first = await wander({
          root: wRoot, config: saved, focus: '城市', now: at(12), log: () => {},
          agentTurn: async () => {
            calls += 1
            return calls === 1
              ? '这不是 JSON'
              : '{"items":[{"text":"重试后的素材","url":"https://example.com/retry"}]}'
          },
        })
        assert.equal(calls, 2, '坏 JSON 应该重试一次')
        assert.equal(first.ok, true)
        assert.equal(first.added, 1)
        const bad = await wander({
          root: wRoot, config: saved, focus: '城市', now: at(12, 5), log: () => {},
          agentTurn: async () => '还是不是 JSON',
        })
        assert.equal(bad.ok, false)
        assert.equal(bad.why, 'bad-json')
        const dropped = await wander({
          root: wRoot, config: saved, focus: '城市', now: at(12, 10), log: () => {},
          agentTurn: async () => '{"items":[{"text":"坏链接素材","url":"javascript:alert(1)"}]}',
        })
        assert.equal(dropped.ok, false)
        assert.equal(dropped.why, 'empty')
        assert.equal(dropped.badUrl, 1)
        const detailed = parseWanderDetailed('{"items":[{"text":"新闻一条","url":"https://example.com/news","kind":"news"}]}')
        assert.equal(detailed.items[0].ttlDays, 3)
      } finally {
        await rm(wRoot, { recursive: true, force: true })
      }
    }

    // 8.53 敏感文件解不开：beat 停跳，且不再调模型
    {
      const vRoot = await mkdtemp(join(tmpdir(), 'whale-vault-'))
      try {
        await ensureDirs(vRoot)
        await ensureBeatDirs(vRoot)
        await mkdir(join(vRoot, 'person'), { recursive: true })
        await writeFile(join(vRoot, 'person', 'psych.json'), Buffer.from('这不是 WHLV1 密文'), 'utf8')
        const vCfg = await saveConfig(vRoot, {
          enabled: true, dryRun: true, busyMinutes: 0, tokenSaverIdleMinutes: 100000,
          quietHours: { start: '01:00', end: '08:00' }, interests: ['城市'],
        })
        let calls = 0
        const r = await runOnce({
          root: vRoot, config: vCfg, now: at(12), dryRun: true,
          turn: async () => { calls += 1; return '{"items":[]}' },
        })
        assert.equal(r.skipped, 'vault-error')
        assert.equal(r.gate.reason, 'vault_error')
        assert.equal(calls, 0)
      } finally {
        await rm(vRoot, { recursive: true, force: true })
      }
    }

    // 8.55 派生画像：从分片重建，素材不参与
    {
      const ps = emptyScope('private', '1')
      addItem(ps, { text: '以后别用 emoji', kind: 'pref', conf: 0.9, source: 'test' })
      addItem(ps, { text: '喜欢高数', kind: 'pref', conf: 0.8, source: 'test' })
      addItem(ps, { text: '正在改记忆插件', kind: 'topic', goal: '把记忆插件改好', conf: 0.7, source: 'test' })
      await saveScope(root, ps)
      const prof = await rebuildProfile(root, { now: at(12) })
      assert.ok(prof.partitions.interest.length >= 1)
      assert.ok(prof.partitions.projects.length >= 1)
      assert.ok(prof.partitions.comm.length >= 1)
      assert.ok(prof.partitions.comm.every((e) => e.evidenceIds.length > 0))
      assert.ok(profileInterests(prof).length >= 1)
      await rm(profilePath(root), { force: true })
      const rebuilt = await loadProfile(root)
      assert.equal(rebuilt.builtFrom.items >= 3, true)
    }

    // 8.6 心事匣 / 心理画像 / 加密路径绑定 / 焚毁
    {
      await writeNotepad(root, '上次没说完的那句', { now: at(12) })
      assert.equal((await readNotepad(root)).text, '上次没说完的那句')
      const np = await readNotepad(root)
      const kept = await clearNotepadIf(root, { text: np.text, at: at(13).toISOString() })
      assert.equal(kept.kept, true, '时间戳对不上时不能清掉并发改写')
      const cleared = await clearNotepadIf(root, np)
      assert.equal(cleared.ok, true)
      assert.equal((await readNotepad(root)).text, '')

      assert.deepEqual(extractPsychStatements('今天好累，不过还行。'), ['今天好累，不过还行'])
      const cap = await capturePsych(root, [{ text: '最近压力好大，睡不着', at: at(12).toISOString() }])
      assert.ok(cap.added >= 1)
      assert.ok((await readPsych(root)).entries.some((e) => /压力|睡不着/.test(e.text)))
      await writePsych(root, { entries: [{ text: '最近有点累' }] }, { now: at(12) })
      assert.equal((await readPsych(root)).entries.length, 1)
      assert.equal((await checkSensitiveHealth(root)).ok, true)

      const sf = join(root, 'secure', 'move-me.enc')
      await writeEncrypted(root, sf, '路径绑定的密文')
      assert.equal(await readEncrypted(root, sf), '路径绑定的密文')
      const moved = join(root, 'secure', 'moved.enc')
      await writeFile(moved, await readFile(sf))
      await assert.rejects(() => readEncrypted(root, moved), '密文挪到别的文件就该解不开')
      const raw = await readFile(sf)
      await assert.rejects(() => decryptText(root, raw), '带 AAD 的密文不能按旧方式解')
      assert.equal(await encryptText(root, 'x') instanceof Buffer, true)

      await writeNotepad(root, '焚毁前再写一格', { now: at(12) })
      assert.equal((await loadMaterial(root)).items.length > 0, true)
      const removed = await burnSensitive(root, { key: false })
      assert.ok(removed.some((x) => x.endsWith('notepad.enc')))
      assert.equal((await readNotepad(root)).text, '')
      assert.equal((await readPsych(root)).entries.length, 0)
      assert.equal((await loadMaterial(root)).items.length > 0, true)
      assert.equal((await import('node:fs')).existsSync(keyPath(root)), true)
      await burnSensitive(root, { key: true })
      assert.equal((await import('node:fs')).existsSync(keyPath(root)), false)
    }

    // 9. 素材包与候选混合
    const pack = buildPack({
      deliveryId: 'd-test',
      materials: [{ id: 'm1', source: 'chat', text: '聊过的事' }],
      notepad: '上次没说完的那句',
    })
    assert.ok(pack.includes('d-test'))
    assert.ok(pack.includes('上次没说完的那句'))
    assert.ok(pack.includes('material_report'), '素材包必须要求报账')
    assert.ok(pack.includes('deliveryId=d-test'))
    const ctxPack = buildPack({
      deliveryId: 'd-ctx',
      materials: [{ id: 'm2', source: 'chat', text: '以后跟我吧', context: '你要不要换新会话？' }],
    })
    assert.ok(ctxPack.includes('上文：你要不要换新会话？'), '会话素材要带上文')
    const fullPack = buildPack({
      deliveryId: 'd-full',
      materials: [{ id: 'm3', source: 'public', text: '前半句…', quote: '前半句，后半句在这。', refs: [] }],
    })
    assert.ok(fullPack.includes('后半句在这'), '旧素材的半句应换成完整原话')
    const mixed = mixCandidates({ chat: [{ id: 'c1' }], fresh: [{ id: 'w1' }, { id: 'w2' }] })
    assert.equal(mixed[0].id, 'c1')
    assert.ok(mixed.length <= 3)
    const bigPack = buildPack({
      deliveryId: 'd-big',
      materials: Array.from({ length: 6 }, (_, i) => ({ id: 'm' + i, source: 'web:city', text: '长'.repeat(200), refs: ['https://example.com/' + i] })),
      notepad: '心事'.repeat(80),
    })
    assert.ok(estimatePackTokens(bigPack) <= 400, '素材包超 400 token')

    // 9.5 搜索模型直连 prompt / 投递目标绑定
    assert.ok(wanderPrompt('城市', '最近', 4).includes('web_search'))
    const directPrompt = wanderPrompt('城市', '最近', 4, { direct: true })
    assert.ok(directPrompt.includes('联网'))
    assert.ok(!directPrompt.includes('web_search'), '直连模型没有工具，别再让它调用 web_search')
    assert.equal(ownerTarget({}).ok, false, '没绑目标就不投')
    assert.equal(ownerTarget({}).why, 'no-target')
    assert.equal(ownerTarget({ targetSessionId: 'session-pinned' }).sessionId, 'session-pinned')
    assert.equal(ownerTarget({ targetSessionId: 'session-pinned' }).pinned, true)

    // 9.6 目标会话正被别的写句柄占着：优先用活 agent / 宿主唤醒，不硬 resume
    {
      const dRoot = await mkdtemp(join(tmpdir(), 'whale-deliver-'))
      try {
        let resumed = 0
        const sent = []
        const live = { followup: (msg) => sent.push(msg) }
        const r1 = await deliver({
          ctx: { agents: { get: (id) => (id === 'session-live' ? live : undefined), resume: async () => { resumed += 1; return { agent: live } } } },
          root: dRoot, config: { targetSessionId: 'session-live' },
          materials: [{ id: 'm1', source: 'chat', text: '聊过的事' }], now: at(12), dryRun: false,
        })
        assert.equal(r1.delivered, true)
        assert.equal(resumed, 0, '有活 agent 就不该 resume')
        assert.equal(sent.length, 1)

        const woken = []
        const ctlAgent = { followup: (msg) => woken.push(msg) }
        const r2 = await deliver({
          ctx: {
            get: (name) => {
              if (name === 'sessionController') return { resolveAgent: async () => ({ agent: ctlAgent }) }
              if (name === 'agents') return { get: () => undefined, resume: async () => { throw new Error('不该走到 resume') } }
              return undefined
            },
          },
          root: dRoot, config: { targetSessionId: 'session-awake' },
          materials: [{ id: 'm2', source: 'web', text: '冷知识', refs: ['https://example.com/a'] }], now: at(12), dryRun: false,
        })
        assert.equal(r2.delivered, true)
        assert.equal(woken.length, 1)
        assert.ok(woken[0].content[0].text.includes('d-'), '唤醒后照样发素材包')
      } finally {
        await rm(dRoot, { recursive: true, force: true })
      }
    }

    // 9.61 写句柄冲突：算“稍后再试”，不能记成当天失败
    {
      const bRoot = await mkdtemp(join(tmpdir(), 'whale-busy-'))
      try {
        await ensureDirs(bRoot)
        await ensureBeatDirs(bRoot)
        const sc = emptyScope('public', 'web')
        addItem(sc, { text: '被占用时的一条素材', kind: 'fact', conf: 0.5, source: 'test' })
        sc.items[0].weight = 0.6
        sc.items[0].observedAt = at(12).toISOString()
        await saveScope(bRoot, sc)
        await saveConfig(bRoot, {
          enabled: true, dryRun: false, refillBelow: 1, minIntervalHours: 4,
          quietHours: { start: '01:00', end: '08:00' },
          windows: [{ start: '11:00', end: '15:00' }],
          targetSessionId: 'session-busy',
        })
        await saveState(bRoot, { lastWanderAt: at(12).toISOString() })
        const cfg2 = await loadConfig(bRoot, { reload: true })
        const busy = Object.assign(new Error('session "session-busy" is already owned by an active write handle'), {
          name: 'SessionAlreadyOwnedError',
        })
        const r = await runOnce({
          ctx: { agents: { get: () => undefined, resume: async () => { throw busy } } },
          root: bRoot, config: cfg2, now: at(12), log: () => {},
        })
        assert.equal(r.delivery.why, 'target-busy')
        const st = await loadState(bRoot)
        assert.equal(st.deliveryFailed, null, '写句柄冲突不该封一整天')
        assert.ok(Date.parse(st.deliveryBackoffUntil) > at(12).getTime(), '应该进十分钟降频窗')
        const ledger = (await readFile(deliveriesPath(bRoot), 'utf8')).trim().split('\n').map((x) => JSON.parse(x))
        assert.equal(ledger.at(-1).outcome, 'busy')
      } finally {
        await rm(bRoot, { recursive: true, force: true })
      }
    }

    // 10. 反馈闭环：投递打标 → 用户回复 → 加减分 / 拒绝退役 / 未报账
    {
      const fbRoot = await mkdtemp(join(tmpdir(), 'whale-fb-'))
      try {
        await ensureDirs(fbRoot)
        await ensureBeatDirs(fbRoot)
        const cfgFb = await saveConfig(fbRoot, { enabled: true, dryRun: false })
        const one = await addMaterial(fbRoot, {
          text: '周末有通宵书店', source: 'web', refs: ['https://example.com/book'],
          focus: '书店', tags: ['书店', '通宵'], conf: 0.4,
        }, { config: cfgFb, now: at(12) })
        assert.ok(one.item?.id)

        await noteDelivery(fbRoot, {
          deliveryId: 'd-fb1', at: at(12), sessionId: 's1', materials: [one.item],
        })
        const before = (await loadMaterial(fbRoot)).items.find((x) => x.id === one.item.id).boost
        const r1 = await noteUserMessage(fbRoot, {
          sessionId: 's1', text: '那家书店后来怎么样了？', at: at(12, 5),
        })
        assert.equal(r1.acted, true)
        const after = (await loadMaterial(fbRoot)).items.find((x) => x.id === one.item.id).boost
        assert.ok(after > before, '追问应该给素材加分')

        const fbLines = (await readFile(join(fbRoot, 'beat', 'feedback.jsonl'), 'utf8'))
          .split('\n').filter(Boolean).map((x) => JSON.parse(x))
        const reply = fbLines.find((x) => x.source === 'reply')
        assert.ok(reply)
        assert.equal(reply.materialId, one.item.id)
        assert.ok(reply.replyHash)
        assert.equal('text' in reply, false, 'feedback 不能存回复原文')

        // 报账：精确给 usedIds 加分
        const repItem = await addMaterial(fbRoot, {
          text: '报账专用的素材', source: 'web', refs: ['https://example.com/report'],
          focus: '报账', conf: 0.4,
        }, { config: cfgFb, now: at(12) })
        const beforeReport = (await loadMaterial(fbRoot)).items.find((x) => x.id === repItem.item.id).boost
        const rep = await applyReport(fbRoot, { deliveryId: 'd-fb2', usedIds: [repItem.item.id], mode: 'quote', at: at(12, 10) })
        assert.equal(rep.adjusted, 1)
        const afterReport = (await loadMaterial(fbRoot)).items.find((x) => x.id === repItem.item.id).boost
        assert.ok(afterReport > beforeReport)
        const fb2 = (await readFile(join(fbRoot, 'beat', 'feedback.jsonl'), 'utf8'))
          .split('\n').filter(Boolean).map((x) => JSON.parse(x))
        assert.ok(fb2.some((x) => x.source === 'report' && x.mode === 'quote'))

        // 明确拒绝：素材退役
        const two = await addMaterial(fbRoot, {
          text: '另一条会让人烦的新闻', source: 'web', refs: ['https://example.com/noise'],
          focus: '新闻', conf: 0.4,
        }, { config: cfgFb, now: at(12) })
        await noteDelivery(fbRoot, {
          deliveryId: 'd-fb3', at: at(12), sessionId: 's1', materials: [two.item],
        })
        await noteUserMessage(fbRoot, { sessionId: 's1', text: '别发这个，烦不烦', at: at(12, 1) })
        assert.equal((await loadMaterial(fbRoot)).items.find((x) => x.id === two.item.id).state, 'retired')

        // 未报账：24h 后轻微降权
        const three = await addMaterial(fbRoot, {
          text: '没人理的第三条', source: 'web', refs: ['https://example.com/three'],
          focus: '测试', conf: 0.4,
        }, { config: cfgFb, now: at(12) })
        await noteDelivery(fbRoot, {
          deliveryId: 'd-fb4', at: at(10), sessionId: 's1', materials: [three.item],
        })
        assert.equal((await settleUnreported(fbRoot, { now: at(12) })).settled, 0)
        await settleUnreported(fbRoot, { now: new Date(at(12).getTime() + 25 * 3600000) })
        assert.ok((await loadMaterial(fbRoot)).items.find((x) => x.id === three.item.id).boost < 0)

        // 连续 3 次 none：下一轮投递降频
        await applyReport(fbRoot, { deliveryId: 'd-n1', usedIds: [], mode: 'none', at: at(12) })
        await applyReport(fbRoot, { deliveryId: 'd-n2', usedIds: [], mode: 'none', at: at(12) })
        await applyReport(fbRoot, { deliveryId: 'd-n3', usedIds: [], mode: 'none', at: at(12) })
        const stFb = await loadState(fbRoot)
        assert.ok(stFb.deliveryBackoffUntil, '连续三次 none 应该拉长投递间隔')
      } finally {
        await rm(fbRoot, { recursive: true, force: true })
      }
    }

    // 10.5 投递后的第一条真实回复打 reply_to；蒸馏与心理画像都不收它
    {
      const iRoot = await mkdtemp(join(tmpdir(), 'whale-ingest-'))
      const oldCfg = process.env.DSH_QQ_BRIDGE_CONFIG
      const cfgFile = join(iRoot, 'qq-bridge-config.json')
      try {
        await ensureDirs(iRoot)
        await ensureBeatDirs(iRoot)
        await saveConfig(iRoot, { enabled: true, dryRun: true })
        await writeFile(cfgFile, JSON.stringify({
          绑定: [{ 类型: '私聊', 号码: '123456789', 会话: 'sess-reply', 称呼: '老爹' }],
        }), 'utf8')
        process.env.DSH_QQ_BRIDGE_CONFIG = cfgFile
        resetSourceCache()

        const sid = 'sess-reply'
        const staging = join(paths(iRoot).staging, `${sid}.jsonl`)
        // ingest 用真实时钟，这里的投递/回复时间也得贴着现在，不能写死日期
        const userAt = new Date(Date.now() - 5 * 60000)
        const pendingAt = new Date(Date.now() - 2 * 60000)
        const herAt = new Date(Date.now() - 60000)
        await writeFile(staging, [
          { at: userAt.toISOString(), role: 'user', speaker: '老爹', text: '最近压力好大，睡不着' },
          { at: herAt.toISOString(), role: 'her', text: '怎么又熬夜' },
        ].map((x) => JSON.stringify(x)).join('\n') + '\n', 'utf8')
        const st = await loadState(iRoot)
        st.pendingDelivery = {
          deliveryId: 'd-reply', at: pendingAt.toISOString(), sessionId: sid, materialIds: [], focus: '', tags: [],
        }
        await saveState(iRoot, st)

        let handler = null
        registerIngest({ on: (name, fn) => { handler = fn; return () => {} } }, { root: iRoot, log: () => {} })
        assert.equal(typeof handler, 'function')
        handler({ header: { id: sid, cwd: 'D:/Workspace' } }, {
          type: 'user/message',
          data: { content: '记住：以后都用 Chrome' },
        })
        await flush()

        const lines = (await readFile(staging, 'utf8')).split('\n').filter(Boolean).map((x) => JSON.parse(x))
        const last = lines[lines.length - 1]
        assert.equal(last.role, 'user')
        assert.equal(last.reply_to, 'd-reply')
        assert.equal((await loadState(iRoot)).pendingDelivery, null)

        await distillSession(iRoot, sid, { log: () => {} })
        const sc = await loadScope(iRoot, 'private', '123456789')
        assert.ok(sc.items.every((x) => !String(x.text).includes('Chrome')), 'reply_to 消息不该进记忆')
        const psych = await readPsych(iRoot)
        assert.ok(psych.entries.some((e) => /压力|睡不着/.test(e.text)), '心理自述应加密入库')
      } finally {
        if (oldCfg === undefined) delete process.env.DSH_QQ_BRIDGE_CONFIG
        else process.env.DSH_QQ_BRIDGE_CONFIG = oldCfg
        resetSourceCache()
        await rm(iRoot, { recursive: true, force: true })
      }
    }

    // 11. 闸门：当天失败不重试 / 降频窗
    {
      const g1 = checkGate({
        now: at(12), config: base, counts: { active: 3 },
        state: { daily: { day: dayKey(at(12)), sent: 0 }, deliveryFailed: { day: dayKey(at(12)), why: 'no-target' } },
      })
      assert.equal(g1.reason, 'delivery_failed')
      const g2 = checkGate({
        now: at(12), config: base, counts: { active: 3 },
        state: { daily: { day: dayKey(at(12)), sent: 0 }, deliveryBackoffUntil: at(13).toISOString() },
      })
      assert.equal(g2.reason, 'backoff')
    }

    // 12. 调度器：heartbeat 已挂载 / 环境变量一键停
    {
      const home = await mkdtemp(join(tmpdir(), 'whale-home-'))
      const oldHome = process.env.DSH_HOME
      const oldOff = process.env.DSH_MEMORY_BEAT
      try {
        await mkdir(join(home, 'profiles', 'desktop'), { recursive: true })
        await writeFile(join(home, 'profiles', 'desktop', 'package.json'), JSON.stringify({
          dsh: { profile: { bundles: ['dsh-heartbeat'] } },
        }), 'utf8')
        process.env.DSH_HOME = home
        delete process.env.DSH_MEMORY_BEAT
        assert.equal(schedulerState({ config: { enabled: true } }).active, 'heartbeat')
        process.env.DSH_MEMORY_BEAT = 'off'
        assert.equal(schedulerState({ config: { enabled: true } }).envOff, true)
        assert.equal(schedulerState({ config: { enabled: true } }).active, 'off')

        // 真正拉起 startBeat：环境变量优先于 config.enabled，且不起定时器
        const runRoot = await mkdtemp(join(tmpdir(), 'whale-off-'))
        try {
          await ensureDirs(runRoot)
          await ensureBeatDirs(runRoot)
          await saveConfig(runRoot, { enabled: true, dryRun: true })
          const b = startBeat(null, { root: runRoot, log: () => {} })
          await new Promise((r) => setTimeout(r, 60))
          const st = await b.status()
          assert.equal(st.disabled, 'env-off')
          b.dispose()
        } finally {
          await rm(runRoot, { recursive: true, force: true })
        }
      } finally {
        if (oldHome === undefined) delete process.env.DSH_HOME
        else process.env.DSH_HOME = oldHome
        if (oldOff === undefined) delete process.env.DSH_MEMORY_BEAT
        else process.env.DSH_MEMORY_BEAT = oldOff
        await rm(home, { recursive: true, force: true })
      }
    }

    // 13. 会话轮转会释放旧 agent
    {
      const sRoot = await mkdtemp(join(tmpdir(), 'whale-sess-'))
      try {
        await ensureBeatDirs(sRoot)
        await saveSessions(sRoot, {
          sessionId: 's-old', createdAt: at(1).toISOString(), lastUsedAt: at(1).toISOString(), rotates: 0,
        })
        let released = ''
        const agents = {
          get: (id) => ({ agent: { session: { id }, dispose: () => { released = id } } }),
        }
        await rotateBeatSession(sRoot, () => {}, { agents })
        assert.equal(released, 's-old')
        assert.equal((await loadSessions(sRoot)).sessionId, '')
      } finally {
        await rm(sRoot, { recursive: true, force: true })
      }
    }

    // 14. 素材 boost 会进排序分
    {
      const item = { text: 'x', source: 'chat', conf: 0.5, ttlDays: 7, at: at(12).toISOString(), usedCount: 0, boost: 0 }
      const s0 = scoreOf(item, at(12).getTime())
      const s1 = scoreOf({ ...item, boost: 0.2 }, at(12).getTime())
      assert.ok(s1 > s0)
    }

    // 15. 闲逛结果读取：宿主事件正文在 data.message.content，不在 data.content
    {
      const asst = {
        type: 'assistant/message',
        seq: 11,
        data: {
          message: {
            content: [
              { type: 'reasoning', text: '想一下' },
              { type: 'text', text: '{"items":[{"text":"一条素材","url":"https://example.com/x"}]}' },
            ],
          },
        },
      }
      assert.equal(
        textOfEvent(asst),
        '{"items":[{"text":"一条素材","url":"https://example.com/x"}]}',
      )
      assert.equal(textOfEvent({ type: 'assistant', data: { content: '旧版正文' } }), '旧版正文')
      assert.equal(textOfEvent({ type: 'assistant', content: [{ type: 'text', text: '更旧' }] }), '更旧')

      const events = [
        { type: 'assistant/message', seq: 2, data: { message: { content: [{ type: 'text', text: '上一轮' }] } } },
        { type: 'tool/result', seq: 9 },
        asst,
      ]
      assert.equal(lastAssistantText(events, { seq: 5 }), '{"items":[{"text":"一条素材","url":"https://example.com/x"}]}')
      assert.equal(lastAssistantText(events, { seq: 12 }), '')
      // 没有 seq 的旧宿主退回索引判断
      const old = [
        { type: 'assistant', data: { content: '旧一轮' } },
        { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '新一轮' }] } } },
      ]
      assert.equal(lastAssistantText(old, { index: 1 }), '新一轮')
      // 有 seq 但没传 seq 时，不能把 index 当 seq 用
      assert.equal(lastAssistantText(events, { index: 2 }), '{"items":[{"text":"一条素材","url":"https://example.com/x"}]}')

      // snapshotEvents 优先于 session.events，seq 用于计数
      const session = {
        seq: 7,
        events: [{ type: 'assistant', data: { content: 'stale' } }],
        snapshotEvents: () => events,
      }
      assert.equal(sessionEvents(session), events)
      assert.equal(sessionEventCount(session), 7)
      assert.equal(sessionEventCount({ events: [1, 2, 3] }), 3)
    }

    console.log('beat ok')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
