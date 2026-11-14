    const 探测状态名 = {
      ok: '可用',
      limited: '限流',
      auth: '未授权',
      denied: '无权限',
      unusable: '非对话',
      timeout: '超时',
      error: '连不上',
      skipped: '未测',
    }
    const 探测状态色 = {
      ok: '#3ba55d',
      limited: '#e0952e',
      auth: '#c23a5e',
      denied: '#e0952e',
      unusable: '#8a94a6',
      timeout: '#e0952e',
      error: '#c23a5e',
      skipped: '#8a94a6',
    }

    /** 单个模型配置卡：蒸馏 / 向量 / 找素材共用一套，只是文案和接口不同。 */
    function 模型配置卡({ 名, 说明, 成功话, 态, 表单, 改表单, 保存, 测试, 探测, 候选, 探测中, 忙, 结果, 探测说明, 不可用名 }) {
      const v = 态 || {}
      const [展开, 设展开] = React.useState(false)
      const 输入 = (k, 标签, 类型, 提示) =>
        h('label', { key: k, className: 'wm-field', style: { marginTop: 8 } },
          h('span', { className: 'wm-hint' }, 标签),
          h('input', {
            type: 类型,
            value: 表单[k] || '',
            placeholder: 提示,
            spellCheck: false,
            autoComplete: 'off',
            className: 'wm-input',
            onChange: (e) => 改表单(Object.assign({}, 表单, { [k]: e.target.value })),
          }),
        )
      const 状态名 = 不可用名 ? { ...探测状态名, unusable: 不可用名 } : 探测状态名
      const 行 = (m) =>
        h('div', { key: m.id, className: 'wm-row' },
          h('button', {
            className: 'wm-btn wm-mono',
            title: m.why || '',
            onClick: () => 改表单(Object.assign({}, 表单, { model: m.id })),
          }, m.id),
          h('span', { className: 'wm-hint', style: { color: 探测状态色[m.state] } },
            (状态名[m.state] || m.state) + (m.ms ? ` · ${m.ms}ms` : '')),
        )
      const 取 = (state) => (候选 ? (候选.models || []).filter((m) => m.state === state) : [])
      const 可用 = 取('ok')
      const 限流 = 取('limited')
      const 不可用 = 取('unusable')
      const 其它 = 候选
        ? (候选.models || []).filter((m) => !['ok', 'limited', 'unusable'].includes(m.state))
        : []

      return h('div', { className: 'wm-body' },
        WD.卡(名,
          h('div', null,
            WD.提(说明),
            输入('base', '端点', 'text', 'https://api.deepseek.com/v1'),
            输入('model', '模型名', 'text', 名.includes('向量') ? '留空就点「探测向量模型」自动找' : 名.includes('搜索') ? '带联网能力的模型名' : 'deepseek-chat'),
            输入('key', 'API Key', 'password', v.hasKey ? `已保存 ${v.keyMasked}，留空不改` : '没填就是不鉴权（本地 Ollama 常见）'),
            h('div', { className: 'wm-saveBar', style: { marginTop: 12 } },
              h('button', { className: 'wm-btn wm-btnPrimary', disabled: 忙, onClick: 保存 }, 忙 ? '处理中…' : '保存'),
              h('button', { className: 'wm-btn', disabled: 忙 || 探测中, onClick: 测试 }, '测试连通'),
              探测 ? h('button', {
                className: 'wm-btn',
                disabled: 忙 || 探测中 || !(表单.base || v.base),
                onClick: 探测,
              }, 探测中 ? '探测中…' : (名.includes('向量') ? '探测向量模型' : '探测可用模型')) : null,
              WD.徽(v.ready ? '已就绪' : '未配置', v.ready ? 'wm-badgeOk' : 'wm-badgeOff', Boolean(v.ready)),
              v.from === 'env' ? h('span', { className: 'wm-hint' }, '当前值来自环境变量，保存后以这里为准') : null,
              v.inherit ? h('span', { className: 'wm-hint' }, '端点/Key 当前跟蒸馏相同，改这里就独立') : null,
            ),
            探测 ? WD.提(探测说明 || '探测会先拉模型列表，再逐个发一条最小消息，约 10–20 秒，消耗少量额度；要填 API Key 才能探测。') : null,
            结果
              ? h('div', { className: 'wm-notice ' + (结果.ok ? 'wm-good' : 'wm-bad') },
                结果.ok ? 成功话 : '没通 · ' + (结果.why || '未知原因'))
              : null,
            候选
              ? h('div', { style: { marginTop: 8 } },
                WD.提(`可用 ${候选.counts.usable} · 限流 ${候选.counts.limited} · ${不可用名 || '非对话'} ${候选.counts.unusable}` +
                  (候选.counts.timeout ? ` · 超时 ${候选.counts.timeout}` : '') +
                  (候选.counts.denied ? ` · 无权限 ${候选.counts.denied}` : '') +
                  (候选.counts.auth ? ` · 未授权 ${候选.counts.auth}` : '') +
                  (候选.truncated
                    ? (候选.likelyOnly ? ` · 只测了 ${候选.models.length} 个像 embedding 的` : ' · 只测了前 24 个')
                    : '')),
                可用.length ? h('div', { style: { marginTop: 5 } }, 可用.map(行)) : null,
                限流.length ? h('div', { style: { marginTop: 5 } }, 限流.map(行)) : null,
                其它.length ? h('div', { style: { marginTop: 5 } }, 其它.map(行)) : null,
                不可用.length
                  ? h('div', { style: { marginTop: 6 } },
                    h('button', { className: 'wm-btn', onClick: () => 设展开(!展开) },
                      展开 ? `收起${不可用名 || '非对话'}模型` : `展开 ${不可用.length} 个${不可用名 || '非对话'}模型`),
                    展开 ? h('div', { style: { marginTop: 4 } }, 不可用.map(行)) : null,
                  )
                  : null,
                可用.length ? WD.提('点模型名填入，再点「保存」才生效。') : null,
              )
              : null,
          ),
          WD.徽(v.kind === 'search' ? '搜索' : '蒸馏', 'wm-badgeInfo'),
        ),
        h('details', { style: { padding: '0 2px' } },
          h('summary', { className: 'wm-hint', style: { cursor: 'pointer' } }, '配置位置'),
          h('div', { style: { marginTop: 6 } },
            WD.提('文件：' + String(v.path || '?')),
            WD.提('key 用 Windows DPAPI 加密后存在这个文件里，只有当前账户能解；非 Windows 或加密失败才落明文（0600）。界面只显示尾巴，换端点要重填。向量模型在「模型 → 向量」里单独配，点探测会自动找支持 embeddings 的模型；人格审查没单独配就跟着蒸馏模型。'),
          ),
        ),
      )
    }

    /** 主动闲逛用的那一路 agent：配置存在 beat config 里，只有 model / provider。 */
    function 闲逛模型卡({ 态, 表单, 改表单, 保存, 结果, 忙 }) {
      if (!表单) return WD.卡('闲逛 agent 模型', WD.提('读取主动行为配置…'))
      const f = 表单
      const c = (态 && 态.config) || {}
      const ad = (态 && 态.agentDefault) || null
      const 改 = (k, v) => 改表单(Object.assign({}, f, { [k]: v }))
      const 文 = (k, 标签, 提示) =>
        h('label', { key: k, className: 'wm-field', style: { marginTop: 8 } },
          h('span', { className: 'wm-hint' }, 标签),
          h('input', {
            className: 'wm-input',
            value: f[k] || '',
            placeholder: 提示,
            spellCheck: false,
            onChange: (e) => 改(k, e.target.value),
          }),
        )
      return h('div', { className: 'wm-body' },
        WD.卡('闲逛 agent 模型',
          h('div', null,
            WD.提('默认走这条：在宿主里真开一路 agent。你在下面选的模型只负责“想搜什么、怎么整理”，它自己不联网；真正联网搜索由 DSH 的 web_search 完成，默认走 DeepSeek 搜索 provider，单独消耗 DEEPSEEK_API_KEY。'),
            WD.提('这里填的是 DSH 里已经配好的 provider id / model id，不是 API 地址或 Key；留空就跟宿主当前默认。'),
            ad
              ? WD.提(`宿主当前默认：${ad.provider || '?'} / ${ad.model || '?'}`)
              : WD.提('宿主没报当前默认模型；可以留空，或先在 DSH 的模型设置里配好 provider。'),
            文('model', 'model（宿主 model id）', '留空跟全局默认；只影响宿主里跑的那一路'),
            文('provider', 'provider（宿主 provider id）', '留空跟全局默认'),
            h('div', { className: 'wm-saveBar', style: { marginTop: 12 } },
              h('button', { className: 'wm-btn wm-btnPrimary', disabled: 忙, onClick: 保存 },
                忙 ? '保存中…' : '保存'),
              ad
                ? h('button', {
                  className: 'wm-btn',
                  disabled: 忙,
                  onClick: () => 改表单(Object.assign({}, f, { provider: ad.provider || '', model: ad.model || '' })),
                }, '填入当前默认')
                : null,
              WD.徽(c.model || '跟全局默认', c.model ? 'wm-badgeInfo' : 'wm-badgeOff'),
            ),
            结果 ? h('div', { className: 'wm-notice ' + (结果.ok ? 'wm-good' : 'wm-bad') }, 结果.text) : null,
          ),
        ),
        h('div', { style: { padding: '0 2px' } },
          WD.提('要换 agent 的思考模型：先在 DSH 的模型/provider 设置里把它配好，再回这里填 provider id + model id。要换真正联网的搜索通道，去 DSH 插件 → 网页搜索；这里不填搜索 key。'),
        ),
      )
    }

    /** 找素材：两条路合成一个选择，默认 agent。 */
    function 找素材页({ 搜索, 闲逛, 切引擎, 结果 }) {
      const c = (闲逛.态 && 闲逛.态.config) || {}
      const 引擎 = c.engine === 'search' ? 'search' : 'agent'
      const 切 = (v) => {
        if (v !== 引擎 && !闲逛.忙) 切引擎(v)
      }
      return h('div', null,
        WD.卡('用什么找素材',
          h('div', null,
            h('div', { className: 'wm-subtabs', style: { marginBottom: 8 } },
              h('button', {
                className: 'wm-subtab' + (引擎 === 'agent' ? ' wm-subtabOn' : ''),
                disabled: 闲逛.忙,
                onClick: () => 切('agent'),
              }, '闲逛 agent'),
              h('button', {
                className: 'wm-subtab' + (引擎 === 'search' ? ' wm-subtabOn' : ''),
                disabled: 闲逛.忙,
                onClick: () => 切('search'),
              }, '直连搜索模型'),
            ),
            WD.提(引擎 === 'agent'
              ? '默认：在宿主里真开一路 agent。下面选的模型负责想搜什么、怎么整理，不负责联网；真正搜索走 DSH 的 web_search（默认 DeepSeek 搜索 provider，单独用 DEEPSEEK_API_KEY），会翻 3–5 轮再回来。'
              : '备选：不开 agent，把 prompt 直接发给下面这个模型，一问一答。它必须自带联网能力（Kimi / 智谱联网 / OpenRouter :online 之类）；只发一轮，不联网的模型会返回空。'),
            WD.提('费用也不一样：agent 模式 = 思考模型 token + 每次 web_search 的搜索模型 token；直连模式 = 只算你填的搜索模型 token。'),
            结果 ? h('div', { className: 'wm-notice ' + (结果.ok ? 'wm-good' : 'wm-bad') }, 结果.text) : null,
          ),
          WD.徽(引擎 === 'agent' ? '当前：agent' : '当前：直连', 'wm-badgeInfo'),
        ),
        引擎 === 'agent'
          ? h(闲逛模型卡, 闲逛)
          : h(模型配置卡, Object.assign({}, 搜索, {
            名: '直连搜索模型',
            成功话: `通了 · ${(搜索.结果 && 搜索.结果.ms) || 0}ms · 下一跳闲逛就用这个模型联网找素材`,
            说明: '必须填「自己能联网」的模型（Kimi / 智谱联网 / OpenRouter :online 之类）。它既搜也整理，只发一轮、不会调工具；没有第二个模型帮忙整理，不联网或没配好会返回空并自动回退闲逛 agent。',
          })),
      )
    }

    function 模型页({ 页签, 蒸馏, 搜索, 向量, 闲逛, 切引擎, 引擎结果 }) {
      return h('div', { className: 'wm-body' },
        页签 === '蒸馏'
          ? h(模型配置卡, Object.assign({}, 蒸馏, {
            名: '蒸馏模型',
            成功话: `通了 · ${(蒸馏.结果 && 蒸馏.结果.ms) || 0}ms · 保存后下一次蒸馏就生效，不用重启 DSH`,
            说明: '抽记忆用的模型。填完点「测试连通」，通了再保存。任何 OpenAI 兼容端点都行（官方 / one-api / 本地 Ollama）。',
          }))
          : 页签 === '向量'
            ? h(模型配置卡, Object.assign({}, 向量, {
              名: '向量模型',
              成功话: `通了 · ${(向量.结果 && 向量.结果.ms) || 0}ms${向量.结果?.dim ? ` · ${向量.结果.dim} 维` : ''} · 保存后检索生效`,
              说明: '检索用的 embedding 模型。不知道填什么就点「探测向量模型」，会拉 /models 并逐个试 /embeddings；端点可以和蒸馏不同。',
              探测说明: '探测会拉模型列表，优先试名字像 embedding 的，每个发一次最小 /embeddings；约 10–20 秒。',
              不可用名: '不支持向量',
            }))
            : h(找素材页, { 搜索, 闲逛, 切引擎, 结果: 引擎结果 }),
      )
    }

    /** 日记页：左边按天挑，右边看正文；写和重写都在顶部。 */
    function 日记页({ 态, 正文, 忙, 结果, 读, 写今天, 重写这天 }) {
      const cfg = (态 && 态.config) || {}
      const days = (态 && 态.days) || []
      const p2 = (n) => String(n).padStart(2, '0')
      const 自动 = cfg.enabled === false ? '关' : `每天 ${p2(cfg.hour ?? 23)}:${p2(cfg.minute ?? 0)}`
      const 行样式 = {
        textAlign: 'left', width: '100%', height: 30, padding: '0 9px',
        borderRadius: 8, border: '1px solid transparent', background: 'transparent',
        color: 'var(--dsw-alias-label-secondary)', fontSize: 12, cursor: 'pointer',
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
      }
      return h('div', { className: 'wm-body' },
        h('div', { className: 'wm-statusStrip' },
          WD.徽(`自动写：${自动}`, cfg.enabled === false ? 'wm-badgeOff' : 'wm-badgeInfo'),
          WD.徽(`已写 ${days.length} 天`, 'wm-badgeInfo'),
          (态 && 态.lastError) ? WD.徽('上次没写成', 'wm-badgeWarn', true) : null,
          h('div', { style: { marginLeft: 'auto', display: 'flex', gap: 6 } },
            h('button', { className: 'wm-btn', disabled: 忙, onClick: 写今天 }, 忙 ? '写呢…' : '写今天的'),
            h('button', {
              className: 'wm-btn',
              disabled: 忙 || !(正文 && 正文.ok),
              onClick: 重写这天,
            }, '重写这天'),
          ),
        ),
        结果 ? h('div', { className: 'wm-notice ' + (结果.ok ? 'wm-good' : 'wm-bad') }, 结果.text) : null,
        (态 && 态.lastError && !结果) ? WD.提(态.lastError) : null,
        h('div', { style: { display: 'flex', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' } },
          h('div', {
            style: {
              flex: '0 0 150px', display: 'flex', flexDirection: 'column', gap: 3,
              maxHeight: 480, overflowY: 'auto', paddingRight: 2,
            },
          },
            days.length
              ? days.map((d) => h('button', {
                key: d.day,
                style: Object.assign({}, 行样式, (正文 && 正文.day === d.day)
                  ? { background: 'rgba(99,102,241,.13)', borderColor: 'rgba(99,102,241,.32)', color: '#5b5bd6', fontWeight: 600 }
                  : null),
                title: d.title,
                onClick: () => 读(d.day),
              }, `${d.day.slice(5)} · ${d.chars} 字`))
              : WD.提('还没写过。'),
          ),
          h('div', { style: { flex: '1 1 320px', minWidth: 0 } },
            正文
              ? WD.卡(正文.title || 正文.day,
                h('div', { style: { whiteSpace: 'pre-wrap', lineHeight: 1.9, fontSize: 13 } },
                  正文.ok ? 正文.text : (正文.why || '这天还没写')),
                WD.徽(`${正文.chars || 0} 字`, 'wm-badgeInfo'))
              : WD.卡('日记', WD.提('左边选一天，或者点「写今天的」。')),
          ),
        ),
        WD.提('日记按当天新记和重新想起来的记忆生成，只存在记忆库目录的 diary/ 下；改时间改那边的 config.json（没有就按默认每天 23:00）。'),
      )
    }

    /** 主动行为层的表单：配置文件是对象/数组，界面用字符串。 */
