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

