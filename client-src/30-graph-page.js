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

