# dsh-whale-memory

大肥鱼的记忆库。固定人格 + 分层记忆 + 用户/群分片 + 蒸馏 + 淡忘归档。

这是 DeepSeek Harness（DSH）的插件：装上以后，会话创建时自动挂一份人格到 system prompt，聊天内容按私聊 / 群 / 本机分片落盘，空闲时蒸馏成条目，长会话按需读取而不是把整个库塞进上下文。零外部依赖，只用 Node 内置模块。

## 安装

**前置**
- DSH 桌面版，profile 目录是 `$DSH_HOME/profiles/desktop`（`DSH_HOME` 一般指 `~/.dsh` 或你自定义的安装目录）
- Node ≥ 20，profile 里带 pnpm（DSH 自带在 `$DSH_HOME/dsh-runtimes/`）
- **安装时 DSH 必须关闭**：装的过程会重写 `profile/node_modules`

**方式一：脚本（在本仓库里）**

```bash
export DSH_HOME=/path/to/dsh               # Windows: set DSH_HOME=D:\dsh
node tools/deploy.mjs                      # 打包 + 装机，一条命令干完
```

脚本会打包 → 放进 `profile/vendor/` → 改 `profile/package.json` 的 `dependencies` 和 `dsh.profile.bundles` → `pnpm install` → 核对装机的 `lib/client.js` 和工作区一致。任何一步失败都会还原配置，不会留下半装状态。

**方式二：手工**

1. `npm pack`，把 tgz 放进 `$DSH_HOME/profiles/desktop/vendor/`
2. `profile/package.json` 里加两处：
   ```json
   {
     "dependencies": { "dsh-whale-memory": "file:vendor/dsh-whale-memory-<版本>.tgz" },
     "dsh": { "profile": { "bundles": ["...原有项", "dsh-whale-memory"] } }
   }
   ```
3. 在 profile 目录跑 `pnpm install`
4. 启动 DSH，设置里应该出现「大肥鱼记忆」页签

**装完先改人格**：仓库里的 `persona.md` 只是新装时的种子，`$DSH_HOME/dsh-memory/persona.md` 才是运行时那份（库里有就不覆盖）。把里面「拥有者是 QQ 123456789」换成你自己的号，否则它认不出谁是主人。不想要鲸鱼人设，整份换成你自己写的也行——`<!-- PERSONA:CORE:START -->` 和 `<!-- PERSONA:EVOLVABLE:START -->` 两个区块要留着，探针和自动迭代都靠它们定位。

## 它做什么

- **固定人格**：`persona.md` 挂进所有会话的 system prompt（默认全局，含人格与纪律）；注入前去掉区块标记，预算 ≤1200 tok。
  完整来历与旧稿在 `persona_full.md`（只做参考，不注入）。人格沉淀走 `node tools/persona.mjs propose/apply/rollback`，只改 EVOLVABLE 区块，人工确认后版本化落盘。
  蒸馏生成与审查分开：生成只看脱敏样本（命令 / 日志 / 凭据不进，按分片均衡），审查先跑确定性检查
  （证据 id 必须在库、不写事件 / 日期 / 号码 / 路径 / 凭据、不重复、不超预算），再可选调独立审查模型；
  没配 LLM 就退回规则候选，失败不写半截提案。
- **人格探针**：20 项静态体检（区块 / 预算 / 不自曝 / 不写事件与日期 / 不写路径与凭据 / 称呼与语气规则在不在）。
  `propose` 时给人看，`apply` 前后各跑一次，通过项数掉了就拒绝应用；变更写进 `persona_changelog.md`（版本、新增规则、依据的记忆 id）。
- **人格自动迭代**：每小时看一次，只有「距上次迭代 ≥24h + 累计 ≥100 条有效用户消息 + ≥20 条有效样本」
  齐了才出提案；出提案不等于改人格。自动发布还要过「本周没发布过 + 确认闸门在 enforce + 连续 3 次人工通过」，
  否则只落 `persona_proposal.json` 等人工 `apply`。拒绝用 `persona.mjs reject --why "原因"`，会清零连续计数，
  同一规则 30 天内不再提；回滚也清零。「每周最多一个 revision」对自动发布硬拦，人工紧急用 `apply --force`。
  关掉自动跑：`DSH_MEMORY_PERSONA_AUTO=off`（CLI 手动流程不受影响）。
