
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
