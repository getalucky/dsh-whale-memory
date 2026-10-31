# dsh-whale-memory

大肥鱼的记忆库。固定人格 + 分层记忆 + 用户/群分片 + 蒸馏 + 淡忘归档。

## 它做什么

- **固定人格**：`persona.md` 挂进所有会话的 system prompt（默认全局，含人格与纪律）；注入前去掉区块标记，预算 ≤1200 tok。
  完整来历与旧稿在 `persona_full.md`（只做参考，不注入）。人格沉淀走 `node tools/persona.mjs propose/apply/rollback`，只改 EVOLVABLE 区块，人工确认后版本化落盘。
- **分片记忆**：`scopes/private-<QQ号>/`、`scopes/group-<群号>/`，私聊和群各记各的；每个分片是「主库 + 派生副库」的目录，旧版单文件 JSON 启动时自动迁移
- **蒸馏**：会话空闲 10 分钟后，从用户消息里提取值得记的事实/偏好/约定
  （默认规则抽取；配了 `DSH_MEMORY_LLM_*` 就走一次 LLM，失败自动回退规则）
- **降维**：每条记忆落盘时生成摘要、受控标签、上级标签、时间线、权重（`lib/enrich.js` + `lib/taxonomy.js`），
  标签只认词表（高数/高等数学/微积分 → 高数），认不出来退回类型标签，不自由生长
- **预筛**：先看信号词再抽候选；寒暄、问句、工具输出不跑抽取，跳过原因写进 `audit/writes.jsonl`
- **深化**：标签 ≥20 条、副库 >24KB、或 7 天没整理且新增 ≥10 时，合并近重复（数字不同不合并）、归档最冷条目
- **时间锚定**：「明天 / 下周三 / 下午3点」按消息发言时刻换算成绝对时间，注入时一起带上
  （`（10-31 08:30）`），否则三天后它还在说「明天」
- **事实取代**：同一个人、同一个槽位（上班时间 / 住址 / 名字 / 年龄 / 电话）的新说法
  会让旧条目标成 `superseded`，不再注入、不进图谱，但留在库里可回溯
- **容量门**：单个分片最多 400 条，超了把最冷的搬进 `archive/`（不删）
- **命中记录**：每条消息命中的条目只记在内存里（供后续预览/调试），不再影响常驻段，也不逐条消息重画 system prompt
- **群成员**：只记昵称和活跃度，注入成「【群里的人】」，不落 QQ 号
- **淡忘**：`conf × exp(-age/30d) × 命中加成`，低于 0.5 降 warm、低于 0.25 降 cold
- **归档**：cold 且 90 天没碰 → 移进 `archive/`，不删；`expires_at` 到期的标 `expired`，主库保留、副库和注入剔除；两者都能 `memory_revive` 找回
- **审计**：`audit/writes.jsonl`、`audit/injects.jsonl`
- **两级漏斗**：`search_memory` 只在副库字段上检索（语义 0.35 / 标签 0.15 / 权重 0.15 / 新近 0.15 / 置信 0.10），
  命中后做一跳标签展开（上下位，0.7 衰减）；无关查询返回空，不拿最近的记忆硬凑
- **读侧工具**：`search_memory`（查副库，只返回 id/摘要/标签/权重）/ `read_memory`（按 section 读主库，单次 ≤800 tok）
  / `profile_show`；旧的 `memory_recall` 作为别名保留
- **写侧工具**：`memory_save`（必须带 `source_quote` 用户原话）/ `memory_correct` / `memory_forget` / `memory_revive`（从归档或过期里找回）
- **L3 图谱**：把记忆拆成「实体 —关系→ 实体」，落 `graph/nodes.jsonl` + `graph/edges.jsonl`；
  目前只用于界面展示，不再塞进 system prompt（注入只留规矩段 + 骨架）
- **界面**：DSH 设置 → 「大肥鱼记忆」，五个页签（总览 / 记忆 / 图谱 / 审计 / 运行）；运行页看人格预算、信任状态、每分片容量、最近检索与跳过原因；记忆页可以删单条