- **经验与画像**：`AGENT.md`（原则 / 路径 / 坑，≤3000 字符）和 `USER.md`（偏好 / 习惯 / 红线 / 背景，≤3000 字符）
  两份独立文件，跟 `persona.md` 分家。偏好和教训在记忆**转正之后**自动沉淀（待确认的不进），
  每条带主库指针；一条经验连续两次「按它做还是失败」自动标待复核并退出注入，一次成功就恢复。
  文件可手改、可 git diff，容量到顶先丢最老的非待复核条目。
- **分片记忆**：`scopes/public-web/`（公共池）、`scopes/group-<群号>/`（圈子池）、
  `scopes/private-<QQ号>/`（私聊池）、`scopes/local-dsh/`。
  公共池放网上学到的公开内容（B站账本等），群和私聊都能读，只有本机能写；
  圈子池每个群一份、群之间不互通，私聊可以读圈子池；私聊池每份私聊各记各的，私聊之间不互通。
  本地会话（桌面 / CLI / Web 直接开的）没有绑定表可查，统一进 `local:dsh` 一个全局分片，不做项目隔离。
  每个分片都是「主库 + 派生副库」的目录，旧版单文件 JSON 启动时自动迁移
- **蒸馏**：会话空闲 10 分钟后，从用户消息里提取值得记的事实/偏好/约定
  （默认规则抽取；设置页「大肥鱼记忆 → 模型」填了端点、或配了 `DSH_MEMORY_LLM_*`，就先走一次 LLM，失败自动回退规则）。
  本地会话换一套工程信号词（路径 / 版本 / 「以后都用」/ 约定 / 决定），
  只记能迁移的结论，不把代码和工具输出当记忆
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
- **审计**：`audit/writes.jsonl`、`audit/reads.jsonl`、`audit/injects.jsonl`；
  `node tools/metrics.mjs [天数]` 从真实账本算主动读取有效率、无效读取 token、
  主动写入准确率（24h 后仍保留）和重复写入率，运行页同一口径
- **两级漏斗**：`search_memory` 只在副库字段上检索（语义 0.35 / 标签 0.15 / 权重 0.15 / 新近 0.15 / 置信 0.10），
  命中后做一跳标签展开（上下位，0.7 衰减）；无关查询返回空，不拿最近的记忆硬凑
- **读侧工具**：`search_memory`（查副库，只返回 id/摘要/标签/权重）/ `read_memory`（按 section 读主库，单次 ≤800 tok）
  / `profile_show`；旧的 `memory_recall` 作为别名保留
- **写侧工具**：`memory_save`（必须带 `source_quote` 用户原话）/ `memory_pending`（看待确认）/ `memory_confirm`（点头转正）
  / `memory_correct` / `memory_update`（只改话题进展、承诺到期，不新建）/ `memory_forget` / `memory_revive`（从归档或过期里找回）
  / `memory_experience`（看 / 增经验与画像，`ok` / `fail` 记一次用后结果，连续失败两次自动待复核）
- **三类特殊记忆**：`lesson` 教训（必填 `trigger`「当……时」+ `anti_pattern`，写不出来就不是教训）、
  `topic` 进行中话题（必填 `goal`，进展变化用 `memory_update` 改，不新建条目）、
  `commitment` 承诺（必填 `due` / `to_whom`，日期或「下次提到 X 时」）。
  会话首轮的骨架里会提醒「逾期/一周内到期的承诺 + 进行中话题 + 最重的一条教训」，零 LLM、纯日期比较，不逐轮扫
- **确认闸门**：`memory_save` 只认用户原话里的「记住 / 纠正 / 长期偏好」信号，有信号才直接生效；
  没有就落 `suggested`（待确认）——不进副库、不进骨架、不参与检索，等用户点头再 `memory_confirm`。
  待确认条目不占容量位，也不会取代已生效的旧说法；蒸馏链路（规则/LLM 抽取）仍按原来的过滤直接入库。
  三态灰度：`DSH_MEMORY_GATE=enforce`（默认，真拦）/ `warn`（放行但条目和审计留 `gate=warn` 记号，
  先看拒绝率）/ `off`（只记录不拦）；运行页会给出 warn / blocked 计数
- **L3 图谱**：把记忆拆成「实体 —关系→ 实体」，落 `graph/nodes.jsonl` + `graph/edges.jsonl`；
  目前只用于界面展示，不再塞进 system prompt（注入只留规矩段 + 骨架）
