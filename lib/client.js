// dsh-whale-memory · 网页半边
//
// 在 **DSH 设置** 左侧栏加一项「大肥鱼记忆」，两级导航：
//   总览（概览 / 运行）
//   记忆（分片 / 图谱 / 审计）
//   主动（状态 / 素材 / 设置 / 维护）
//   模型（蒸馏 / 找素材）
// 同时在主界面左侧边栏加一个 🐟 图标，点开是同一套页面的整页版。
//
// ⚠ 这个文件必须长这样：window.__ModuleLoader__.load({id, factory})，
//   里面只能 require('react')，不能写 import / export。
//   写成普通 ESM 会让宿主 ClientModuleRegistry.flush 直接抛错，整个 DSH 起不来
//   （2026-10-30 就这么崩过一次）。

window.__ModuleLoader__.load({
  id: 'dsh-whale-memory',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const inject = ['slots']
    const h = React.createElement

    const B = '/dsh-whale-memory/api'
    const get = (p) =>
      fetch(B + p, { cache: 'no-store' })
        .then((r) => r.json())
        .catch(() => null)
    const post = (p, body) =>
      fetch(B + p, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      })
        .then((r) => r.json())
        .catch(() => null)

    const 色彩 = {
      person: '#4a8fe7',
      place: '#3ba55d',
      org: '#b072d8',
      thing: '#e0952e',
      event: '#d0567a',
    }
    const 状态色 = {
      active: '#3ba55d',
      warm: '#e0952e',
      cold: '#8a94a6',
      suggested: '#c99a1e',
      superseded: '#c08ad0',
      archived: '#b6bcc8',
    }

    /** 心跳风格的共享小件：所有页签统一用这套，别再各写各的卡片。 */
    const WD = {
      徽: (text, cls = 'wm-badgeInfo', dot = false) =>
        h('span', { className: 'wm-badge ' + cls }, dot ? h('i', { className: 'wm-dot' }) : null, text),
      格: (label, value, hint, extra) =>
        h('div', { className: 'wm-tile' + (extra ? ' ' + extra : '') },
          h('span', { className: 'wm-tileLabel' }, label),
          h('span', { className: 'wm-tileValue' }, value),
          hint ? h('span', { className: 'wm-tileHint' }, hint) : null,
        ),
      卡: (title, node, right) =>
        h('div', { className: 'wm-card' },
          title
            ? h('div', { className: 'wm-cardHead' },
              h('span', { className: 'wm-cardTitle' }, title),
              right || null,
            )
            : null,
          node,
        ),
      行: (left, right, key) =>
        h('div', { key, className: 'wm-row' },
          h('span', { style: { minWidth: 0, wordBreak: 'break-word' } }, left),
          h('span', { className: 'wm-hint', style: { textAlign: 'right', flex: 'none' } }, right),
        ),
      提: (text, style) => h('div', { className: 'wm-hint', style }, text),
      条: (key, node) => h('div', { key, className: 'wm-listRow' }, node),
    }

    const S = {
      wrap: { padding: '12px 14px 24px', fontSize: 13, lineHeight: 1.7 },
      h: { fontSize: 14, fontWeight: 600, margin: '14px 0 8px' },
      dim: { opacity: 0.62, fontSize: 12 },
      card: {
        border: '1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.1))',
        borderRadius: 10,
        padding: '10px 12px',
        margin: '8px 0',
        background: 'var(--dsw-alias-bg-layer-1, rgba(255,255,255,.65))',
      },
      tabs: { display: 'flex', gap: 6, margin: '10px 0 4px', flexWrap: 'wrap' },
      tab: {
        padding: '4px 12px',
        borderRadius: 999,
        border: '1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.12))',
        cursor: 'pointer',
        background: 'transparent',
        fontSize: 12,
      },
      tabOn: { background: 'var(--dsw-alias-bg-layer-2, rgba(74,143,231,.14))', borderColor: '#4a8fe7', fontWeight: 600 },
      row: { display: 'flex', gap: 8, alignItems: 'baseline', padding: '3px 0' },
      badge: {
        fontSize: 11,
        padding: '0 6px',
        borderRadius: 6,
        color: '#fff',
        lineHeight: '17px',
        flex: '0 0 auto',
      },
      mono: { fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 11.5 },
      table: { width: '100%', borderCollapse: 'collapse', marginTop: 6, fontSize: 12 },
      th: { textAlign: 'left', padding: '4px 8px 4px 0', opacity: 0.62, fontWeight: 500, whiteSpace: 'nowrap', verticalAlign: 'top', width: '5.5em' },
      td: { padding: '4px 0', verticalAlign: 'top', wordBreak: 'break-word' },
      btn: {
        padding: '3px 10px',
        borderRadius: 7,
        border: '1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.14))',
        background: 'transparent',
        cursor: 'pointer',
        fontSize: 12,
      },
      input: {
        width: '100%',
        boxSizing: 'border-box',
        marginTop: 3,
        padding: '5px 8px',
        borderRadius: 7,
        border: '1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.16))',
        background: 'transparent',
        color: 'inherit',
        fontSize: 12.5,
        fontFamily: 'ui-monospace, Consolas, monospace',
      },
      good: { marginTop: 10, padding: '6px 9px', borderRadius: 8, background: 'rgba(59,165,93,.1)', color: '#2e8a4c' },
      bad: { marginTop: 10, padding: '6px 9px', borderRadius: 8, background: 'rgba(208,86,122,.1)', color: '#c23a5e' },
    }

    const 类型名 = { person: '人', place: '地点', org: '组织', thing: '东西', event: '事件' }
    const 档名 = { active: '活跃', warm: '温热', cold: '变冷', suggested: '待确认', superseded: '已取代', archived: '归档' }

    function 时间(t) {
      if (!t) return ''
      const d = new Date(t)
      if (Number.isNaN(d.getTime())) return ''
      const p = (n) => String(n).padStart(2, '0')
      return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
    }

    /** 简易力导向布局：环形起手 + 斥力/弹簧迭代。纯计算，不碰 DOM。 */
    function 布局(nodes, edges, w, hgt) {
      const n = nodes.length
      const pos = nodes.map((_, i) => {
        const a = (i / Math.max(1, n)) * Math.PI * 2
        const r = Math.min(w, hgt) * 0.34
        return { x: w / 2 + Math.cos(a) * r, y: hgt / 2 + Math.sin(a) * r, vx: 0, vy: 0 }
      })
      const at = new Map(nodes.map((x, i) => [x.id, i]))
      for (let it = 0; it < 200; it++) {
        for (let i = 0; i < n; i++) {
          for (let j = i + 1; j < n; j++) {
            let dx = pos[i].x - pos[j].x
            let dy = pos[i].y - pos[j].y
            let d2 = dx * dx + dy * dy || 0.01
            const d = Math.sqrt(d2)
            const f = 2600 / d2
            const ux = dx / d
            const uy = dy / d
            pos[i].vx += ux * f
            pos[i].vy += uy * f
            pos[j].vx -= ux * f
            pos[j].vy -= uy * f
          }
        }
        for (const e of edges) {
          const a = pos[at.get(e.from)]
          const b = pos[at.get(e.to)]
          if (!a || !b) continue
          const dx = b.x - a.x
          const dy = b.y - a.y
          const d = Math.sqrt(dx * dx + dy * dy) || 0.01
          const f = (d - 96) * 0.018
          const ux = dx / d
          const uy = dy / d
          a.vx += ux * f
          a.vy += uy * f
          b.vx -= ux * f
          b.vy -= uy * f
        }
        for (const p of pos) {
          p.vx *= 0.85
          p.vy *= 0.85
          p.x += p.vx
          p.y += p.vy
          p.x = Math.max(36, Math.min(w - 36, p.x))
          p.y = Math.max(22, Math.min(hgt - 22, p.y))
        }
      }
      return pos
    }

    function 图谱页({ 图 }) {
      const W = 560
      const HGT = 360
      const [选中, 设选中] = React.useState(null)
      const nodes = (图 && 图.nodes) || []
      const edges = (图 && 图.edges) || []
      const pos = React.useMemo(() => 布局(nodes, edges, W, HGT), [nodes, edges])
      const at = new Map(nodes.map((x, i) => [x.id, i]))

      if (!nodes.length) {
        return WD.卡('实体图谱',
          h('div', null,
            WD.提('图谱还是空的。'),
            WD.提('只有句子长得像「在X上班」「住在X」「喜欢X」「养了X」「我叫X」「X是Y」时才会连出边；' +
              '现在库里那几条都是时间类的话，抽不出实体，所以是空的。多聊几句带地点/喜好/称呼的就会长出来。'),
          ),
        )
      }

      const 邻居 = new Set()
      if (选中) {
        邻居.add(选中)
        for (const e of edges) {
          if (e.from === 选中) 邻居.add(e.to)
          if (e.to === 选中) 邻居.add(e.from)
        }
      }
      const 亮 = (id) => !选中 || 邻居.has(id)

      const 图区 = h('div', null,
        WD.提(`${nodes.length} 个实体 · ${edges.length} 条关系` + (选中 ? '　点空白处取消选中' : '　点一个点看它连着谁')),
        h('svg', {
          width: '100%',
          viewBox: `0 0 ${W} ${HGT}`,
          style: { display: 'block', marginTop: 8, cursor: 选中 ? 'pointer' : 'default' },
          onClick: () => 设选中(null),
        },
        edges.map((e, i) => {
          const a = pos[at.get(e.from)]
          const b = pos[at.get(e.to)]
          if (!a || !b) return null
          const 高亮 = 选中 && (e.from === 选中 || e.to === 选中)
          return h('line', {
            key: 'e' + i,
            x1: a.x,
            y1: a.y,
            x2: b.x,
            y2: b.y,
            stroke: 高亮 ? '#4a8fe7' : 'rgba(120,130,150,.42)',
            strokeWidth: 高亮 ? 2 : Math.min(2.4, 0.8 + (e.weight || 1) * 0.2),
          })
        }),
        nodes.map((nd, i) => {
          const p = pos[i]
          const 中 = 选中 === nd.id
          const 半径 = Math.min(16, 6 + Math.sqrt((nd.mentions || 1) * 3))
          return h('g', {
            key: nd.id,
            style: { cursor: 'pointer', opacity: 亮(nd.id) ? 1 : 0.25 },
            onClick: (ev) => {
              ev.stopPropagation()
              设选中(中 ? null : nd.id)
            },
          },
          h('circle', {
            cx: p.x,
            cy: p.y,
            r: 半径 + (中 ? 3 : 0),
            fill: 色彩[nd.type] || 色彩.thing,
            stroke: 中 ? '#1b1f27' : 'rgba(255,255,255,.85)',
            strokeWidth: 中 ? 1.6 : 1.2,
          }),
          h('text', {
            x: p.x,
            y: p.y + 半径 + 12,
            textAnchor: 'middle',
            fontSize: 11,
            fill: 'currentColor',
            style: { opacity: 亮(nd.id) ? 0.88 : 0.3 },
          }, nd.name.length > 8 ? nd.name.slice(0, 8) + '…' : nd.name),
          )
        }),
        ),
      )

      const 图例 = h('div', null,
        h('div', { style: { display: 'flex', gap: 12, flexWrap: 'wrap' } },
          Object.keys(类型名).map((k) =>
            h('span', { key: k, style: { display: 'flex', alignItems: 'center', gap: 4, fontSize: 12 } },
              h('span', { style: { width: 9, height: 9, borderRadius: 999, background: 色彩[k] } }),
              类型名[k],
            ),
          ),
        ),
        选中
          ? h('div', { style: { marginTop: 8 } },
            edges
              .filter((e) => e.from === 选中 || e.to === 选中)
              .slice(0, 12)
              .map((e, i) => {
                const 从 = nodes[at.get(e.from)]
                const 到 = nodes[at.get(e.to)]
                if (!从 || !到) return null
                return h('div', { key: i, className: 'wm-row' },
                  h('span', { style: { fontWeight: e.from === 选中 ? 600 : 400 } }, 从.name),
                  h('span', { className: 'wm-hint' }, '—' + e.rel + '→'),
                  h('span', { style: { fontWeight: e.to === 选中 ? 600 : 400 } }, 到.name),
                )
              }),
          )
          : null,
      )

      return h('div', { className: 'wm-body' },
        WD.卡('实体图谱', 图区, WD.徽(`${nodes.length} 节点`, 'wm-badgeInfo')),
        WD.卡('图例', 图例),
      )
    }

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
      const 待确认 = (sc.items || []).filter((it) => it.state === 'suggested')
      const 已生效 = (sc.items || []).filter((it) => it.state !== 'suggested')
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
                      h('span', { className: 'wm-hint' }, `h${it.hits}·${it.score}`),
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

    function 审计页({ 态, 账本 }) {
      const rows = (账本 && 账本.rows) || (态 && 态.audit) || []
      if (!rows.length) return WD.卡('审计账本', WD.提('还没有账本记录。'))
      return WD.卡('审计账本',
        h('div', null,
          WD.提(`最近 ${rows.length} 条记录（写 + 读，新的在上面）`),
          h('div', { className: 'wm-mono', style: { marginTop: 6 } },
            rows.slice().reverse().map((r, i) =>
              h('div', { key: i, style: { padding: '2px 0', borderBottom: '1px dashed rgba(120,130,150,.18)' } },
                h('span', { style: { opacity: 0.55 } }, 时间(r.at) + ' '),
                h('span', { style: { color: '#4a8fe7' } }, r.kind || '?'),
                ' ',
                h('span', null, (r.scope || '') + ' ' + (r.text ? '「' + r.text + '」' : r.item ? r.item : '')),
              ),
            ),
          ),
        ),
        WD.徽(`${rows.length} 条`, 'wm-badgeInfo'),
      )
    }

    function 总览页({ 态, 观察, 图 }) {
      const c = (态 && 态.counts) || {}
      const scopes = (态 && 态.scopes) || []
      const 活跃 = scopes.reduce((n, s) => n + (s.active || 0), 0)
      const 待确认 = scopes.reduce((n, s) => n + (s.suggested || 0), 0)
      const 归档 = scopes.reduce((n, s) => n + (s.archived || 0), 0)
      const p = (观察 && 观察.persona) || {}
      const 信任 = (观察 && 观察.trust) || {}
      return h('div', { className: 'wm-body' },
        h('div', { className: 'wm-grid' },
          WD.格('分片', String(c.scopes ?? 0), '私聊 / 群 / 本机 各自隔离'),
          WD.格('记忆条数', String(c.items ?? 0), `可用 ${活跃} · 待确认 ${待确认} · 归档 ${归档}`, 'wm-tileAccent'),
          WD.格('实体', 图 ? `${(图.nodes || []).length} 个` : '—', 图 ? `${(图.edges || []).length} 条关系` : '图谱还没建'),
          WD.格('人格', p.exists ? `v${p.version || 0}` : '缺 persona.md', p.exists ? `${p.tokens || 0}/${p.limit || 1200} tok${p.overBudget ? ' · 超预算' : ''}` : '固定人格没挂上'),
          WD.格('信任', 信任.origin || '—', 信任.usable ? '读写正常' : '未信任，采集停用'),
          WD.格('版本', String((态 && 态.version) || '?'), '库路径见下'),
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
        WD.卡('库',
          h('div', null,
            WD.提('库路径：' + String((态 && 态.root) || '?')),
            WD.提('人格来自 persona.md（固定，不衰减）；记忆按分片隔离，私聊、群、本地会话互不串；' +
              '长期不碰的条目会变冷、再久会归档，归档的不再进提示词。'),
          ),
        ),
      )
    }

    function 运行页({ 观察 }) {
      const o = 观察 || {}
      const p = o.persona || {}
      const t = o.trust || {}
      const rd = o.reads || {}
      const 行 = (k, v) => WD.行(k, v, k)
      return h('div', { className: 'wm-body' },
        h('div', { className: 'wm-grid' },
          WD.格('人格', p.exists ? `v${p.version || 0}` : '缺失', p.exists ? `${p.tokens || 0}/${p.limit || 1200} tok${p.overBudget ? '（超预算）' : ''}` : 'persona.md 不在', p.overBudget ? 'wm-tileAccent' : ''),
          WD.格('人格探针', p.probes ? `${p.probes.passed}/${p.probes.total}` : '—', (p.probes?.failed || []).map((f) => f.name).join('、') || '全部通过'),
          WD.格('信任', t.origin || '?', t.usable ? '可用' : '未信任'),
          WD.格('读取', String(rd.total || 0), `查 ${rd.search || 0} · 读 ${rd.read || 0} · 画像 ${rd.profile || 0} · 空/拒 ${rd.empty || 0}`, 'wm-tileAccent'),
        ),
        WD.卡('人格迭代',
          p.auto
            ? h('div', null,
              行('新消息', `${p.auto.pendingMessages}/${p.auto.minMessages} 条`),
              行('连续通过', `${p.auto.streak}/${p.auto.minStreak}`),
              行('本周发布', p.auto.publishedThisWeek ? `已发布，下次 ${p.auto.nextPublishAt}` : '未发布'),
            )
            : WD.提('人格自动迭代没开。'),
        ),
        WD.卡('分片容量',
          (o.vault || []).length
            ? h('div', null, (o.vault || []).map((v) =>
              h('div', { key: v.scope, className: 'wm-listRow' },
                h('div', { style: { display: 'flex', gap: 8, alignItems: 'baseline' } },
                  h('span', { style: { flex: 1 } }, v.label),
                  WD.徽(`${v.live} 条`, 'wm-badgeInfo'),
                ),
                WD.提(`副库 ${(v.indexBytes / 1024).toFixed(1)}KB${v.pending ? ' · ⚠ 待重建' : ''} · 读取 ${v.reads} 次 · 深化 ${v.lastDeepen || '—'}`),
              ),
            ))
            : WD.提('还没有分片。'),
        ),
        WD.卡('最近检索',
          (o.searches || []).length
            ? (o.searches || []).map((x, i) =>
              h('div', { key: i, className: 'wm-listRow' },
                h('div', null, `${x.query || '（空）'} · ${x.count || 0} 条${x.hops ? ` · ${x.hops} 跳` : ''}`),
                WD.提((x.top || []).map((y) => (typeof y === 'string' ? y : `${y.id}(${y.score})`)).join(' · ')),
              ),
            )
            : WD.提('还没有检索记录。'),
        ),
        WD.卡('写入跳过',
          (o.skips || []).length
            ? (o.skips || []).map((x, i) =>
              h('div', { key: i, className: 'wm-listRow' },
                h('div', null, `${x.scope} · 跳过 ${x.skipped || 0} 条`),
                WD.提(JSON.stringify(x.reasons || {})),
              ),
            )
            : WD.提('没有跳过记录。'),
        ),
      )
    }

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

    /** 单个模型配置卡：蒸馏和找素材的直连搜索共用一套，只是文案和接口不同。 */
    function 模型配置卡({ 名, 说明, 成功话, 态, 表单, 改表单, 保存, 测试, 探测, 候选, 探测中, 忙, 结果 }) {
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
      const 行 = (m) =>
        h('div', { key: m.id, className: 'wm-row' },
          h('button', {
            className: 'wm-btn wm-mono',
            title: m.why || '',
            onClick: () => 改表单(Object.assign({}, 表单, { model: m.id })),
          }, m.id),
          h('span', { className: 'wm-hint', style: { color: 探测状态色[m.state] } },
            (探测状态名[m.state] || m.state) + (m.ms ? ` · ${m.ms}ms` : '')),
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
            输入('model', '模型名', 'text', 名.includes('搜索') ? '带联网能力的模型名' : 'deepseek-chat'),
            输入('key', 'API Key', 'password', v.hasKey ? `已保存 ${v.keyMasked}，留空不改` : '没填就是不鉴权（本地 Ollama 常见）'),
            h('div', { className: 'wm-saveBar', style: { marginTop: 12 } },
              h('button', { className: 'wm-btn wm-btnPrimary', disabled: 忙, onClick: 保存 }, 忙 ? '处理中…' : '保存'),
              h('button', { className: 'wm-btn', disabled: 忙 || 探测中, onClick: 测试 }, '测试连通'),
              h('button', {
                className: 'wm-btn',
                disabled: 忙 || 探测中 || !(表单.base || v.base),
                onClick: 探测,
              }, 探测中 ? '探测中…' : '探测可用模型'),
              WD.徽(v.ready ? '已就绪' : '未配置', v.ready ? 'wm-badgeOk' : 'wm-badgeOff', Boolean(v.ready)),
              v.from === 'env' ? h('span', { className: 'wm-hint' }, '当前值来自环境变量，保存后以这里为准') : null,
            ),
            WD.提('探测会先拉模型列表，再逐个发一条最小消息，约 10–20 秒，消耗少量额度；要填 API Key 才能探测。'),
            结果
              ? h('div', { className: 'wm-notice ' + (结果.ok ? 'wm-good' : 'wm-bad') },
                结果.ok ? 成功话 : '没通 · ' + (结果.why || '未知原因'))
              : null,
            候选
              ? h('div', { style: { marginTop: 8 } },
                WD.提(`可用 ${候选.counts.usable} · 限流 ${候选.counts.limited} · 非对话 ${候选.counts.unusable}` +
                  (候选.counts.timeout ? ` · 超时 ${候选.counts.timeout}` : '') +
                  (候选.counts.denied ? ` · 无权限 ${候选.counts.denied}` : '') +
                  (候选.counts.auth ? ` · 未授权 ${候选.counts.auth}` : '') +
                  (候选.truncated ? ' · 只测了前 40 个' : '')),
                可用.length ? h('div', { style: { marginTop: 5 } }, 可用.map(行)) : null,
                限流.length ? h('div', { style: { marginTop: 5 } }, 限流.map(行)) : null,
                其它.length ? h('div', { style: { marginTop: 5 } }, 其它.map(行)) : null,
                不可用.length
                  ? h('div', { style: { marginTop: 6 } },
                    h('button', { className: 'wm-btn', onClick: () => 设展开(!展开) },
                      展开 ? '收起非对话模型' : `展开 ${不可用.length} 个非对话模型`),
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
            WD.提('key 明文存在这个文件里，只有本机能读；界面只显示尾巴。向量模型（embedding）和人格审查要单独指定还是走环境变量；人格审查没单独配就跟着蒸馏模型。'),
          ),
        ),
      )
    }

    /** 主动闲逛用的那一路 agent：配置存在 beat config 里，只有 model / provider。 */
    function 闲逛模型卡({ 态, 表单, 改表单, 保存, 结果, 忙 }) {
      if (!表单) return WD.卡('闲逛 agent 模型', WD.提('读取主动行为配置…'))
      const f = 表单
      const c = (态 && 态.config) || {}
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
            WD.提('默认走这条：在宿主里真开一路 agent，带 web_search 翻几轮再回来。留空跟全局默认；这里配的 model / provider 和蒸馏、直连搜索互不影响。'),
            文('model', '模型名', '留空跟全局默认；只影响宿主里跑的那一路'),
            文('provider', 'provider', '留空跟全局默认'),
            h('div', { className: 'wm-saveBar', style: { marginTop: 12 } },
              h('button', { className: 'wm-btn wm-btnPrimary', disabled: 忙, onClick: 保存 },
                忙 ? '保存中…' : '保存'),
              WD.徽(c.model || '跟全局默认', c.model ? 'wm-badgeInfo' : 'wm-badgeOff'),
            ),
            结果 ? h('div', { className: 'wm-notice ' + (结果.ok ? 'wm-good' : 'wm-bad') }, 结果.text) : null,
          ),
        ),
        h('div', { style: { padding: '0 2px' } },
          WD.提('存在主动行为的 beat 配置里，保存后下一跳闲逛生效；「直连搜索模型」只负责一轮联网找素材，不跑 agent。'),
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
              ? '默认：在宿主里真开一路 agent，带 web_search 翻几轮，找回来的素材更耐聊。下面挑它用哪个模型。'
              : '备选：不开 agent，直接把 prompt 发给一个自带联网的模型，一问一答。省 token，但只有一轮。'),
            结果 ? h('div', { className: 'wm-notice ' + (结果.ok ? 'wm-good' : 'wm-bad') }, 结果.text) : null,
          ),
          WD.徽(引擎 === 'agent' ? '当前：agent' : '当前：直连', 'wm-badgeInfo'),
        ),
        引擎 === 'agent'
          ? h(闲逛模型卡, 闲逛)
          : h(模型配置卡, Object.assign({}, 搜索, {
            名: '直连搜索模型',
            成功话: `通了 · ${(搜索.结果 && 搜索.结果.ms) || 0}ms · 下一跳闲逛就用这个模型联网找素材`,
            说明: '必须填「自己能联网」的模型（Kimi / 智谱联网 / OpenRouter :online 之类）。它只发一轮，不会调工具；没配好会自动回退闲逛 agent。',
          })),
      )
    }

    function 模型页({ 页签, 设页签, 蒸馏, 搜索, 闲逛, 切引擎, 引擎结果 }) {
      return h('div', { className: 'wm-body' },
        h('div', { className: 'wm-subtabs' },
          ['蒸馏', '找素材'].map((k) =>
            h('button', {
              key: k,
              className: 'wm-subtab' + (页签 === k ? ' wm-subtabOn' : ''),
              onClick: () => 设页签(k),
            }, k),
          ),
        ),
        页签 === '蒸馏'
          ? h(模型配置卡, Object.assign({}, 蒸馏, {
            名: '蒸馏模型',
            成功话: `通了 · ${(蒸馏.结果 && 蒸馏.结果.ms) || 0}ms · 保存后下一次蒸馏就生效，不用重启 DSH`,
            说明: '抽记忆用的模型。填完点「测试连通」，通了再保存。任何 OpenAI 兼容端点都行（官方 / one-api / 本地 Ollama）。',
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
                  ? { background: 'rgba(74,143,231,.13)', borderColor: 'rgba(74,143,231,.35)', color: '#2b8fe8', fontWeight: 600 }
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
    function 主动表单从(b) {
      const c = (b && b.config) || {}
      return {
        enabled: c.enabled !== false,
        dryRun: c.dryRun !== false,
        windows: Array.isArray(c.windows) ? c.windows.map((x) => `${x.start}-${x.end}`).join(', ') : '',
        quietHours: c.quietHours ? `${c.quietHours.start}-${c.quietHours.end}` : '',
        minIntervalHours: String(c.minIntervalHours ?? 4),
        maxWanderPerDay: String(c.maxWanderPerDay ?? 2),
        refillBelow: String(c.refillBelow ?? 6),
        maxDailySend: String(c.maxDailySend ?? 10),
        cooldownMinutes: String(c.cooldownMinutes ?? 30),
        busyMinutes: String(c.busyMinutes ?? 10),
        tokenSaverIdleMinutes: String(c.tokenSaverIdleMinutes ?? 30),
        maxMaterial: String(c.maxMaterial ?? 30),
        sessionRotateDays: String(c.sessionRotateDays ?? 7),
        interests: Array.isArray(c.interests) ? c.interests.join('、') : '',
        model: c.model || '',
        provider: c.provider || '',
        targetSessionId: c.targetSessionId || '',
        targetSessionLabel: c.targetSessionLabel || '',
        targetSessionKind: c.targetSessionKind || '',
      }
    }

    function 表单有改动(f, c) {
      const base = 主动表单从({ config: c || {} })
      return Object.keys(base).some((k) => String(f?.[k] ?? '') !== String(base[k] ?? ''))
    }

    /** 模仿 dsh-heartbeat 的原生面板：只注入一次样式，类名统一 wm- 前缀。 */
    let 主动样式已注入 = false
    function 确保主动样式() {
      if (主动样式已注入 || typeof document === 'undefined') return
      主动样式已注入 = true
      const el = document.createElement('style')
      el.id = 'whale-beat-style'
      el.textContent = [
        '.wm-panel{display:flex;flex-direction:column;gap:12px;font-size:13px;line-height:1.65}',
        '.wm-hero{position:relative;overflow:hidden;border-radius:16px;padding:15px 17px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.25));background:linear-gradient(120deg,rgba(74,143,231,.20),rgba(124,92,255,.13) 46%,rgba(74,143,231,0) 82%)}',
        '.wm-hero::after{content:"";position:absolute;right:-40px;top:-70px;width:220px;height:220px;border-radius:50%;background:radial-gradient(circle,rgba(74,143,231,.30),transparent 68%);filter:blur(6px);pointer-events:none}',
        '.wm-heroTop{position:relative;display:flex;align-items:center;gap:12px;flex-wrap:wrap}',
        '.wm-logo{flex:none;width:40px;height:40px;border-radius:13px;display:grid;place-items:center;font-size:20px;background:linear-gradient(135deg,#4a8fe7,#7c5cff);box-shadow:0 8px 20px rgba(74,143,231,.34)}',
        '.wm-heroText{display:flex;flex-direction:column;gap:2px;min-width:0}',
        '.wm-heroTitle{font-size:16px;font-weight:700;letter-spacing:.3px;color:var(--dsw-alias-label-primary)}',
        '.wm-heroSub{font-size:11.5px;letter-spacing:.4px;color:var(--dsw-alias-label-tertiary)}',
        '.wm-heroRight{margin-left:auto;display:flex;align-items:center;gap:6px;flex-wrap:wrap;justify-content:flex-end}',
        '.wm-heroRight .wm-badge{background:var(--dsw-alias-bg-layer-1,rgba(255,255,255,.55));color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.25))}',
        '.wm-badge{display:inline-flex;align-items:center;gap:5px;height:23px;padding:0 9px;border-radius:999px;font-size:11px;font-weight:600;white-space:nowrap}',
        '.wm-badgeOk{background:rgba(61,220,151,.16);color:#2fbf7f}',
        '.wm-badgeInfo{background:rgba(74,143,231,.16);color:#2b8fe8}',
        '.wm-badgeWarn{background:rgba(245,184,61,.20);color:#c98b12}',
        '.wm-badgeOff{background:rgba(140,150,170,.18);color:var(--dsw-alias-label-tertiary)}',
        '.wm-tags{display:flex;flex-wrap:wrap;gap:6px}',
        '.wm-tag{display:inline-flex;align-items:center;gap:5px;height:24px;padding:0 9px;border-radius:999px;background:rgba(74,143,231,.14);color:#2b8fe8;font-size:11.5px;font-weight:600;border:1px solid rgba(74,143,231,.28)}',
        '.wm-tagX{border:none;background:transparent;color:inherit;font-size:13px;line-height:1;padding:0;cursor:pointer;opacity:.7}',
        '.wm-tagX:hover{opacity:1}',
        '.wm-tagRow{display:flex;gap:8px;align-items:center}',
        '.wm-tagRow .wm-tagInput{flex:1;min-width:120px;width:auto}',
        '.wm-dot{width:6px;height:6px;border-radius:50%;background:currentColor;box-shadow:0 0 7px currentColor}',
        '.wm-tabs{display:flex;flex-wrap:wrap;gap:5px;padding:5px;border-radius:14px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.25));background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.08))}',
        '.wm-tab{height:29px;padding:0 13px;border-radius:10px;border:none;background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;cursor:pointer}',
        '.wm-tab:hover{background:rgba(74,143,231,.12);color:var(--dsw-alias-label-primary)}',
        '.wm-tabOn,.wm-tabOn:hover{background:linear-gradient(135deg,#4a8fe7,#6b8bff);color:#fff;font-weight:600;box-shadow:0 5px 16px rgba(74,143,231,.32)}',
        '.wm-body{display:flex;flex-direction:column;gap:11px}',
        '.wm-statusStrip{display:flex;align-items:center;gap:7px;flex-wrap:wrap;padding:7px 10px;border-radius:11px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.20));background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.05))}',
        '.wm-card{border-radius:14px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.25));background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.06));padding:13px 15px;display:flex;flex-direction:column;gap:9px}',
        '.wm-cardHead{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}',
        '.wm-cardTitle{display:flex;align-items:center;gap:8px;font-size:13.5px;font-weight:600;color:var(--dsw-alias-label-primary)}',
        '.wm-cardTitle::before{content:"";flex:none;width:3px;height:15px;border-radius:2px;background:linear-gradient(180deg,#4a8fe7,#7c5cff)}',
        '.wm-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:9px}',
        '.wm-tile{border-radius:12px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.22));background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.04));padding:10px 12px;display:flex;flex-direction:column;gap:4px;transition:transform .16s,border-color .16s}',
        '.wm-tile:hover{transform:translateY(-1px);border-color:rgba(74,143,231,.50)}',
        '.wm-tileWide{grid-column:span 2}',
        '.wm-tileLabel{font-size:10.5px;letter-spacing:.4px;color:var(--dsw-alias-label-tertiary)}',
        '.wm-tileValue{font-size:14px;font-weight:600;line-height:1.35;color:var(--dsw-alias-label-primary);word-break:break-word}',
        '.wm-tileHint{font-size:11px;color:var(--dsw-alias-label-tertiary);word-break:break-word}',
        '.wm-tileAccent{background:linear-gradient(135deg,rgba(74,143,231,.15),rgba(124,92,255,.09))}',
        '.wm-bar{height:5px;border-radius:999px;background:rgba(127,127,127,.18);overflow:hidden;margin-top:2px}',
        '.wm-barFill{height:100%;border-radius:999px;background:linear-gradient(90deg,#4a8fe7,#7c5cff)}',
        '.wm-barWarn{background:linear-gradient(90deg,#e0952e,#d0567a)}',
        '.wm-row{display:flex;justify-content:space-between;gap:12px;padding:3px 0;border-bottom:1px dashed rgba(127,127,127,.12)}',
        '.wm-row:last-child{border-bottom:none}',
        '.wm-hint{font-size:11.5px;color:var(--dsw-alias-label-tertiary);line-height:1.55}',
        '.wm-mono{font-family:ui-monospace,Consolas,monospace;font-size:11px}',
        '.wm-listRow{padding:7px 0;border-bottom:1px dashed rgba(127,127,127,.12)}',
        '.wm-listRow:last-child{border-bottom:none}',
        '.wm-subtabs{display:flex;gap:2px;flex-wrap:wrap;padding:3px;border-radius:10px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.18));background:rgba(127,127,127,.06);width:max-content;max-width:100%}',
        '.wm-subtab{height:26px;padding:0 11px;border-radius:7px;border:none;background:transparent;color:var(--dsw-alias-label-secondary);font-size:11.5px;cursor:pointer;white-space:nowrap}',
        '.wm-subtab:hover{background:rgba(74,143,231,.10);color:var(--dsw-alias-label-primary)}',
        '.wm-subtab:disabled{opacity:.45;cursor:default}',
        '.wm-subtabOn,.wm-subtabOn:hover{background:var(--dsw-alias-bg-layer-1,rgba(255,255,255,.72));color:#2b8fe8;font-weight:600;box-shadow:0 1px 4px rgba(0,0,0,.10)}',
        '.wm-chips{display:flex;gap:6px;flex-wrap:wrap}',
        '.wm-chip{height:24px;padding:0 9px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.22));background:transparent;color:var(--dsw-alias-label-secondary);font-size:11.5px;cursor:pointer}',
        '.wm-chip:hover{border-color:rgba(74,143,231,.40);color:var(--dsw-alias-label-primary)}',
        '.wm-chipOn,.wm-chipOn:hover{background:rgba(74,143,231,.14);border-color:rgba(74,143,231,.38);color:#2b8fe8;font-weight:600}',
        '.wm-switchRow{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:5px 0}',
        '.wm-switch{flex:none;width:38px;height:21px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.28));background:rgba(127,127,127,.18);position:relative;cursor:pointer;transition:background .16s,border-color .16s}',
        '.wm-switch i{position:absolute;left:2px;top:2px;width:15px;height:15px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.25);transition:left .16s}',
        '.wm-switchOn{background:linear-gradient(135deg,#4a8fe7,#7c5cff);border-color:transparent}',
        '.wm-switchOn i{left:20px}',
        '.wm-field{display:flex;flex-direction:column;gap:3px}',
        '.wm-input{width:100%;box-sizing:border-box;padding:5px 8px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.22));background:var(--dsw-specific-input-bg,rgba(127,127,127,.06));color:var(--dsw-alias-label-primary);font-size:12px;outline:none}',
        '.wm-input:focus{border-color:rgba(74,143,231,.55)}',
        '.wm-btn{height:27px;padding:0 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.24));background:rgba(127,127,127,.08);color:var(--dsw-alias-label-primary);font-size:11.5px;cursor:pointer}',
        '.wm-btn:hover{border-color:rgba(74,143,231,.45)}',
        '.wm-btn:disabled{opacity:.5;cursor:default}',
        '.wm-btnPrimary{border:none;background:linear-gradient(135deg,#4a8fe7,#6b8bff);color:#fff;font-weight:600;box-shadow:0 4px 14px rgba(74,143,231,.25)}',
        '.wm-btnDanger{border-color:rgba(208,86,122,.45);color:#c23a5e}',
        '.wm-saveBar{display:flex;align-items:center;gap:9px;flex-wrap:wrap;padding-top:2px}',
        '.wm-notice{padding:6px 9px;border-radius:8px;font-size:11.5px}',
        '.wm-good{background:rgba(59,165,93,.10);color:#2e8a4c}',
        '.wm-bad{background:rgba(208,86,122,.10);color:#c23a5e}',
        '.wm-warn{background:rgba(224,149,46,.12);color:#b7791f}',
        '.wm-page{display:flex;flex-direction:column;gap:12px;padding:16px 20px 26px;box-sizing:border-box;max-height:calc(100vh - 120px);overflow-y:auto;overflow-x:hidden;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}',
        '.wm-page > .wm-panel{flex:0 0 auto}',
      ].join('\n')
      document.head?.appendChild?.(el)
    }

    function 主动页({ 态, 表单, 改表单, 保存, 结果, 忙, 专注分钟, 设专注分钟, 专注, 重建画像, 清理素材, 刷新, 轮换会话, 目标候选, 拉目标 }) {
      确保主动样式()
      const b = 态 || {}
      const c = b.config || {}
      const s = b.state || {}
      const f = 表单 || {}
      const sched = b.scheduler || {}
      const env = s.lastEnv || {}
      const [页, 设页] = React.useState('状态')
      const [素材筛, 设素材筛] = React.useState('all')
      const [轮换确认, 设轮换确认] = React.useState(false)
      const [新兴趣, 设新兴趣] = React.useState('')
      if (!表单) return h('div', { className: 'wm-hint' }, '加载中…')
      const 改 = (k, v) => 改表单(Object.assign({}, f, { [k]: v }))
      const 有改动 = 表单有改动(f, c)

      const 兴趣表 = () => String(f.interests || '')
        .split(/[,，;；\n、]+/)
        .map((x) => x.trim())
        .filter(Boolean)
      const 设兴趣表 = (rows) => 改('interests', rows.join('、'))
      const 加兴趣 = () => {
        const 新 = String(新兴趣 || '').split(/[,，;；\n、]+/).map((x) => x.trim()).filter(Boolean)
        if (!新.length) return
        const 合 = 兴趣表()
        for (const x of 新) if (!合.includes(x)) 合.push(x)
        设兴趣表(合.slice(0, 20))
        设新兴趣('')
      }
      const 删兴趣 = (name) => 设兴趣表(兴趣表().filter((x) => x !== name))

      const 数 = (k, 名, 提示, 宽) =>
        h('label', { key: k, className: 'wm-field' },
          h('span', { className: 'wm-hint' }, 名),
          h('input', {
            type: 'number',
            value: f[k] === 0 || f[k] ? String(f[k]) : '',
            placeholder: 提示,
            className: 'wm-input',
            style: 宽 ? { width: 宽 } : null,
            onChange: (e) => 改(k, e.target.value),
          }),
        )
      const 开关 = (k, 名, 说明) =>
        h('div', { key: k, className: 'wm-switchRow' },
          h('div', null,
            h('div', { style: { fontWeight: 600 } }, 名),
            h('div', { className: 'wm-hint' }, 说明),
          ),
          h('button', {
            type: 'button',
            className: 'wm-switch' + (f[k] ? ' wm-switchOn' : ''),
            'aria-pressed': Boolean(f[k]),
            onClick: () => 改(k, !f[k]),
          }, h('i')),
        )
      // 时间窗用原生 time 选择器；表单里仍存 "HH:MM-HH:MM, ..." 的字符串。
      const 时间值 = (s) => {
        const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim())
        if (!m || Number(m[1]) > 23) return ''
        return `${String(Number(m[1])).padStart(2, '0')}:${m[2]}`
      }
      const 拆窗 = (text) => String(text || '')
        .split(/[,，;；\n]+/)
        .map((x) => x.trim())
        .filter(Boolean)
        .map((x) => {
          const m = /^(.*?)\s*(?:-|~|—|–|至|到)\s*(.*)$/.exec(x)
          return m ? { start: 时间值(m[1]), end: 时间值(m[2]) } : { start: 时间值(x), end: '' }
        })
      const 拼窗 = (rows) => rows
        .filter((r) => r.start || r.end)
        .map((r) => `${r.start}-${r.end}`)
        .join(', ')
      const 改窗行 = (rows) => 改('windows', 拼窗(rows))
      const 窗编辑器 = () => {
        const rows = 拆窗(f.windows)
        const 时 = (r, i, k, label) => h('input', {
          type: 'time',
          className: 'wm-input',
          style: { width: 128 },
          value: r[k],
          'aria-label': label,
          onChange: (e) => {
            const next = rows.slice()
            next[i] = Object.assign({}, r, { [k]: e.target.value })
            改窗行(next)
          },
        })
        return h('div', null,
          rows.length
            ? rows.map((r, i) => h('div', {
              key: 'win' + i,
              style: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginTop: 4 },
            },
              时(r, i, 'start', `第 ${i + 1} 个时间窗开始`),
              h('span', { className: 'wm-hint' }, '到'),
              时(r, i, 'end', `第 ${i + 1} 个时间窗结束`),
              h('button', {
                type: 'button',
                className: 'wm-btn',
                disabled: 忙,
                title: '删除这个时间窗',
                'aria-label': `删除第 ${i + 1} 个时间窗`,
                onClick: () => 改窗行(rows.filter((_, j) => j !== i)),
              }, '×'),
            ))
            : h('span', { className: 'wm-hint' }, '还没有时间窗，不会闲逛。'),
          h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 6 } },
            h('button', {
              type: 'button',
              className: 'wm-btn',
              disabled: 忙,
              onClick: () => 改窗行([...rows, { start: '11:00', end: '15:00' }]),
            }, '加一个时间窗'),
            h('span', { className: 'wm-hint' }, '每行两格都要填；跨零点写 22:00-02:00；全删 = 不闲逛。'),
          ),
        )
      }
      const 静窗 = () => 拆窗(f.quietHours)[0] || { start: '', end: '' }
      const 设静窗 = (patch) => {
        const r = Object.assign({}, 静窗(), patch)
        改('quietHours', (r.start || r.end) ? `${r.start}-${r.end}` : '')
      }
      const 静编辑器 = () => {
        const r = 静窗()
        const 时 = (k, label) => h('input', {
          type: 'time',
          className: 'wm-input',
          style: { width: 128 },
          value: r[k],
          'aria-label': label,
          onChange: (e) => 设静窗({ [k]: e.target.value }),
        })
        return h('div', { style: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginTop: 4 } },
          时('start', '静默时段开始'),
          h('span', { className: 'wm-hint' }, '到'),
          时('end', '静默时段结束'),
          h('button', {
            type: 'button',
            className: 'wm-btn',
            disabled: 忙,
            onClick: () => 改('quietHours', ''),
          }, '清空'),
        )
      }
      // 统一用 WD 这套小件，别在页面里再写一份，免得样式越改越散。
      const 徽 = WD.徽
      const 格 = WD.格
      const 卡 = WD.卡

      const 调度 = sched.active === 'heartbeat'
        ? { cls: 'wm-badgeWarn', text: 'heartbeat 占用' }
        : sched.envOff
          ? { cls: 'wm-badgeOff', text: '环境变量已停' }
          : c.enabled === false
            ? { cls: 'wm-badgeOff', text: '未启用' }
            : { cls: 'wm-badgeOk', text: 'beat 调度' }
      const 闸门 = s.lastGate || '—'
      const 闸门名 = {
        pass: '通过', dry: '预演', delivered: '已投递', delivery_failed: '投递失败',
        target_busy: '目标会话被占用',
        busy: '你在忙', quiet_hours: '静默时段', token_saver: '离开/锁屏', focus_mode: '专注模式',
        daily_cap: '今日已满', cooldown: '冷却中', no_material: '没素材', duplicate: '都投过', backoff: '降频中',
        'no-target': '未绑投递目标',
      }[闸门] || 闸门
      const 今日 = Number(s.daily?.sent) || 0
      const 上限 = Number(c.maxDailySend) || 0
      const 比例 = 上限 > 0 ? Math.min(1, 今日 / 上限) : 0
      const 素材源 = { all: '全部', chat: '会话', web: '搜索', public: '公共' }
      const 素材 = (Array.isArray(b.materials) ? b.materials : [])
        .filter((m) => 素材筛 === 'all' || String(m.source || '').startsWith(素材筛))
      const 反馈 = Array.isArray(b.feedback) ? b.feedback : []
      const 投递 = Array.isArray(b.deliveries) ? b.deliveries : []
      const 画像 = b.profile || {}
      const 画像数 = 画像.counts || {}
      const 环境字 = env.locked ? '锁屏' : env.busy ? '你在忙' : env.away ? '离开' : env.source === 'unknown' ? '未知' : '在场'
      const 环境色 = env.locked || env.away ? 'wm-badgeWarn' : env.busy ? 'wm-badgeInfo' : 'wm-badgeOk'

      const 状态页 = () => h('div', { className: 'wm-body' },
        h('div', { className: 'wm-card' },
          h('div', { className: 'wm-cardHead' },
            h('span', { className: 'wm-cardTitle' }, '这一跳'),
            h('span', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
              徽(环境字, 环境色, true),
              徽(sched.heartbeat ? 'heartbeat 占位' : 'beat', sched.heartbeat ? 'wm-badgeWarn' : 'wm-badgeInfo'),
            ),
          ),
          h('div', { className: 'wm-grid' },
            格('上次跳', s.lastTickAt ? 时间(s.lastTickAt) : '—', '每分钟看一次节律'),
            格('上次投递', s.lastDeliveryAt ? 时间(s.lastDeliveryAt) : '—', s.pendingDelivery ? `待报账 ${s.pendingDelivery.deliveryId || ''}` : '没有待报账'),
            h('div', { className: 'wm-tile' },
              h('span', { className: 'wm-tileLabel' }, '今日投递'),
              h('span', { className: 'wm-tileValue' }, `${今日} / ${上限}`),
              h('div', { className: 'wm-bar' }, h('div', {
                className: 'wm-barFill' + (比例 >= 1 ? ' wm-barWarn' : ''),
                style: { width: Math.round(比例 * 100) + '%' },
              })),
            ),
            格('素材', `${b.counts?.active ?? 0} 条`, `会话 ${b.counts?.bySource?.chat ?? 0} · 搜索 ${b.counts?.bySource?.web ?? 0} · 公共 ${b.counts?.bySource?.public ?? 0}`),
            格('上次闸门', 闸门名, s.lastGateAt ? 时间(s.lastGateAt) : ''),
            格('专用会话', b.sessions?.sessionId ? b.sessions.sessionId.slice(0, 16) + '…' : '还没建', b.sessions?.ageDays ? `已用 ${b.sessions.ageDays} 天` : ''),
            格('闲置', env.idleMinutes != null ? `${env.idleMinutes} 分钟` : '—', env.source === 'idle-probe' ? '键鼠探针' : env.source === 'last-message' ? '最后一条消息' : '刚启动', 'wm-tileAccent'),
            格('素材反馈', `${反馈.filter((x) => (Number(x.engagement) || 0) > 0).length} 正 / ${反馈.filter((x) => (Number(x.engagement) || 0) < 0).length} 负`, '只调权重，不写偏好'),
          ),
          s.deliveryFailed
            ? h('div', { className: 'wm-notice wm-warn' }, `今天投递失败：${s.deliveryFailed.why || '未知'} · 今天不再重试同一目标`)
            : null,
        ),
        卡('最近投递', 投递.length
          ? 投递.map((d) => h('div', { key: d.id || d.at, className: 'wm-row' },
            h('span', { className: 'wm-mono' }, `${d.id || '—'} · ${d.outcome || '?'}`),
            h('span', { className: 'wm-hint' }, `${(d.materialIds || []).length} 条 · ${时间(d.at)}`),
          ))
          : h('div', { className: 'wm-hint' }, '还没有投递记录。')),
        卡('反馈账本', 反馈.length
          ? 反馈.map((x, i) => h('div', { key: `${x.at}-${i}`, className: 'wm-row' },
            h('span', null,
              徽(x.source || '?', Number(x.engagement) > 0 ? 'wm-badgeOk' : Number(x.engagement) < 0 ? 'wm-badgeWarn' : 'wm-badgeOff'),
              h('span', { className: 'wm-mono', style: { marginLeft: 6 } }, x.deliveryId || '—'),
            ),
            h('span', { className: 'wm-hint' }, `${x.mode || x.source} · ${Number(x.engagement) >= 0 ? '+' : ''}${Number(x.engagement) || 0}${x.replyHash ? ` · ${x.replyHash.slice(0, 8)}` : ''}`),
          ))
          : h('div', { className: 'wm-hint' }, '还没有反馈。投递后等她回一句。')),
      )

      const 素材页 = () => h('div', { className: 'wm-body' },
        h('div', { className: 'wm-card' },
          h('div', { className: 'wm-cardHead' },
            h('span', { className: 'wm-cardTitle' }, '当前素材'),
            h('div', { className: 'wm-chips' },
              Object.keys(素材源).map((k) => h('button', {
                key: k,
                className: 'wm-chip' + (素材筛 === k ? ' wm-chipOn' : ''),
                onClick: () => 设素材筛(k),
              }, `${素材源[k]} ${k === 'all' ? (b.counts?.active ?? 0) : (b.counts?.bySource?.[k] ?? 0)}`)),
            ),
          ),
          素材.length
            ? 素材.map((m) => h('div', { key: m.id, className: 'wm-listRow' },
              h('div', { style: { display: 'flex', gap: 7, alignItems: 'baseline', flexWrap: 'wrap' } },
                徽(String(m.source || '').split(':')[0], m.source?.startsWith('chat') ? 'wm-badgeOk' : m.source?.startsWith('web') ? 'wm-badgeInfo' : 'wm-badgeOff'),
                h('span', { className: 'wm-mono' }, m.id),
                h('span', { className: 'wm-hint' }, `权重 ${m.weight} · boost ${Number(m.boost) >= 0 ? '+' : ''}${m.boost || 0} · 用过 ${m.usedCount || 0} 次${m.focus ? ` · ${m.focus}` : ''}`),
              ),
              h('div', { style: { marginTop: 2 } }, m.text),
            ))
            : h('div', { className: 'wm-hint' }, '这一类还没有素材。'),
        ),
      )

      const 设目标 = (id) => {
        const it = ((目标候选 && 目标候选.items) || []).find((x) => x.id === id)
        改表单(Object.assign({}, f, {
          targetSessionId: id,
          targetSessionLabel: (it && it.label) || (id ? '手动绑定' : ''),
          targetSessionKind: (it && it.kind) || (id ? 'custom' : ''),
        }))
      }
      const 候选表 = (目标候选 && 目标候选.items) || []
      const 已绑定 = String(f.targetSessionId || '')
      const 选中的候选 = 候选表.find((x) => x.id === 已绑定) || null

      const 配置页 = () => h('div', { className: 'wm-body' },
        卡('开关', h('div', null,
          开关('enabled', '启用主动行为', '关掉就完全不动；重启后仍按这个值。'),
          开关('dryRun', '只预演，不真的发', '先看素材包像不像人话，再关预演。'),
        )),
        卡('节律', h('div', null,
          h('div', { className: 'wm-field' },
            h('span', { className: 'wm-hint' }, '允许闲逛的时间窗'),
            窗编辑器(),
          ),
          h('div', { className: 'wm-field', style: { marginTop: 10 } },
            h('span', { className: 'wm-hint' }, '静默时段'),
            静编辑器(),
            h('span', { className: 'wm-hint' }, '两格都填才生效；点「清空」关掉。'),
          ),
          h('div', { className: 'wm-grid', style: { marginTop: 10 } },
            数('minIntervalHours', '两次闲逛最小间隔（小时）', '1–72'),
            数('maxWanderPerDay', '每天最多闲逛次数', '0–20'),
            数('refillBelow', '素材少于多少条时补货', '0–30'),
          ),
        )),
        卡('投递与忙闲', h('div', { className: 'wm-grid' },
          数('maxDailySend', '每日最多投递', '0–50'),
          数('cooldownMinutes', '两次投递最小间隔（分钟）', '0–1440'),
          数('busyMinutes', '最近多少分钟有活动算「在忙」', '0–120'),
          数('tokenSaverIdleMinutes', '闲置多少分钟算离开', '0–240'),
          数('maxMaterial', '素材库上限', '1–200'),
          数('sessionRotateDays', '专用会话多少天轮换', '1–90'),
        )),
        卡('投递目标', h('div', null,
          h('div', { className: 'wm-row' },
            h('span', { className: 'wm-hint' }, '当前发到'),
            h('span', { style: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' } },
              h('span', { className: 'wm-mono' }, (b.target && b.target.sessionId) ? b.target.sessionId.slice(0, 20) + '…' : '未绑定'),
              徽(b.target && b.target.pinned ? '手动绑定' : '未绑定', b.target && b.target.pinned ? 'wm-badgeInfo' : 'wm-badgeOff'),
              b.target && b.target.pinned && b.target.ok === false ? 徽('找不到目标', 'wm-badgeWarn') : null,
            ),
          ),
          h('div', { className: 'wm-field', style: { marginTop: 6 } },
            h('span', { className: 'wm-hint' }, '选一个会话（也可以直接改下面的会话 id）'),
            h('select', {
              className: 'wm-input',
              value: 已绑定,
              onChange: (e) => 设目标(e.target.value),
            },
              h('option', { value: '' }, '不绑定 · 不投递'),
              已绑定 && !候选表.some((x) => x.id === 已绑定)
                ? h('option', { value: 已绑定 }, `当前 · ${b.target?.label || 已绑定.slice(0, 18)}`)
                : null,
              候选表.map((x) => h('option', { key: x.id, value: x.id },
                `${x.label} · ${x.id.slice(0, 18)}${x.id.length > 18 ? '…' : ''}`)),
            ),
            选中的候选 && 选中的候选.source === 'bridge'
              ? h('span', { className: 'wm-hint' }, 'QQ 会话：投递会经桥接真的发出去，但不会改桥接绑定。')
              : null,
          ),
          h('div', { className: 'wm-field', style: { marginTop: 6 } },
            h('span', { className: 'wm-hint' }, '会话 id'),
            h('input', {
              value: f.targetSessionId || '',
              placeholder: '留空 = 不投递',
              spellCheck: false,
              className: 'wm-input',
              onChange: (e) => 设目标(e.target.value.trim()),
            }),
          ),
          h('div', { className: 'wm-saveBar', style: { marginTop: 8 } },
            h('button', { className: 'wm-btn', disabled: 忙, onClick: 拉目标 }, '读取可绑定会话'),
            h('span', { className: 'wm-hint' }, '候选来自宿主里的全部会话；QQ 会话只是打标签，不改桥接绑定。不绑就不投。'),
          ),
        )),
        卡('兴趣焦点', h('div', null,
          h('div', { className: 'wm-hint' }, '写给闲逛用的话题方向；留空就只跟画像。按回车或点「添加」变成一个标签。'),
          h('div', { className: 'wm-tagRow', style: { marginTop: 8 } },
            h('input', {
              className: 'wm-input wm-tagInput',
              value: 新兴趣,
              placeholder: '城市生活、独立游戏…',
              spellCheck: false,
              onChange: (e) => 设新兴趣(e.target.value),
              onKeyDown: (e) => {
                if (e.key === 'Enter' && !(e.nativeEvent && e.nativeEvent.isComposing)) {
                  e.preventDefault()
                  加兴趣()
                }
              },
            }),
            h('button', {
              type: 'button',
              className: 'wm-btn',
              disabled: 忙 || 兴趣表().length >= 20,
              onClick: 加兴趣,
            }, '添加'),
          ),
          兴趣表().length
            ? h('div', { className: 'wm-tags', style: { marginTop: 9 } },
              兴趣表().map((x) => h('span', { key: x, className: 'wm-tag' },
                x,
                h('button', {
                  type: 'button',
                  className: 'wm-tagX',
                  title: '删除',
                  'aria-label': '删除兴趣 ' + x,
                  onClick: () => 删兴趣(x),
                }, '×'),
              )))
            : h('div', { className: 'wm-hint', style: { marginTop: 8 } }, '还没有兴趣标签。'),
          h('div', { className: 'wm-hint', style: { marginTop: 6 } }, `已加 ${兴趣表().length} / 20；点标签上的 × 删除，改完点下面保存。`),
        )),
        h('div', { className: 'wm-hint' }, '模型配置统一在「模型」页：蒸馏 / 找素材（闲逛 agent 或直连搜索）。'),
        h('div', { className: 'wm-saveBar' },
          h('button', {
            className: 'wm-btn wm-btnPrimary',
            disabled: 忙 || !有改动,
            onClick: 保存,
          }, 忙 ? '保存中…' : (有改动 ? '保存主动设置' : '已保存')),
          有改动 ? 徽('有未保存修改', 'wm-badgeWarn') : null,
          h('span', { className: 'wm-hint' }, '保存后下一跳生效；开关和预演是两回事。'),
          结果 ? h('span', { className: 'wm-notice ' + (结果.ok ? 'wm-good' : 'wm-bad') }, 结果.text) : null,
        ),
      )

      const 维护页 = () => h('div', { className: 'wm-body' },
        卡('专注模式', h('div', null,
          h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
            h('input', {
              type: 'number', value: 专注分钟, min: 1, max: 1440, className: 'wm-input',
              style: { width: 90 }, onChange: (e) => 设专注分钟(e.target.value),
            }),
            h('button', { className: 'wm-btn', disabled: 忙, onClick: () => 专注(false) }, 忙 ? '处理中…' : '开始专注'),
            h('button', { className: 'wm-btn', disabled: 忙, onClick: () => 专注(true) }, '解除'),
          ),
          h('div', { className: 'wm-hint', style: { marginTop: 5 } }, s.focusUntil ? `专注到 ${时间(s.focusUntil)}；期间闸门直接拦，不调模型。` : '专注期间闸门直接拦，不调模型；重启后仍然有效。'),
        )),
        卡('派生画像', h('div', null,
          h('div', { className: 'wm-grid' },
            格('interest', 画像数.interest ?? 0, '反复出现的主题'),
            格('projects', 画像数.projects ?? 0, '正在做的事'),
            格('comm', 画像数.comm ?? 0, '说话方式偏好'),
            格('证据', 画像.evidence ? '完整' : '有缺项', 画像.ok === false ? '还没重建' : 画像.hash ? String(画像.hash).slice(0, 12) : ''),
          ),
          h('div', { className: 'wm-saveBar', style: { marginTop: 8 } },
            h('button', { className: 'wm-btn', disabled: 忙, onClick: 重建画像 }, '重建画像'),
            h('span', { className: 'wm-hint' }, '画像是 memory 派生缓存，删掉可重建。'),
          ),
        )),
        卡('素材与日志', h('div', null,
          h('div', { className: 'wm-hint' }, '按 TTL 退休；投递/反馈/日志按天保留。'),
          h('div', { className: 'wm-saveBar', style: { marginTop: 8 } },
            h('button', { className: 'wm-btn', disabled: 忙, onClick: 清理素材 }, '清理过期素材'),
            h('button', { className: 'wm-btn', disabled: 忙, onClick: 刷新 }, '刷新状态'),
          ),
        )),
        卡('专用会话', h('div', null,
          h('div', { className: 'wm-row' }, h('span', { className: 'wm-hint' }, '会话'), h('span', { className: 'wm-mono' }, b.sessions?.sessionId || '—')),
          h('div', { className: 'wm-row' }, h('span', { className: 'wm-hint' }, '已用'), h('span', null, b.sessions?.ageDays ? `${b.sessions.ageDays} 天` : '—')),
          h('div', { className: 'wm-row' }, h('span', { className: 'wm-hint' }, '轮转次数'), h('span', null, b.sessions?.rotates ?? 0)),
          h('div', { className: 'wm-saveBar', style: { marginTop: 8 } },
            h('button', {
              className: 'wm-btn' + (轮换确认 ? ' wm-btnDanger' : ''),
              disabled: 忙,
              onClick: () => {
                if (!轮换确认) { 设轮换确认(true); return }
                设轮换确认(false)
                轮换会话()
              },
            }, 轮换确认 ? '确认轮换（会释放旧会话）' : '轮换会话'),
            h('span', { className: 'wm-hint' }, 轮换确认 ? '再点一次才执行。' : '7 天会自动轮换；这里可以手动。'),
          ),
        )),
        结果 ? h('div', { className: 'wm-notice ' + (结果.ok ? 'wm-good' : 'wm-bad') }, 结果.text) : null,
      )

      return h('div', { className: 'wm-body' },
        h('div', { className: 'wm-statusStrip' },
          徽(调度.text, 调度.cls, true),
          徽(c.dryRun !== false ? '预演' : '可投递', c.dryRun !== false ? 'wm-badgeWarn' : 'wm-badgeOk'),
          徽(c.enabled === false ? '已关' : '已开', c.enabled === false ? 'wm-badgeOff' : 'wm-badgeOk'),
          h('span', { className: 'wm-hint', style: { marginLeft: 'auto' } },
            s.lastTickAt ? `上次跳 ${时间(s.lastTickAt)}` : '还没跳过'),
        ),
        h('div', { className: 'wm-subtabs' }, ['状态', '素材', '设置', '维护'].map((k) =>
          h('button', {
            key: k,
            className: 'wm-subtab' + (页 === k ? ' wm-subtabOn' : ''),
            onClick: () => 设页(k),
          }, k),
        )),
        页 === '状态' ? 状态页() : 页 === '素材' ? 素材页() : 页 === '设置' ? 配置页() : 维护页(),
      )
    }

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
      const [搜索态, 设搜索态] = React.useState(null)
      const [搜索表单, 设搜索表单] = React.useState({ base: '', model: '', key: '' })
      const [搜索结果, 设搜索结果] = React.useState(null)
      const [搜索候选, 设搜索候选] = React.useState(null)
      const [搜索探测中, 设搜索探测中] = React.useState(false)
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

      const 刷新 = React.useCallback((soft = false) => {
        if (!soft) 设忙(true)
        return Promise.all([get('/state'), get('/graph'), get('/audit?n=80'), get('/obs'), get('/beat')])
          .then(([s, g, a, o, b]) => {
            设态(s)
            设图(g)
            设账本(a)
            设观察(o)
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
        fetch(B + '/forget', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ scope, id }),
        })
          .then((r) => r.json())
          .then((r) => { if (r && r.ok === false) window.alert('没删掉：' + (r.why || '未知原因')) })
          .catch(() => window.alert('没删掉：请求失败'))
          .finally(() => { 刷新() })
      }, [刷新])

      const 确认 = React.useCallback((scope, id) => {
        设忙(true)
        fetch(B + '/confirm', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ scope, id }),
        })
          .then((r) => r.json())
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

      React.useEffect(() => {
        if (页 !== '模型') return
        if (!模型态) 拉模型()
        if (!搜索态) 拉搜索()
      }, [页, 模型态, 搜索态, 拉模型, 拉搜索])

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
      React.useEffect(() => {
        const timer = setInterval(() => {
          if (页 === '主动') 拉主动(true)
          else if (页 !== '模型') 刷新(true)
        }, 30000)
        return () => clearInterval(timer)
      }, [页, 拉主动, 刷新])

      const 提交模型 = async (path, 表单, 装) => {
        const r = await fetch(B + path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(表单),
        }).then((x) => x.json()).catch(() => null)
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
          const r = await fetch(B + path + '/test', { method: 'POST' })
            .then((x) => x.json())
            .catch(() => null)
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
      const 子页签 = (列表, 当前, 设当前) =>
        h('div', { className: 'wm-subtabs', style: { marginBottom: 10 } },
          列表.map((k) =>
            h('button', {
              key: k,
              className: 'wm-subtab' + (当前 === k ? ' wm-subtabOn' : ''),
              onClick: () => 设当前(k),
            }, k),
          ),
        )

      return h('div', { className: 'wm-panel' },
        h('div', { className: 'wm-hero' },
          h('div', { className: 'wm-heroTop' },
            h('div', { className: 'wm-logo' }, '🐟'),
            h('div', { className: 'wm-heroText' },
              h('span', { className: 'wm-heroTitle' }, '大肥鱼记忆'),
              h('span', { className: 'wm-heroSub' }, '人格 · 记忆 · 主动行为，都在这里'),
            ),
            h('div', { className: 'wm-heroRight' },
              WD.徽(`v${(态 && 态.version) || '?'}`, 'wm-badgeInfo'),
              WD.徽(`${分片数} 分片 · ${条数} 条`, 'wm-badgeInfo'),
              未信任 ? WD.徽('未信任', 'wm-badgeWarn', true) : WD.徽('信任正常', 'wm-badgeOk', true),
              h('button', {
                className: 'wm-btn',
                disabled: 忙,
                onClick: async () => {
                  设忙(true)
                  await get('/refresh')
                  刷新()
                },
              }, 忙 ? '读取中…' : '刷新'),
            ),
          ),
        ),
        h('div', { className: 'wm-tabs' },
          ['总览', '日记', '记忆', '主动', '模型'].map((k) =>
            h('button', {
              key: k,
              className: 'wm-tab' + (页 === k ? ' wm-tabOn' : ''),
              onClick: () => 设页(k),
            }, k),
          ),
        ),
        页 === '总览' ? h('div', null,
          子页签(['概览', '运行'], 总览页签, 设总览页签),
          总览页签 === '概览'
            ? (态 ? h(总览页, { 态, 观察, 图 }) : WD.卡('总览', WD.提('加载中…')))
            : (观察 ? h(运行页, { 观察 }) : WD.卡('运行', WD.提('加载中…'))),
        ) : null,
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
        页 === '记忆' ? h('div', null,
          子页签(['分片', '图谱', '审计'], 记忆页签, 设记忆页签),
          记忆页签 === '分片'
            ? (态 ? h(记忆页, { 态, 删, 确认 }) : WD.卡('记忆', WD.提('加载中…')))
            : 记忆页签 === '图谱'
              ? (图 ? h(图谱页, { 图 }) : WD.卡('图谱', WD.提('加载中…')))
              : (账本 || 态 ? h(审计页, { 态, 账本 }) : WD.卡('审计', WD.提('加载中…'))),
        ) : null,
        页 === '主动' ? (主动态
          ? h(主动页, {
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
        页 === '模型' ? ((模型态 || 搜索态 || 主动态)
          ? h(模型页, {
            页签: 模型页签,
            设页签: 设模型页签,
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
            闲逛: {
              态: 主动态, 表单: 主动表单, 改表单: 设主动表单,
              保存: 保存闲逛模型, 结果: 主动结果, 忙,
            },
            切引擎,
            引擎结果,
          })
          : WD.卡('模型', WD.提('加载中…'))) : null,
      )
    }

    // 左侧边栏整页入口：图标 id 与 main 的 key 必须相同，点图标就切到整页。
    // 宿主原文：sidebar.panellist「Each list id addresses the matching main panel」。
    const WM_侧栏ID = 'dsh-whale-memory'

    function 侧栏图标({ size = 20, active } = {}) {
      return h('span', {
        'aria-hidden': 'true',
        style: {
          display: 'block',
          width: size,
          height: size,
          lineHeight: size + 'px',
          textAlign: 'center',
          fontSize: Math.round(size * 0.9),
          opacity: active ? 1 : 0.82,
        },
      }, '🐟')
    }

    function 整页() {
      确保主动样式()
      return h('div', { className: 'wm-page' }, h(Section))
    }

    function apply(ctx) {
      const slots = ctx.get('slots')
      if (slots === undefined) return
      slots.inject('settings.section', () =>
        slots.register(
          { name: 'settings.section', id: 'whale-memory', order: 56, label: () => '大肥鱼记忆' },
          Section,
        ),
      )
      slots.inject('sidebar.panellist', () =>
        slots.register(
          { name: 'sidebar.panellist', id: WM_侧栏ID, order: 6, label: '大肥鱼记忆' },
          侧栏图标,
        ),
      )
      slots.inject('main', () =>
        slots.register(
          { name: 'main', key: WM_侧栏ID },
          整页,
        ),
      )
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
