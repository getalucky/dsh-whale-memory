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