- **界面**：DSH 设置 → 「大肥鱼记忆」，五个页签（总览 / 记忆 / 图谱 / 审计 / 运行）；运行页看人格预算、信任状态、每分片容量、最近检索与跳过原因；记忆页可以删单条，待确认的一栏能点「确认」转正

## 数据长什么样

```text
<DSH_HOME>/dsh-memory/
  persona.md                 人格（会话创建时快照）
  persona_changelog.md       人格变更日志（版本 / 规则 / 依据 / 探针）
  persona_archive/           人格历史版本，可 rollback
  AGENT.md                   经验（原则 / 路径 / 坑，≤3000 字符，可手改）
  USER.md                    画像（偏好 / 习惯 / 红线 / 背景，≤3000 字符，可手改）
  scopes/private-<QQ号>/
    memory_full/{id}.md      主库：唯一真源，一条一段完整记录
    memory_index.md          副库：派生目录，≤32KB，可删可重建
    tag_graph.md             派生：标签计数
    status.md                派生：给人看的状态面
    meta.json                画像 / 成员 / 来源标记
    archive/full/            删掉或归档的条目（正文保留，可翻回）
    .rev                     写入版本号（注入层按它判断要不要重画）
  scopes/local-dsh/          本地会话（桌面 / CLI / Web）的全局记忆，结构同上
  scopes/group-<群号>/       群记忆（圈子池），结构同上
  scopes/public-web/         公共记忆池：网上学到的公开内容，所有会话可读、只有本机能写，结构同上
```

规矩：**先写主库，再写副库**。副库坏了、删了，跑 `node tools/rebuild-index.mjs` 从主库重建；
主库里的条目删掉时只挪进 `archive/full/`，不物理删。

## 记忆什么时候进提示词（重要）

`agent/created` 时挂两个 section（都声明 `interpolate: false`，正文里的 `{{` 不会被宿主当变量），
`text()` 同步求值，不能在里面读盘：

- **人格段**：会话创建时取一次快照，整个会话用这份。中途改 `persona.md` 不会改当前会话的
  system prompt（改了 prefix cache 就整段作废），下个会话生效，日志里会提示一次。
- **记忆段 = 规矩段 + 目录骨架**：规矩段是常量（怎么查、什么时候写、什么不许写），骨架是
  标签树 + 条目摘要 + 计数 + 版本号，总预算 ≤1600 tok。分片 ≤12 条时**全列**（藏起来省不下字，
  只会让模型看漏），更大才按类目收着放，被截掉的条数在行尾写明「…还有 N 条」；群分片额外带
  一行「群里的人」。**正文不再常驻**，模型要详情必须 `search_memory` → `read_memory`。
- **经验与画像段**：`AGENT.md` / `USER.md` 各挑最多 3 条跟当前分片、仓库相关的条目，
  总共 ≤420 字，接在骨架后面。会话首轮挑一次，中途不重挑；`USER.md` 有内容时
  骨架里的画像摘要就不再重复。要看全文用 `memory_experience(action="show")`。
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

## 外部记忆接入

别的插件（B站值班、抓取任务、以后别的东西）想把自己的观察放进记忆库，不用改本插件：

**方式一：投递箱（跨进程/跨 profile，零代码）**

往 `$DSH_HOME/memory-inbox/<来源>.jsonl` 追加行，一行一条：

```json
{"text":"池塘水温 18 度。","quote":"传感器读数","refs":["pond-3"],"at":"2026-11-03 09:00","kind":"event","conf":0.8}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `text` | 是 | 条目正文 |
| `quote` | 否 | 原文摘录/为什么记，进 `sourceQuote` |
| `refs` | 否 | 字符串或数组，进条目的引用 |
| `at` | 否 | 观测时间，`2026-11-03 09:00` 或 ISO；缺省按入库时间 |
| `kind` | 否 | `fact` / `pref` / `event` / `relation`，缺省 `fact` |
| `conf` | 否 | 0.1–1，缺省 0.5 |
| `source` | 否 | 来源标记，缺省用文件名 |

文件名就是来源，进库后能在审计里按来源查。目录可用 `DSH_MEMORY_INBOX` 改；总开关 `DSH_MEMORY_INBOUND=off`。
拉，不推：投递方不需要知道本插件存在，写入失败也不影响它；本插件按字节水位取新增行，
半行等写完，账本被截断/替换时用正文 hash 兜住重复。

**方式二：注册 provider（同进程、自定义解析）**

```js
import { registerInboundProvider } from 'dsh-whale-memory/inbound'

