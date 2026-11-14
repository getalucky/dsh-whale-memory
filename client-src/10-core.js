    const React = require('react')
    const inject = ['slots']
    const h = React.createElement

    const B = '/dsh-whale-memory/api'
    // 接口要鉴权：先领进程令牌，之后每个请求都带 x-whale-token。
    // 令牌过期（宿主重启）时清掉重领一次，界面不用手动刷新。
    let 令牌请求 = null
    const 取令牌 = () => {
      if (令牌请求) return 令牌请求
      令牌请求 = fetch(B + '/session', { cache: 'no-store', credentials: 'same-origin' })
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => (j && j.ok && j.token ? String(j.token) : ''))
        .catch(() => '')
      令牌请求.then((t) => { if (!t) 令牌请求 = null })
      return 令牌请求
    }
    const 带令牌 = async (p, opts) => {
      const token = await 取令牌()
      const 发 = (tok) => fetch(B + p, Object.assign({}, opts, {
        credentials: 'same-origin',
        headers: Object.assign({}, opts.headers || {}, tok ? { 'x-whale-token': tok } : {}),
      }))
      let r = await 发(token)
      if (r.status === 401) {
        令牌请求 = null
        const again = await 取令牌()
        if (again) r = await 发(again)
      }
      return r
    }
    const get = (p) =>
      带令牌(p, { cache: 'no-store' })
        .then((r) => r.json())
        .catch(() => null)
    const post = (p, body) =>
      带令牌(p, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      })
        .then((r) => r.json())
        .catch(() => null)

    const 色彩 = {
      person: '#5da8ff',
      place: '#46dda6',
      org: '#b98aff',
      thing: '#ffb454',
      event: '#ff7fa8',
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
      tabOn: { background: 'rgba(99,102,241,.14)', borderColor: '#6366f1', fontWeight: 600 },
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

