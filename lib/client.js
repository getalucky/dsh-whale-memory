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

    function 时间(t) {
      if (!t) return ''
      const d = new Date(t)
      if (Number.isNaN(d.getTime())) return ''
      const p = (n) => String(n).padStart(2, '0')
      return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
    }

    const 星云视宽 = 920
    const 星云视高 = 560
    const 星云球心 = { x: 星云视宽 / 2, y: 星云视高 / 2 }
    const 星云球半径 = Math.min(星云视宽, 星云视高) * 0.42
    const 星云相机 = 4.2

    /** 固定种子的伪随机：同一张图每次打开都长一个样，不会一刷新就跳。 */
    function 星云随机(seed) {
      let a = 2166136261 >>> 0
      const s = String(seed || '')
      for (let i = 0; i < s.length; i++) {
        a ^= s.charCodeAt(i)
        a = Math.imul(a, 16777619)
      }
      return () => {
        a = (a + 0x6D2B79F5) | 0
        let t = Math.imul(a ^ (a >>> 15), 1 | a)
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
      }
    }

    function 归一(v) {
      const d = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z) || 1
      return { x: v.x / d, y: v.y / d, z: v.z / d }
    }

    /**
     * 球形布局：斐波那契球面先均匀撒点，再在球面上做斥力/弹簧松弛。
     * 关系多的实体靠近球心，孤星漂在球壳外层；纯计算，不碰 DOM。
     */
    function 星云布局(nodes, edges) {
      const n = nodes.length
      const 索引 = new Map(nodes.map((nd, i) => [nd.id, i]))
      const 度数 = new Map()
      for (const e of edges) {
        const w = Math.max(0.5, Number(e.weight) || 1)
        度数.set(e.from, (度数.get(e.from) || 0) + w)
        度数.set(e.to, (度数.get(e.to) || 0) + w)
      }
      const 最大度 = Math.max(1, ...度数.values())
      const 黄金角 = Math.PI * (3 - Math.sqrt(5))
      const 单位 = nodes.map((nd, i) => {
        const y = n === 1 ? 0 : 1 - (i / Math.max(1, n - 1)) * 2
        const rr = Math.sqrt(Math.max(0, 1 - y * y))
        const rnd = 星云随机(nd.id)
        const a = 黄金角 * i + (rnd() - 0.5) * 0.45
        return 归一({ x: Math.cos(a) * rr, y: y + (rnd() - 0.5) * 0.1, z: Math.sin(a) * rr })
      })
      const 分布半径 = nodes.map((nd) => {
        const 重要度 = Math.sqrt((度数.get(nd.id) || 0) / 最大度)
        return 1 - 0.3 * 重要度
      })
      const 迭代 = n > 280 ? 90 : n > 160 ? 140 : 210

      for (let it = 0; it < 迭代; it++) {
        const 冷却 = 1 - it / 迭代
        const 推 = nodes.map(() => ({ x: 0, y: 0, z: 0 }))
        // 球面斥力：只推切向，保证点始终贴在球壳上
        for (let i = 0; i < n; i++) {
          const A = 单位[i]
          for (let j = i + 1; j < n; j++) {
            const B = 单位[j]
            const dx = A.x - B.x
            const dy = A.y - B.y
            const dz = A.z - B.z
            const d2 = dx * dx + dy * dy + dz * dz
            if (d2 > 0.5 || d2 < 1e-8) continue
            const d = Math.sqrt(d2)
            const f = (0.0026 * (0.3 + 冷却 * 0.7)) / Math.max(0.006, d2)
            const ux = dx / d
            const uy = dy / d
            const uz = dz / d
            const ai = 推[i]
            const bi = 推[j]
            ai.x += ux * f
            ai.y += uy * f
            ai.z += uz * f
            bi.x -= ux * f
            bi.y -= uy * f
            bi.z -= uz * f
          }
        }
        // 弹簧：有关系的点互相靠拢，簇就自然成形
        for (const e of edges) {
          const ai = 索引.get(e.from)
          const bi = 索引.get(e.to)
          if (ai === undefined || bi === undefined) continue
          const A = 单位[ai]
          const B = 单位[bi]
          const dx = B.x - A.x
          const dy = B.y - A.y
          const dz = B.z - A.z
          const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 0.001
          const w = Math.min(3, Math.max(0.6, Number(e.weight) || 1))
          const 静息 = 0.6 - 0.1 * w
          const f = (d - 静息) * 0.014 * (0.35 + 冷却 * 0.65)
          const ux = dx / d
          const uy = dy / d
          const uz = dz / d
          const pa = 推[ai]
          const pb = 推[bi]
          pa.x += ux * f
          pa.y += uy * f
          pa.z += uz * f
          pb.x -= ux * f
          pb.y -= uy * f
          pb.z -= uz * f
        }
        for (let i = 0; i < n; i++) {
          const A = 单位[i]
          const m = 推[i]
          const dot = m.x * A.x + m.y * A.y + m.z * A.z
          单位[i] = 归一({
            x: A.x + (m.x - dot * A.x),
            y: A.y + (m.y - dot * A.y),
            z: A.z + (m.z - dot * A.z),
          })
        }
      }

      return nodes.map((nd, i) => {
        const score = (度数.get(nd.id) || 0) + (nd.mentions || 0) * 0.45
        const r = Math.max(5, Math.min(17, 5 + Math.sqrt(score) * 2.6))
        return {
          ux: 单位[i].x,
          uy: 单位[i].y,
          uz: 单位[i].z,
          rf: 分布半径[i],
          r,
          score,
          deg: 度数.get(nd.id) || 0,
        }
      })
    }

    /** 先绕 Y 轴偏航、再绕 X 轴俯仰，得到相机坐标系里的位置。 */
    function 星云旋转(v, 向) {
      const cy = Math.cos(向.yaw)
      const sy = Math.sin(向.yaw)
      const cp = Math.cos(向.pitch)
      const sp = Math.sin(向.pitch)
      const x1 = v.x * cy + v.z * sy
      const z1 = -v.x * sy + v.z * cy
      return { x: x1, y: v.y * cp - z1 * sp, z: v.y * sp + z1 * cp }
    }

    /** 透视投影：前面的星放大、后面的星缩小，才有球的层次。 */
    function 星云投影(v, 缩放) {
      const f = 星云相机 / (星云相机 - v.z)
      const s = 星云球半径 * 缩放
      return { x: 星云球心.x + v.x * f * s, y: 星云球心.y + v.y * f * s, z: v.z, f }
    }

    /** 让某个方向正对镜头时该用的转向角。 */
    function 星云对准方向(向) {
      const 横 = Math.sqrt(向.x * 向.x + 向.z * 向.z) || 0.0001
      return { yaw: Math.atan2(-向.x, 向.z), pitch: Math.atan2(向.y, 横) }
    }

    function 图谱页({ 图, 态 }) {
      const nodes = React.useMemo(() => (图 && Array.isArray(图.nodes) ? 图.nodes : []), [图])
      const edges = React.useMemo(() => (图 && Array.isArray(图.edges) ? 图.edges : []), [图])
      const 位图 = React.useMemo(() => 星云布局(nodes, edges), [nodes, edges])
      const 位置 = React.useMemo(() => new Map(nodes.map((nd, i) => [nd.id, 位图[i]])), [nodes, 位图])
      const 节点表 = React.useMemo(() => new Map(nodes.map((nd) => [nd.id, nd])), [nodes])
      const 关系数 = React.useMemo(() => {
        const m = new Map()
        for (const e of edges) {
          m.set(e.from, (m.get(e.from) || 0) + 1)
          m.set(e.to, (m.get(e.to) || 0) + 1)
        }
        return m
      }, [edges])
      const 星点 = React.useMemo(() => {
        const rnd = 星云随机('whale-nebula-stars')
        return Array.from({ length: 92 }, (_, i) => ({
          x: rnd() * 星云视宽,
          y: rnd() * 星云视高,
          r: 0.4 + rnd() * 1.5,
          o: 0.12 + rnd() * 0.62,
          d: (2.6 + rnd() * 5.2).toFixed(1) + 's',
          delay: (rnd() * 6).toFixed(1) + 's',
          c: i % 13 === 0 ? '#9cc2ff' : i % 19 === 0 ? '#d8bdff' : '#e2ecff',
        }))
      }, [])
      // 球体内部撒的星尘：随球一起转，靠透视分出前后
      const 星尘 = React.useMemo(() => {
        const rnd = 星云随机('whale-nebula-dust')
        return Array.from({ length: 150 }, (_, i) => {
          const u = rnd() * 2 - 1
          const 角 = rnd() * Math.PI * 2
          const rr = Math.cbrt(rnd()) * 0.94
          const 横 = Math.sqrt(Math.max(0, 1 - u * u))
          return {
            x: Math.cos(角) * 横 * rr,
            y: u * rr,
            z: Math.sin(角) * 横 * rr,
            s: 0.7 + rnd() * 1.7,
            o: 0.3 + rnd() * 0.6,
            c: i % 17 === 0 ? '#cdb6ff' : i % 23 === 0 ? '#9fd4ff' : '#dbe8ff',
          }
        })
      }, [])
      // 球内几团雾气，随球转动，衬出体积
      const 星雾 = React.useMemo(() => {
        const rnd = 星云随机('whale-nebula-clouds')
        return Array.from({ length: 7 }, () => {
          const u = rnd() * 2 - 1
          const 角 = rnd() * Math.PI * 2
          const 横 = Math.sqrt(Math.max(0, 1 - u * u))
          const rr = 0.25 + rnd() * 0.55
          return {
            x: Math.cos(角) * 横 * rr,
            y: u * rr,
            z: Math.sin(角) * 横 * rr,
            r: 0.26 + rnd() * 0.26,
            o: 0.5 + rnd() * 0.4,
          }
        })
      }, [])
      // 球壳经纬线：5 条纬线 + 6 条经线
      const 星环 = React.useMemo(() => {
        const 环 = []
        const 点 = (经, 纬) => ({
          x: Math.cos(纬) * Math.cos(经),
          y: Math.sin(纬),
          z: Math.cos(纬) * Math.sin(经),
        })
        for (const 纬 of [-60, -30, 0, 30, 60]) {
          const lat = (纬 * Math.PI) / 180
          const arr = []
          for (let i = 0; i <= 60; i++) arr.push(点((i / 60) * Math.PI * 2, lat))
          环.push(arr)
        }
        for (let 经 = 0; 经 < 180; 经 += 30) {
          const lon = (经 * Math.PI) / 180
          const arr = []
          for (let i = 0; i <= 36; i++) arr.push(点(lon, -Math.PI / 2 + (i / 36) * Math.PI))
          环.push(arr)
        }
        return 环
      }, [])
      const 分片标签 = React.useMemo(() => {
        const m = new Map()
        for (const sc of (态 && 态.scopes) || []) if (sc && sc.scope) m.set(sc.scope, sc.label || sc.scope)
        for (const nd of nodes) for (const sc of nd.scopes || []) if (!m.has(sc)) m.set(sc, sc)
        for (const e of edges) for (const sc of (e.scopes || [e.scope]).filter(Boolean)) if (!m.has(sc)) m.set(sc, sc)
        return [...m.entries()]
      }, [态, nodes, edges])
      const 分片映射 = React.useMemo(() => new Map(分片标签), [分片标签])
      const 标签优先 = React.useMemo(() => {
        const sorted = [...nodes].sort((a, b) => {
          const pa = 位置.get(a.id) || { score: 0 }
          const pb = 位置.get(b.id) || { score: 0 }
          return pb.score - pa.score
        })
        const 上限 = nodes.length <= 26 ? 18 : nodes.length <= 80 ? 26 : 30
        return new Set(sorted.slice(0, 上限).map((nd) => nd.id))
      }, [nodes, 位置])

      const [查询, 设查询] = React.useState('')
      const [搜开, 设搜开] = React.useState(false)
      const [选中, 设选中] = React.useState(null)
      const [选中边, 设选中边] = React.useState(null)
      const [悬停, 设悬停] = React.useState(null)
      const [悬停边, 设悬停边] = React.useState(null)
      const [类型开, 设类型开] = React.useState(() => new Set(Object.keys(类型名)))
      const [范围, 设范围] = React.useState('')
      const [转向, 设转向] = React.useState({ yaw: -0.5, pitch: -0.14 })
      const [缩放值, 设缩放值] = React.useState(1)
      const [拖动, 设拖动] = React.useState(false)
      const 图引用 = React.useRef(null)
      const 拖参考 = React.useRef(null)
      const 拖过 = React.useRef(false)

      React.useEffect(() => {
        if (选中 && !节点表.has(选中)) 设选中(null)
        if (选中边 && !edges.some((e) => e.id === 选中边)) 设选中边(null)
      }, [节点表, edges, 选中, 选中边])

      // 慢速自转；选中、搜索、拖拽、悬停时停住，免得看东西时一直飘
      React.useEffect(() => {
        let raf = 0
        let last = 0
        const 间隔 = nodes.length > 140 ? 80 : 40
        const 步 = (t) => {
          raf = requestAnimationFrame(步)
          if (typeof document !== 'undefined' && document.hidden) return
          if (选中 || 选中边 || 搜开 || 拖动 || 悬停 || 悬停边) return
          if (t - last < 间隔) return
          last = t
          设转向((v) => ({ yaw: v.yaw + (间隔 > 40 ? 0.007 : 0.0035), pitch: v.pitch }))
        }
        raf = requestAnimationFrame(步)
        return () => cancelAnimationFrame(raf)
      }, [选中, 选中边, 搜开, 拖动, 悬停, 悬停边, nodes.length])

      React.useEffect(() => {
        const el = 图引用.current
        if (!el || !el.addEventListener) return
        const 滚 = (ev) => {
          if (!ev.deltaY) return
          ev.preventDefault()
          设缩放值((k) => Math.max(0.55, Math.min(2.6, k * Math.exp(-ev.deltaY * 0.0012))))
        }
        el.addEventListener('wheel', 滚, { passive: false })
        return () => el.removeEventListener('wheel', 滚)
      }, [nodes.length])

      const 投影 = React.useMemo(() => {
        const 表 = new Map()
        for (let i = 0; i < nodes.length; i++) {
          const p = 位图[i]
          if (!p) continue
          const 转 = 星云旋转({ x: p.ux * p.rf, y: p.uy * p.rf, z: p.uz * p.rf }, 转向)
          表.set(nodes[i].id, 星云投影(转, 缩放值))
        }
        return 表
      }, [nodes, 位图, 转向, 缩放值])

      // 屏幕上的样子：越靠前越大越亮，标签也只用正半球
      const 投影视图 = React.useMemo(() => {
        const 表 = new Map()
        for (const nd of nodes) {
          const p = 位置.get(nd.id)
          const pr = 投影.get(nd.id)
          if (!p || !pr) continue
          const 深 = (pr.z + 1) / 2
          表.set(nd.id, { x: pr.x, y: pr.y, z: pr.z, 深, r: p.r * (0.78 + 0.4 * 深) })
        }
        return 表
      }, [nodes, 位置, 投影])

      const 曲线 = React.useMemo(() => {
        const m = new Map()
        for (const e of edges) {
          const a = 位置.get(e.from)
          const b = 位置.get(e.to)
          const A = 投影.get(e.from)
          const B = 投影.get(e.to)
          if (!a || !b || !A || !B) continue
          // 球面大圆中点投影出来，弧线就贴着球面走
          const 中方向 = 归一({ x: a.ux + b.ux, y: a.uy + b.uy, z: a.uz + b.uz })
          const 中rf = (a.rf + b.rf) / 2
          const C = 星云投影(星云旋转({ x: 中方向.x * 中rf, y: 中方向.y * 中rf, z: 中方向.z * 中rf }, 转向), 缩放值)
          const qx = 2 * C.x - (A.x + B.x) / 2
          const qy = 2 * C.y - (A.y + B.y) / 2
          m.set(e.id, {
            d: `M${A.x.toFixed(1)},${A.y.toFixed(1)} Q${qx.toFixed(1)},${qy.toFixed(1)} ${B.x.toFixed(1)},${B.y.toFixed(1)}`,
            中: C,
            箭: C,
            角: (Math.atan2(B.y - A.y, B.x - A.x) * 180) / Math.PI,
            z: (A.z + B.z + C.z) / 3,
          })
        }
        return m
      }, [edges, 位置, 投影, 转向, 缩放值])

      // 经纬线分段投影；正反面分开描，才有球壳的纵深
      const 环球面 = React.useMemo(() => {
        const 正 = []
        const 背 = []
        for (const pts of 星环) {
          let front = ''
          let back = ''
          let prev = 星云投影(星云旋转(pts[0], 转向), 缩放值)
          for (let i = 1; i < pts.length; i++) {
            const cur = 星云投影(星云旋转(pts[i], 转向), 缩放值)
            const 段 = `M${prev.x.toFixed(1)},${prev.y.toFixed(1)}L${cur.x.toFixed(1)},${cur.y.toFixed(1)}`
            if (prev.z + cur.z >= 0) front += 段
            else back += 段
            prev = cur
          }
          正.push(front)
          背.push(back)
        }
        return { 正, 背 }
      }, [星环, 转向, 缩放值])

      const 搜索词 = 查询.trim().toLowerCase()
      const 搜索中 = 搜索词.length > 0
      const 命中节点 = new Set()
      const 命中边 = new Set()
      const 节点结果 = []
      const 边结果 = []
      if (搜索中) {
        for (const nd of nodes) {
          const hay = [nd.name, ...(nd.aliases || [])].join(' ').toLowerCase()
          if (hay.includes(搜索词)) {
            命中节点.add(nd.id)
            节点结果.push(nd)
          }
        }
        for (const e of edges) {
          const hay = [e.rel, e.text, ...(e.texts || [])].join(' ').toLowerCase()
          if (hay.includes(搜索词)) {
            命中边.add(e.id)
            命中节点.add(e.from)
            命中节点.add(e.to)
            边结果.push(e)
          }
        }
        节点结果.sort((a, b) => {
          const pa = 位置.get(a.id) || { score: 0 }
          const pb = 位置.get(b.id) || { score: 0 }
          const 开头 = (x) => (String(x.name).toLowerCase().startsWith(搜索词) ? 1 : 0)
          return 开头(b) - 开头(a) || pb.score - pa.score
        })
        边结果.sort((a, b) => String(b.updated || '').localeCompare(String(a.updated || '')))
      }
      const 搜索结果 = [
        ...节点结果.slice(0, 5).map((nd) => ({ 型: 'node', 节点: nd })),
        ...边结果.slice(0, 4).map((e) => ({ 型: 'edge', 边: e })),
      ]

      const 节点可见 = (nd) => {
        if (!nd || !类型开.has(nd.type)) return false
        if (范围 && !(nd.scopes || []).includes(范围)) return false
        return true
      }
      const 边可见 = (e) => {
        const a = 节点表.get(e.from)
        const b = 节点表.get(e.to)
        if (!a || !b || !节点可见(a) || !节点可见(b)) return false
        if (范围 && !(e.scopes || [e.scope]).filter(Boolean).includes(范围)) return false
        return true
      }

      const 邻域 = React.useMemo(() => {
        const ns = new Set()
        const es = new Set()
        if (选中) {
          ns.add(选中)
          for (const e of edges) {
            if (e.from === 选中 || e.to === 选中) {
              es.add(e.id)
              ns.add(e.from)
              ns.add(e.to)
            }
          }
        } else if (选中边) {
          for (const e of edges) {
            if (e.id !== 选中边) continue
            es.add(e.id)
            ns.add(e.from)
            ns.add(e.to)
          }
        }
        return { ns, es }
      }, [选中, 选中边, edges])

      const 清选中 = () => { 设选中(null); 设选中边(null) }
      const 选节点 = (id) => { 设选中(id); 设选中边(null) }
      const 选边 = (id) => { 设选中边(id); 设选中(null) }
      const 分片名 = (scs) => {
        const arr = (Array.isArray(scs) ? scs : [scs]).filter(Boolean)
        const names = arr.map((sc) => 分片映射.get(sc) || sc)
        return names.length ? names.slice(0, 2).join(' · ') + (names.length > 2 ? ` +${names.length - 2}` : '') : '—'
      }
      const 原文 = (e, n) => {
        if (!e) return []
        const arr = Array.isArray(e.texts) && e.texts.length ? e.texts : (e.text ? [e.text] : [])
        const uniq = [...new Set(arr.filter(Boolean))]
        return n ? uniq.slice(0, n) : uniq
      }
      const 转向到 = (向, 倍) => {
        if (!向) return
        设转向(星云对准方向({ x: 向.ux || 0, y: 向.uy || 0, z: 向.uz || 0 }))
        if (倍) 设缩放值((v) => Math.max(v, 倍))
      }
      const 缩放 = (倍) => 设缩放值((v) => Math.max(0.55, Math.min(2.6, v * 倍)))
      const 让显示 = (列表) => {
        const 要开 = new Set(类型开)
        let 改了 = false
        for (const nd of 列表) {
          if (nd && !要开.has(nd.type)) { 要开.add(nd.type); 改了 = true }
        }
        if (改了) 设类型开(要开)
        if (范围 && !列表.some((nd) => nd && (nd.scopes || []).includes(范围))) 设范围('')
      }
      const 选结果 = (r) => {
        if (!r) return
        if (r.型 === 'node') {
          const nd = r.节点
          让显示([nd])
          选节点(nd.id)
          转向到(位置.get(nd.id), 1.3)
        } else {
          const e = r.边
          const a = 节点表.get(e.from)
          const b = 节点表.get(e.to)
          让显示([a, b])
          选边(e.id)
          const pa = 位置.get(e.from)
          const pb = 位置.get(e.to)
          if (pa && pb) {
            const 中 = 归一({ x: pa.ux + pb.ux, y: pa.uy + pb.uy, z: pa.uz + pb.uz })
            转向到({ ux: 中.x, uy: 中.y, uz: 中.z }, 1.2)
          }
        }
        设查询('')
        设搜开(false)
      }
      const 按下背景 = (ev) => {
        if (ev.button !== 0) return
        拖过.current = false
        拖参考.current = { x: ev.clientX, y: ev.clientY, yaw: 转向.yaw, pitch: 转向.pitch }
        设拖动(true)
        try { ev.currentTarget.setPointerCapture(ev.pointerId) } catch {}
      }
      const 移动背景 = (ev) => {
        const d = 拖参考.current
        if (!d) return
        const el = 图引用.current
        const ctm = el && el.getScreenCTM ? el.getScreenCTM() : null
        const 倍 = ctm && ctm.a ? ctm.a : 1
        const dx = (ev.clientX - d.x) / 倍
        const dy = (ev.clientY - d.y) / 倍
        if (Math.abs(dx) + Math.abs(dy) > 3) 拖过.current = true
        设转向({
          yaw: d.yaw + dx * 0.006,
          pitch: Math.max(-1.25, Math.min(1.25, d.pitch - dy * 0.005)),
        })
      }
      const 松开背景 = (ev) => {
        拖参考.current = null
        设拖动(false)
        try { ev.currentTarget.releasePointerCapture(ev.pointerId) } catch {}
      }
      const 点背景 = () => {
        if (拖过.current) { 拖过.current = false; return }
        设搜开(false)
        清选中()
      }

      const 点态 = (nd) => {
        if (!节点可见(nd)) return { o: 0, 高: false }
        if (选中) {
          const 近 = 邻域.ns.has(nd.id)
          return { o: nd.id === 选中 ? 1 : 近 ? 0.9 : 0.14, 高: nd.id === 选中 || 悬停 === nd.id }
        }
        if (选中边) {
          const 近 = 邻域.ns.has(nd.id)
          return { o: 近 ? 1 : 0.22, 高: 近 }
        }
        if (搜索中) return { o: 命中节点.has(nd.id) ? 1 : 0.14, 高: 命中节点.has(nd.id) }
        return { o: 悬停 === nd.id ? 1 : 0.95, 高: 悬停 === nd.id }
      }
      const 边态 = (e) => {
        if (!边可见(e)) return { o: 0, 高: false }
        if (悬停边 === e.id) return { o: 1, 高: true }
        if (选中边) {
          const 中 = e.id === 选中边
          return { o: 中 ? 1 : 邻域.es.has(e.id) ? 0.4 : 0.08, 高: 中 }
        }
        if (选中) {
          const 近 = 邻域.es.has(e.id)
          return { o: 近 ? 0.95 : 0.08, 高: 近 }
        }
        if (搜索中) {
          if (命中边.has(e.id)) return { o: 1, 高: true }
          return { o: 命中节点.has(e.from) || 命中节点.has(e.to) ? 0.3 : 0.07, 高: false }
        }
        return { o: 0.72, 高: false }
      }
      const 显标签 = (nd, 态) => {
        const v = 投影视图.get(nd.id)
        if (!v || v.z < -0.3) return false
        if (态.o < 0.22) return false
        if (选中 === nd.id) return false
        if (悬停 === nd.id) return true
        if (选中 && 邻域.ns.has(nd.id)) return true
        if (搜索中 && 命中节点.has(nd.id)) return true
        return 标签优先.has(nd.id)
      }

      if (!nodes.length) {
        return h('div', { className: 'wm-neb-card' },
          h('div', { className: 'wm-neb-top' },
            h('div', { className: 'wm-neb-titleWrap' },
              h('span', { className: 'wm-neb-title' }, '记忆星云'),
              h('span', { className: 'wm-neb-sub' }, '实体和关系还没长出第一颗星'),
            ),
          ),
          h('div', { className: 'wm-neb-stage' },
            h('div', { className: 'wm-neb-aurora' }),
            h('svg', {
              className: 'wm-neb-stars',
              viewBox: `0 0 ${星云视宽} ${星云视高}`,
              preserveAspectRatio: 'none',
              'aria-hidden': 'true',
            },
              星点.map((s, i) => h('circle', {
                key: i, cx: s.x, cy: s.y, r: s.r, fill: s.c,
                style: { opacity: s.o, animation: `wmNebTwinkle ${s.d} ease-in-out ${s.delay} infinite` },
              })),
            ),
            h('svg', {
              className: 'wm-neb-emptyGlobe',
              viewBox: `0 0 ${星云视宽} ${星云视高}`,
              preserveAspectRatio: 'xMidYMid meet',
              'aria-hidden': 'true',
            },
              h('defs', null,
                h('radialGradient', { id: 'wmNebEmptyGlobe' },
                  h('stop', { offset: '0%', stopColor: '#16254d', stopOpacity: 0.5 }),
                  h('stop', { offset: '62%', stopColor: '#0b1330', stopOpacity: 0.3 }),
                  h('stop', { offset: '100%', stopColor: '#050a18', stopOpacity: 0.5 }),
                ),
                h('radialGradient', { id: 'wmNebEmptyAtmo' },
                  h('stop', { offset: '58%', stopColor: '#3d6bff', stopOpacity: 0 }),
                  h('stop', { offset: '92%', stopColor: '#6f9dff', stopOpacity: 0.14 }),
                  h('stop', { offset: '100%', stopColor: '#9cc2ff', stopOpacity: 0 }),
                ),
              ),
              h('circle', { cx: 星云球心.x, cy: 星云球心.y, r: 星云球半径 * 1.14, fill: 'url(#wmNebEmptyAtmo)' }),
              h('circle', {
                cx: 星云球心.x, cy: 星云球心.y, r: 星云球半径,
                fill: 'url(#wmNebEmptyGlobe)', stroke: 'rgba(143,184,255,.2)', strokeWidth: 1,
              }),
            ),
            h('div', { className: 'wm-neb-emptyBig' },
              h('div', { className: 'wm-neb-emptyTitle' }, '星云还没成形'),
              h('div', { className: 'wm-neb-emptyText' }, '多聊几句带地点、喜好、称呼的话，实体就会在这里亮起来。'),
            ),
          ),
        )
      }

      // 标签避让：先试径向朝外，再试上下左右；宁可少一个名字，也不叠在一起
      const 标签计划 = (() => {
        const out = new Map()
        const 已占 = []
        const 排序 = [...nodes].sort((a, b) => {
          const 级 = (n) => (n.id === 悬停 ? 0 : 搜索中 && 命中节点.has(n.id) ? 1 : 3)
          return 级(a) - 级(b) || (位置.get(b.id) || { score: 0 }).score - (位置.get(a.id) || { score: 0 }).score
        })
        const 撞框 = (box) => 已占.some((b) => !(box.x2 <= b.x1 || box.x1 >= b.x2 || box.y2 <= b.y1 || box.y1 >= b.y2))
        const 撞点 = (box, self) => nodes.some((nd) => {
          if (!节点可见(nd) || nd.id === self) return false
          const p = 投影视图.get(nd.id)
          if (!p) return false
          const dx = Math.max(box.x1 - p.x, 0, p.x - box.x2)
          const dy = Math.max(box.y1 - p.y, 0, p.y - box.y2)
          const 距 = p.r + 3
          return dx * dx + dy * dy < 距 * 距
        })
        const 试标签 = (nd, 松) => {
          if (out.has(nd.id)) return
          const p = 投影视图.get(nd.id)
          if (!p) return
          if (!显标签(nd, 点态(nd))) return
          const 名 = nd.name.length > 11 ? nd.name.slice(0, 11) + '…' : nd.name
          let 宽 = 0
          for (const ch of 名) 宽 += /[\x00-\xff]/.test(ch) ? 6.4 : 11.2
          const 方向 = Math.atan2(p.y - 星云球心.y, p.x - 星云球心.x)
          const ux = Math.cos(方向)
          const uy = Math.sin(方向)
          const 距 = p.r + 9
          const 候选 = []
          if (Math.abs(uy) >= Math.abs(ux)) {
            候选.push({ x: p.x, y: uy < 0 ? p.y - 距 : p.y + 距, anchor: 'middle' })
          } else {
            候选.push({ x: ux > 0 ? p.x + 距 : p.x - 距, y: p.y + 4, anchor: ux > 0 ? 'start' : 'end' })
          }
          候选.push({ x: p.x, y: p.y + p.r + 13, anchor: 'middle' })
          候选.push({ x: p.x, y: p.y - p.r - 6, anchor: 'middle' })
          候选.push({ x: p.x + p.r + 7, y: p.y + 4, anchor: 'start' })
          候选.push({ x: p.x - p.r - 7, y: p.y + 4, anchor: 'end' })
          for (const c of 候选) {
            const x1 = c.anchor === 'middle' ? c.x - 宽 / 2 : c.anchor === 'start' ? c.x : c.x - 宽
            const box = { x1, y1: c.y - 9, x2: x1 + 宽, y2: c.y + 4 }
            if (x1 < 8 || box.x2 > 星云视宽 - 8 || box.y1 < 8 || box.y2 > 星云视高 - 8) continue
            if (撞框(box)) continue
            if (!松 && 撞点(box, nd.id)) continue
            已占.push(box)
            out.set(nd.id, { x: c.x, y: c.y, anchor: c.anchor })
            return
          }
        }
        for (const nd of 排序) 试标签(nd, false)
        // 第二轮放宽「别压住别的星」，点名优先，宁可贴着星也不让名字缺席
        for (const nd of 排序) 试标签(nd, true)
        // 悬停/搜索命中的名字，就算挤不下也强行露出来
        for (const nd of 排序) {
          if (out.has(nd.id)) continue
          if (!(悬停 === nd.id || (搜索中 && 命中节点.has(nd.id)))) continue
          const p = 投影视图.get(nd.id)
          if (!p) continue
          const 名 = nd.name.length > 11 ? nd.name.slice(0, 11) + '…' : nd.name
          let 宽 = 0
          for (const ch of 名) 宽 += /[\x00-\xff]/.test(ch) ? 6.4 : 11.2
          const x = Math.max(宽 / 2 + 4, Math.min(星云视宽 - 宽 / 2 - 4, p.x))
          const y = Math.min(星云视高 - 10, p.y + p.r + 14)
          out.set(nd.id, { x, y, anchor: 'middle' })
        }
        return out
      })()

      const 当前节点 = 选中 ? 节点表.get(选中) || null : null
      const 当前边 = 选中边 ? edges.find((x) => x.id === 选中边) || null : null
      const 节点关系 = 当前节点
        ? edges
          .filter((e) => e.from === 当前节点.id || e.to === 当前节点.id)
          .sort((a, b) => (Number(b.weight) || 0) - (Number(a.weight) || 0) || String(b.updated || '').localeCompare(String(a.updated || '')))
        : []

      const 头 = h('div', { className: 'wm-neb-top' },
        h('div', { className: 'wm-neb-titleWrap' },
          h('span', { className: 'wm-neb-title' }, '记忆星云'),
          h('span', { className: 'wm-neb-sub' }, `${nodes.length} 实体 · ${edges.length} 关系 · ${nodes.filter((nd) => !关系数.get(nd.id)).length} 颗孤星`),
        ),
        h('div', { className: 'wm-neb-tools' },
          h('select', {
            className: 'wm-neb-select',
            value: 范围,
            onChange: (ev) => 设范围(ev.target.value),
            title: '按分片看',
          },
            h('option', { value: '' }, '全部分片'),
            分片标签.map(([sc, label]) => h('option', { key: sc, value: sc }, label)),
          ),
          h('button', {
            className: 'wm-neb-btn',
            onClick: () => { 设转向({ yaw: -0.5, pitch: -0.14 }); 设缩放值(1); 清选中() },
          }, '复位视角'),
        ),
      )

      const 星空 = h('svg', {
        className: 'wm-neb-stars',
        viewBox: `0 0 ${星云视宽} ${星云视高}`,
        preserveAspectRatio: 'none',
        'aria-hidden': 'true',
      },
        星点.map((s, i) => h('circle', {
          key: i, cx: s.x, cy: s.y, r: s.r, fill: s.c,
          style: { opacity: s.o, animation: `wmNebTwinkle ${s.d} ease-in-out ${s.delay} infinite` },
        })),
      )

      const 渐变 = h('defs', null,
        Object.keys(类型名).map((k) => h('radialGradient', { key: 'h' + k, id: 'wmNebHalo-' + k },
          h('stop', { offset: '0%', stopColor: 色彩[k], stopOpacity: 0.5 }),
          h('stop', { offset: '45%', stopColor: 色彩[k], stopOpacity: 0.18 }),
          h('stop', { offset: '100%', stopColor: 色彩[k], stopOpacity: 0 }),
        )),
        Object.keys(类型名).map((k) => h('radialGradient', { key: 'c' + k, id: 'wmNebCore-' + k },
          h('stop', { offset: '0%', stopColor: '#ffffff', stopOpacity: 1 }),
          h('stop', { offset: '26%', stopColor: '#ffffff', stopOpacity: 0.85 }),
          h('stop', { offset: '52%', stopColor: 色彩[k], stopOpacity: 1 }),
          h('stop', { offset: '100%', stopColor: 色彩[k], stopOpacity: 0.95 }),
        )),
        h('radialGradient', { id: 'wmNebAtmo' },
          h('stop', { offset: '56%', stopColor: '#3d6bff', stopOpacity: 0 }),
          h('stop', { offset: '86%', stopColor: '#5c8dff', stopOpacity: 0.12 }),
          h('stop', { offset: '97%', stopColor: '#9cc2ff', stopOpacity: 0.22 }),
          h('stop', { offset: '100%', stopColor: '#9cc2ff', stopOpacity: 0 }),
        ),
        h('radialGradient', { id: 'wmNebGlobe' },
          h('stop', { offset: '0%', stopColor: '#16254d', stopOpacity: 0.55 }),
          h('stop', { offset: '60%', stopColor: '#0b1330', stopOpacity: 0.34 }),
          h('stop', { offset: '100%', stopColor: '#050a18', stopOpacity: 0.58 }),
        ),
        h('radialGradient', { id: 'wmNebCoreGlow' },
          h('stop', { offset: '0%', stopColor: '#7fb0ff', stopOpacity: 0.26 }),
          h('stop', { offset: '46%', stopColor: '#4f7dff', stopOpacity: 0.1 }),
          h('stop', { offset: '100%', stopColor: '#4f7dff', stopOpacity: 0 }),
        ),
        h('linearGradient', { id: 'wmNebRim', x1: '0', y1: '0', x2: '1', y2: '1' },
          h('stop', { offset: '0%', stopColor: '#cfe2ff', stopOpacity: 0.9 }),
          h('stop', { offset: '48%', stopColor: '#6f9dff', stopOpacity: 0.3 }),
          h('stop', { offset: '100%', stopColor: '#6f9dff', stopOpacity: 0.05 }),
        ),
        h('radialGradient', { id: 'wmNebSheen' },
          h('stop', { offset: '0%', stopColor: '#a9c8ff', stopOpacity: 0.16 }),
          h('stop', { offset: '46%', stopColor: '#7ba4ff', stopOpacity: 0.06 }),
          h('stop', { offset: '100%', stopColor: '#7ba4ff', stopOpacity: 0 }),
        ),
        ['#3d6bff', '#7c5cff', '#2ad6be', '#ff7fa8', '#5da8ff', '#9d7bff'].map((色, i) => h('radialGradient', { key: 'cl' + i, id: 'wmNebCloud-' + i },
          h('stop', { offset: '0%', stopColor: 色, stopOpacity: 0.5 }),
          h('stop', { offset: '55%', stopColor: 色, stopOpacity: 0.16 }),
          h('stop', { offset: '100%', stopColor: 色, stopOpacity: 0 }),
        )),
      )

      const 球半径px = 星云球半径 * 缩放值
      const 尘埃 = 星尘.map((d, i) => {
        const v = 星云投影(星云旋转(d, 转向), 缩放值)
        const 深 = (v.z + 1) / 2
        return h('circle', {
          key: i,
          cx: v.x,
          cy: v.y,
          r: d.s * (0.6 + 0.7 * 深),
          fill: d.c,
          opacity: d.o * (0.25 + 0.75 * 深),
          style: { pointerEvents: 'none' },
        })
      })
      const 排序边 = edges
        .map((e) => ({ e, c: 曲线.get(e.id) }))
        .filter((x) => x.c)
        .sort((a, b) => a.c.z - b.c.z)
      const 排序节点 = [...nodes]
        .filter((nd) => 投影视图.get(nd.id))
        .sort((a, b) => (投影视图.get(a.id).z + (选中 === a.id ? 3 : 0)) - (投影视图.get(b.id).z + (选中 === b.id ? 3 : 0)))

      const 图区 = h('svg', {
        ref: 图引用,
        className: 'wm-neb-graph' + (拖动 ? ' wm-neb-grabbing' : ''),
        viewBox: `0 0 ${星云视宽} ${星云视高}`,
        preserveAspectRatio: 'xMidYMid meet',
        role: 'img',
        'aria-label': '记忆星云图',
      },
        h('rect', {
          x: 0, y: 0, width: 星云视宽, height: 星云视高, fill: 'transparent',
          onPointerDown: 按下背景,
          onPointerMove: 移动背景,
          onPointerUp: 松开背景,
          onPointerCancel: 松开背景,
          onClick: 点背景,
          style: { cursor: 拖动 ? 'grabbing' : 'grab' },
        }),
        渐变,
        h('g', { style: { pointerEvents: 'none' } },
          h('circle', { cx: 星云球心.x, cy: 星云球心.y, r: 球半径px * 1.16, fill: 'url(#wmNebAtmo)' }),
          h('circle', { cx: 星云球心.x, cy: 星云球心.y, r: 球半径px, fill: 'url(#wmNebGlobe)' }),
          h('circle', {
            cx: 星云球心.x - 球半径px * 0.28,
            cy: 星云球心.y - 球半径px * 0.32,
            r: 球半径px * 0.92,
            fill: 'url(#wmNebSheen)',
          }),
          h('circle', {
            cx: 星云球心.x, cy: 星云球心.y, r: 球半径px,
            fill: 'none', stroke: 'url(#wmNebRim)', strokeWidth: 1.2, opacity: 0.7,
          }),
          h('g', { fill: 'none', stroke: '#8fb8ff', strokeWidth: 0.7, strokeLinecap: 'round', style: { pointerEvents: 'none' } },
            环球面.背.map((d, i) => (d ? h('path', { key: 'b' + i, d, opacity: 0.08 }) : null)),
            环球面.正.map((d, i) => (d ? h('path', { key: 'f' + i, d, opacity: 0.2 }) : null)),
          ),
          h('circle', { cx: 星云球心.x, cy: 星云球心.y, r: 球半径px * 0.66, fill: 'url(#wmNebCoreGlow)' }),
        ),
        h('g', { style: { pointerEvents: 'none' } },
          星雾.map((d, i) => {
            const v = 星云投影(星云旋转(d, 转向), 缩放值)
            const 深 = (v.z + 1) / 2
            const rr = Math.max(8, d.r * 星云球半径 * 缩放值 * v.f)
            return h('circle', {
              key: 'c' + i,
              cx: v.x,
              cy: v.y,
              r: rr,
              fill: 'url(#wmNebCloud-' + (i % 6) + ')',
              opacity: d.o * (0.4 + 0.6 * 深),
            })
          }),
        ),
        h('g', { style: { pointerEvents: 'none' } }, 尘埃),
        h('g', null,
          排序边.map(({ e, c }) => {
            const 态 = 边态(e)
            if (!态.o) return null
            const 从 = 节点表.get(e.from)
            const 色 = (从 && 色彩[从.type]) || '#9cc9ff'
            const 高 = 态.高
            const 深 = (c.z + 1) / 2
            const 亮 = 态.o * (0.4 + 0.6 * 深)
            const 宽 = 高 ? 2.1 : 0.9 + Math.min(1.1, (Number(e.weight) || 1) * 0.16)
            return h('g', { key: e.id },
              h('path', {
                d: c.d,
                fill: 'none',
                stroke: 高 ? 色 : '#8fb0e8',
                strokeWidth: 宽,
                strokeOpacity: 高 ? Math.min(1, 0.75 + 0.25 * 深) : 0.1 + 0.42 * 亮,
                strokeLinecap: 'round',
                className: 高 ? 'wm-neb-edgeOn' : undefined,
              }),
              h('path', {
                d: c.d,
                fill: 'none',
                stroke: 'transparent',
                strokeWidth: 14,
                style: { cursor: 'pointer', pointerEvents: 'stroke' },
                onPointerDown: (ev) => ev.stopPropagation(),
                onPointerEnter: () => 设悬停边(e.id),
                onPointerLeave: () => 设悬停边((x) => (x === e.id ? null : x)),
                onClick: (ev) => { ev.stopPropagation(); 选边(e.id) },
              }),
              高 ? h('path', {
                d: 'M -4 -3 L 4 0 L -4 3 Z',
                fill: 色,
                opacity: 0.95,
                transform: `translate(${c.箭.x} ${c.箭.y}) rotate(${c.角})`,
                style: { pointerEvents: 'none' },
              }) : null,
              (悬停边 === e.id || 选中边 === e.id || (搜索中 && 命中边.has(e.id))) ? h('text', {
                x: c.中.x,
                y: c.中.y,
                textAnchor: 'middle',
                fontSize: 10.5,
                fill: '#cfe3ff',
                stroke: '#070b18',
                strokeWidth: 3,
                paintOrder: 'stroke',
                style: { pointerEvents: 'none' },
              }, e.rel) : null,
            )
          }),
        ),
        h('g', null,
          排序节点.map((nd) => {
            const v = 投影视图.get(nd.id)
            if (!v) return null
            const 态 = 点态(nd)
            if (!态.o) return null
            const 色 = 色彩[nd.type] || 色彩.thing
            const 中 = 选中 === nd.id
            const 悬 = 悬停 === nd.id
            const 标签 = 标签计划.get(nd.id)
            const 亮 = 态.o * (0.45 + 0.55 * v.深)
            return h('g', {
              key: nd.id,
              transform: `translate(${v.x} ${v.y})`,
              style: { opacity: 亮, cursor: 'pointer', transition: 'opacity .18s' },
              onPointerDown: (ev) => ev.stopPropagation(),
              onPointerEnter: () => 设悬停(nd.id),
              onPointerLeave: () => 设悬停((x) => (x === nd.id ? null : x)),
              onClick: (ev) => { ev.stopPropagation(); if (中) 清选中(); else 选节点(nd.id) },
            },
              h('title', null, nd.name + ' · ' + (类型名[nd.type] || nd.type) + ((关系数.get(nd.id) || 0) ? ' · ' + 关系数.get(nd.id) + ' 条关系' : '')),
              h('circle', {
                r: v.r * 3.4,
                fill: 'url(#wmNebHalo-' + nd.type + ')',
                opacity: 中 ? 1 : 悬 ? 0.9 : 0.62,
                style: 中 ? { animation: 'wmNebBreathe 2.6s ease-in-out infinite' } : null,
              }),
              h('circle', {
                r: v.r,
                fill: 'url(#wmNebCore-' + nd.type + ')',
                stroke: 中 ? '#ffffff' : 'rgba(255,255,255,.58)',
                strokeWidth: 中 ? 1.6 : 0.8,
              }),
              h('circle', {
                cx: -v.r * 0.3,
                cy: -v.r * 0.32,
                r: Math.max(1.1, v.r * 0.3),
                fill: 'rgba(255,255,255,.62)',
                style: { pointerEvents: 'none' },
              }),
              中 ? h('circle', {
                r: v.r + 6,
                fill: 'none',
                stroke: '#bcd8ff',
                strokeWidth: 1,
                strokeDasharray: '3 5',
                className: 'wm-neb-orbit',
                style: { pointerEvents: 'none' },
              }) : null,
              h('circle', { r: v.r + 9, fill: 'transparent' }),
              标签 ? h('text', {
                x: 标签.x - v.x,
                y: 标签.y - v.y,
                textAnchor: 标签.anchor,
                fontSize: 10 + 1.3 * v.深,
                fill: 中 || 悬 ? '#ffffff' : '#d7e4ff',
                stroke: '#070b18',
                strokeWidth: 3.2,
                paintOrder: 'stroke',
                style: { pointerEvents: 'none', letterSpacing: '.2px' },
              }, nd.name.length > 11 ? nd.name.slice(0, 11) + '…' : nd.name) : null,
            )
          }),
        ),
      )

      const 搜索框 = h('div', { className: 'wm-neb-search' },
        h('svg', { viewBox: '0 0 24 24', width: 14, height: 14, 'aria-hidden': 'true' },
          h('circle', { cx: 11, cy: 11, r: 7, fill: 'none', stroke: 'currentColor', strokeWidth: 2 }),
          h('path', { d: 'M16.5 16.5 L21 21', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' }),
        ),
        h('input', {
          value: 查询,
          placeholder: '搜实体、关系或记忆…',
          'aria-label': '搜索星云',
          onChange: (ev) => { 设查询(ev.target.value); 设搜开(true) },
          onFocus: () => 设搜开(true),
          onBlur: () => 设搜开(false),
          onKeyDown: (ev) => {
            if (ev.key === 'Enter' && 搜索结果.length) {
              ev.preventDefault()
              选结果(搜索结果[0])
            } else if (ev.key === 'Escape') {
              设查询('')
              设搜开(false)
              ev.currentTarget.blur()
            }
          },
        }),
      )

      const 结果层 = (搜索中 && 搜开)
        ? h('div', { className: 'wm-neb-results', onMouseDown: (ev) => ev.preventDefault() },
          搜索结果.length
            ? 搜索结果.map((r) => {
              if (r.型 === 'node') {
                const nd = r.节点
                return h('div', { key: 'n_' + nd.id, className: 'wm-neb-result', onClick: () => 选结果(r) },
                  h('i', { className: 'wm-neb-resultDot', style: { background: 色彩[nd.type] || 色彩.thing, color: 色彩[nd.type] || 色彩.thing } }),
                  h('span', { className: 'wm-neb-resultName' }, nd.name),
                  h('span', { className: 'wm-neb-resultMeta' }, (类型名[nd.type] || '实体') + ' · ' + (关系数.get(nd.id) || 0) + ' 关系'),
                )
              }
              const e = r.边
              const a = 节点表.get(e.from)
              const b = 节点表.get(e.to)
              return h('div', { key: 'e_' + e.id, className: 'wm-neb-result', onClick: () => 选结果(r) },
                h('i', { className: 'wm-neb-resultDot', style: { background: '#8fb8ff', color: '#8fb8ff' } }),
                h('span', { className: 'wm-neb-resultName' }, (a ? a.name : '?') + ' —' + e.rel + '→ ' + (b ? b.name : '?')),
                h('span', { className: 'wm-neb-resultMeta' }, 原文(e, 1)[0] || ''),
              )
            })
            : h('div', { className: 'wm-neb-empty' }, '当前筛选下没有匹配的实体或关系'),
        )
        : null

      const 图例 = h('div', { className: 'wm-neb-legend' },
        Object.keys(类型名).map((k) => {
          const 开 = 类型开.has(k)
          const 数 = nodes.filter((nd) => nd.type === k).length
          return h('button', {
            key: k,
            className: 'wm-neb-chip' + (开 ? ' wm-neb-chipOn' : ''),
            title: 开 ? '点击隐藏' : '点击显示',
            onClick: () => {
              const next = new Set(类型开)
              if (next.has(k)) next.delete(k)
              else next.add(k)
              设类型开(next)
            },
          },
            h('i', { style: { background: 色彩[k], color: 色彩[k], opacity: 开 ? 1 : 0.3 } }),
            h('span', null, 类型名[k]),
            h('span', { className: 'wm-neb-chipN' }, String(数)),
          )
        }),
      )

      const 缩放钮 = h('div', { className: 'wm-neb-zoom' },
        h('button', { onClick: () => 缩放(1 / 1.35), title: '缩小' }, '−'),
        h('button', { onClick: () => 缩放(1.35), title: '放大' }, '+'),
        h('button', { onClick: () => { 设缩放值(1); 设转向({ yaw: -0.5, pitch: -0.14 }) }, title: '复位视角' }, '1:1'),
      )

      const 提示 = h('div', { className: 'wm-neb-hint' },
        (选中 || 选中边) ? '拖动旋转 · 滚轮缩放 · 点空白取消选中' : '拖动旋转 · 滚轮缩放 · 点实体或连线查看记忆',
      )

      let 详情 = null
      if (当前节点) {
        详情 = h('div', { className: 'wm-neb-detail' },
          h('div', { className: 'wm-neb-detailHead' },
            h('span', { className: 'wm-neb-detailTitle' }, 当前节点.name),
            h('button', { className: 'wm-neb-x', onClick: 清选中, title: '关闭' }, '×'),
          ),
          h('div', { className: 'wm-neb-meta' },
            h('i', { className: 'wm-neb-typeDot', style: { background: 色彩[当前节点.type] || 色彩.thing } }),
            h('span', null, 类型名[当前节点.type] || 当前节点.type || '实体'),
            h('span', null, '·'),
            h('span', null, `提及 ${当前节点.mentions || 0}`),
            h('span', null, '·'),
            h('span', null, `${节点关系.length} 条关系`),
          ),
          h('div', { className: 'wm-neb-meta' }, h('span', null, '出现于 ' + 分片名(当前节点.scopes || []))),
          h('div', { style: { display: 'flex', gap: 6 } },
            h('button', { className: 'wm-neb-mini', onClick: () => 转向到(位置.get(当前节点.id), 1.4) }, '居中'),
          ),
          h('div', { className: 'wm-neb-section' }, '关系'),
          节点关系.length
            ? 节点关系.slice(0, 30).map((e) => {
              const 出 = e.from === 当前节点.id
              const 另 = 节点表.get(出 ? e.to : e.from)
              return h('button', { key: e.id, className: 'wm-neb-rel', onClick: () => 选边(e.id) },
                h('div', { className: 'wm-neb-relTop' },
                  h('span', { className: 'wm-neb-relName', style: { color: 另 ? 色彩[另.type] || '#dce9ff' : '#dce9ff' } }, 另 ? 另.name : '?'),
                  h('span', { className: 'wm-neb-relTag' }, (出 ? '→ ' : '← ') + e.rel),
                ),
                h('div', { className: 'wm-neb-relText' }, 原文(e, 1)[0] || ''),
              )
            })
            : h('div', { className: 'wm-neb-empty' }, '这颗星还没连上别人。'),
          (当前节点.texts || []).length
            ? h('div', { className: 'wm-neb-section' }, '提到它的记忆')
            : null,
          (当前节点.texts || []).slice(0, 6).map((t, i) => h('div', { key: i, className: 'wm-neb-memo' }, t)),
        )
      } else if (当前边) {
        const a = 节点表.get(当前边.from)
        const b = 节点表.get(当前边.to)
        const 文 = 原文(当前边)
        详情 = h('div', { className: 'wm-neb-detail' },
          h('div', { className: 'wm-neb-detailHead' },
            h('span', { className: 'wm-neb-detailTitle' }, '关系'),
            h('button', { className: 'wm-neb-x', onClick: 清选中, title: '关闭' }, '×'),
          ),
          h('div', { className: 'wm-neb-meta' },
            h('span', { style: { color: a ? 色彩[a.type] || '#dce9ff' : '#dce9ff', fontWeight: 600 } }, a ? a.name : '?'),
            h('span', { className: 'wm-neb-relTag' }, '→ ' + 当前边.rel + ' →'),
            h('span', { style: { color: b ? 色彩[b.type] || '#dce9ff' : '#dce9ff', fontWeight: 600 } }, b ? b.name : '?'),
          ),
          h('div', { className: 'wm-neb-meta' },
            h('span', null, `更新 ${时间(当前边.updated) || '—'} · ${分片名(当前边.scopes || [当前边.scope])}`),
          ),
          h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
            a ? h('button', { className: 'wm-neb-mini', onClick: () => 选节点(a.id) }, '看 ' + a.name) : null,
            b ? h('button', { className: 'wm-neb-mini', onClick: () => 选节点(b.id) }, '看 ' + b.name) : null,
          ),
          h('div', { className: 'wm-neb-section' }, '来源记忆' + (文.length ? ' · ' + 文.length : '')),
          文.length
            ? 文.map((t, i) => h('div', { key: i, className: 'wm-neb-memo' },
              h('div', null, t),
              h('div', { className: 'wm-neb-memoMeta' }, 时间(当前边.updated) || ''),
            ))
            : h('div', { className: 'wm-neb-empty' }, '这条关系没有留下原文。'),
        )
      }

      return h('div', { className: 'wm-neb-card' },
        头,
        h('div', { className: 'wm-neb-layout' + (详情 ? ' wm-neb-hasDetail' : '') },
          h('div', { className: 'wm-neb-stage' },
            h('div', { className: 'wm-neb-aurora' }),
            星空,
            图区,
            搜索框,
            结果层,
            图例,
            缩放钮,
            提示,
          ),
          详情,
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

      return h('div', null,
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
      if (!表单) return WD.卡('思考模型', WD.提('读取主动行为配置…'))
      const f = 表单
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
      return WD.卡('思考模型',
        h('div', null,
          WD.提('填 DSH 里已经配好的 id，不是地址或 Key；留空就跟宿主当前默认。'),
          文('model', 'model', '留空跟全局默认'),
          文('provider', 'provider', '留空跟全局默认'),
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
            ad
              ? h('span', { className: 'wm-hint' }, `宿主当前默认：${ad.provider || '?'} / ${ad.model || '?'}`)
              : h('span', { className: 'wm-hint' }, '宿主没报当前默认，留空也行'),
          ),
          结果 ? h('div', { className: 'wm-notice ' + (结果.ok ? 'wm-good' : 'wm-bad') }, 结果.text) : null,
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
        WD.卡(null,
          h('div', null,
            h('div', { className: 'wm-subtabs', style: { marginBottom: 10 } },
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
              ? '宿主里开一路 agent：它决定搜什么、怎么整理，联网交给 DSH 的 web_search，翻 3–5 轮回来。'
              : '不开 agent：prompt 直接发给下面这个模型，一问一答；它得自带联网，否则返回空并自动退回 agent。'),
            WD.提(引擎 === 'agent'
              ? '成本：思考模型 + 每次 web_search 的搜索模型'
              : '成本：只算下面这个搜索模型', { marginTop: 4 }),
            结果 ? h('div', { className: 'wm-notice ' + (结果.ok ? 'wm-good' : 'wm-bad') }, 结果.text) : null,
          ),
        ),
        引擎 === 'agent'
          ? h(闲逛模型卡, 闲逛)
          : h(模型配置卡, Object.assign({}, 搜索, {
            名: '搜索模型',
            成功话: `通了 · ${(搜索.结果 && 搜索.结果.ms) || 0}ms · 下一跳闲逛就用这个模型联网找素材`,
            说明: '端点填这个搜索模型自己的服务地址，和蒸馏 / 向量互不影响。',
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
        refillWebBelow: String(c.refillBelowBySource?.web ?? 2),
        maxDailySend: String(c.maxDailySend ?? 10),
        cooldownMinutes: String(c.cooldownMinutes ?? 30),
        idleMinutes: String(c.idleMinutes ?? 30),
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
        '.wm-panel{--wm-primary:#6366f1;--wm-primary2:#8b5cf6;display:flex;flex-direction:column;gap:13px;font-size:13px;line-height:1.65;container-type:inline-size}',
        '.wm-hero{position:relative;overflow:hidden;border-radius:22px;padding:16px 18px;border:1px solid rgba(99,102,241,.13);background:linear-gradient(120deg,rgba(99,102,241,.14),rgba(236,72,153,.07) 50%,rgba(139,92,246,.05) 82%),var(--dsw-alias-bg-layer-2,rgba(255,255,255,.66));box-shadow:0 16px 40px rgba(99,102,241,.10)}',
        '.wm-hero::after{content:"";position:absolute;right:-40px;top:-70px;width:230px;height:230px;border-radius:50%;background:radial-gradient(circle,rgba(139,92,246,.26),rgba(236,72,153,.10) 55%,transparent 72%);filter:blur(8px);pointer-events:none}',
        '.wm-heroTop{position:relative;display:flex;align-items:center;gap:13px;flex-wrap:wrap}',
        '.wm-logo{flex:none;width:42px;height:42px;border-radius:14px;display:grid;place-items:center;font-size:21px;background:linear-gradient(135deg,#6366f1,#ec4899);box-shadow:0 10px 22px rgba(99,102,241,.32)}',
        '.wm-heroText{display:flex;flex-direction:column;gap:2px;min-width:0}',
        '.wm-heroTitle{font-size:17px;font-weight:800;letter-spacing:.2px;color:var(--dsw-alias-label-primary)}',
        '.wm-heroSub{font-size:11.5px;letter-spacing:.3px;color:var(--dsw-alias-label-tertiary)}',
        '.wm-heroRight{margin-left:auto;display:flex;align-items:center;gap:6px;flex-wrap:wrap;justify-content:flex-end}',
        '.wm-heroRight .wm-badge{background:var(--dsw-alias-bg-layer-1,rgba(255,255,255,.68));color:var(--dsw-alias-label-primary);border:1px solid rgba(99,102,241,.12);box-shadow:0 3px 10px rgba(99,102,241,.07)}',
        '.wm-badge{display:inline-flex;align-items:center;gap:5px;height:23px;padding:0 9px;border-radius:999px;font-size:11px;font-weight:600;white-space:nowrap}',
        '.wm-badgeOk{background:rgba(16,185,129,.13);color:#0e9f6e}',
        '.wm-badgeInfo{background:rgba(99,102,241,.13);color:#5b5bd6}',
        '.wm-badgeWarn{background:rgba(245,158,11,.16);color:#b7791f}',
        '.wm-badgeOff{background:rgba(140,150,170,.16);color:var(--dsw-alias-label-tertiary)}',
        '.wm-badgeDanger{background:rgba(236,72,153,.13);color:#db2777}',
        '.wm-tags{display:flex;flex-wrap:wrap;gap:6px}',
        '.wm-tag{display:inline-flex;align-items:center;gap:5px;height:24px;padding:0 9px;border-radius:999px;background:rgba(99,102,241,.12);color:#5b5bd6;font-size:11.5px;font-weight:600;border:1px solid rgba(99,102,241,.24)}',
        '.wm-tagX{border:none;background:transparent;color:inherit;font-size:13px;line-height:1;padding:0;cursor:pointer;opacity:.7}',
        '.wm-tagX:hover{opacity:1}',
        '.wm-tagRow{display:flex;gap:8px;align-items:center}',
        '.wm-tagRow .wm-tagInput{flex:1;min-width:120px;width:auto}',
        '.wm-dot{width:6px;height:6px;border-radius:50%;background:currentColor;box-shadow:0 0 7px currentColor}',
        '.wm-body{display:flex;flex-direction:column;gap:11px}',
        '.wm-shell{display:flex;flex-direction:column;gap:11px}',
        '.wm-rail{display:flex;flex-wrap:wrap;gap:5px;align-items:center;padding:6px;border-radius:18px;border:1px solid rgba(99,102,241,.11);background:var(--dsw-alias-bg-layer-1,rgba(255,255,255,.7));box-shadow:0 10px 26px rgba(99,102,241,.09)}',
        '.wm-menuHead{flex:none;display:flex;align-items:center;gap:7px;height:36px;padding:0 13px 0 7px;border:none;border-radius:12px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:12.5px;font-weight:600;cursor:pointer;white-space:nowrap;transition:background .16s,color .16s,box-shadow .16s}',
        '.wm-menuHead:hover{background:rgba(99,102,241,.08);color:var(--dsw-alias-label-primary)}',
        '.wm-menuHeadOn,.wm-menuHeadOn:hover{background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;box-shadow:0 10px 22px rgba(99,102,241,.28)}',
        '.wm-menuHeadOn .wm-menuIcon{background:rgba(255,255,255,.20);color:#fff}',
        '.wm-menuIcon{flex:none;width:22px;height:22px;border-radius:8px;display:grid;place-items:center;font-size:10.5px;font-weight:700;color:#5b5bd6;background:rgba(99,102,241,.13)}',
        '.wm-ic1{color:#d6388b;background:rgba(236,72,153,.13)}',
        '.wm-ic2{color:#0e9f6e;background:rgba(16,185,129,.14)}',
        '.wm-ic3{color:#c47b0a;background:rgba(245,158,11,.16)}',
        '.wm-ic4{color:#7c5cff;background:rgba(139,92,246,.14)}',
        '.wm-menuText{line-height:1}',
        '.wm-groupTabs{display:flex;flex-wrap:wrap;gap:3px;padding:4px;border-radius:15px;border:1px solid rgba(99,102,241,.12);background:rgba(99,102,241,.06);width:max-content;max-width:100%}',
        '.wm-groupTab{height:32px;padding:0 15px;border:none;border-radius:11px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:12.5px;font-weight:600;cursor:pointer;white-space:nowrap;transition:background .16s,color .16s,box-shadow .16s}',
        '.wm-groupTab:hover{background:rgba(99,102,241,.09);color:var(--dsw-alias-label-primary)}',
        '.wm-groupTabOn,.wm-groupTabOn:hover{background:var(--dsw-alias-bg-layer-1,#fff);color:#4f46e5;box-shadow:0 6px 14px rgba(99,102,241,.16),inset 0 0 0 1px rgba(99,102,241,.10)}',
        '.wm-main{min-width:0;display:flex;flex-direction:column;gap:10px}',
        '.wm-pageHead{display:flex;align-items:flex-end;justify-content:space-between;gap:12px;padding:2px 2px 5px}',
        '.wm-pageEyebrow{font-size:10px;font-weight:700;letter-spacing:.16em;color:#6366f1;margin-bottom:3px}',
        '.wm-pageTitle{font-size:20px;font-weight:800;letter-spacing:.2px;line-height:1.25;color:var(--dsw-alias-label-primary)}',
        '.wm-pageDesc{font-size:11.5px;color:var(--dsw-alias-label-tertiary);line-height:1.55;margin-top:3px}',
        '.wm-cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:11px;align-items:stretch}',
        '.wm-grid.wm-tiles{grid-template-columns:repeat(auto-fit,minmax(240px,1fr))}',
        '.wm-grid.wm-tiles4{grid-template-columns:repeat(auto-fit,minmax(230px,1fr))}',
        '.wm-cfg{columns:1;column-gap:11px}',
        '.wm-cfg>*{break-inside:avoid;margin:0 0 11px}',
        '.wm-maint{display:grid;grid-template-columns:minmax(0,1fr);gap:11px}',
        '.wm-maintSide{display:flex;flex-direction:column;gap:11px;min-width:0}',
        '.wm-fold{border:1px solid rgba(99,102,241,.10);border-radius:15px;background:var(--dsw-alias-bg-layer-1,rgba(255,255,255,.58));padding:10px 14px;box-shadow:0 8px 20px rgba(99,102,241,.05)}',
        '.wm-fold>summary{cursor:pointer;list-style:none;font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary)}',
        '.wm-fold>summary::-webkit-details-marker{display:none}',
        '.wm-fold>summary::before{content:"▸";display:inline-block;margin-right:6px;color:#6366f1;transition:transform .14s}',
        '.wm-fold[open]>summary::before{transform:rotate(90deg)}',
        '@container (min-width:900px){.wm-grid.wm-tiles{grid-template-columns:repeat(3,minmax(0,1fr))}.wm-grid.wm-tiles4{grid-template-columns:repeat(4,minmax(0,1fr))}}',
        '@container (max-width:600px){.wm-rail{gap:3px;padding:5px}.wm-menuHead{height:34px;padding:0 10px 0 5px;gap:5px;font-size:12px}.wm-menuIcon{width:20px;height:20px;border-radius:7px;font-size:10px}.wm-groupTabs{gap:2px;padding:3px}.wm-groupTab{height:30px;padding:0 12px;font-size:12px}}',
        '@container (min-width:640px){.wm-cfg{columns:2}}',
        '@container (min-width:780px){.wm-maint{grid-template-columns:minmax(0,1.15fr) minmax(0,.85fr);align-items:start}}',
        '@container (min-width:1080px){.wm-cfg{columns:3}}',
        '.wm-statusStrip{display:flex;align-items:center;gap:7px;flex-wrap:wrap;padding:8px 12px;border-radius:15px;border:1px solid rgba(99,102,241,.10);background:var(--dsw-alias-bg-layer-1,rgba(255,255,255,.66));box-shadow:0 8px 20px rgba(99,102,241,.06)}',
        '.wm-card{border-radius:18px;border:1px solid rgba(99,102,241,.10);background:var(--dsw-alias-bg-layer-1,rgba(255,255,255,.7));padding:14px 16px;display:flex;flex-direction:column;gap:9px;box-shadow:0 12px 28px rgba(99,102,241,.08)}',
        '.wm-cardHead{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}',
        '.wm-cardTitle{display:flex;align-items:center;gap:8px;font-size:13.5px;font-weight:700;color:var(--dsw-alias-label-primary)}',
        '.wm-cardTitle::before{content:"";flex:none;width:4px;height:16px;border-radius:3px;background:linear-gradient(180deg,#6366f1,#ec4899)}',
        '.wm-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:9px}',
        '.wm-tile{border-radius:16px;border:1px solid rgba(99,102,241,.09);background:var(--dsw-alias-bg-layer-1,rgba(255,255,255,.62));padding:11px 13px;display:flex;flex-direction:column;gap:4px;box-shadow:0 6px 16px rgba(99,102,241,.05);transition:transform .16s,border-color .16s,box-shadow .16s}',
        '.wm-tile:hover{transform:translateY(-2px);border-color:rgba(99,102,241,.26);box-shadow:0 12px 24px rgba(99,102,241,.12)}',
        '.wm-tileWide{grid-column:span 2}',
        '.wm-tileLabel{font-size:10.5px;letter-spacing:.5px;color:var(--dsw-alias-label-tertiary)}',
        '.wm-tileValue{font-size:14.5px;font-weight:700;line-height:1.35;color:var(--dsw-alias-label-primary);word-break:break-word}',
        '.wm-tileHint{font-size:11px;color:var(--dsw-alias-label-tertiary);word-break:break-word}',
        '.wm-tileAccent{background:linear-gradient(135deg,rgba(99,102,241,.13),rgba(236,72,153,.07));border-color:rgba(99,102,241,.16)}',
        '.wm-bar{height:6px;border-radius:999px;background:rgba(99,102,241,.12);overflow:hidden;margin-top:2px}',
        '.wm-barFill{height:100%;border-radius:999px;background:linear-gradient(90deg,#6366f1,#ec4899)}',
        '.wm-barWarn{background:linear-gradient(90deg,#f59e0b,#ec4899)}',
        '.wm-row{display:flex;justify-content:space-between;gap:12px;padding:3px 0;border-bottom:1px dashed rgba(127,127,127,.12)}',
        '.wm-row:last-child{border-bottom:none}',
        '.wm-hint{font-size:11.5px;color:var(--dsw-alias-label-tertiary);line-height:1.55}',
        '.wm-mono{font-family:ui-monospace,Consolas,monospace;font-size:11px}',
        '.wm-listRow{padding:7px 0;border-bottom:1px dashed rgba(127,127,127,.12)}',
        '.wm-listRow:last-child{border-bottom:none}',
        '.wm-subtabs{display:flex;gap:2px;flex-wrap:wrap;padding:3px;border-radius:12px;border:1px solid rgba(99,102,241,.12);background:rgba(99,102,241,.05);width:max-content;max-width:100%}',
        '.wm-subtab{height:26px;padding:0 11px;border-radius:8px;border:none;background:transparent;color:var(--dsw-alias-label-secondary);font-size:11.5px;cursor:pointer;white-space:nowrap}',
        '.wm-subtab:hover{background:rgba(99,102,241,.10);color:var(--dsw-alias-label-primary)}',
        '.wm-subtab:disabled{opacity:.45;cursor:default}',
        '.wm-subtabOn,.wm-subtabOn:hover{background:var(--dsw-alias-bg-layer-1,rgba(255,255,255,.9));color:#5b5bd6;font-weight:600;box-shadow:0 4px 10px rgba(99,102,241,.14)}',
        '.wm-chips{display:flex;gap:6px;flex-wrap:wrap}',
        '.wm-chip{height:24px;padding:0 9px;border-radius:999px;border:1px solid rgba(99,102,241,.14);background:transparent;color:var(--dsw-alias-label-secondary);font-size:11.5px;cursor:pointer}',
        '.wm-chip:hover{border-color:rgba(99,102,241,.34);color:var(--dsw-alias-label-primary)}',
        '.wm-chipOn,.wm-chipOn:hover{background:rgba(99,102,241,.13);border-color:rgba(99,102,241,.30);color:#5b5bd6;font-weight:600}',
        '.wm-switchRow{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:5px 0}',
        '.wm-switch{flex:none;width:38px;height:21px;border-radius:999px;border:1px solid rgba(99,102,241,.16);background:rgba(99,102,241,.14);position:relative;cursor:pointer;transition:background .16s,border-color .16s,box-shadow .16s}',
        '.wm-switch i{position:absolute;left:2px;top:2px;width:15px;height:15px;border-radius:50%;background:#fff;box-shadow:0 2px 5px rgba(15,23,42,.18);transition:left .16s}',
        '.wm-switchOn{background:linear-gradient(135deg,#6366f1,#8b5cf6);border-color:transparent;box-shadow:0 4px 12px rgba(99,102,241,.28)}',
        '.wm-switchOn i{left:20px}',
        '.wm-field{display:flex;flex-direction:column;gap:3px}',
        '.wm-input{width:100%;box-sizing:border-box;padding:6px 9px;border-radius:10px;border:1px solid rgba(99,102,241,.12);background:var(--dsw-specific-input-bg,rgba(241,245,249,.92));color:var(--dsw-alias-label-primary);font-size:12px;outline:none;transition:border-color .16s,box-shadow .16s}',
        '.wm-input:focus{border-color:rgba(99,102,241,.55);box-shadow:0 0 0 3px rgba(99,102,241,.13)}',
        '.wm-btn{height:28px;padding:0 13px;border-radius:10px;border:1px solid rgba(99,102,241,.14);background:var(--dsw-alias-bg-layer-1,rgba(255,255,255,.8));color:var(--dsw-alias-label-primary);font-size:11.5px;font-weight:500;cursor:pointer;box-shadow:0 3px 10px rgba(99,102,241,.07);transition:transform .14s,box-shadow .14s,border-color .14s}',
        '.wm-btn:hover{transform:translateY(-1px);border-color:rgba(99,102,241,.35);box-shadow:0 8px 18px rgba(99,102,241,.13)}',
        '.wm-btn:disabled{opacity:.5;cursor:default;transform:none;box-shadow:none}',
        '.wm-btnPrimary{border:none;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;font-weight:600;box-shadow:0 8px 18px rgba(99,102,241,.28)}',
        '.wm-btnPrimary:hover{box-shadow:0 12px 24px rgba(99,102,241,.34)}',
        '.wm-btnDanger{border-color:rgba(236,72,153,.35);color:#db2777;background:rgba(236,72,153,.06)}',
        '.wm-saveBar{display:flex;align-items:center;gap:9px;flex-wrap:wrap;padding-top:2px}',
        '.wm-notice{padding:7px 10px;border-radius:10px;font-size:11.5px;font-weight:500}',
        '.wm-good{background:rgba(16,185,129,.11);color:#0e9f6e}',
        '.wm-bad{background:rgba(236,72,153,.10);color:#db2777}',
        '.wm-warn{background:rgba(245,158,11,.13);color:#b7791f}',
        '.wm-page{display:flex;flex-direction:column;gap:12px;padding:16px 20px 26px;box-sizing:border-box;max-height:calc(100vh - 120px);overflow-y:auto;overflow-x:hidden;background:radial-gradient(920px 380px at 10% -8%,rgba(99,102,241,.07),transparent 60%),radial-gradient(760px 360px at 100% 0,rgba(236,72,153,.05),transparent 55%),var(--dsw-alias-bg-base,#f6f7fb);color:var(--dsw-alias-label-primary)}',
        '.wm-page > .wm-panel{flex:0 0 auto}',
        // 星云图：暗色面板在亮/暗主题下都保持同一张星图，文字不跟随宿主主题漂移
        '.wm-neb-card{container-type:inline-size;display:flex;flex-direction:column;border-radius:16px;overflow:hidden;border:1px solid rgba(126,163,235,.26);background:#070b18;color:#e9efff;box-shadow:0 18px 50px rgba(18,36,80,.28)}',
        '.wm-neb-top{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:11px 14px;background:linear-gradient(180deg,rgba(18,28,54,.94),rgba(9,14,30,.62));border-bottom:1px solid rgba(126,163,235,.13)}',
        '.wm-neb-titleWrap{display:flex;flex-direction:column;gap:1px;min-width:0}',
        '.wm-neb-title{font-size:14px;font-weight:700;letter-spacing:.6px;background:linear-gradient(90deg,#e2edff,#8fb8ff);-webkit-background-clip:text;background-clip:text;color:transparent}',
        '.wm-neb-sub{font-size:11px;color:#8298c4}',
        '.wm-neb-tools{margin-left:auto;display:flex;gap:6px;align-items:center;flex-wrap:wrap}',
        '.wm-neb-select{height:28px;max-width:220px;border-radius:8px;border:1px solid rgba(126,163,235,.24);background:#101a34;color:#dfe9ff;font-size:11.5px;padding:0 7px;outline:none}',
        '.wm-neb-btn{height:28px;padding:0 10px;border-radius:8px;border:1px solid rgba(126,163,235,.24);background:rgba(126,163,235,.09);color:#cfe0ff;font-size:11.5px;cursor:pointer}',
        '.wm-neb-btn:hover{border-color:rgba(143,184,255,.55);background:rgba(126,163,235,.16)}',
        '.wm-neb-layout{display:grid;grid-template-columns:minmax(0,1fr);gap:0}',
        '.wm-neb-stage{position:relative;height:clamp(390px,54vh,540px);overflow:hidden;background:radial-gradient(60% 70% at 50% 45%,#0d1733 0%,#070b18 58%,#04060e 100%)}',
        '.wm-neb-aurora{position:absolute;inset:0;pointer-events:none;background:radial-gradient(45% 55% at 24% 30%,rgba(62,116,255,.18),transparent 70%),radial-gradient(42% 52% at 78% 66%,rgba(142,92,255,.16),transparent 72%),radial-gradient(36% 42% at 60% 18%,rgba(42,214,190,.07),transparent 70%)}',
        '.wm-neb-stars{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}',
        '.wm-neb-emptyGlobe{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;opacity:.75}',
        '.wm-neb-graph{position:absolute;inset:0;width:100%;height:100%;touch-action:none;cursor:grab}',
        '.wm-neb-grabbing{cursor:grabbing}',
        '.wm-neb-search{position:absolute;left:12px;top:12px;width:min(340px,calc(100% - 24px));z-index:4}',
        '.wm-neb-search svg{position:absolute;left:9px;top:8px;color:#7d94c2;pointer-events:none}',
        '.wm-neb-search input{width:100%;height:31px;box-sizing:border-box;border-radius:9px;border:1px solid rgba(126,163,235,.28);background:rgba(8,14,31,.82);color:#eaf1ff;font-size:12px;padding:0 10px 0 30px;outline:none;backdrop-filter:blur(8px)}',
        '.wm-neb-search input::placeholder{color:#7186b0}',
        '.wm-neb-search input:focus{border-color:rgba(143,184,255,.65);box-shadow:0 0 0 2px rgba(90,150,255,.14)}',
        '.wm-neb-results{position:absolute;left:12px;top:50px;width:min(380px,calc(100% - 24px));max-height:310px;overflow:auto;z-index:5;border-radius:11px;border:1px solid rgba(126,163,235,.26);background:rgba(7,12,26,.96);box-shadow:0 16px 40px rgba(0,0,0,.4);padding:5px;backdrop-filter:blur(10px)}',
        '.wm-neb-result{display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:8px;cursor:pointer;min-width:0}',
        '.wm-neb-result:hover{background:rgba(93,168,255,.14)}',
        '.wm-neb-resultDot{flex:none;width:7px;height:7px;border-radius:50%;box-shadow:0 0 7px currentColor}',
        '.wm-neb-resultName{font-size:12px;color:#e7efff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:58%}',
        '.wm-neb-resultMeta{margin-left:auto;flex:none;font-size:10.5px;color:#7f95c0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:44%}',
        '.wm-neb-empty{padding:8px 4px;font-size:11.5px;color:#7f95c0;line-height:1.6}',
        '.wm-neb-legend{position:absolute;left:12px;bottom:34px;display:flex;gap:5px;flex-wrap:wrap;max-width:calc(100% - 100px);z-index:3}',
        '.wm-neb-chip{display:inline-flex;align-items:center;gap:4px;height:23px;padding:0 8px;border-radius:999px;border:1px solid rgba(126,163,235,.24);background:rgba(8,14,31,.68);color:#aabfe4;font-size:10.5px;cursor:pointer;backdrop-filter:blur(6px)}',
        '.wm-neb-chip i{width:6px;height:6px;border-radius:50%;background:#5da8ff;flex:none;box-shadow:0 0 7px currentColor}',
        '.wm-neb-chip:hover{border-color:rgba(143,184,255,.5);color:#e7efff}',
        '.wm-neb-chipOn{color:#e7efff;border-color:rgba(126,163,235,.42)}',
        '.wm-neb-chipN{opacity:.55;font-size:10px}',
        '.wm-neb-zoom{position:absolute;right:12px;bottom:34px;display:flex;gap:4px;z-index:3}',
        '.wm-neb-zoom button{width:27px;height:25px;border-radius:7px;border:1px solid rgba(126,163,235,.24);background:rgba(8,14,31,.72);color:#b9cdf1;font-size:12px;line-height:1;cursor:pointer}',
        '.wm-neb-zoom button:last-child{width:34px;font-size:10px}',
        '.wm-neb-zoom button:hover{border-color:rgba(143,184,255,.55);color:#fff}',
        '.wm-neb-hint{position:absolute;left:12px;bottom:9px;font-size:10.5px;color:#6f84ad;z-index:2;pointer-events:none;letter-spacing:.2px}',
        '.wm-neb-detail{display:flex;flex-direction:column;gap:8px;padding:12px;background:linear-gradient(170deg,rgba(20,31,60,.96),rgba(7,11,24,.98));border-top:1px solid rgba(126,163,235,.16);max-height:clamp(390px,54vh,540px);overflow:auto}',
        '.wm-neb-detail::-webkit-scrollbar,.wm-neb-results::-webkit-scrollbar{width:6px}',
        '.wm-neb-detail::-webkit-scrollbar-thumb,.wm-neb-results::-webkit-scrollbar-thumb{background:rgba(126,163,235,.24);border-radius:999px}',
        '@container (min-width:680px){.wm-neb-layout.wm-neb-hasDetail{grid-template-columns:minmax(0,1fr) 252px}.wm-neb-detail{border-top:none;border-left:1px solid rgba(126,163,235,.16);max-height:clamp(390px,54vh,540px)}}',
        '.wm-neb-detailHead{display:flex;align-items:center;gap:8px}',
        '.wm-neb-detailTitle{font-size:13.5px;font-weight:700;color:#f1f6ff;min-width:0;word-break:break-word}',
        '.wm-neb-x{margin-left:auto;flex:none;width:22px;height:22px;border:none;border-radius:6px;background:rgba(126,163,235,.1);color:#9fb3d9;font-size:14px;line-height:1;cursor:pointer}',
        '.wm-neb-x:hover{background:rgba(255,110,150,.18);color:#ffd3df}',
        '.wm-neb-meta{display:flex;align-items:center;gap:5px;flex-wrap:wrap;font-size:10.5px;color:#879cc7;line-height:1.55}',
        '.wm-neb-typeDot{width:7px;height:7px;border-radius:50%;flex:none}',
        '.wm-neb-section{font-size:10px;letter-spacing:1px;color:#6c82ad;margin-top:3px}',
        '.wm-neb-rel{display:flex;flex-direction:column;gap:2px;width:100%;box-sizing:border-box;text-align:left;padding:6px 7px;border-radius:8px;border:1px solid rgba(126,163,235,.12);background:rgba(126,163,235,.045);color:inherit;cursor:pointer}',
        '.wm-neb-rel:hover{border-color:rgba(143,184,255,.35);background:rgba(93,168,255,.1)}',
        '.wm-neb-relTop{display:flex;align-items:baseline;gap:5px;min-width:0}',
        '.wm-neb-relName{font-size:12px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
        '.wm-neb-relTag{flex:none;font-size:10px;color:#8fb8ff}',
        '.wm-neb-relText{font-size:10.5px;color:#8196bf;line-height:1.5;word-break:break-word}',
        '.wm-neb-memo{padding:6px 8px;border-left:2px solid rgba(143,184,255,.4);background:rgba(126,163,235,.055);border-radius:0 7px 7px 0;font-size:11px;line-height:1.6;color:#c7d8f7;word-break:break-word}',
        '.wm-neb-memoMeta{font-size:10px;color:#7589b2;margin-top:2px}',
        '.wm-neb-mini{height:23px;padding:0 8px;border-radius:6px;border:1px solid rgba(126,163,235,.24);background:transparent;color:#9fb3d9;font-size:10.5px;cursor:pointer}',
        '.wm-neb-mini:hover{color:#fff;border-color:rgba(143,184,255,.55)}',
        '.wm-neb-emptyBig{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;text-align:center;padding:20px}',
        '.wm-neb-emptyTitle{font-size:15px;font-weight:700;color:#dce9ff;letter-spacing:1px}',
        '.wm-neb-emptyText{font-size:11.5px;color:#7f95c0;max-width:320px;line-height:1.7}',
        '@keyframes wmNebTwinkle{0%,100%{opacity:.14}50%{opacity:.85}}',
        '@keyframes wmNebBreathe{0%,100%{opacity:.55}50%{opacity:.95}}',
        '@keyframes wmNebDash{to{stroke-dashoffset:-24}}',
        '.wm-neb-edgeOn{stroke-dasharray:6 5;animation:wmNebDash 1.1s linear infinite}',
        '.wm-neb-orbit{animation:wmNebDash 5s linear infinite}',
      ].join('\n')
      document.head?.appendChild?.(el)
    }

    function 主动页({ 页, 态, 表单, 改表单, 保存, 结果, 忙, 专注分钟, 设专注分钟, 专注, 重建画像, 清理素材, 刷新, 轮换会话, 目标候选, 拉目标 }) {
      确保主动样式()
      const b = 态 || {}
      const c = b.config || {}
      const s = b.state || {}
      const f = 表单 || {}
      const sched = b.scheduler || {}
      const env = s.lastEnv || {}
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
        away: '所有会话闲置', busy: '你在忙（旧）', token_saver: '全局会话闲置（旧）',
        chatting: '绑定会话刚聊过', quiet_hours: '静默时段', focus_mode: '专注模式',
        daily_cap: '今日已满', cooldown: '冷却中', no_material: '没素材', duplicate: '都投过', backoff: '降频中',
        'no-target': '未绑投递目标', 'no-topic': '目标会话没话题', 'off-topic': '素材对不上话题',
      }[闸门] || 闸门
      const 今日 = Number(s.daily?.sent) || 0
      const 上限 = Number(c.maxDailySend) || 0
      const 比例 = 上限 > 0 ? Math.min(1, 今日 / 上限) : 0
      const 指标 = b.metrics || null
      const 百分比 = (v) => (v == null ? '—' : `${Math.round(Number(v) * 100)}%`)
      const 素材源 = { all: '全部', chat: '会话', web: '搜索', public: '公共' }
      const 素材 = (Array.isArray(b.materials) ? b.materials : [])
        .filter((m) => 素材筛 === 'all' || String(m.source || '').startsWith(素材筛))
      // report 的合计行会和每条素材的明细重复；只有「决定不说」没有明细，得留下。
      const 反馈 = (Array.isArray(b.feedback) ? b.feedback : [])
        .filter((x) => !(x.source === 'report' && x.summary && x.mode !== 'none'))
      const 投递 = Array.isArray(b.deliveries) ? b.deliveries : []
      // 投递和反馈按 deliveryId 对齐：一跳一行，下面挂这一跳的反馈。
      const 投递结果 = {
        sent: { text: '已发出', cls: 'wm-badgeOk' },
        delivered: { text: '已发出', cls: 'wm-badgeOk' },
        dry: { text: '预演，没真发', cls: 'wm-badgeOff' },
        busy: { text: '目标会话被占用，推迟', cls: 'wm-badgeWarn' },
        failed: { text: '投递失败', cls: 'wm-badgeWarn' },
      }
      const 反馈来源 = { reply: '回复', focus: '再提', unreported: '没回应', report: '报账' }
      const 反馈色 = (x) => (Number(x.engagement) || 0) > 0 ? 'wm-badgeOk'
        : (Number(x.engagement) || 0) < 0 ? 'wm-badgeWarn' : 'wm-badgeOff'
      const 反馈分 = (x) => `${Number(x.engagement) >= 0 ? '+' : ''}${Number(x.engagement) || 0}`
      const 反馈句 = (x) => {
        const g = x.signals || {}
        if (x.source === 'reply') {
          if (g.negative) return '明确说别发了，素材已退役'
          const bits = [Number(g.minutes) <= 30 ? `${Number(g.minutes)} 分钟内回了` : '回了，但超过 30 分钟']
          if (Number(g.chars) > 0) bits.push(`${Number(g.chars)} 字`)
          return bits.join(' · ')
        }
        if (x.source === 'focus') return g.focus ? `又提到「${g.focus}」` : '又提到同一话题'
        if (x.source === 'unreported') return `${Number(g.hours) || 24} 小时没回应`
        if (x.source === 'report') {
          if (x.mode === 'quote') return '她引用了素材'
          if (x.mode === 'improvise') return '她即兴用上了素材'
          if (x.mode === 'none') return '她决定这次不说'
          return '她报了账'
        }
        return x.mode || '反馈'
      }
      const 反馈行 = (x, key) => h('div', {
        key,
        className: 'wm-row',
        title: x.replyHash ? `行标识 ${x.replyHash.slice(0, 8)}，不含回复原文` : '',
      },
        h('span', null,
          徽(反馈来源[x.source] || x.source || '反馈', 反馈色(x)),
          h('span', { style: { marginLeft: 6 } }, 反馈句(x))),
        h('span', { className: 'wm-hint' }, 反馈分(x)),
      )
      const 反馈集 = new Set(投递.map((d) => String(d.id || '')).filter(Boolean))
      const 挂到 = new Map()
      for (const x of 反馈) {
        const k = String(x.deliveryId || '')
        if (!挂到.has(k)) 挂到.set(k, [])
        挂到.get(k).push(x)
      }
      const 孤儿反馈 = 反馈.filter((x) => !反馈集.has(String(x.deliveryId || '')))
      const 画像 = b.profile || {}
      const 画像数 = 画像.counts || {}
      const 环境字 = env.locked ? '锁屏' : env.away ? '离开' : env.source === 'unknown' ? '未知' : '在场'
      const 环境色 = env.locked || env.away ? 'wm-badgeWarn' : 'wm-badgeOk'

      const 状态页 = () => h('div', { className: 'wm-body' },
        h('div', { className: 'wm-card' },
          h('div', { className: 'wm-cardHead' },
            h('span', { className: 'wm-cardTitle' }, '这一跳'),
            h('span', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
              徽(环境字, 环境色, true),
              徽(sched.heartbeat ? 'heartbeat 占位' : 'beat', sched.heartbeat ? 'wm-badgeWarn' : 'wm-badgeInfo'),
            ),
          ),
          h('div', { className: 'wm-grid wm-tiles4' },
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
            格('全局会话闲置',
              env.idleMinutes != null ? `${env.idleMinutes} 分钟` : env.presenceKnown ? '没有活动记录' : '—',
              env.source === 'sessions' ? '宿主会话' : env.source === 'session-cache' ? '会话缓存'
                : env.source === 'user-messages' ? '用户消息' : '读不到',
              'wm-tileAccent'),
            格('素材反馈', `${反馈.filter((x) => (Number(x.engagement) || 0) > 0).length} 正 / ${反馈.filter((x) => (Number(x.engagement) || 0) < 0).length} 负`, '只调权重，不写偏好'),
          ),
          s.deliveryFailed
            ? h('div', { className: 'wm-notice wm-warn' }, `今天投递失败：${s.deliveryFailed.why || '未知'} · 今天不再重试同一目标`)
            : null,
        ),
        指标 ? 卡('验收指标 · 近 30 天',
          h('div', { className: 'wm-grid wm-tiles4' },
            格('素材采纳率', 百分比(指标.adoption), `${指标.materialsDelivered} 条投出去的素材`),
            格('报账率', 百分比(指标.reportRate), `未报账 ${指标.unreported}`),
            格('误投率', 百分比(指标.negativeRate), `${指标.negative} 次负反馈`),
            格('闸门拦截', 百分比(指标.gateBlockRate), `${指标.gateTicks} 跳`),
            格('画像证据', 指标.profileEvidence ? '齐全' : '缺证据', '每项都要有 evidenceIds'),
            格('人格污染', 指标.personaPollution ? `${指标.personaPollution} 处` : '0', '素材不该进人格/画像'),
          ),
        ) : null,
        卡('最近投递 · 反馈账本',
          h('div', null,
            WD.提('每一跳主动投递的结果，和之后的反应。反馈只调素材权重，不写偏好。'),
            (投递.length || 孤儿反馈.length)
              ? h('div', { style: { marginTop: 6 } },
                ...投递.map((d) => {
                  const id = String(d.id || '')
                  const 结 = 投递结果[d.outcome] || { text: d.outcome || '?', cls: 'wm-badgeOff' }
                  const 子 = (挂到.get(id) || []).slice().sort((a, b) => String(a.at).localeCompare(String(b.at)))
                  return h('div', { key: id || d.at, className: 'wm-listRow' },
                    h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 7, flexWrap: 'wrap' } },
                      h('span', { className: 'wm-mono', style: { fontSize: 11 } }, id || '—'),
                      徽(结.text, 结.cls),
                      h('span', { className: 'wm-hint' }, `${(d.materialIds || []).length} 条素材 · ${时间(d.at)}`),
                    ),
                    子.length
                      ? h('div', { style: { margin: '4px 0 0 10px', paddingLeft: 8, borderLeft: '1px solid rgba(120,130,150,.25)' } },
                        子.map((x, i) => 反馈行(x, `${x.at}-${i}`)))
                      : h('div', { className: 'wm-hint', style: { margin: '3px 0 0 10px' } },
                        d.outcome === 'sent' || d.outcome === 'delivered' ? '还没等到反馈。' : '这一跳没发出去，不会有反馈。'),
                  )
                }),
                孤儿反馈.length
                  ? h('div', { style: { marginTop: 10 } },
                    WD.提('投递记录已经滚出去了，只剩反馈：'),
                    孤儿反馈.map((x, i) => h('div', {
                      key: `${x.at}-${i}`,
                      className: 'wm-row',
                      title: x.replyHash ? `行标识 ${x.replyHash.slice(0, 8)}，不含回复原文` : '',
                    },
                      h('span', null,
                        h('span', { className: 'wm-mono', style: { fontSize: 11, marginRight: 6 } }, x.deliveryId || '—'),
                        徽(反馈来源[x.source] || x.source || '反馈', 反馈色(x)),
                        h('span', { style: { marginLeft: 6 } }, 反馈句(x))),
                      h('span', { className: 'wm-hint' }, 反馈分(x)),
                    )))
                  : null,
              )
              : WD.提('还没有投递记录。beat 跑起来后这里会出现。'),
          ),
          WD.徽(`${投递.length} 跳`, 'wm-badgeInfo'),
        ),
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
        h('div', { className: 'wm-cfg' },
        卡('开关', h('div', null,
          开关('enabled', '启用主动行为', '关掉就完全不动；重启后仍按这个值。'),
          开关('dryRun', '只预演，不真的发', '先看素材包像不像人话，再关预演。'),
        )),
        卡('时间窗', h('div', null,
          h('div', { className: 'wm-field' },
            h('span', { className: 'wm-hint' }, '允许闲逛的时间窗'),
            窗编辑器(),
          ),
          h('div', { className: 'wm-field', style: { marginTop: 10 } },
            h('span', { className: 'wm-hint' }, '静默时段'),
            静编辑器(),
            h('span', { className: 'wm-hint' }, '两格都填才生效；点「清空」关掉。'),
          ),
        )),
        卡('投递与忙闲', h('div', { className: 'wm-grid' },
          数('maxDailySend', '每日最多投递', '0–50'),
          数('cooldownMinutes', '两次投递最小间隔（分钟）', '0–1440'),
          h('label', { key: 'idleMinutes', className: 'wm-field', style: { gridColumn: '1 / -1' } },
            h('span', { className: 'wm-hint' }, '空闲阈值（分钟）'),
            h('input', {
              type: 'number',
              value: f.idleMinutes === 0 || f.idleMinutes ? String(f.idleMinutes) : '',
              placeholder: '0–1440',
              className: 'wm-input',
              onChange: (e) => 改('idleMinutes', e.target.value),
            }),
            h('span', { className: 'wm-hint' }, '绑定会话安静满这么久才投；所有会话都静了这么久算离开，不投。填 0 两边都不判。'),
          ),
          数('maxMaterial', '素材库上限', '1–200'),
          数('sessionRotateDays', '专用会话多少天轮换', '1–90'),
        )),
        卡('闲逛频率', h('div', { className: 'wm-grid' },
          数('minIntervalHours', '两次闲逛最小间隔（小时）', '1–72'),
          数('maxWanderPerDay', '每天最多闲逛次数', '0–20'),
          数('refillBelow', '素材少于多少条时补货', '0–30'),
          数('refillWebBelow', '搜索素材少于多少条就单独补（0 = 关）', '0–10'),
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
        ),
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
        h('div', { className: 'wm-maint' },
          h('div', { className: 'wm-maintMain' },
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
          ),
          h('div', { className: 'wm-maintSide' },
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
            卡('素材与日志', h('div', null,
              h('div', { className: 'wm-hint' }, '按 TTL 退休；投递/反馈/日志按天保留。'),
              h('div', { className: 'wm-saveBar', style: { marginTop: 8 } },
                h('button', { className: 'wm-btn', disabled: 忙, onClick: 清理素材 }, '清理过期素材'),
                h('button', { className: 'wm-btn', disabled: 忙, onClick: 刷新 }, '刷新状态'),
              ),
            )),
          ),
        ),
        结果 ? h('div', { className: 'wm-notice ' + (结果.ok ? 'wm-good' : 'wm-bad') }, 结果.text) : null,
      )

      return h('div', { className: 'wm-body' },
        h('div', { className: 'wm-statusStrip' },
          徽(调度.text, 调度.cls, true),
          徽(c.dryRun !== false ? '预演' : '可投递', c.dryRun !== false ? 'wm-badgeWarn' : 'wm-badgeOk'),
          徽(c.enabled === false ? '已关' : '已开', c.enabled === false ? 'wm-badgeOff' : 'wm-badgeOk'),
        ),
        页 === '素材' ? 素材页() : 页 === '设置' ? 配置页() : 页 === '维护' ? 维护页() : 状态页(),
      )
    }

    function 数据备份页() {
      const [备份中, 设备份中] = React.useState(false)
      const [备份结果, 设备份结果] = React.useState(null)
      const [导入文件, 设导入文件] = React.useState(null)
      const [导入中, 设导入中] = React.useState(false)
      const [导入结果, 设导入结果] = React.useState(null)
      const [召回中, 设召回中] = React.useState(false)
      const [召回结果, 设召回结果] = React.useState(null)

      const 导出备份 = async () => {
        if (备份中) return
        设备份中(true)
        设备份结果(null)
        try {
          const r = await get('/backup/export')
          if (!r || !r.ok || !r.data) {
            设备份结果({ ok: false, text: (r && r.why) || '导出失败' })
            return
          }
          const text = JSON.stringify(r.data, null, 2)
          const blob = new Blob([text], { type: 'application/json' })
          const url = URL.createObjectURL(blob)
          const a = document.createElement('a')
          a.href = url
          a.download = r.filename || 'whale-memory-backup.json'
          document.body.appendChild(a)
          a.click()
          a.remove()
          setTimeout(() => URL.revokeObjectURL(url), 1000)
          设备份结果({ ok: true, text: `已导出 ${r.filename || '备份'} · ${text.length.toLocaleString()} 字节` })
        } catch (e) {
          设备份结果({ ok: false, text: String(e?.message ?? e) })
        } finally {
          设备份中(false)
        }
      }

      const 选导入文件 = (e) => {
        const file = e.target.files && e.target.files[0]
        if (!file) return
        const reader = new FileReader()
        reader.onload = () => {
          设导入文件({ name: file.name, text: String(reader.result || '') })
          设导入结果(null)
        }
        reader.onerror = () => 设导入结果({ ok: false, text: '读取文件失败' })
        reader.readAsText(file)
      }

      const 导入备份 = async (dryRun) => {
        if (!导入文件 || 导入中) return
        let data
        try {
          data = JSON.parse(导入文件.text)
        } catch {
          设导入结果({ ok: false, text: '备份文件不是有效 JSON' })
          return
        }
        设导入中(true)
        设导入结果(null)
        try {
          const r = await post('/backup/import', { data, dryRun })
          if (!r || !r.ok) {
            设导入结果({ ok: false, text: (r && r.why) || '导入失败' })
            return
          }
          const t = r.totals || {}
          const 前缀 = r.dryRun ? '预演' : '导入完成'
          设导入结果({ ok: true, text: `${前缀}：新增 ${t.added || 0}，合并 ${t.merged || 0}，跳过 ${t.skipped || 0}，死条 ${t.dead || 0}` })
          if (!r.dryRun) 设导入文件(null)
        } catch (e) {
          设导入结果({ ok: false, text: String(e?.message ?? e) })
        } finally {
          设导入中(false)
        }
      }

      const 导入召回 = async (dryRun) => {
        if (召回中) return
        设召回中(true)
        设召回结果(null)
        try {
          const r = await post('/import/history', { dryRun })
          if (!r || !r.ok) {
            设召回结果({ ok: false, text: (r && r.why) || '导入召回失败' })
            return
          }
          const t = r.totals || {}
          const 前缀 = r.dryRun ? '预演' : '导入完成'
          设召回结果({
            ok: true,
            text: `${前缀}：扫描 ${t.scanned || 0} 个会话，可导 ${t.picked || 0} 个，候选 ${t.candidates || 0} 条，预计新增 ${t.wouldAdd || 0} 条`,
          })
        } catch (e) {
          设召回结果({ ok: false, text: String(e?.message ?? e) })
        } finally {
          设召回中(false)
        }
      }

      return h('div', { className: 'wm-body' },
        WD.提('导出为 JSON 包，包含全部分片和人格文件，不含模型密钥。导入只合并记忆条目，不覆盖当前库。'),
        h('div', { className: 'wm-grid', style: { marginTop: 10 } },
          WD.卡('导出备份', h('div', null,
            WD.提('把当前记忆库打包下载到本机，换设备或重装前先导一份。'),
            h('div', { className: 'wm-saveBar', style: { marginTop: 8 } },
              h('button', { className: 'wm-btn wm-btnPrimary', disabled: 备份中, onClick: 导出备份 }, 备份中 ? '导出中…' : '导出备份'),
            ),
            备份结果 ? h('div', { className: 'wm-notice ' + (备份结果.ok ? 'wm-good' : 'wm-bad') }, 备份结果.text) : null,
          )),
          WD.卡('导入备份', h('div', null,
            WD.提('选择之前导出的 JSON 备份包，先预演看会合并多少条，确认后再导入。'),
            h('div', { className: 'wm-saveBar', style: { marginTop: 8 } },
              h('label', { className: 'wm-btn', style: { cursor: 'pointer' } }, '选择备份文件',
                h('input', {
                  type: 'file',
                  accept: '.json,application/json',
                  style: { display: 'none' },
                  onChange: 选导入文件,
                }),
              ),
              导入文件 ? h('span', { className: 'wm-hint' }, `已选 ${导入文件.name}`) : null,
            ),
            h('div', { className: 'wm-saveBar', style: { marginTop: 6 } },
              h('button', { className: 'wm-btn', disabled: 导入中 || !导入文件, onClick: () => 导入备份(true) }, '预演'),
              h('button', { className: 'wm-btn wm-btnPrimary', disabled: 导入中 || !导入文件, onClick: () => 导入备份(false) }, 导入中 ? '导入中…' : '导入备份'),
            ),
            导入结果 ? h('div', { className: 'wm-notice ' + (导入结果.ok ? 'wm-good' : 'wm-bad') }, 导入结果.text) : null,
          )),
          WD.卡('导入召回', h('div', null,
            WD.提('扫描 DSH 里存着的旧会话，把还没入库的内容补进记忆。先预演，确认后再导入；默认只走规则，不调模型。'),
            h('div', { className: 'wm-saveBar', style: { marginTop: 8 } },
              h('button', { className: 'wm-btn', disabled: 召回中, onClick: () => 导入召回(true) }, '预演'),
              h('button', { className: 'wm-btn wm-btnPrimary', disabled: 召回中, onClick: () => 导入召回(false) }, 召回中 ? '导入中…' : '导入召回'),
            ),
            召回结果 ? h('div', { className: 'wm-notice ' + (召回结果.ok ? 'wm-good' : 'wm-bad') }, 召回结果.text) : null,
          )),
        ),
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