const off = registerInboundProvider({
  id: 'my-source',
  label: '我的账本',
  files: () => [{ file: '/path/to/ledger.jsonl', token: 'main' }],
  parse: (row, { toIso }) => ({ text: row.msg, quote: row.note, at: toIso(row.when) }),
})
```

其余（水位、去重、半行、落盘、审计）都由引擎处理。完整规格见 `lib/inbound.js` 里
`registerInboundProvider` 的注释；B站那一路就是现成示例（`lib/inbound-bili.js`）。

## 数据卫生

- **来源判定**：每条消息落盘前 `await sourceOfSession(sid)`，按 `qq-bridge-config.json`
  的 mtime 现查，不用启动时的缓存快照（旧版缓存不刷新，Web 开发会话被当成桥接收进来过）。
  绑定表里没有、且配置可读（或根本没配桥接）的会话 = 本地会话，进 `local:dsh`；
  配置在但读坏/JSON 坏了就先跳过，不把桥接会话误归本地
- **本地记忆开关**：`DSH_MEMORY_LOCAL_SCOPE=off` 退回只收 QQ 桥接，本地会话连记忆段都不挂
- **过滤宿主元消息**：`Time sampled while…` / `Browser time zone…` / `Elapsed since…` /
  `<system-reminder>` 这些不是人说的话，直接丢，别占 `KEEP=300` 的名额
- **孤儿 staging**：本地记忆关掉、或绑定表读坏时，认不出来源的会话文件挪进 `staging/orphan/`
  + 记 `index.jsonl`。不删数据，但也不会每 5 分钟重试一次蒸馏（旧版就卡在这）
- **写保护**：工具靠「最近活跃会话」推断分片，超过 10 分钟就拒绝写，宁可失败也不写错人
- **写队列**：distill / forget / 工具 / 界面删除全走同一把进程内锁，读改写不会互相覆盖
- **水位断点**：蒸馏按「这轮读到的前缀」消费 staging，调 LLM 那 8 秒里新进来的消息留着下一轮；
  落库成功但没来得及消费就崩了，重跑靠合并去重，不会记两遍（`test/watermark.mjs`）
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
- 崩了打不开：把 `package.json` 的 `exports["./client"]` 和 `dsh.client` 摘掉，只留记忆本体，宿主就不会因为客户端 bundle 报错而整个起不来

## 测试

```
npm test                # 29 组全跑，零外部依赖，不联网
```

单跑某一组：

```
node test/smoke.mjs     # 存储/蒸馏/遗忘
node test/time.mjs      # 相对时间锚定 + 注入 {{ 守卫
node test/memory.mjs    # 事实取代/并发写/容量门/相关注入/群成员/脱敏/memory_correct
node test/llm.mjs       # 可选 LLM 蒸馏 + 向量召回（桩 fetch，不联网）
node test/graph.mjs     # 图谱抽取 + 界面接口
node test/recall.mjs    # 检索
node test/profile.mjs   # 画像
node test/hygiene.mjs   # 元消息 / 孤儿 staging / 手动删除 / 写保护 / 截断
node test/local.mjs     # 本地会话：采集 → local:dsh → 工程抽取 → 注入 → 工具写
node test/confirm.mjs   # 确认闸门：suggested 不进目录，点头才生效
node test/watermark.mjs # 蒸馏水位：中途追加不丢，重跑不重
node test/client.mjs    # 客户端 bundle 离线冒烟
node test/persona.mjs   # 人格闸门 + 20 项探针 + 变更日志
node test/personaauto.mjs # 人格自动迭代：门槛 / 每周一次 / 连续通过 / 拒绝清零
node test/docs.mjs      # AGENT.md / USER.md：容量门 / 去重 / 失败降级 / 注入预算
node test/gate.mjs      # 确认闸门灰度：off / warn / enforce
node test/metrics.mjs   # 真实流量指标口径：读有效率 / 写入准确率 / 重复写入
node test/personadistill.mjs  # 人格蒸馏：采样脱敏 / 生成审查分离 / 假证据拦截
node tools/verify-client.mjs   # 重启前体检
node tools/check.mjs           # 跑起来之后看真实数据
```

## 目录

```
$DSH_HOME/dsh-memory/        （可用 DSH_MEMORY_HOME 改到别处）
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
- `DSH_MEMORY_PERSONA_AUTO` — 人格自动迭代：`on`（默认，每小时检查）/ `off`（只留手动 CLI）
- `DSH_MEMORY_LOCAL_SCOPE` — `on`（默认，本地会话也记）/ `off`（退回只收 QQ 桥接）
- `DSH_MEMORY_PROJECT_SCOPE` — `on`（默认，仓库里的本地会话可挂 project 命名空间）/ `off`（只有个人库）
- `DSH_MEMORY_GATE` — confirm 闸门灰度：`enforce`（默认）/ `warn`（放行但留记号）/ `off`（不拦）
- `DSH_QQ_BRIDGE_CONFIG` — 桥接配置路径（默认 `$DSH_HOME/qq-bridge-config.json`）
- `DSH_MEMORY_LLM_BASE` / `DSH_MEMORY_LLM_KEY` / `DSH_MEMORY_LLM_MODEL` — 可选蒸馏端点
  （OpenAI 兼容，`BASE` 写到 `/v1`；不配就纯规则）。设置页「模型」里填的优先于这里，
  key 落盘在 `<库>/settings.json`（界面只回显尾巴）；不确定模型名就点「探测可用模型」，
  会拉 `/models` 再逐个实测，能用的直接点选（探测不落盘，但会消耗少量额度）
