    function 总览页({ 态, 观察, 图, 体检 }) {
      const c = (态 && 态.counts) || {}
      const 构建 = (态 && 态.build) || null
      const 版本标签 = (态 && 态.label) || `v${(态 && 态.version) || '?'}`
      const scopes = (态 && 态.scopes) || []
      const 活跃 = scopes.reduce((n, s) => n + (s.active || 0), 0)
      const 待确认 = scopes.reduce((n, s) => n + (s.suggested || 0), 0)
      const 归档 = scopes.reduce((n, s) => n + (s.archived || 0), 0)
      const p = (观察 && 观察.persona) || {}
      const 信任 = (观察 && 观察.trust) || {}
      const 体检数 = (体检 && 体检.totals) || {}
      const 体检行 = []
      if (体检 && 体检.ok) {
        for (const row of 体检.scopes || []) {
          for (const it of row.issues || []) 体检行.push({ row, it })
        }
      }
      const 等级色 = (level) => level === 'error' ? 'wm-badgeDanger' : level === 'warn' ? 'wm-badgeWarn' : 'wm-badgeInfo'
      // 情绪：只读展示（文档 14.9）。数值不进面板，只给最近的分量和档位。
      const 情绪 = (态 && 态.affect) || null
      const 档 = ['', '（轻）', '（中）', '（明显）']
      const 情绪名 = 情绪 && 情绪.mood && 情绪.mood.length
        ? `${情绪.mood[0].name}${档[情绪.mood[0].bucket] || ''}`
        : '平常'
      const 情绪说明 = 情绪
        ? (情绪.mood || []).slice(0, 3).map((m) => `${m.name}${档[m.bucket] || ''}`).join(' · ') || '没什么起伏'
        : '情绪层没开'
      return h('div', { className: 'wm-body' },
        h('div', { className: 'wm-grid wm-tiles' },
          WD.格('分片', String(c.scopes ?? 0), '私聊 / 群 / 本机 各自隔离'),
          WD.格('记忆条数', String(c.items ?? 0), `可用 ${活跃} · 待确认 ${待确认} · 归档 ${归档}`, 'wm-tileAccent'),
          WD.格('实体', 图 ? `${(图.nodes || []).length} 个` : '—', 图 ? `${(图.edges || []).length} 条关系` : '图谱还没建'),
          WD.格('人格', p.exists ? `v${p.version || 0}` : '缺 persona.md', p.exists ? `${p.tokens || 0}/${p.limit || 1200} tok · ${p.budget?.mode === 'auto' ? '自动额度' : '固定额度'}${p.overBudget ? ' · 超预算' : ''}` : '固定人格没挂上'),
          WD.格('信任', 信任.origin || '—', 信任.usable ? '读写正常' : '未信任，采集停用'),
          WD.格('心情', 情绪名, 情绪说明),
          WD.格('版本', 版本标签, 构建 && 构建.commit
            ? `${构建.branch || '?'} · ${时间(构建.builtAt) || '构建时间未知'}${构建.dirty ? ' · 打包时有未提交改动' : ''}`
            : '库路径见下'),
        ),
        h('div', { className: 'wm-cols' },
        WD.卡('体检',
          !体检
            ? WD.提('还没跑')
            : !体检.ok
              ? WD.提(体检.why || '体检没跑成')
              : h('div', null,
                WD.提(`错误 ${体检数.errors || 0} · 提醒 ${体检数.warnings || 0} · 重复 ${体检数.duplicates || 0} 组 · 长期未用 ${体检数.stale || 0} 条`),
                体检行.length
                  ? h('div', { style: { marginTop: 8 } },
                    体检行.slice(0, 8).map(({ row, it }, i) =>
                      h('div', { key: row.scope + it.id + i, className: 'wm-listRow' },
                        h('div', { style: { display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' } },
                          WD.徽(it.level === 'error' ? '错误' : it.level === 'warn' ? '提醒' : '顺手', 等级色(it.level)),
                          h('span', { style: { flex: 1 } }, `${row.label || row.scope}：${it.text}`),
                        ),
                        it.fix ? h('div', { className: 'wm-hint' }, it.fix) : null,
                      ),
                    ),
                  )
                  : null,
                (体检.advice || []).length ? WD.提(体检.advice.join('；')) : null,
              ),
          WD.徽(体检 && 体检.ok ? (体检.healthy ? '健康' : `${(体检数.errors || 0) + (体检数.warnings || 0)} 项`) : '—', 体检 && 体检.ok && !体检.healthy ? 'wm-badgeWarn' : 'wm-badgeInfo'),
        ),
        WD.卡('分片',
          scopes.length
            ? h('div', null,
              scopes.map((sc) =>
                h('div', { key: sc.scope, className: 'wm-listRow' },
                  h('div', { style: { display: 'flex', gap: 8, alignItems: 'baseline' } },
                    h('span', { style: { flex: 1 } }, sc.label),
                    h('span', { className: 'wm-hint' }, `${sc.total} 条 · 可用 ${sc.active}`),
                  ),
                  h('div', { className: 'wm-bar' },
                    h('div', {
                      className: 'wm-barFill',
                      style: { width: Math.round((sc.total ? sc.active / sc.total : 0) * 100) + '%' },
                    }),
                  ),
                ),
              ),
            )
            : WD.提('还没有分片。'),
          WD.徽(`${scopes.length} 个`, 'wm-badgeInfo'),
        ),
        ),
        h('details', { className: 'wm-fold' },
          h('summary', null, '库位置与规则'),
          h('div', { style: { marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 } },
            WD.提('库路径：' + String((态 && 态.root) || '?')),
            WD.提('人格来自 persona.md（固定，不衰减）；记忆按分片隔离，私聊、群、本地会话互不串；' +
              '长期不碰的条目会变冷、再久会归档，归档的不再进提示词。'),
          ),
        ),
      )
    }

    /** 人格预算卡：fixed 固定额度 / auto 按「上下文窗口 × 占比」自动算，都钳在 600–2400。 */
    function 人格预算卡({ p, 刷新 }) {
      const cfg = (p && p.budgetConfig) || { mode: 'fixed', tokens: 1200, window: 0, share: 0 }
      const b = (p && p.budget) || null
      const [表单, 设表单] = React.useState(() => ({
        mode: cfg.mode === 'auto' ? 'auto' : 'fixed',
        tokens: String(cfg.tokens ?? 1200),
        window: cfg.window ? String(cfg.window) : '',
        share: cfg.share > 0 ? String(+(cfg.share * 100).toFixed(3)) : '1',
      }))
      const [忙, 设忙] = React.useState(false)
      const [结果, 设结果] = React.useState(null)
      const 改 = (k, v) => 设表单((f) => Object.assign({}, f, { [k]: v }))
      const 输入 = (k, 标签, 提示, 类型) =>
        h('label', { key: k, className: 'wm-field', style: { marginTop: 8 } },
          h('span', { className: 'wm-hint' }, 标签),
          h('input', {
            type: 类型 || 'number',
            value: 表单[k],
            placeholder: 提示,
            min: 0,
            className: 'wm-input',
            onChange: (e) => 改(k, e.target.value),
          }),
        )
      const 保存 = async () => {
        设忙(true)
        设结果(null)
        const r = await post('/persona/budget', {
          mode: 表单.mode,
          tokens: 表单.tokens === '' ? null : Number(表单.tokens),
          window: 表单.window === '' ? null : Number(表单.window),
          // 界面填百分数，接口存小数
          share: 表单.share === '' ? null : Number(表单.share) / 100,
        })
        设忙(false)
        if (!r || !r.ok) {
          设结果({ ok: false, text: (r && r.why) || '保存失败' })
          return
        }
        设结果({ ok: true, text: `已生效：${r.budget.limit} tok（${r.budget.mode === 'auto' ? `自动 ${r.budget.window} × ${(r.budget.share * 100).toFixed(2)}%` : '固定'}${r.budget.why ? `；${r.budget.why}` : ''}）` })
        if (刷新) 刷新(true)
      }
      const 来源 = b ? ({ settings: '设置页', env: '环境变量', default: '默认值' }[b.source] || b.source) : ''
      return WD.卡('人格预算',
        h('div', null,
          b
            ? WD.提(`当前生效上限 ${b.limit} tok · ${b.mode === 'auto' ? `自动（窗口 ${b.window} × ${(b.share * 100).toFixed(2)}%）` : `固定 ${b.tokens} tok`} · 来源 ${来源}`)
            : WD.提('还没读到预算状态；下面保存一次就会生效。'),
          b && b.why ? WD.提(`注意：${b.why}`) : null,
          h('details', { className: 'wm-fold', style: { marginTop: 8 } },
            h('summary', null, '调整上限'),
            h('div', { style: { marginTop: 8 } },
              h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
                h('button', {
                  className: 'wm-btn' + (表单.mode === 'fixed' ? ' wm-btnPrimary' : ''),
                  onClick: () => 改('mode', 'fixed'),
                }, '固定额度'),
                h('button', {
                  className: 'wm-btn' + (表单.mode === 'auto' ? ' wm-btnPrimary' : ''),
                  onClick: () => 改('mode', 'auto'),
                }, '按上下文窗口自动'),
              ),
              表单.mode === 'fixed'
                ? 输入('tokens', '固定额度（tok，600–2400）', '1200')
                : h('div', null,
                  输入('window', '上下文窗口（tok，模型能带多少上下文）', '128000'),
                  输入('share', '人格占比（%，0.1–20）', '1'),
                  WD.提('自动额度 ＝ 窗口 × 占比，再钳到 600–2400 tok。不知道窗口就填模型文档里的上下文长度；填错了会先回退固定额度并提示原因。'),
                ),
              h('div', { className: 'wm-saveBar', style: { marginTop: 12 } },
                h('button', { className: 'wm-btn wm-btnPrimary', disabled: 忙, onClick: 保存 }, 忙 ? '保存中…' : '保存预算'),
                WD.徽(b ? `${b.limit} tok` : '—', 'wm-badgeInfo'),
                b && b.headroom < 30 ? WD.徽('额度紧张', 'wm-badgeWarn', true) : null,
              ),
              结果 ? h('div', { className: 'wm-notice ' + (结果.ok ? 'wm-good' : 'wm-bad') }, 结果.text) : null,
              WD.提('只控制 persona.md 能写多长（每次会话都会注入）；改完下一轮迭代、体检和保存提案就按新上限算，不用重启 DSH。'),
            ),
          ),
        ),
        b ? WD.徽(b.mode === 'auto' ? '自动' : '固定', 'wm-badgeInfo') : null,
      )
    }

    function 运行页({ 观察, 刷新 }) {
      const o = 观察 || {}
      const p = o.persona || {}
      const t = o.trust || {}
      const rd = o.reads || {}
      const 行 = (k, v) => WD.行(k, v, k)
      const 迭代 = (p.recentRuns || [])[0] || null
      const 提案 = p.proposal || null
      const 提案条数 = (提案 && 提案.additions ? 提案.additions.length : 0)
      const 替换条数 = (提案 && 提案.replacements ? 提案.replacements.length : 0)
      const 压缩条数 = (提案 && 提案.compressions ? 提案.compressions.length : 0)
      // status 里的是实时审视，优先用；提案里的只是那一轮的历史快照
      const 审视 = p.audit || (提案 && 提案.audit) || []
      const 预算 = p.budget || (提案 && 提案.budget) || null
      // 提案卡片讲的是「这一轮按什么口径算的」，有提案快照就先用快照，别拿实时值硬拼
      const 提案预算 = (提案 && 提案.budget) || 预算
      const 变更 = (p.lastApplied && p.lastApplied.rules) || []
      const 换过的 = (p.lastApplied && p.lastApplied.replaced) || []
      const 压过的 = (p.lastApplied && p.lastApplied.compressed) || []
      const 审视名 = { verbose: '偏长', example: '示例', redundant: '疑似重复', keep: '精简' }
      const 审视计数 = (f) => 审视.filter((r) => r.flag === f).length
      const 采样名 = {
        length: '长短不合', command: '命令/日志/代码', secret: '含凭据', style: '不是说「怎么说」的话',
      }
      const 采样明细 = (obj) => {
        const rows = Object.entries(obj || {}).filter(([, n]) => n > 0)
        return rows.length ? rows.map(([k, n]) => `${采样名[k] || k} ${n}`).join(' · ') : ''
      }
      const 阶段名 = {
        sample: '采样门', generator: '生成', blacklist: '30 天黑名单',
        dedupe: '去重', review: '确定性审查', 'review-llm': '审查模型',
        triage: '模型分类', compact: '压缩旧规矩', replace: '替换旧说法', accepted: '通过',
      }
      const 预算来源 = (b) => b
        ? ({ settings: '设置页', env: '环境变量', default: '默认值' }[b.source] || b.source || '默认值')
        : '默认值'
      const 提案改动数 = 提案条数 + 替换条数 + 压缩条数
      const 提案有内容 = Boolean(提案 && 提案改动数)
      const 迭代徽 = !p.auto
        ? { text: '已关闭', cls: 'wm-badgeOff' }
        : 提案有内容
          ? { text: '待确认', cls: 'wm-badgeWarn' }
          : 提案
            ? { text: '提案为空', cls: 'wm-badgeOff' }
            : { text: '等条件', cls: 'wm-badgeInfo' }
      const 迭代结论 = !p.auto
        ? '人格自动迭代没开。'
        : 提案有内容
          ? `有一份提案等你确认：新增 ${提案条数} · 替换 ${替换条数} · 压缩 ${压缩条数}。`
          : 提案
            ? '刚跑过一轮：没有新候选，旧人设也没有可整理的地方。'
            : `还没出提案：${p.auto.waitReason || '等条件满足'}`
      const 迭代下一步 = 提案有内容
        ? '确认后才会写入：DSH 关闭时在插件目录跑 node tools/persona.mjs apply --approve。'
        : !p.auto
          ? '手动流程：node tools/persona.mjs propose，看过提案再 apply --approve。'
          : `自动条件：累计 ≥${p.auto.minMessages || 100} 条新消息 · 距上次 ≥24h · ≥20 条有效样本。出提案不会直接改人格。`
      const 提案明细 = 提案
        ? h('div', { style: { marginTop: 8 } },
          WD.提(`生成于 ${时间(提案.at)} · 生成 ${提案.generator || '?'} · 审查 ${提案.reviewer || '?'} · 样本 ${(提案.samples && 提案.samples.count) || 0} 条`),
          提案预算
            ? WD.提(`本轮上限 ${提案预算.limit} tok · ${提案预算.mode === 'auto' ? '自动' : '固定'} · 来源 ${预算来源(提案预算)}；写入时按整理后的 ${提案预算.basis ?? 提案预算.tokens} tok 审查`)
            : null,
          (() => {
            const 分类 = (提案 && 提案.triage) || []
            const 汇总 = (提案 && 提案.triageSummary) || null
            if (!分类.length && !汇总) return null
            const 动作名 = { keep: '必须保留', shorten: '可缩短', replace: '可替换' }
            const 动作色 = { keep: 'wm-badgeInfo', shorten: 'wm-badgeWarn', replace: 'wm-badgeWarn' }
            const 摘要 = 汇总
              ? 汇总.returned
                ? `必须保留 ${汇总.keep} · 可缩短 ${汇总.shorten} · 可替换 ${汇总.replace}${汇总.invalid ? ` · 校验未过 ${汇总.invalid}` : ''} / 共 ${汇总.lines} 行`
                : '模型没返回，这轮只用规则整理'
              : '逐行分类'
            return h('details', { style: { marginTop: 6 } },
              h('summary', { className: 'wm-hint', style: { cursor: 'pointer' } }, `模型逐行分类（${摘要}）`),
              h('div', { style: { marginTop: 4 } },
                WD.提('必须保留的行这轮不压缩也不替换，下一轮重新判。'),
                ['keep', 'shorten', 'replace'].map((action) => {
                  const rows = 分类.filter((x) => x.action === action)
                  if (!rows.length) return null
                  return h('div', { key: action, style: { marginTop: 5 } },
                    WD.徽(`${动作名[action]} ${rows.length}`, 动作色[action]),
                    rows.slice(0, 6).map((x, i) =>
                      h('div', { key: `${action}${i}`, className: 'wm-listRow' },
                        h('div', null, x.text),
                        WD.提(`${x.why || ''}${x.rule ? ` → ${x.rule}` : ''}${x.ok === false ? ` · 未采用：${x.whyDropped}` : ''}`),
                      ),
                    ),
                  )
                }),
              ),
            )
          })(),
          压缩条数
            ? 提案.compressions.map((c, i) => WD.条(`cmp${i}`, h('div', null,
              h('div', null, `< 写短旧规矩 [${审视名[c.flag] || c.flag}]${c.freed > 0 ? ` · 约腾 ${c.freed} tok` : ''}`),
              h('div', null, `  旧：${c.old}`),
              h('div', null, `  新：${c.rule}`),
              WD.提(c.why),
            )))
            : null,
          提案条数
            ? 提案.additions.map((a, i) => WD.条(`add${i}`, h('div', null,
              h('div', null, `+ ${a.rule}`),
              WD.提(`依据 ${a.evidence} 条记忆${(a.refs || []).length ? `：${a.refs.map((r) => `${r.id}${r.text ? `「${r.text}」` : ''}`).join('、')}` : ''}`),
            )))
            : null,
          替换条数
            ? 提案.replacements.map((r, i) => WD.条(`rep${i}`, h('div', null,
              h('div', null, `~ 换掉旧的：${r.old}`),
              h('div', null, `  换成：${r.rule}`),
              WD.提(`${r.why}${r.freed > 0 ? ` · 腾出 ${r.freed} tok` : ''}`),
            )))
            : null,
          !提案改动数 ? WD.提('没有新候选，旧人设这轮也没找到能写短或替换的地方。') : null,
          (提案.rejected || []).slice(0, 8).map((r, i) => h('div', { key: `rej${i}` },
            WD.提(`拦截：${r.rule} —— ${r.why}`))),
          (提案.rejected || []).length > 8
            ? WD.提(`还有 ${(提案.rejected || []).length - 8} 条拦截，完整清单见提案文件。`)
            : null,
          (提案.warnings || []).filter(Boolean).map((w, i) => h('div', { key: `warn${i}` }, WD.提(`提示：${w}`))),
        )
        : WD.提('还没有提案文件；下一轮生成后会显示在这里。')
      const 上次迭代 = 迭代
        ? h('div', { style: { marginTop: 8 } },
          行('时间', 时间(迭代.at)),
          行('结论', (迭代.applied || 迭代.replaced || 迭代.compressed) > 0
            ? `发布 v${迭代.version} · 新增 ${迭代.applied || 0} · 替换 ${迭代.replaced || 0} · 压缩 ${迭代.compressed || 0}`
            : 迭代.proposed
              ? `只出提案，没发布（新增 ${迭代.additions || 0} 条）`
              : '没跑成'),
          迭代.why ? 行('原因', 迭代.why) : null,
          迭代.samples
            ? 行('样本', `采样 ${迭代.samples.count || 0} 条 / 库内 ${迭代.samples.total || 0} 条 · 跳过 ${迭代.samples.skipped || 0}`)
            : null,
          (提案 && 提案.samples && 采样明细(提案.samples.skipReasons))
            ? WD.提(`采样跳过原因：${采样明细(提案.samples.skipReasons)}`)
            : null,
        )
        : h('div', { style: { marginTop: 8 } },
          p.auto && p.auto.lastRunAt ? 行('上次运行', 时间(p.auto.lastRunAt)) : null,
          WD.提('还没有结果记录（旧版跑的不留痕）；下次自动迭代跑完就会显示。'),
        )
      return h('div', { className: 'wm-body' },
        h('div', { className: 'wm-grid' },
          WD.格('人格', p.exists ? `v${p.version || 0}` : '缺失', p.exists ? `${p.tokens || 0}/${p.limit || 1200} tok${p.overBudget ? '（超预算）' : ''}` : 'persona.md 不在', p.overBudget ? 'wm-tileAccent' : ''),
          WD.格('人格探针', p.probes ? `${p.probes.passed}/${p.probes.total}` : '—', (p.probes?.failed || []).map((f) => f.name).join('、') || '全部通过'),
          WD.格('信任', t.origin || '?', t.usable ? '可用' : '未信任'),
          WD.格('读取', String(rd.total || 0), `查 ${rd.search || 0} · 读 ${rd.read || 0} · 画像 ${rd.profile || 0} · 空/拒 ${rd.empty || 0}`, 'wm-tileAccent'),
        ),
        WD.卡('人格迭代',
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
            h('div', { style: { fontSize: 14, fontWeight: 600, lineHeight: 1.5 } }, 迭代结论),
            WD.提(迭代下一步),
            h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
              WD.徽(`占用 ${p.tokens || 0}/${p.limit || 1200} tok`, p.overBudget ? 'wm-badgeWarn' : 'wm-badgeInfo', p.overBudget),
              预算 ? WD.徽(`整理后可用 ${预算.effective ?? 预算.headroom} tok`, 'wm-badgeInfo') : null,
              p.auto ? WD.徽(`新消息 ${p.auto.pendingMessages ?? 0}/${p.auto.minMessages ?? 100}`, 'wm-badgeOff') : null,
              p.auto ? WD.徽(`连续通过 ${p.auto.streak || 0}/${p.auto.minStreak || 3}`, 'wm-badgeOff') : null,
              p.auto ? WD.徽(p.auto.publishedThisWeek ? `本周已发布 · 下次 ${p.auto.nextPublishAt || '—'}` : '本周未发布', p.auto.publishedThisWeek ? 'wm-badgeWarn' : 'wm-badgeOff') : null,
              p.auto && p.auto.lastRunAt ? WD.徽(`上次 ${时间(p.auto.lastRunAt)}`, 'wm-badgeOff') : null,
            ),
            WD.提('只改 EVOLVABLE 区块，CORE 不动；生成不算生效，还要过审查、闸门和前后探针。'),
            h('details', { className: 'wm-fold', open: 提案有内容, style: { marginTop: 2 } },
              h('summary', null, 提案 ? `本轮提案明细 · 新增 ${提案条数} / 替换 ${替换条数} / 压缩 ${压缩条数}` : '本轮提案明细'),
              提案明细,
            ),
            h('details', { className: 'wm-fold' },
              h('summary', null, '上次迭代结果'),
              上次迭代,
            ),
          ),
          WD.徽(迭代徽.text, 迭代徽.cls, 提案有内容),
        ),
        h('div', { className: 'wm-cols' },
          h(人格预算卡, { p, 刷新 }),
          WD.卡('迭代档案',
            h('div', { style: { display: 'flex', flexDirection: 'column', gap: 7 } },
              h('details', null,
                h('summary', { className: 'wm-hint', style: { cursor: 'pointer' } }, 审视.length
                  ? `旧人设审视 · ${审视.length} 行 · 偏长 ${审视计数('verbose')} · 示例 ${审视计数('example')} · 疑似重复 ${审视计数('redundant')}`
                  : '旧人设审视'),
                h('div', { style: { marginTop: 6 } },
                  审视.length
                    ? h('div', null,
                      WD.提(`精简 ${审视计数('keep')} 行。示例行占预算但不算约束句，偏长的多半能写短。`),
                      审视.filter((r) => r.flag !== 'keep').slice(0, 8).map((r, i) =>
                        h('div', { key: `au${i}`, className: 'wm-listRow' },
                          h('div', { style: { display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' } },
                            WD.徽(审视名[r.flag] || r.flag, r.flag === 'example' ? 'wm-badgeWarn' : 'wm-badgeInfo'),
                            WD.徽(`${r.chars} 字`, 'wm-badgeOff'),
                            h('span', { style: { flex: 1 } }, r.text.slice(0, 60)),
                          ),
                          WD.提(`${r.why}${r.suggestion ? `；建议：${r.suggestion}` : ''}`),
                        ),
                      ),
                    )
                    : WD.提('还没有审视记录；下一次生成提案时会逐行看一遍旧人设。'),
                ),
              ),
              h('details', null,
                h('summary', { className: 'wm-hint', style: { cursor: 'pointer' } },
                  (p.decisions || []).length ? `迭代判决明细 · 最近 ${(p.decisions || []).length} 轮` : '迭代判决明细'),
                h('div', { style: { marginTop: 6 } },
                  (p.decisions || []).length
                    ? h('div', null,
                      WD.提('每条候选在哪一关被留下、丢掉、或换成旧说法，按轮次留档；提案文件会被覆盖，这份台账不会。'),
                      (p.decisions || []).slice(0, 2).map((run, ri) =>
                        h('div', { key: `run${ri}`, style: { marginTop: 8 } },
                          WD.提(`一轮 · ${时间(run.at)}`),
                          (run.rows || []).map((d, i) =>
                            h('div', { key: `d${i}`, className: 'wm-listRow' },
                              h('div', { style: { display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' } },
                                WD.徽(
                                  d.action === 'accepted' ? '留下'
                                    : d.action === 'replaced' ? '替换'
                                      : d.action === 'compressed' ? '压缩'
                                        : d.action === 'kept' ? '保留' : '丢弃',
                                  d.action === 'accepted' ? 'wm-badgeOk'
                                    : d.action === 'kept' ? 'wm-badgeInfo'
                                      : d.action === 'replaced' || d.action === 'compressed' ? 'wm-badgeWarn' : 'wm-badgeOff',
                                ),
                                WD.徽(阶段名[d.stage] || d.stage, 'wm-badgeInfo'),
                                h('span', { style: { flex: 1 } }, d.rule),
                              ),
                              WD.提(d.why),
                              (d.evidence || []).length
                                ? WD.提(`依据：${d.evidence.map((e) => `${e.id}${e.text ? `「${e.text}」` : ''}`).join('、')}`)
                                : null,
                            ),
                          ),
                        ),
                      ),
                    )
                    : WD.提('还没有判决记录；下一次生成提案后，每条候选的取舍都会记在这里。'),
                ),
              ),
              h('details', null,
                h('summary', { className: 'wm-hint', style: { cursor: 'pointer' } }, `最近变更 · 当前 v${p.version || 0}`),
                h('div', { style: { marginTop: 6 } },
                  变更.length || 换过的.length || 压过的.length || p.changelog
                    ? h('div', null,
                      p.changelog
                        ? h('pre', { style: { ...S.mono, whiteSpace: 'pre-wrap', margin: 0, lineHeight: 1.6 } }, p.changelog)
                        : h('div', null,
                          p.lastApplied && p.lastApplied.at ? WD.提(时间(p.lastApplied.at)) : null,
                          变更.map((r, i) => WD.条(`app${i}`, h('div', null, `+ ${r}`))),
                          换过的.map((r, i) => WD.条(`swap${i}`, h('div', null,
                            h('div', null, `~ 旧：${r.old}`),
                            h('div', null, `  新：${r.rule}`),
                          ))),
                          压过的.map((r, i) => WD.条(`cmp${i}`, h('div', null,
                            h('div', null, `< 旧：${r.old}`),
                            h('div', null, `  短：${r.rule}`),
                          ))),
                        ),
                    )
                    : WD.提(`还没发布过 revision，当前 v${p.version || 0}${p.lastApplied && p.lastApplied.source ? `（${p.lastApplied.source}）` : ''}。`),
                ),
              ),
              h('details', null,
                h('summary', { className: 'wm-hint', style: { cursor: 'pointer' } }, '其他运行明细 · 分片容量 / 最近检索 / 写入跳过'),
                h('div', { style: { marginTop: 8, display: 'flex', flexDirection: 'column', gap: 10 } },
                  h('div', null,
                    h('div', { style: { fontWeight: 600 } }, '分片容量'),
                    (o.vault || []).length
                      ? (o.vault || []).map((v) =>
                        h('div', { key: v.scope, className: 'wm-listRow' },
                          h('div', { style: { display: 'flex', gap: 8, alignItems: 'baseline' } },
                            h('span', { style: { flex: 1 } }, v.label),
                            WD.徽(`${v.live} 条`, 'wm-badgeInfo'),
                          ),
                          WD.提(`副库 ${(v.indexBytes / 1024).toFixed(1)}KB${v.pending ? ' · ⚠ 待重建' : ''} · 读取 ${v.reads} 次 · 深化 ${v.lastDeepen || '—'}`),
                        ),
                      )
                      : WD.提('还没有分片。'),
                  ),
                  h('div', null,
                    h('div', { style: { fontWeight: 600 } }, '最近检索'),
                    (o.searches || []).length
                      ? (o.searches || []).map((x, i) =>
                        h('div', { key: i, className: 'wm-listRow' },
                          h('div', null, `${x.query || '（空）'} · ${x.count || 0} 条${x.hops ? ` · ${x.hops} 跳` : ''}`),
                          WD.提((x.top || []).map((y) => (typeof y === 'string' ? y : `${y.id}(${y.score})`)).join(' · ')),
                        ),
                      )
                      : WD.提('还没有检索记录。'),
                  ),
                  h('div', null,
                    h('div', { style: { fontWeight: 600 } }, '写入跳过'),
                    (o.skips || []).length
                      ? (o.skips || []).map((x, i) =>
                        h('div', { key: i, className: 'wm-listRow' },
                          h('div', null, `${x.scope} · 跳过 ${x.skipped || 0} 条`),
                          WD.提(JSON.stringify(x.reasons || {})),
                        ),
                      )
                      : WD.提('没有跳过记录。'),
                  ),
                ),
              ),
            ),
            WD.徽('只读', 'wm-badgeOff'),
          ),
        ),
      )
    }

