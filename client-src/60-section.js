    function Section() {
      确保主动样式()
      const [页, 设页] = React.useState('总览')
      const [总览页签, 设总览页签] = React.useState('概览')
      const [记忆页签, 设记忆页签] = React.useState('分片')
      const [态, 设态] = React.useState(null)
      const [图, 设图] = React.useState(null)
      const [账本, 设账本] = React.useState(null)
      const [观察, 设观察] = React.useState(null)
      const [模型态, 设模型态] = React.useState(null)
      const [模型表单, 设模型表单] = React.useState({ base: '', model: '', key: '' })
      const [模型结果, 设模型结果] = React.useState(null)
      const [候选, 设候选] = React.useState(null)
      const [探测中, 设探测中] = React.useState(false)
      const [模型页签, 设模型页签] = React.useState('蒸馏')
      const [主动页签, 设主动页签] = React.useState('状态')
      const [搜索态, 设搜索态] = React.useState(null)
      const [搜索表单, 设搜索表单] = React.useState({ base: '', model: '', key: '' })
      const [搜索结果, 设搜索结果] = React.useState(null)
      const [搜索候选, 设搜索候选] = React.useState(null)
      const [搜索探测中, 设搜索探测中] = React.useState(false)
      const [向量态, 设向量态] = React.useState(null)
      const [向量表单, 设向量表单] = React.useState({ base: '', model: '', key: '' })
      const [向量结果, 设向量结果] = React.useState(null)
      const [向量候选, 设向量候选] = React.useState(null)
      const [向量探测中, 设向量探测中] = React.useState(false)
      const [主动态, 设主动态] = React.useState(null)
      const [主动表单, 设主动表单] = React.useState(null)
      const [主动结果, 设主动结果] = React.useState(null)
      const [引擎结果, 设引擎结果] = React.useState(null)
      const [目标候选, 设目标候选] = React.useState(null)
      const [专注分钟, 设专注分钟] = React.useState('60')
      const [忙, 设忙] = React.useState(false)
      const [日记态, 设日记态] = React.useState(null)
      const [日记正文, 设日记正文] = React.useState(null)
      const [日记忙, 设日记忙] = React.useState(false)
      const [日记结果, 设日记结果] = React.useState(null)
      const [体检, 设体检] = React.useState(null)

      const 刷新 = React.useCallback((soft = false) => {
        if (!soft) 设忙(true)
        return Promise.all([get('/state'), get('/graph'), get('/audit?n=80'), get('/obs'), get('/beat'), get('/health')])
          .then(([s, g, a, o, b, hl]) => {
            设态(s)
            设图(g)
            设账本(a)
            设观察(o)
            if (hl) 设体检(hl)
            if (b && b.ok) {
              设主动态(b)
              设主动表单((prev) => prev || 主动表单从(b))
            }
          })
          .finally(() => { if (!soft) 设忙(false) })
      }, [])

      React.useEffect(() => { 刷新() }, [刷新])

      const 拉日记 = React.useCallback(() => get('/diary').then((r) => {
        if (r && r.ok) 设日记态(r)
        return r
      }), [])
      const 读日记 = React.useCallback((day) => get('/diary/read?day=' + encodeURIComponent(day)).then((r) => {
        设日记正文(r && r.ok ? r : { ok: false, day, title: day, chars: 0, why: (r && r.why) || '读不出来' })
        return r
      }), [])
      const 刷新日记 = React.useCallback(() => 拉日记().then((r) => {
        const first = r && r.days && r.days[0] && r.days[0].day
        return first ? 读日记(first) : null
      }), [拉日记, 读日记])
      const 今天键 = React.useCallback(() => {
        const d = new Date()
        const p2 = (n) => String(n).padStart(2, '0')
        return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`
      }, [])
      const 写今天日记 = React.useCallback(() => {
        设日记忙(true)
        设日记结果(null)
        return post('/diary/write', { day: 今天键() }).then((r) => {
          if (r && r.ok) {
            设日记正文(r)
            设日记结果({ ok: true, text: r.skipped === 'exists' ? '今天已经写过了。' : '写好了。' })
          } else {
            设日记结果({ ok: false, text: (r && r.why) || '没写成' })
          }
          return 拉日记()
        }).finally(() => 设日记忙(false))
      }, [今天键, 拉日记])
      const 重写这天 = React.useCallback(() => {
        const day = 日记正文 && 日记正文.day
        if (!day) return Promise.resolve()
        if (!window.confirm(`重写 ${day} 的日记？\n\n原来那篇会被覆盖。`)) return Promise.resolve()
        设日记忙(true)
        设日记结果(null)
        return post('/diary/write', { day, rewrite: true }).then((r) => {
          if (r && r.ok) {
            设日记正文(r)
            设日记结果({ ok: true, text: '重写好了。' })
          } else {
            设日记结果({ ok: false, text: (r && r.why) || '没写成' })
          }
          return 拉日记()
        }).finally(() => 设日记忙(false))
      }, [日记正文, 拉日记])
      React.useEffect(() => {
        if (页 !== '日记' || 日记态) return
        刷新日记()
      }, [页, 日记态, 刷新日记])

      const 删 = React.useCallback((scope, id, text) => {
        if (!window.confirm(`删掉这条？\n\n${text}\n\n（会进归档，能翻回来）`)) return
        设忙(true)
        post('/forget', { scope, id })
          .then((r) => { if (r && r.ok === false) window.alert('没删掉：' + (r.why || '未知原因')) })
          .catch(() => window.alert('没删掉：请求失败'))
          .finally(() => { 刷新() })
      }, [刷新])

      const 确认 = React.useCallback((scope, id) => {
        设忙(true)
        post('/confirm', { scope, id })
          .then((r) => { if (r && r.ok === false) window.alert('没转正：' + (r.why || '未知原因')) })
          .catch(() => window.alert('没转正：请求失败'))
          .finally(() => { 刷新() })
      }, [刷新])

      const 装模型 = React.useCallback((r) => {
        设模型态(r)
        设模型表单({ base: r.base || '', model: r.model || '', key: '' })
      }, [])
      const 装搜索 = React.useCallback((r) => {
        设搜索态(r)
        设搜索表单({ base: r.base || '', model: r.model || '', key: '' })
      }, [])
      const 拉模型 = React.useCallback(() => {
        get('/llm').then((r) => { if (r && r.ok) 装模型(r) })
      }, [装模型])
      const 拉搜索 = React.useCallback(() => {
        get('/llm/search').then((r) => { if (r && r.ok) 装搜索(r) })
      }, [装搜索])
      const 装向量 = React.useCallback((r) => {
        设向量态(r)
        设向量表单({ base: r.base || '', model: r.model || '', key: '' })
      }, [])
      const 拉向量 = React.useCallback(() => {
        get('/llm/embed').then((r) => { if (r && r.ok) 装向量(r) })
      }, [装向量])

      React.useEffect(() => {
        if (页 !== '模型') return
        if (!模型态) 拉模型()
        if (!搜索态) 拉搜索()
        if (!向量态) 拉向量()
      }, [页, 模型态, 搜索态, 向量态, 拉模型, 拉搜索, 拉向量])

      const 拉主动 = React.useCallback((soft = false) => {
        get('/beat').then((b) => {
          if (b && b.ok) {
            设主动态(b)
            // soft 刷新只换状态，不覆盖用户正在改的表单
            设主动表单((prev) => prev || 主动表单从(b))
          }
        })
      }, [])

      const 拉目标 = React.useCallback(() => {
        get('/beat/targets').then((r) => { if (r && r.ok) 设目标候选(r) })
      }, [])

      React.useEffect(() => {
        // 模型页的「闲逛 agent」页签也要读 beat 配置
        if ((页 === '主动' || 页 === '模型') && !主动态) 拉主动()
        if (页 === '主动' && !目标候选) 拉目标()
      }, [页, 主动态, 目标候选, 拉主动, 拉目标])

      // 和心跳面板一样：停在任意页每 30 秒刷一次状态，不用手动点。
      // 模型页跳过：表单里有未保存的 key/端点，自动刷新会把输入盖掉。
      // 页面切到后台就停，回来立刻补一次——省掉看不见时的空转请求。
      React.useEffect(() => {
        const tick = () => {
          if (typeof document !== 'undefined' && document.hidden) return
          if (页 === '主动') 拉主动(true)
          else if (页 !== '模型') 刷新(true)
        }
        const timer = setInterval(tick, 30000)
        const hasDoc = typeof document !== 'undefined'
        const onVisible = () => { if (!document.hidden) tick() }
        if (hasDoc) document.addEventListener('visibilitychange', onVisible)
        return () => {
          clearInterval(timer)
          if (hasDoc) document.removeEventListener('visibilitychange', onVisible)
        }
      }, [页, 拉主动, 刷新])

      const 提交模型 = async (path, 表单, 装) => {
        const r = await post(path, 表单)
        if (r && r.ok) 装(r)
        return r
      }

      const 模型操作 = ({ path, 表单, 装, 设结果, 设候选, 探测中, 设探测中 }) => ({
        保存: async () => {
          设忙(true)
          设结果(null)
          const r = await 提交模型(path, 表单, 装)
          if (!r || !r.ok) 设结果({ ok: false, why: (r && r.why) || '保存失败' })
          设忙(false)
        },
        测试: async () => {
          设忙(true)
          设结果(null)
          // 先存再测：测的是输入框里这份配置，不是上一次的旧值
          const s = await 提交模型(path, 表单, 装)
          if (!s || !s.ok) {
            设结果({ ok: false, why: (s && s.why) || '保存失败' })
            设忙(false)
            return
          }
          const r = await post(path + '/test', {})
          设结果(r || { ok: false, why: '请求失败' })
          设忙(false)
        },
        探测: async () => {
          if (探测中) return
          设探测中(true)
          设结果(null)
          设候选(null)
          const r = await post(path + '/models', { base: 表单.base, key: 表单.key })
          设探测中(false)
          if (!r || !r.ok) {
            设结果({ ok: false, why: (r && r.why) || '探测失败' })
            return
          }
          设候选(r)
        },
      })

      const 蒸馏操作 = 模型操作({
        path: '/llm', 表单: 模型表单, 装: 装模型,
        设结果: 设模型结果, 设候选, 探测中, 设探测中,
      })
      const 搜索操作 = 模型操作({
        path: '/llm/search', 表单: 搜索表单, 装: 装搜索,
        设结果: 设搜索结果, 设候选: 设搜索候选, 探测中: 搜索探测中, 设探测中: 设搜索探测中,
      })

      const 向量操作 = 模型操作({
        path: '/llm/embed', 表单: 向量表单, 装: 装向量,
        设结果: 设向量结果, 设候选: 设向量候选, 探测中: 向量探测中, 设探测中: 设向量探测中,
      })

      const 保存主动 = async () => {
        if (!主动表单) return
        设忙(true)
        设主动结果(null)
        const r = await post('/beat/config', 主动表单)
        if (r && r.ok) {
          设主动态(r)
          设主动表单(主动表单从(r))
          设主动结果({ ok: true, text: '已保存，下一跳生效。' })
        } else {
          设主动结果({ ok: false, text: (r && r.why) || '保存失败' })
        }
        设忙(false)
      }

      // 找素材的引擎切换：只改 beat 配置里的 engine，不碰两套模型配置。
      const 切引擎 = async (引擎) => {
        设忙(true)
        设引擎结果(null)
        const r = await post('/beat/config', { engine: 引擎 })
        if (r && r.ok) {
          设主动态(r)
          const 新 = 主动表单从(r)
          设主动表单((prev) => (prev ? Object.assign({}, prev, { model: 新.model, provider: 新.provider }) : 新))
          设引擎结果({
            ok: true,
            text: 引擎 === 'search' ? '已切到直连搜索模型，下一跳生效。' : '已切到闲逛 agent，下一跳生效。',
          })
        } else {
          设引擎结果({ ok: false, text: (r && r.why) || '保存失败' })
        }
        设忙(false)
      }

      // 模型页只改 beat 配置里的 model / provider，别顺手把别的未保存表单一起提交。
      const 保存闲逛模型 = async () => {
        if (!主动表单) return
        设忙(true)
        设主动结果(null)
        const r = await post('/beat/config', { model: 主动表单.model || '', provider: 主动表单.provider || '' })
        if (r && r.ok) {
          设主动态(r)
          const 新 = 主动表单从(r)
          设主动表单((prev) => (prev ? Object.assign({}, prev, { model: 新.model, provider: 新.provider }) : 新))
          设主动结果({ ok: true, text: '已保存，下一跳闲逛生效。' })
        } else {
          设主动结果({ ok: false, text: (r && r.why) || '保存失败' })
        }
        设忙(false)
      }

      const 切换专注 = async (off) => {
        const min = Number(专注分钟)
        if (!off && (!Number.isFinite(min) || min < 1)) {
          设主动结果({ ok: false, text: '专注分钟要填 1–1440。' })
          return
        }
        设忙(true)
        设主动结果(null)
        const r = await post('/beat/focus', off ? { off: true } : { minutes: min })
        if (r && r.ok) {
          设主动结果({ ok: true, text: off ? '专注模式已解除。' : `专注模式到 ${时间(r.focusUntil)}。` })
          await 拉主动()
        } else {
          设主动结果({ ok: false, text: (r && r.why) || '设置失败' })
        }
        设忙(false)
      }

      const 重建画像 = async () => {
        设忙(true)
        设主动结果(null)
        const r = await post('/beat/profile', {})
        if (r && r.ok) {
          设主动结果({ ok: true, text: `画像已重建${r.after ? ` · ${r.after}` : ''}` })
          await 拉主动()
        } else {
          设主动结果({ ok: false, text: (r && r.why) || '重建失败' })
        }
        设忙(false)
      }

      const 清理素材 = async () => {
        设忙(true)
        设主动结果(null)
        const r = await post('/beat/gc', {})
        if (r && r.ok) {
          设主动结果({ ok: true, text: `清理完成 · 退休 ${r.retired || 0} 条` })
          await 拉主动(true)
        } else {
          设主动结果({ ok: false, text: (r && r.why) || '清理失败' })
        }
        设忙(false)
      }

      const 轮换会话 = async () => {
        设忙(true)
        设主动结果(null)
        const r = await post('/beat/session/rotate', {})
        if (r && r.ok) {
          设主动态(r)
          设主动表单(主动表单从(r))
          设主动结果({ ok: true, text: '专用会话已轮换，下一次闲逛会新建。' })
        } else {
          设主动结果({ ok: false, text: (r && r.why) || '轮换失败' })
        }
        设忙(false)
      }

      const b = 主动态 || {}
      const 未信任 = 观察 && 观察.trust && 观察.trust.usable === false
      const 条数 = (态 && 态.counts && 态.counts.items) || 0
      const 分片数 = (态 && 态.counts && 态.counts.scopes) || 0
      const 构建 = (态 && 态.build) || null
      const 版本标签 = (态 && 态.label) || `v${(态 && 态.version) || '?'}`
      // 导航：横向主菜单，子菜单作为内容页顶部的页签展示。
      const 导航组 = [
        { 名: '总览', 图: '览', 项: [['概览', '总览', '概览'], ['运行', '总览', '运行']] },
        { 名: '记忆', 图: '忆', 项: [['分片', '记忆', '分片'], ['星云', '记忆', '星云'], ['审计', '记忆', '审计']] },
        { 名: '主动', 图: '动', 项: [['状态', '主动', '状态'], ['素材', '主动', '素材'], ['设置', '主动', '设置'], ['维护', '主动', '维护']] },
        { 名: '模型', 图: '模', 项: [['蒸馏', '模型', '蒸馏'], ['向量', '模型', '向量'], ['找素材', '模型', '找素材']] },
        { 名: '备份', 图: '备', 项: [['数据', '备份', '']] },
        { 名: '记录', 图: '录', 项: [['日记', '日记', '']] },
      ]
      const 说明 = {
        概览: '记忆规模、人格状态和体检结果，一眼看全。',
        运行: '先看人格迭代结论与待确认提案；审视、账本、检索、容量收在折叠区。',
        分片: '每个会话、每个群各自一册，可逐条确认或删除。',
        星云: '实体和关系组成的一颗球：拖动旋转，滚轮缩放，点节点看详情。',
        审计: '记忆的读写流水，用来核对谁在什么时候动过哪一条。',
        状态: '这一跳投递了什么、她怎么反应；只调素材权重，不写偏好。',
        素材: '主动投递用的素材池，按来源筛选，权重决定下一次谁先被挑中。',
        设置: '节律、投递目标、忙闲判定和兴趣焦点，保存后下一跳生效。',
        维护: '专注模式、画像重建、素材清理、专用会话轮换。',
        数据: '导出备份、导入备份，或从旧会话里补回记忆。',
        蒸馏: '抽记忆用的模型，任何 OpenAI 兼容端点都行。',
        向量: '检索用的 embedding 模型；端点不一定和蒸馏共用，探测会自动找支持 /embeddings 的模型。',
        找素材: '决定素材从哪来：闲逛 agent 里选的模型负责思考/整理，联网搜索单独走 web_search；直连搜索模型必须自带联网。',
        日记: '每天自动生成的一篇小记，也能手动补写或重写。',
      }
      const 当前子 = 页 === '总览' ? 总览页签 : 页 === '记忆' ? 记忆页签 : 页 === '主动' ? 主动页签 : 页 === '模型' ? 模型页签 : ''
      const 当前名 = (() => {
        for (const g of 导航组) for (const it of g.项) if (页 === it[1] && (!it[2] || 当前子 === it[2])) return it[0]
        return 页
      })()
      const 当前组 = (() => {
        for (const g of 导航组) {
          if (g.项.some((it) => 页 === it[1] && (!it[2] || 当前子 === it[2]))) return g.名
        }
        return ''
      })()
      const 当前组项 = (导航组.find((g) => g.名 === 当前组) || { 项: [] }).项
      const 去 = (主, 子) => {
        设页(主)
        if (主 === '总览') 设总览页签(子)
        else if (主 === '记忆') 设记忆页签(子)
        else if (主 === '主动') 设主动页签(子)
        else if (主 === '模型') 设模型页签(子)
      }

      return h('div', { className: 'wm-panel' },
        h('div', { className: 'wm-hero' },
          h('div', { className: 'wm-heroTop' },
            h('div', { className: 'wm-logo' }, '🐟'),
            h('div', { className: 'wm-heroText' },
              h('span', { className: 'wm-heroTitle' }, '大肥鱼记忆'),
              h('span', { className: 'wm-heroSub' }, '人格 · 记忆 · 主动行为，都在这里'),
            ),
            h('div', { className: 'wm-heroRight' },
              WD.徽(版本标签, 'wm-badgeInfo'),
              WD.徽(`${分片数} 分片 · ${条数} 条`, 'wm-badgeInfo'),
              未信任 ? WD.徽('未信任', 'wm-badgeWarn', true) : WD.徽('信任正常', 'wm-badgeOk', true),
              h('button', {
                className: 'wm-btn',
                disabled: 忙,
                onClick: async () => {
                  设忙(true)
                  await post('/refresh', {})
                  刷新()
                },
              }, 忙 ? '读取中…' : '刷新'),
            ),
          ),
        ),
        h('div', { className: 'wm-shell' },
          h('nav', { className: 'wm-rail', 'aria-label': '大肥鱼记忆导航' },
            ...导航组.map((g, gi) => {
              const 组内 = g.名 === 当前组
              return h('button', {
                key: g.名,
                type: 'button',
                className: 'wm-menuHead' + (组内 ? ' wm-menuHeadOn' : ''),
                'aria-current': 组内 ? 'page' : undefined,
                onClick: () => 去(g.项[0][1], g.项[0][2]),
              },
                h('span', { className: 'wm-menuIcon wm-ic' + gi }, g.图),
                h('span', { className: 'wm-menuText' }, g.名),
              )
            }),
          ),
          h('main', { className: 'wm-main' },
            当前组项.length > 1 ? h('div', { className: 'wm-groupTabs', role: 'tablist', 'aria-label': 当前组 },
              ...当前组项.map(([名, 主, 子]) => {
                const 选中 = 页 === 主 && (子 ? 当前子 === 子 : true)
                return h('button', {
                  key: 名,
                  type: 'button',
                  role: 'tab',
                  'aria-selected': 选中 ? 'true' : 'false',
                  className: 'wm-groupTab' + (选中 ? ' wm-groupTabOn' : ''),
                  onClick: () => 去(主, 子),
                }, 名)
              }),
            ) : null,
            h('div', { className: 'wm-pageHead' },
              h('div', { className: 'wm-pageHeadText' },
                h('div', { className: 'wm-pageEyebrow' }, 当前组),
                h('div', { className: 'wm-pageTitle' }, 当前名),
                h('div', { className: 'wm-pageDesc' }, 说明[当前名] || ''),
              ),
            ),
        页 === '总览' ? (总览页签 === '概览'
          ? (态 ? h(总览页, { 态, 观察, 图, 体检 }) : WD.卡('总览', WD.提('加载中…')))
          : (观察 ? h(运行页, { 观察, 刷新 }) : WD.卡('运行', WD.提('加载中…')))) : null,
        页 === '日记' ? (日记态
          ? h(日记页, {
            态: 日记态,
            正文: 日记正文,
            忙: 日记忙,
            结果: 日记结果,
            读: 读日记,
            写今天: 写今天日记,
            重写这天,
          })
          : WD.卡('日记', WD.提('加载中…'))) : null,
        页 === '记忆' ? (记忆页签 === '分片'
          ? (态 ? h(记忆页, { 态, 删, 确认 }) : WD.卡('记忆', WD.提('加载中…')))
          : 记忆页签 === '星云'
            ? (图 ? h(图谱页, { 图, 态 }) : WD.卡('星云', WD.提('加载中…')))
            : (账本 || 态 ? h(审计页, { 态, 账本 }) : WD.卡('审计', WD.提('加载中…')))) : null,
        页 === '主动' ? (主动态
          ? h(主动页, {
            页: 主动页签,
            态: 主动态,
            表单: 主动表单,
            改表单: 设主动表单,
            保存: 保存主动,
            结果: 主动结果,
            忙,
            专注分钟,
            设专注分钟,
            专注: 切换专注,
            重建画像,
            清理素材,
            刷新: () => 拉主动(true),
            轮换会话,
            目标候选,
            拉目标,
          })
          : WD.卡('主动行为', WD.提('加载中…'))) : null,
        页 === '备份' ? h(数据备份页) : null,
        页 === '模型' ? ((模型态 || 搜索态 || 向量态 || 主动态)
          ? h(模型页, {
            页签: 模型页签,
            蒸馏: {
              态: 模型态, 表单: 模型表单, 改表单: 设模型表单,
              保存: 蒸馏操作.保存, 测试: 蒸馏操作.测试, 探测: 蒸馏操作.探测,
              候选, 探测中, 忙, 结果: 模型结果,
            },
            搜索: {
              态: 搜索态, 表单: 搜索表单, 改表单: 设搜索表单,
              保存: 搜索操作.保存, 测试: 搜索操作.测试, 探测: 搜索操作.探测,
              候选: 搜索候选, 探测中: 搜索探测中, 忙, 结果: 搜索结果,
            },
            向量: {
              态: 向量态, 表单: 向量表单, 改表单: 设向量表单,
              保存: 向量操作.保存, 测试: 向量操作.测试, 探测: 向量操作.探测,
              候选: 向量候选, 探测中: 向量探测中, 忙, 结果: 向量结果,
            },
            闲逛: {
              态: 主动态, 表单: 主动表单, 改表单: 设主动表单,
              保存: 保存闲逛模型, 结果: 主动结果, 忙,
            },
            切引擎,
            引擎结果,
          })
          : WD.卡('模型', WD.提('加载中…'))) : null,
          ),
        ),
      )
    }