- `DSH_MEMORY_EMBED_BASE` / `DSH_MEMORY_EMBED_KEY` / `DSH_MEMORY_EMBED_MODEL` — 可选向量端点
  （Ollama 填 `http://127.0.0.1:11434/v1` + `bge-m3`；不配就纯词法）
- `DSH_MEMORY_REVIEW_BASE` / `DSH_MEMORY_REVIEW_KEY` / `DSH_MEMORY_REVIEW_MODEL` — 可选人格审查模型；
  不填就退回主 LLM（仍是单独一次调用、独立提示词），只配主 LLM 时提案里会标 `llm(fallback)`

## 边界

- 不建会话、不刷 B 站、不主动说话
- 来源识别靠桥接绑定表（sessionId → 私聊/群）；表里没有的算本地会话，进 `local:dsh`，
  不解析消息文本
- 公共池（`public:web`）所有会话可读，写入收口在本机会话：`memory_save(..., namespace="public")`
  或 B站 inbound；群/私聊只能读，不能改、删、转正公共条目；公共池也不参与遗忘衰减、
  自动深化和人格蒸馏
- 本地会话默认进 `local:dsh`；如果 cwd 在一个仓库里（向上找得到 `.git` / `package.json` /
  `AGENTS.md` 等标记），额外挂一个 **project 命名空间**，库放在 `<repo>/.dsh/storages/whale-memory`，
  两个库各有独立的 `memory_index.md` 与 `memory_full/`。检索和注入合并两处，写入仍默认进个人库：
  - 跟这个仓库有关的命令、路径、约定、坑，用 `memory_save(..., namespace="project")` 显式存仓库库；
  - **自动蒸馏只进个人库**，不把聊天摘要提交进仓库；
  - 仓库库登记在个人库的 `namespaces.json`，遗忘/深化循环会一起扫；
  - 设置页只列个人库的分片，仓库库的条目在注入骨架和记忆工具里能看到；
  - `DSH_MEMORY_PROJECT_SCOPE=off` 关掉；`DSH_HOME` 内和无标记的目录不会被当成仓库。
- 蒸馏默认规则抽取；LLM 是可选项，失败/超时一律回退规则，不会写半截结果
- 检索默认词法（字符 n-gram）；向量也是可选项，端点不可达时静默降级
- 图谱只认「在X上班 / 住在X / 喜欢X / 养了X / 我叫X / X是Y / 在<地名尾缀>」这几种句式，
  抽不出来就不抽——宁可图谱稀一点也不瞎连边，所以多数时候它确实是空的
- 人格只有一处运行时来源：`$DSH_HOME/dsh-memory/persona.md`（人格 + 纪律都在里面）。
  插件仓库的 `persona.md` 只是新装时的种子；桌宠那份 `PET-PERSONA` 是独立的压缩版
