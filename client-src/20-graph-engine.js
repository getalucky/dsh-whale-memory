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

