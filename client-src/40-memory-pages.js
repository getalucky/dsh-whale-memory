    const 表头 = (k, right) => h('th', { style: Object.assign({}, S.th, { width: 'auto', textAlign: right ? 'right' : 'left' }) }, k)

    /** 成员表：谁在群里、这个人是什么样（条数/最近在上面一行已经有了，不重复铺）。 */
    function 成员表(成员) {
      return h('table', { style: S.table },
        h('thead', null,
          h('tr', null, 表头('成员'), 表头('画像')),
        ),
        h('tbody', null,
          成员.map((m) => h('tr', { key: m.name },
            h('td', { style: Object.assign({}, S.td, { whiteSpace: 'nowrap', verticalAlign: 'top' }) }, m.name),
            h('td', { style: S.td }, m.note || '—'),
          )),
        ),
      )
    }

    /** 画像详情：概览/偏好/常提到用表格铺开；群分片再补一张成员表。 */
    function 画像详情(sc) {
      const p = sc.profile || {}
      const 成员 = Array.isArray(sc.members) ? sc.members : []
      const 行 = (k, v) => h('tr', { key: k },
        h('th', { style: S.th }, k),
        h('td', { style: S.td }, v),
      )
      return h('div', { style: { marginTop: 6 } },
        h('table', { style: S.table },
          h('tbody', null,
            行('概览', p.summary || '—'),
            行('记得', `${p.total ?? 0} 件${p.hot ? ` · 其中 ${p.hot} 件还热` : ''}`),
            行('偏好', (p.traits || []).length ? p.traits.join('、') : '—'),
            行('常提到', (p.topics || []).length ? p.topics.join('、') : '—'),
            行('更新', 时间(p.updated) || '—'),
          ),
        ),
        成员.length ? h('div', { style: { marginTop: 8 } }, 成员表(成员)) : null,
      )
    }

    function 记忆页({ 态, 删, 确认 }) {
      const scopes = (态 && 态.scopes) || []
      const [当前, 设当前] = React.useState(null)
      const [展全部, 设展全部] = React.useState('')
      const [展画像, 设展画像] = React.useState('')
      const [展成员, 设展成员] = React.useState('')
      if (!scopes.length) {
        return WD.卡('记忆分片', WD.提('还没有任何分片。聊过几轮、蒸馏出第一条记忆之后才会出现。'))
      }
      // 一次只展开一个分片，避免前面分片条目多时把后面的挤到看不见
      const sc = scopes.find((x) => x.scope === 当前) || scopes[0]
      // 按记录时间倒序：最新的在最上面，跟审计账本一致
      const 时序 = (a, b) => String(b.created || b.atAbs || b.lastHit || '').localeCompare(String(a.created || a.atAbs || a.lastHit || ''))
      const 待确认 = (sc.items || []).filter((it) => it.state === 'suggested').sort(时序)
      const 已生效 = (sc.items || []).filter((it) => it.state !== 'suggested').sort(时序)
      const 全部开 = 展全部 === sc.scope
      const 画像开 = 展画像 === sc.scope
      const 成员 = Array.isArray(sc.members) ? sc.members : []
      const 成员开 = 展成员 === sc.scope
      // 成员常驻一行，别藏在「详情」里：这个群里都有谁，一眼该看见
      const 成员块 = 成员.length
        ? h('div', { style: { marginTop: 4 } },
          h('div', { style: { display: 'flex', gap: 8, alignItems: 'baseline' } },
            h('span', { className: 'wm-hint', style: { flex: 1 } },
              `成员画像 · ${成员.length} 人：` + 成员.slice(0, 6).map((m) => `${m.name}（${m.items ?? 0}）`).join('、') + (成员.length > 6 ? ' …' : '')),
            h('button', {
              className: 'wm-btn',
              onClick: () => 设展成员(成员开 ? '' : sc.scope),
            }, 成员开 ? '收起' : '全部'),
          ),
          成员开 ? h('div', { style: { marginTop: 6 } }, 成员表(成员)) : null,
        )
        : null
      const 显示条目 = 全部开 ? 已生效 : 已生效.slice(0, 30)

      return h('div', { className: 'wm-body' },
        scopes.length > 1
          ? h('div', { className: 'wm-chips' },
            scopes.map((x) =>
              h('button', {
                key: x.scope,
                className: 'wm-chip' + (x.scope === sc.scope ? ' wm-chipOn' : ''),
                onClick: () => 设当前(x.scope),
              }, `${x.label} · ${x.total}`),
            ),
          )
          : null,
        WD.卡(sc.label,
          h('div', null,
            WD.提(`${sc.total} 条 · 可用 ${sc.active}${待确认.length ? ` · 待确认 ${待确认.length}` : ''} · 更新 ${时间(sc.updatedAt)}`),
            sc.profile && sc.profile.summary
              ? h('div', { style: { marginTop: 4 } },
                h('div', { style: { display: 'flex', gap: 8, alignItems: 'baseline' } },
                  h('span', { className: 'wm-mono', style: { opacity: 0.85, flex: 1 } }, '画像：' + sc.profile.summary),
                  h('button', {
                    className: 'wm-btn',
                    onClick: () => 设展画像(画像开 ? '' : sc.scope),
                  }, 画像开 ? '收起' : '详情'),
                ),
                画像开 ? 画像详情(sc) : null,
              )
              : WD.提('画像还没生成（等下一次蒸馏）'),
            成员块,
            待确认.length
              ? h('div', { className: 'wm-notice wm-warn', style: { marginTop: 8 } },
                h('div', null, '待确认：她主动记下的，你点头才生效（还没进目录，也检索不到）'),
                待确认.map((it) =>
                  h('div', { key: it.id, className: 'wm-row', style: { alignItems: 'center' } },
                    WD.徽(档名.suggested, 'wm-badgeWarn'),
                    h('span', { style: { flex: 1, minWidth: 0, wordBreak: 'break-word' } }, it.text),
                    h('button', {
                      className: 'wm-btn',
                      title: '确认这条，转成正式记忆',
                      onClick: () => 确认(sc.scope, it.id),
                    }, '确认'),
                    h('button', {
                      className: 'wm-btn wm-btnDanger',
                      title: '不要这条（进归档，能找回）',
                      onClick: () => 删(sc.scope, it.id, it.text),
                    }, '×'),
                  ),
                ),
              )
              : null,
            (sc.items || []).length
              ? h('div', { style: { marginTop: 6 } },
                显示条目.map((it) =>
                  h('div', { key: it.id, className: 'wm-listRow' },
                    h('div', { style: { display: 'flex', gap: 7, alignItems: 'baseline', flexWrap: 'wrap' } },
                      WD.徽(档名[it.state] || it.state, it.state === 'active' ? 'wm-badgeOk' : it.state === 'warm' ? 'wm-badgeWarn' : 'wm-badgeOff'),
                      h('span', { style: { flex: 1, minWidth: 0, wordBreak: 'break-word' } }, it.text),
                      h('span', { className: 'wm-hint' }, `${时间(it.created || it.atAbs) || '—'} · h${it.hits}·${it.score}`),
                      h('button', {
                        className: 'wm-btn wm-btnDanger',
                        title: '删掉这条（会进归档，能找回）',
                        onClick: () => 删(sc.scope, it.id, it.text),
                      }, '×'),
                    ),
                  ),
                ),
                已生效.length > 30
                  ? h('div', { style: { marginTop: 6, display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
                    WD.提(全部开 ? `全部 ${已生效.length} 条` : `显示 30 / ${已生效.length} 条`),
                    h('button', {
                      className: 'wm-btn',
                      onClick: () => 设展全部(全部开 ? '' : sc.scope),
                    }, 全部开 ? '收起' : `展开全部（${已生效.length} 条）`),
                  )
                  : null,
              )
              : WD.提('（空）'),
            h('details', { style: { marginTop: 6 } },
              h('summary', { className: 'wm-hint', style: { cursor: 'pointer' } }, '看她现在会读到什么'),
              h('pre', { className: 'wm-mono', style: { whiteSpace: 'pre-wrap', margin: '6px 0 0' } }, sc.render || '（空）'),
            ),
          ),
          WD.徽(`${sc.total} 条`, 'wm-badgeInfo'),
        ),
      )
    }

    // 账本条目只有三类：读记忆、写记忆、注入记忆。界面只认这三类，其余归写。
    const 审计读类 = new Set(['search', 'read', 'profile'])
    const 审计分类 = (kind) => kind === 'render' ? '注入' : 审计读类.has(kind) ? '读' : '写'
    const 审计类色 = { 写: 'wm-badgeInfo', 读: 'wm-badgeOk', 注入: 'wm-badgeOff' }
    const 审计名 = {
      distill: '蒸馏入库', write_skip: '跳过没写', quarantine: '隔离可疑', archive: '归档',
      forget: '删除', revive: '恢复', inbound: '外部拉入', deepen: '加深',
      week: '周记', month: '月记', year: '年记', rebuild: '画像重建',
      'ui-confirm': '界面确认', render: '注入记忆段',
      'tool-save': '保存', 'tool-update': '更新', 'tool-pin': '固定', 'tool-confirm': '确认',
      'tool-correct': '纠正', 'tool-review': '复核', 'experience-add': '加经验',
      search: '检索', read: '读取', profile: '查画像',
    }
    const 审计详情 = (r) => r.text ? ' 「' + r.text + '」'
      : r.item ? ' ' + r.item
      : r.label ? ' ' + r.label + (r.items ? ` · ${r.items} 条` : '') + (r.chars ? ` · ${r.chars} 字` : '')
      : ''

    function 审计页({ 态, 账本 }) {
      const [源, 设源] = React.useState('all')
      const [账, 设账] = React.useState(null)
      React.useEffect(() => {
        let 活 = true
        const q = '/audit?n=120' + (源 === 'all' ? '' : '&source=' + 源)
        get(q).then((r) => { if (活 && r && r.ok) 设账(r) }).catch(() => {})
        return () => { 活 = false }
      }, [源])
      const 源表 = { all: '全部', writes: '写入', reads: '读取', injects: '注入' }
      const 兜底 = (账本 && 账本.rows) || (态 && 态.audit) || []
      const 新鲜 = 账 && 账.source === 源 ? 账.rows : null
      const rows = 新鲜 || (源 === 'all' ? 兜底 : [])
      const 等待 = !新鲜 && 源 !== 'all'
      return WD.卡('审计账本',
        h('div', null,
          WD.提('记忆的读写流水：谁、什么时候、动了哪一条。新的在上面。'),
          h('div', { className: 'wm-chips', style: { margin: '6px 0 8px' } },
            Object.keys(源表).map((k) => h('button', {
              key: k,
              className: 'wm-chip' + (源 === k ? ' wm-chipOn' : ''),
              onClick: () => 设源(k),
            }, 源表[k])),
          ),
          rows.length
            ? h('div', { className: 'wm-mono', style: { marginTop: 2 } },
              rows.slice().reverse().map((r, i) => {
                const 类 = 审计分类(r.kind)
                return h('div', { key: i, style: { padding: '3px 0', borderBottom: '1px dashed rgba(120,130,150,.18)' } },
                  h('span', { style: { opacity: 0.55 } }, 时间(r.at) + ' '),
                  h('span', { className: 'wm-badge ' + 审计类色[类], style: { marginRight: 5 } }, 类),
                  h('span', { style: { color: '#5b5bd6' } }, 审计名[r.kind] || r.kind || '?'),
                  h('span', { style: { opacity: 0.65, marginLeft: 6 } }, r.scope || ''),
                  h('span', null, 审计详情(r)),
                )
              }),
            )
            : WD.提(等待 ? '加载中…' : 源 === 'all' ? '还没有账本记录。' : '这一本还没有记录。'),
        ),
        WD.徽(`${rows.length} 条`, 'wm-badgeInfo'),
      )
    }

