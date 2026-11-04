// dsh-whale-memory · 网页半边
//
// 在 **DSH 设置** 左侧栏加一项「大肥鱼记忆」，四个页签：
//   总览 / 记忆 / 图谱 / 审计
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
        return h('div', null,
          h('div', { style: S.dim }, '图谱还是空的。'),
          h('div', { style: Object.assign({}, S.dim, { marginTop: 6 }) },
            '只有句子长得像「在X上班」「住在X」「喜欢X」「养了X」「我叫X」「X是Y」时才会连出边；' +
            '现在库里那几条都是时间类的话，抽不出实体，所以是空的。多聊几句带地点/喜好/称呼的就会长出来。'),
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

      return h(
        'div',
        null,
        h(
          'div',
          { style: S.dim },
          `${nodes.length} 个实体 · ${edges.length} 条关系` + (选中 ? '　点空白处取消选中' : '　点一个点看它连着谁'),
        ),
        h(
          'svg',
          {
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
            return h(
              'g',
              {
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
              h(
                'text',
                {
                  x: p.x,
                  y: p.y + 半径 + 12,
                  textAnchor: 'middle',
                  fontSize: 11,
                  fill: 'currentColor',
                  style: { opacity: 亮(nd.id) ? 0.88 : 0.3 },
                },
                nd.name.length > 8 ? nd.name.slice(0, 8) + '…' : nd.name,
              ),
            )
          }),
        ),
        h(
          'div',
          { style: Object.assign({}, S.card, { marginTop: 6 }) },
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
                  return h('div', { key: i, style: S.row },
                    h('span', { style: { fontWeight: e.from === 选中 ? 600 : 400 } }, 从.name),
                    h('span', { style: S.dim }, '—' + e.rel + '→'),
                    h('span', { style: { fontWeight: e.to === 选中 ? 600 : 400 } }, 到.name),
                  )
                }),
            )
            : null,
        ),
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
      if (!scopes.length) return h('div', { style: S.dim }, '还没有任何分片。')
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
            h('span', { style: Object.assign({}, S.dim, { flex: 1 }) },
              `成员画像 · ${成员.length} 人：` + 成员.slice(0, 6).map((m) => `${m.name}（${m.items ?? 0}）`).join('、') + (成员.length > 6 ? ' …' : '')),
            h('button', {
              style: Object.assign({}, S.btn, { padding: '1px 8px', fontSize: 12 }),
              onClick: () => 设展成员(成员开 ? '' : sc.scope),
            }, 成员开 ? '收起' : '全部'),
          ),
          成员开 ? 成员表(成员) : null,
        )
        : null
      const 显示条目 = 全部开 ? 已生效 : 已生效.slice(0, 30)
      return h(
        'div',
        null,
        scopes.length > 1
          ? h('div', { style: S.tabs },
            scopes.map((x) =>
              h('button', {
                key: x.scope,
                style: Object.assign({}, S.tab, x.scope === sc.scope ? S.tabOn : null),
                onClick: () => 设当前(x.scope),
              }, `${x.label} · ${x.total}`),
            ),
          )
          : null,
        h(
          'div',
          { key: sc.scope, style: S.card },
          h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' } },
            h('span', { style: { fontWeight: 600 } }, sc.label),
            h('span', { style: S.dim }, `${sc.total} 条 · 可用 ${sc.active}${待确认.length ? ` · 待确认 ${待确认.length}` : ''} · 更新 ${时间(sc.updatedAt)}`),
          ),
          sc.profile && sc.profile.summary
            ? h('div', { style: { marginTop: 4 } },
              h('div', { style: { display: 'flex', gap: 8, alignItems: 'baseline' } },
                h('span', { style: Object.assign({}, S.mono, { opacity: 0.85, flex: 1 }) }, '画像：' + sc.profile.summary),
                h('button', {
                  style: Object.assign({}, S.btn, { padding: '1px 8px', fontSize: 12 }),
                  onClick: () => 设展画像(画像开 ? '' : sc.scope),
                }, 画像开 ? '收起' : '详情'),
              ),
              画像开 ? 画像详情(sc) : null,
            )
            : h('div', { style: Object.assign({}, S.dim, { marginTop: 4 }) }, '画像还没生成（等下一次蒸馏）'),
          成员块,
          待确认.length
            ? h('div', { style: { marginTop: 8, padding: '6px 8px', borderRadius: 8, background: 'rgba(201,154,30,.08)' } },
              h('div', { style: S.dim }, '待确认：她主动记下的，你点头才生效（还没进目录，也检索不到）'),
              待确认.map((it) =>
                h('div', { key: it.id, style: S.row },
                  h('span', { style: Object.assign({}, S.badge, { background: 状态色.suggested }) }, 档名.suggested),
                  h('span', { style: { flex: 1 } }, it.text),
                  h('button', {
                    style: Object.assign({}, S.btn, { padding: '0 8px', lineHeight: '18px', fontSize: 12, borderColor: '#3ba55d', color: '#2e8a4c' }),
                    title: '确认这条，转成正式记忆',
                    onClick: () => 确认(sc.scope, it.id),
                  }, '确认'),
                  h('button', {
                    style: Object.assign({}, S.btn, { padding: '0 6px', lineHeight: '18px', fontSize: 12, opacity: 0.7 }),
                    title: '不要这条（进归档，能找回）',
                    onClick: () => 删(sc.scope, it.id, it.text),
                  }, '×'),
                ),
              ),
            )
            : null,
          sc.items.length
            ? h('div', { style: { marginTop: 6 } },
              显示条目.map((it) =>
                h('div', { key: it.id, style: S.row },
                  h('span', { style: Object.assign({}, S.badge, { background: 状态色[it.state] || '#999' }) }, 档名[it.state] || it.state),
                  h('span', { style: { flex: 1 } }, it.text),
                  h('span', { style: S.dim }, `h${it.hits}·${it.score}`),
                  h('button', {
                    style: Object.assign({}, S.btn, { padding: '0 6px', lineHeight: '16px', fontSize: 12, opacity: 0.7 }),
                    title: '删掉这条（会进归档，能找回）',
                    onClick: () => 删(sc.scope, it.id, it.text),
                  }, '×'),
                ),
              ),
              已生效.length > 30
                ? h('div', { style: { marginTop: 6, display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
                  h('span', { style: S.dim }, 全部开 ? `全部 ${已生效.length} 条` : `显示 30 / ${已生效.length} 条`),
                  h('button', {
                    style: S.btn,
                    onClick: () => 设展全部(全部开 ? '' : sc.scope),
                  }, 全部开 ? '收起' : `展开全部（${已生效.length} 条）`),
                )
                : null,
            )
            : h('div', { style: S.dim }, '（空）'),
          h('details', { style: { marginTop: 6 } },
            h('summary', { style: Object.assign({}, S.dim, { cursor: 'pointer' }) }, '看她现在会读到什么'),
            h('pre', { style: Object.assign({}, S.mono, { whiteSpace: 'pre-wrap', margin: '6px 0 0' }) }, sc.render || '（空）'),
          ),
        ),
      )
    }

    function 审计页({ 态, 账本 }) {
      const rows = (账本 && 账本.rows) || (态 && 态.audit) || []
      if (!rows.length) return h('div', { style: S.dim }, '还没有账本记录。')
      return h(
        'div',
        null,
        h('div', { style: S.dim }, '最近 ' + rows.length + ' 条记录（写 + 读，新的在上面）'),
        h('div', { style: Object.assign({}, S.card, S.mono) },
          rows.slice().reverse().map((r, i) =>
            h('div', { key: i, style: { padding: '2px 0', borderBottom: '1px dashed rgba(120,130,150,.18)' } },
              h('span', { style: { opacity: 0.55 } }, 时间(r.at) + ' '),
              h('span', { style: { color: '#4a8fe7' } }, r.kind || '?'),
              ' ',
              h('span', null, (r.scope || '') + ' ' + (r.text ? '「' + r.text + '」' : r.item ? r.item : '')),
            ),
          ),
        ),
      )
    }

    function 总览页({ 态, 版本 }) {
      const c = (态 && 态.counts) || {}
      return h(
        'div',
        null,
        h('div', { style: S.card },
          h('div', { style: { display: 'flex', gap: 18, flexWrap: 'wrap' } },
            h('div', null, h('div', { style: S.dim }, '分片'), h('div', { style: { fontSize: 20, fontWeight: 600 } }, String(c.scopes ?? 0))),
            h('div', null, h('div', { style: S.dim }, '记忆条数'), h('div', { style: { fontSize: 20, fontWeight: 600 } }, String(c.items ?? 0))),
            h('div', null, h('div', { style: S.dim }, '版本'), h('div', { style: { fontSize: 20, fontWeight: 600 } }, String(版本 || (态 && 态.version) || '?'))),
          ),
          h('div', { style: Object.assign({}, S.dim, { marginTop: 6 }) }, '库路径：' + String((态 && 态.root) || '?')),
        ),
        h('div', { style: S.h }, '分片'),
        ((态 && 态.scopes) || []).map((sc) =>
          h('div', { key: sc.scope, style: Object.assign({}, S.card, { display: 'flex', justifyContent: 'space-between' }) },
            h('span', null, sc.label),
            h('span', { style: S.dim }, `${sc.total} 条 · 可用 ${sc.active}`),
          ),
        ),
        h('div', { style: Object.assign({}, S.dim, { marginTop: 10 }) },
          '人格来自 persona.md（固定，不衰减）；记忆按分片隔离，私聊、群、本地会话互不串；' +
          '长期不碰的条目会变冷、再久会归档，归档的不再进提示词。',
        ),
      )
    }

    function 运行页({ 观察 }) {
      const o = 观察 || {}
      const p = o.persona || {}
      const t = o.trust || {}
      const rd = o.reads || {}
      const 行 = (k, v) => h('div', { key: k, style: Object.assign({}, S.card, { display: 'flex', justifyContent: 'space-between' }) },
        h('span', null, k), h('span', { style: S.dim }, v))
      return h('div', null,
        行('人格', p.exists ? `v${p.version || 0} · ${p.tokens || 0}/${p.limit || 1200} tok${p.overBudget ? '（超预算）' : ''}` : '缺 persona.md'),
        行('人格探针', p.probes ? `${p.probes.passed}/${p.probes.total}${(p.probes.failed || []).length ? ` · ${(p.probes.failed || []).map((f) => f.name).join('、')}` : ''}` : '—'),
        行('人格迭代', p.auto
          ? `${p.auto.pendingMessages}/${p.auto.minMessages} 条新消息 · 连续通过 ${p.auto.streak}/${p.auto.minStreak} · ` +
            `${p.auto.publishedThisWeek ? `本周已发布，下次 ${p.auto.nextPublishAt}` : '本周未发布'}`
          : '—'),
        行('信任', t.origin ? `${t.origin} · ${t.usable ? '可用' : '未信任'}` : '?'),
        行('读取', rd.total
          ? `查 ${rd.search || 0} · 读 ${rd.read || 0} · 画像 ${rd.profile || 0} · 空/拒 ${rd.empty || 0} · ${rd.tokens || 0} tok`
          : '还没有读取记录'),
        h('div', { style: S.h }, '分片容量'),
        ((o.vault || []).length ? (o.vault || []).map((v) => h('div', { key: v.scope, style: S.card },
          h('div', null, v.label),
          h('div', { style: S.dim }, `${v.live} 条 · 副库 ${(v.indexBytes / 1024).toFixed(1)}KB${v.pending ? ' · ⚠ 待重建' : ''} · 读取 ${v.reads} 次 · 深化 ${v.lastDeepen || '—'}`),
        )) : h('div', { style: S.dim }, '还没有分片')),
        h('div', { style: S.h }, '最近检索'),
        ((o.searches || []).length ? (o.searches || []).map((x, i) => h('div', { key: i, style: S.card },
          h('div', null, `${x.query || '（空）'} · ${x.count || 0} 条${x.hops ? ` · ${x.hops} 跳` : ''}`),
          h('div', { style: S.dim }, (x.top || []).map((y) => (typeof y === 'string' ? y : `${y.id}(${y.score})`)).join(' · ')),
        )) : h('div', { style: S.dim }, '还没有检索记录')),
        h('div', { style: S.h }, '写入跳过'),
        ((o.skips || []).length ? (o.skips || []).map((x, i) => h('div', { key: i, style: S.card },
          h('div', null, `${x.scope} · 跳过 ${x.skipped || 0} 条`),
          h('div', { style: S.dim }, JSON.stringify(x.reasons || {})),
        )) : h('div', { style: S.dim }, '没有跳过记录')),
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

    function 模型页({ 态, 表单, 改表单, 保存, 测试, 探测, 候选, 探测中, 忙, 结果 }) {
      const v = 态 || {}
      const [展开, 设展开] = React.useState(false)
      const 输入 = (k, 名, 类型, 提示) =>
        h('label', { key: k, style: { display: 'block', marginTop: 10 } },
          h('div', { style: S.dim }, 名),
          h('input', {
            type: 类型,
            value: 表单[k] || '',
            placeholder: 提示,
            spellCheck: false,
            autoComplete: 'off',
            style: S.input,
            onChange: (e) => 改表单(Object.assign({}, 表单, { [k]: e.target.value })),
          }),
        )
      const 行 = (m) =>
        h('div', { key: m.id, style: { display: 'flex', gap: 8, alignItems: 'baseline', padding: '2px 0' } },
          h('button', {
            style: Object.assign({}, S.btn, { padding: '1px 7px', fontFamily: 'ui-monospace, Consolas, monospace' }),
            title: m.why || '',
            onClick: () => 改表单(Object.assign({}, 表单, { model: m.id })),
          }, m.id),
          h('span', { style: Object.assign({}, S.dim, { color: 探测状态色[m.state], opacity: 1 }) },
            (探测状态名[m.state] || m.state) + (m.ms ? ` · ${m.ms}ms` : '')),
        )
      const 取 = (state) => (候选 ? (候选.models || []).filter((m) => m.state === state) : [])
      const 可用 = 取('ok')
      const 限流 = 取('limited')
      const 不可用 = 取('unusable')
      const 其它 = 候选
        ? (候选.models || []).filter((m) => !['ok', 'limited', 'unusable'].includes(m.state))
        : []

      return h('div', null,
        h('div', { style: S.card },
          h('div', { style: Object.assign({}, S.h, { margin: '0 0 2px' }) }, '蒸馏模型'),
          h('div', { style: S.dim }, '抽记忆用的模型。填完点「测试连通」，通了再保存。任何 OpenAI 兼容端点都行（官方 / one-api / 本地 Ollama）。'),
          输入('base', '端点', 'text', 'https://api.deepseek.com/v1'),
          输入('model', '模型名', 'text', 'deepseek-chat'),
          输入('key', 'API Key', 'password', v.hasKey ? `已保存 ${v.keyMasked}，留空不改` : '没填就是不鉴权（本地 Ollama 常见）'),
          h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 14, flexWrap: 'wrap' } },
            h('button', { style: S.btn, disabled: 忙, onClick: 保存 }, 忙 ? '处理中…' : '保存'),
            h('button', { style: S.btn, disabled: 忙 || 探测中, onClick: 测试 }, '测试连通'),
            h('button', {
              style: S.btn,
              disabled: 忙 || 探测中 || !(表单.base || v.base),
              onClick: 探测,
            }, 探测中 ? '探测中…' : '探测可用模型'),
            h('span', { style: Object.assign({}, S.badge, { background: v.ready ? '#3ba55d' : '#8a94a6' }) }, v.ready ? '已就绪' : '未配置'),
            v.from === 'env' ? h('span', { style: S.dim }, '当前值来自环境变量，保存后以这里为准') : null,
          ),
          h('div', { style: Object.assign({}, S.dim, { marginTop: 6 }) },
            '探测会先拉模型列表，再逐个发一条最小消息，约 10–20 秒，消耗少量额度；要填 API Key 才能探测。'),
          结果
            ? h('div', { style: 结果.ok ? S.good : S.bad },
              结果.ok
                ? `通了 · ${结果.ms || 0}ms · 保存后下一次蒸馏就生效，不用重启 DSH`
                : '没通 · ' + (结果.why || '未知原因'),
            )
            : null,
          候选
            ? h('div', { style: { marginTop: 10 } },
              h('div', { style: S.dim },
                `可用 ${候选.counts.usable} · 限流 ${候选.counts.limited} · 非对话 ${候选.counts.unusable}` +
                (候选.counts.timeout ? ` · 超时 ${候选.counts.timeout}` : '') +
                (候选.counts.denied ? ` · 无权限 ${候选.counts.denied}` : '') +
                (候选.counts.auth ? ` · 未授权 ${候选.counts.auth}` : '') +
                (候选.truncated ? ' · 只测了前 40 个' : ''),
              ),
              可用.length ? h('div', { style: { marginTop: 5 } }, 可用.map(行)) : null,
              限流.length ? h('div', { style: { marginTop: 5 } }, 限流.map(行)) : null,
              其它.length ? h('div', { style: { marginTop: 5 } }, 其它.map(行)) : null,
              不可用.length
                ? h('div', { style: { marginTop: 6 } },
                  h('button', { style: S.btn, onClick: () => 设展开(!展开) },
                    展开 ? '收起非对话模型' : `展开 ${不可用.length} 个非对话模型`),
                  展开 ? h('div', { style: { marginTop: 4 } }, 不可用.map(行)) : null,
                )
                : null,
              可用.length ? h('div', { style: Object.assign({}, S.dim, { marginTop: 6 }) }, '点模型名填入，再点「保存」才生效。') : null,
            )
            : null,
        ),
        h('div', { style: S.card },
          h('div', { style: S.dim }, '配置存在：' + String(v.path || '?')),
          h('div', { style: Object.assign({}, S.dim, { marginTop: 4 }) },
            'key 明文存在这个文件里，只有本机能读；界面只显示尾巴。' +
            '向量模型（embedding）和人格审查如果要单独指定，还是走环境变量；人格审查没单独配就跟着上面这个模型。'),
        ),
      )
    }

    function Section() {
      const [页, 设页] = React.useState('总览')
      const [态, 设态] = React.useState(null)
      const [图, 设图] = React.useState(null)
      const [账本, 设账本] = React.useState(null)
      const [观察, 设观察] = React.useState(null)
      const [模型态, 设模型态] = React.useState(null)
      const [模型表单, 设模型表单] = React.useState({ base: '', model: '', key: '' })
      const [模型结果, 设模型结果] = React.useState(null)
      const [候选, 设候选] = React.useState(null)
      const [探测中, 设探测中] = React.useState(false)
      const [忙, 设忙] = React.useState(false)

      const 刷新 = React.useCallback(() => {
        设忙(true)
        Promise.all([get('/state'), get('/graph'), get('/audit?n=80'), get('/obs')])
          .then(([s, g, a, o]) => {
            设态(s)
            设图(g)
            设账本(a)
            设观察(o)
          })
          .finally(() => 设忙(false))
      }, [])

      React.useEffect(() => { 刷新() }, [刷新])

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

      const 拉模型 = React.useCallback(() => {
        get('/llm').then((r) => { if (r && r.ok) 装模型(r) })
      }, [装模型])

      React.useEffect(() => {
        if (页 === '模型' && !模型态) 拉模型()
      }, [页, 模型态, 拉模型])

      const 提交模型 = async () => {
        const r = await fetch(B + '/llm', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(模型表单),
        }).then((x) => x.json()).catch(() => null)
        if (r && r.ok) 装模型(r)
        return r
      }

      const 存模型 = async () => {
        设忙(true)
        设模型结果(null)
        const r = await 提交模型()
        if (!r || !r.ok) 设模型结果({ ok: false, why: (r && r.why) || '保存失败' })
        设忙(false)
      }

      const 测模型 = async () => {
        设忙(true)
        设模型结果(null)
        // 先存再测：测的是输入框里这份配置，不是上一次的旧值
        const s = await 提交模型()
        if (!s || !s.ok) {
          设模型结果({ ok: false, why: (s && s.why) || '保存失败' })
          设忙(false)
          return
        }
        const r = await fetch(B + '/llm/test', { method: 'POST' })
          .then((x) => x.json())
          .catch(() => null)
        设模型结果(r || { ok: false, why: '请求失败' })
        设忙(false)
      }

      // 探测不落盘：用的就是输入框里这份端点 / key，选完还得手动保存
      const 探模型 = async () => {
        if (探测中) return
        设探测中(true)
        设模型结果(null)
        设候选(null)
        const r = await post('/llm/models', { base: 模型表单.base, key: 模型表单.key })
        设探测中(false)
        if (!r || !r.ok) {
          设模型结果({ ok: false, why: (r && r.why) || '探测失败' })
          return
        }
        设候选(r)
      }

      const 页签 = h('div', { style: S.tabs },
        ['总览', '记忆', '图谱', '审计', '运行', '模型'].map((k) =>
          h('button', {
            key: k,
            style: Object.assign({}, S.tab, 页 === k ? S.tabOn : null),
            onClick: () => {
              if (k !== '模型') 设候选(null)
              设页(k)
            },
          }, k),
        ),
        h('span', { style: { flex: 1 } }),
        h('button', {
          style: S.btn,
          disabled: 忙,
          onClick: async () => {
            设忙(true)
            await get('/refresh')
            刷新()
          },
        }, 忙 ? '读取中…' : '刷新'),
      )

      return h(
        'div',
        { style: S.wrap },
        h('div', { style: S.h }, '大肥鱼记忆'),
        h('div', { style: S.dim }, '她在 QQ / 群 / 本地会话里记住的东西，都在这里。能删掉记错的那条，改还得靠她自己记。'),
        页签,
        页 === '总览' ? (态 ? h(总览页, { 态, 版本: null }) : h('div', { style: S.dim }, '加载中…')) : null,
        页 === '记忆' ? (态 ? h(记忆页, { 态, 删, 确认 }) : h('div', { style: S.dim }, '加载中…')) : null,
        页 === '图谱' ? (图 ? h(图谱页, { 图 }) : h('div', { style: S.dim }, '加载中…')) : null,
        页 === '审计' ? (账本 || 态 ? h(审计页, { 态, 账本 }) : h('div', { style: S.dim }, '加载中…')) : null,
        页 === '运行' ? (观察 ? h(运行页, { 观察 }) : h('div', { style: S.dim }, '加载中…')) : null,
        页 === '模型' ? (模型态
          ? h(模型页, { 态: 模型态, 表单: 模型表单, 改表单: 设模型表单, 保存: 存模型, 测试: 测模型, 探测: 探模型, 候选, 探测中, 忙, 结果: 模型结果 })
          : h('div', { style: S.dim }, '加载中…')) : null,
      )
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
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