## 数据长什么样

```text
<DSH_HOME>/dsh-memory/
  persona.md                 人格（会话创建时快照）
  scopes/private-<QQ号>/
    memory_full/{id}.md      主库：唯一真源，一条一段完整记录
    memory_index.md          副库：派生目录，≤32KB，可删可重建
    tag_graph.md             派生：标签计数
    status.md                派生：给人看的状态面
    meta.json                画像 / 成员 / 来源标记
    archive/full/            删掉或归档的条目（正文保留，可翻回）
    .rev                     写入版本号（注入层按它判断要不要重画）
```

规矩：**先写主库，再写副库**。副库坏了、删了，跑 `node tools/rebuild-index.mjs` 从主库重建；
主库里的条目删掉时只挪进 `archive/full/`，不物理删。

## 记忆什么时候进提示词（重要）

`agent/created` 时挂两个 section（都声明 `interpolate: false`，正文里的 `{{` 不会被宿主当变量），
`text()` 同步求值，不能在里面读盘：

- **人格段**：会话创建时取一次快照，整个会话用这份。中途改 `persona.md` 不会改当前会话的
  system prompt（改了 prefix cache 就整段作废），下个会话生效，日志里会提示一次。
- **记忆段 = 规矩段 + 目录骨架**：规矩段是常量（怎么查、什么时候写、什么不许写），骨架是
  标签树 + 每类 Top-2 + 计数 + 版本号，总预算 ≤1600 tok。**正文不再常驻**，模型要详情必须
  `search_memory` → `read_memory`。
- 骨架刷新：文件变了也要「≥5 分钟 + 活跃条目变化 ≥3 条」才重建，删除立即生效。
  每轮命中的条目只记在内存里，不再逐条消息重画 system prompt。

旧版把正文全量塞进 system prompt，长会话每轮都读整库。现在固定开销从「条目数 × 摘要长度」
降到「标签树 + 几个 Top 条目」，可变开销交给工具按需触发。

## 外部库与压缩恢复

- **信任门**：库的 `meta.json` 带 `origin`。本地库直接可用；clone / 导入 / git 仓库里的记忆库默认 `external`，
  不注入、不检索、不参与整理。确认可信后跑 `node tools/memory-trust.mjs trust`（记内容指纹），
  库被替换或外部改动 → 指纹漂移 → 开机自动撤销。我们自己的写入会刷新指纹，不会用一次就掉信任。
- **压缩恢复**：监听宿主的 `compaction/end` 事件，注入一个 ≤420 字的恢复包（当前目标、画像、
  高权重条目、本会话已读/已写 id），10 分钟后自动撤掉；不重放历史，不重新注入正文。
- **并发**：同一进程内所有写入走一把串行队列；CLI（部署、重建、人格、信任）要求 DSH 关闭时跑，
  跨进程不共享同一份库。

## 数据卫生

- **只收桥接会话**：每条消息落盘前 `await sourceOfSession(sid)`，按 `qq-bridge-config.json`
  的 mtime 现查，不用启动时的缓存快照（旧版缓存不刷新，Web 开发会话被当成桥接收进来过）
- **过滤宿主元消息**：`Time sampled while…` / `Browser time zone…` / `Elapsed since…` /
  `<system-reminder>` 这些不是人说的话，直接丢，别占 `KEEP=300` 的名额
- **孤儿 staging**：认不出来源的会话文件挪进 `staging/orphan/` + 记 `index.jsonl`。
  不删数据，但也不会每 5 分钟重试一次蒸馏（旧版就卡在这）
- **写保护**：工具靠「最近活跃会话」推断分片，超过 10 分钟就拒绝写，宁可失败也不写错人
- **写队列**：distill / forget / 工具 / 界面删除全走同一把进程内锁，读改写不会互相覆盖
- **凭据打码**：`sk-` / `ghp_` / `Bearer` / `api_key: xxx` 这类在入库和注入两侧都会换成 `[已隐藏]`
- **删除**：`memory_forget` 工具 / 记忆页的 `×` 都只做归档（`archive/*.jsonl` + 审计），能翻回来

## 界面怎么来的

`lib/client.js` 是手工写的客户端 bundle，必须长这样：

```js
window.__ModuleLoader__.load({ id: '<包名>', factory: (require) => { ... } })
```

- 里面只能 `require('react')`，**不能有顶层 import/export**，否则宿主 `ClientModuleRegistry.flush` 直接抛错，整个 DSH 起不来
- `package.json` 必须同时有 `dsh.client`（platform: web）和 `exports["./client"]`
- 改完先跑 `node tools/verify-client.mjs`（复刻宿主校验规则），过了再重启
- 崩了打不开：双击 `$WORKSPACE\回退-去掉界面.cmd`，只摘掉界面、保留记忆本体

## 测试

```
node test/smoke.mjs     # 存储/蒸馏/遗忘
node test/time.mjs      # 相对时间锚定 + 注入 {{ 守卫
node test/memory.mjs    # 事实取代/并发写/容量门/相关注入/群成员/脱敏/memory_correct
node test/llm.mjs       # 可选 LLM 蒸馏 + 向量召回（桩 fetch，不联网）
node test/graph.mjs     # 图谱抽取 + 界面接口
node test/recall.mjs    # 检索
node test/profile.mjs   # 画像
node test/hygiene.mjs   # 元消息 / 孤儿 staging / 手动删除 / 写保护 / 截断
node test/client.mjs    # 客户端 bundle 离线冒烟
node tools/verify-client.mjs   # 重启前体检
node tools/check.mjs           # 跑起来之后看真实数据
```

## 目录

```
$DSH_HOME/dsh-memory/        （默认 $DSH_HOME\dsh-memory）
├─ persona.md                人格（库里有就不覆盖插件自带那份，改插件不会生效）
├─ scopes/                   分片记忆
├─ staging/                  待蒸馏的原始消息
│  └─ orphan/               认不出来源的会话（停用，不删）
├─ archive/                  归档
├─ audit/                    账本
├─ graph/                     L3 图谱（nodes.jsonl / edges.jsonl）
└─ logs/
```

## 配置

环境变量：

- `DSH_MEMORY_HOME` — 记忆库根目录
- `DSH_MEMORY_PERSONA_SCOPE` — `all`（默认，所有会话都挂人格）/ `bridge`（只挂 QQ 桥接）
- `DSH_QQ_BRIDGE_CONFIG` — 桥接配置路径（默认 `$DSH_HOME/qq-bridge-config.json`）
- `DSH_MEMORY_LLM_BASE` / `DSH_MEMORY_LLM_KEY` / `DSH_MEMORY_LLM_MODEL` — 可选蒸馏端点
  （OpenAI 兼容，`BASE` 写到 `/v1`；不配就纯规则）
- `DSH_MEMORY_EMBED_BASE` / `DSH_MEMORY_EMBED_KEY` / `DSH_MEMORY_EMBED_MODEL` — 可选向量端点
  （Ollama 填 `http://127.0.0.1:11434/v1` + `bge-m3`；不配就纯词法）

## 边界

- 不建会话、不刷 B 站、不主动说话
- 来源识别靠桥接绑定表（sessionId → 私聊/群），不解析消息文本
- 蒸馏默认规则抽取；LLM 是可选项，失败/超时一律回退规则，不会写半截结果
- 检索默认词法（字符 n-gram）；向量也是可选项，端点不可达时静默降级
- 图谱只认「在X上班 / 住在X / 喜欢X / 养了X / 我叫X / X是Y / 在<地名尾缀>」这几种句式，
  抽不出来就不抽——宁可图谱稀一点也不瞎连边，所以多数时候它确实是空的
- 人格只有一处运行时来源：`$DSH_HOME/dsh-memory/persona.md`（人格 + 纪律都在里面）。
  插件仓库的 `persona.md` 只是新装时的种子；桌宠那份 `PET-PERSONA` 是独立的压缩版
