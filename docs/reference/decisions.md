# 决策台账 — AgentDock

> 状态：**设计树已闭合（前沿为空）**，2026-09-18。全部产品决策已由项目所有者裁决；本文件是唯一权威记录。
> 事实依据、出处与置信度见 `docs/reference/facts.md`；本文件不重复证据，只记"定了什么、为什么"。
> 决策者是项目所有者；AI 提供推荐、证据与反例。凡 AI 自行决定、未经用户逐条确认的条目，一律标注 **[AI 决定，可否决]**。

## 一、已结算

### D1 — 产品身份与阶段目标（Q1）

**用户裁定**：短期自用，长期公开开源产品。

**由此冻结的架构约束**：

- 不得把 Core 绑定到某个私有协议或单一 harness。
- 不得依赖 Git 表达变更语义（与 D5 一致）。
- Core 必须与**渲染方式**解耦（见 D11）——最终分发形态可能从扩展变成 fork。
- 差异化必须落在**没有任何在位者占据**的那一格（见 D12）。

### D2 — Turn 的边界（Q2）

**用户裁定（原话）**：turn 的定义是**从用户输入 prompt 到 agent 完全完成处理**。

**推论**：turn 账本由 IDE 自己维护（prompt 发出 → agent 结束之间缓冲），**不指望协议给出分组** —— ACP v1 只提供这个时间窗，不提供 turn 对象；且规范明确允许 `session/update` 在 prompt 之外到达。

### D3 — 用户手改与裁决语义（Q3）

**用户裁定（原话要点）**：

1. 手改**不需要特殊处理**。
2. **Accept 的含义是"应用用户修改后的文本"**；**Reject 依然把文本恢复到 old**，即便该处已被用户改过；Accept file / Accept turn 同理。
3. 系统**必须对用户修改 aware**：新一轮开始时 agent 需要知道上一轮用户拒绝了哪些、修改了哪些（"修改了哪些"的落地方式见 **D45**）。
4. pending / accepted **不做特殊记忆**，因为那是常态。

### D4 — 渲染形态的硬约束（Q1 + PoC §6）

目标形态（普通编辑器中多行 old 以内联代码行呈现）在稳定 API 下不可达，需要冻结于 2019 年的 proposed API `editorInsets`，因此**不能上架 Marketplace**。一期是否多轨见 D11。

### D5 — ChangeSet 不依赖 Git（Q5 附带）

**用户裁定**：`AgentDock` 的 changeSet **不应依赖 git**。

**推论**：baseline 由 IDE 自己持有。副作用是白拿一个能力：**同一份 baseline 反向应用 = 撤销第 N 轮**。

### D6 — 文件级操作是一等实体（Q5）

**用户裁定**：文件级 `new` / `remove` / `rename` **都是一级**。

**推论**：`rename` 必须是真正的 rename 指令，不能降级为 delete+add。文件级操作同样遵循 **"已应用"模型**（见 D26）：agent 的删除 / 新建 / 重命名**已经发生**，**Accept 只是确认，Reject 才需要从快照反向恢复**。破坏性操作的闸门在**权限门**（D9：ACP 的 `session/request_permission` 覆盖 `bash / edit / delete / move`），**不在 review 门**。

### D7 — Adapter 战略（Q6）

**用户裁定**：**(c) + (e)**。

- Core 只认内部契约；**ACP 为脊**；能力层独立、**经 MCP 暴露**（`session/new.mcpServers` 注入）；OMP 的 `--mode rpc`（`set_host_tools` / `set_host_uri_schemes`）**后置为特权通道**。
- **同时把微软 AHP 的数据模型当 Core 的对齐目标**（immutable state + pure reducers + URI 寻址的 changeset）；AHP 今天对扩展不可用，故不当地基。

**实测支撑**：`omp acp` 握手返回协议 1、`sessionCapabilities{list,fork,resume,close}`、`session/new` 接受 `mcpServers[]`、`configOptions` 已含 `model` 与 `thought_level`。

### D8 — ChangeSet 的定义与归因边界（Q7，含用户修正）

**用户裁定**：**ChangeSet 是 agent 的修改意图集合**；只记录**明确能归因为 agent** 的修改。**不做全盘磁盘监控**。

**推论（必须写进设计正文，不得隐藏）**：

1. 归因来源 = 协议声明（`tool_call` 的 `diff` / `locations`）+ IDE 自己的写通道（`fs/write_text_file`、MCP fs 工具）。
2. **"Reject 逐字节还原到 baseline" 的保证范围 = 已归因的修改**；baseline 只需在归因到的写入之前拍摄。
3. 代价：**存在"文件被改了但没有进入 review"的情况**，这是用户明确接受的取舍。
4. 收益：ChangeSet 天然回答"这一步 agent 想干什么"，与 D2 的 turn 语义一致，且避免全盘监控的成本与误报。

### D9 — 权限与审批的归属（Q9，含用户修正）

**用户裁定**：每个 harness 都有自己的沙箱和权限系统，**IDE（Core）只提供配置向的 hint 和 harness 审批操作的转接**；**实际权限由 harness 自己决定**。

**推论**：

1. Core **不实现策略引擎**、**不自建 `allow_always` 存储**、**不追加选项**（选项集由 agent 给出，IDE 只能在其给定的 `optionId` 中选择或取消）。
2. "每次询问 / 自动接受编辑 / 完全自动"这档**降级为 hint**：表达为 **harness 自己的配置**，经 `session/set_config_option` 或 harness 原生配置落盘。
3. 事实支撑：ACP 的 `session/request_permission` 是 **baseline** 能力，不受 capability gate 约束。
4. **权限门与 review 门语义分离**：前者答"允不允许做"，后者答"改动留不留"。**破坏性操作（delete / move）走权限门**（见 D6）。
5. **必须写进设计正文的后果声明**：当 harness 不提供审批、或用户把 harness 设为全自动时，**IDE 侧不存在第二道闸**，唯一把关是 review 门。不做隐藏的安全承诺。

### D10 — 能力层词汇与协商（Q8）

**用户裁定**：**(a)** —— 自定义 `ide.*` 命名空间 + 极小子集。

**一并采纳**：存在性由 MCP `tools/list` 承担；可用性由每次调用返回 `available: false + reason` 承担；提供 `ide.capabilities.describe`；每个能力带 **`fallback: allow | forbidden`** 声明。

### D11 — 渲染策略与分发路线（Q11）

**用户裁定**：**一期只做 `editorInsets`**（其他方案无法满足需求）；**产品功能成熟后再考虑 VS Code fork**。

**推论**：

1. 一期只有一条渲染路径：old 侧 insets + new 侧 decorations + 动作面 CodeLens（三者同步到同一次 `provideCodeLenses` 查询提交，沿用 PoC 已验证的策略）。
2. PoC 的稳定轨变体（comments widget / 单行 old + hover 折叠）**不作为交付路径维护**。
3. `editorInsets` 是 proposed ⇒ **一期不走 Marketplace 分发**。
4. **Core 仍然渲染无关**（只依赖"行级 hunk + anchor"）——这不是为了多轨，而是 D1 的要求。
5. fork 的**触发条件**：只有当"必须上架 Marketplace"或"需要把该形态做成稳定 API"成为真实约束时才启动。

### D12 — 阶段重心排序（Q12）

**用户裁定**：**重心是 review；次重点是 LSP 级能力（目的是提高 agent 效率）；然后才是调试等能力。**

**推论**：建设顺序 = **review 闭环 → LSP 级能力（导航 / references / rename / code action / diagnostics）→ 调试 / 测试等**。LSP 级的验收标准是**可观测的效率提升**，不是"工具存在"。

### D13 — 跨轮反馈的通道（Q10 / Q13）

**用户裁定**：

- **纯拉取**：IDE **不向 prompt 注入内容**（避免干扰 harness 的 prompt 造成不可预期）。
- **条件式、自描述的工具**：**只有当存在"用户修改或拒绝了修改"时，才向 agent 提供该工具**；工具描述里写明"用户修改或拒绝了你的修改，用此工具查看明细"。

**事实支撑（实测）**：OMP 会响应 MCP `notifications/tools/list_changed`，**会话中途**可增删工具并改写描述，下一次模型请求前生效。

**硬约束（实测）**：ACP 模式下 OMP 以 `enableMCP: false` 建会话 ⇒ `.mcp.json` 不生效，**只有 `session/new` 注入的 server 有效，且 server 集合在会话创建后不可更改**。⇒ 能力 MCP server 必须在 `session/new` 就注入，之后只能靠 `tools/list_changed` 变工具。

### D14 — 输入入口与 UI 边界（Q14）

**用户裁定**：**自建薄 webview 面板**承载对话流；所有开发行为留在原生编辑器 / SCM / 终端。

### D15 — 会话记录归属（Q15 / R1）

**用户裁定**：**IDE 全量再存一份对话**，但**只读**——用于搜索 / 导出 / 离线回看，**绝不写回 harness**；重开以 harness 的 `session/resume` 为准；resume 失败时降级为"只读回看 + 新建 session（把 IDE 副本作为上下文注入）"。

### D16 — provider / model / credential 归属（Q16 / R2 / T1）

**用户裁定**：

- IDE 存 canonical preference，**包含凭据**（落 VS Code 的加密 SecretStorage）。
- **凭据如何交给 harness，由 Adapter 决定**。两条原则（原话）：① 用户不会与 IDE 同时使用同一个 harness 实例，因此**即便出现配置文件冲突，后果由用户承担**；② **用户只操作 IDE，不需要额外编辑配置文件**。

**推论**：Core 只定义"凭据已配置"这一抽象；Adapter 必须提供端到端可用的落地路径（env 注入 / 写 harness 原生配置 / harness 认证流程均可）；**不得要求用户手工编辑 harness 配置文件**。

### D17 — prompt 上下文与 pill（Q17 / R4 / T2）

**用户裁定**：

- 默认上下文：**当前打开的文件**。
- 提供快捷方式把 **document 选区 / terminal 选取内容 / 日志** 以 pill 形式加入 prompt（对齐 Codex 等成熟产品）。
- **pill 只发引用**，不发内容快照。
- **终端内容写入日志文件**，让 agent 自由查看。

**捕获范围（T2）**：只捕获 **agent 经 ACP `terminal/create` 创建的终端**（可 100% 完整落盘）；用户自己的终端默认不碰，另提供显式命令"把当前终端内容抓进日志"，执行前明确提示会覆盖剪贴板。

**事实约束**：`Terminal.selection` 是 proposed；`OutputChannel` 只写不读；pill 没有稳定原生 UI 原语，只能在自建 webview 内渲染。

### D18 — 并发范围与 harness 绑定（Q18，含用户澄清）

**用户裁定**：一期**单窗口、单 session、单工作区根**，数据模型按 sessionId 键化以便后扩。
**用户澄清**：**session 与 harness 绑定，不能中途更换 harness**；只能在**新建 session、且在发送第一条 prompt 之前**选择 harness。

**理由**：多 session 会击穿 D8 的归因模型（两个 agent 改同一文件，谁改的？），不在 review 闭环稳定前引入。

### D19 — 外部修改与冲突（Q19 / R3 / T5）

**用户裁定**：

- **不做未归因改动的监控，也不给提示**。
- turn 开始前的外部修改不构成问题：**hunk 以当时的文件实际情况为基准产生**。
- **通过审阅功能打开含 changeset 的文件时，以文件最新内容为 baseline 重新应用 hunk（类似 merge）**；能正确应用则不影响；冲突则提示。
- 冲突的裁决：**hunk 级 + 自动丢弃冲突**。
- **但必须可区分**：被丢弃的 hunk 要记录为**区别于"用户审阅拒绝"的另一种 reject**，以便下一轮 agent 知道该文件的真实情况，不会误以为"是用户审阅时拒绝的"。

**推论（写入设计正文）**：

1. 模型上 `rejected` **必须携带原因**（`user` | `conflict`），并在 D13 的工具输出里如实反映。
2. **这条替换了 PoC 的现有行为**：PoC 是"跨边界编辑即 `stale` 并冻结动作"，现在改为"重新应用；成功则照常参与裁决，冲突则丢弃并标记原因"。`stale` 作为终态消失（D45 另立了"保留但内容是用户的"这一终态语义，**不复用 `stale` 一词**）。
3. 被丢弃的 hunk 必须在 UI 上**可见**（不能静默消失）。

### D20 — 异常终止语义（Q20）

**用户裁定**：**不做特殊处理**——已经产生的 changeset 对文件已经产生，与 turn 正常结束**完全一致**：可逐个裁决，也可 Accept All / Reject All。

### D21 — 第一阶段 DoD（Q21）

**用户裁定（更松）**：**在三个真实任务里用它完成 review 即可**。

AI 原先建议的"连续 10 个工作日唯一入口"与"接入第二个 harness 不改 Core"**降为非硬标准**（后者仍作为架构约束的证据保留）。

### D22 — 仓库与包结构（Q22）

**用户裁定**：**单包 + 目录分层 + lint 规则**（`core/` 不得 import `vscode`），将来再拆多包。

### D23 — 分发 / 版本 / 遥测 / 合规（Q23）

**用户裁定**：手动 VSIX + 有新版时提示；启动时检测 VS Code 版本，**不兼容则明确报错拒绝激活**；**零 telemetry**；vendored proposed d.ts 保留 MIT 版权头 + NOTICE 说明来源。

### D24 — Changes 视图形态（T3，用户给出的具体规格）

**用户裁定（原话转写）**：

- 轻量**文件列表**：每行形如 `foo.cs  +100 -80` / `bar.cs  +3 -5`。
- 点击某行 → document 区域跳转到该文件并显示审阅内容。
- 每行右侧 `√ / ×` 做**文件级** Accept / Reject。
- 悬停显示**常规 diff view 浮窗**，点击跳转到 document。
- 列表**最下方** Accept All / Reject All。
- **document 顶部区域**再加 Accept All / Reject All，以及 `< 1/10 >` 形式的"该文件共多少 hunk + 快速定位"。

**[AI 决定，可否决]** 由该规格推出的实现选择：

1. TreeView **没有页脚区域**，而规格要求"列表最下方"有按钮 ⇒ Changes 列表用 **webview view（侧边栏）** 实现，而不是原生 TreeView。代价：我们自维护一层 UI（主题、无障碍、本地化）。
2. document 顶部区域用**原生编辑器标题菜单**（`menus.editor/title`，稳定）+ 命令实现，hunk 计数写进命令标题。
3. **Accept 不产生任何文档编辑**（见 D26）；只有 Reject 路径需要 `WorkspaceEdit` 恢复 baseline，并借此保留原生 undo 栈。
4. 未裁决的 hunk **不阻塞**保存与提交。

### D25 — turn 中途干预（T4）

**用户裁定**：由 **Adapter 声明能力**（是否支持 steer / follow-up）并提供实现；**不支持则只提供"中断当前 turn"**；支持则额外提供"插话"入口。⇒ 能力差异显式化，不在 Core 里假设。

### D26 — Accept / Reject 的落盘语义（用户修正）

**用户裁定（原话）**："Accept 需要落盘？我理解文档应该已经被 agent 改为 accept 之后的状态了？"

**结论**：

1. agent 的修改**已经落到文档 / 磁盘**，因此 **Accept = 仅确认保留**，**不产生任何文档编辑**。
2. **Reject = 把文档恢复到 baseline**，这是唯一需要写盘的路径，用 `WorkspaceEdit` 落地以保留原生 undo 栈。
3. 用户在 new 侧改过文本时，Accept 采纳当前文本 —— 仍然不产生编辑。
4. **写盘策略见 D28**（原稿此处写的"必须立即 save"已被用户裁定覆盖为"一律立即保存"）。
5. **文件级操作同理**：agent 已经做了，Accept 无动作；Reject 用 baseline 快照反向恢复（删除 → 复原文件、新建 → 删除文件、rename → 反向重命名）。
6. **破坏性操作的前置快照**：必须在**批准**破坏性操作（delete / move）**之前**拍快照，否则 Reject 无法还原。
7. 本条**纠正**了此前 D6 与 D24 中"只有 Accept 才真正落盘删除"的错误表述。

### D27 — CLI Adapter 抽象与 adapter 能力声明（U1）

**用户裁定（原话）**："我觉得应该原生支持 acp 和 CLI adapter，因此需要完成 CLI adapter 的抽象，至于 adapter 谁来做目前先不关心。"

**背景事实**：Claude Code 与 Codex **均不原生支持 ACP**（分别靠 Zed 的 `claude-agent-acp` 与 ACP 官方组织的 `codex-acp` 桥接）；Gemini CLI 原生；Copilot 预览中。另有 **ACP Registry**（2026-03-09 稳定）作为官方 curated 索引，可作 harness 发现与安装入口。

**推论**：

1. Core 的 adapter 接口必须**同时**覆盖 ACP 与 CLI 两类，且**不得假设**任何 harness 具备某项能力。每个 adapter 必须声明能力：
   `session.resume / session.list` · `permission.request` · `diff.declared`（能否提供归因）· `config.options` · `mcp.injection` · `steer` / `followUp`。
2. **降级规则**（禁止假装可用）：
   - `diff.declared = false`（典型 CLI adapter）⇒ 该 harness **没有可审阅内容**，review 门为空，**权限门是唯一闸门**；UI 必须明说。
   - `permission.request = false` ⇒ 破坏性操作无前置闸门，UI 必须明示。
   - `mcp.injection = false` ⇒ 能力层与反馈回路对该 harness 不可用。
   - `steer/followUp = false` ⇒ 只提供"中断当前 turn"（与 D25 一致）。
3. **一期只实现 ACP adapter**（D7 / D21）；CLI adapter 只交付**抽象**，不交付具体实现。
4. 具体 adapter 由谁实现，**当前不关心**（用户原话）。

### D28 — 写盘策略（U2，覆盖 D26 第 4 条）

**用户裁定**：**一律立即保存**——IDE 对文档的任何修改（agent 写入、Reject 还原）都立即 `save`。

**代价（必须写进设计正文）**：若用户在该文件中本来有未保存的改动，这些改动会被一并提交，用户可能并未打算保存。这是明确接受的取舍。

**附注（事实）**：一致性其实不依赖保存——ACP 的 `fs/read_text_file` 会连同未保存状态一起返回。选择"一律保存"是为了让**磁盘与 agent 的认知始终一致**，而不是出于技术必要性。

### D29 — 回退到第 N 轮（W1 / W2 / W3）

**用户裁定**：

- 回退到第 N 轮时，第 N+1 轮及之后**直接丢弃，不留档**。
- 抓回输入框**只恢复 prompt 文本**（原话："正因为回退后指针引用的内容很可能已经失效，所以只能把文本 prompt 恢复，其他都丢弃"）。
- **回退与 fork 是两个独立动作**：**回退动文件**，**fork 不动文件**。

**推论（连带，待用户确认）**：W1 的"不留档"与 D15 的"IDE 全量只读副本"存在张力 ⇒ 回退必须**同时删除 IDE 副本中对应区段**，否则"丢弃"只是假象。

**两个面（会话侧机制待事实确认）**：

1. **文件侧**：逐轮按 changeset 反向还原——台账、baseline、归因都在 IDE 手里（D5 / D8 已具备），**不依赖 harness**。
2. **会话侧**：若 harness 自带回退则用之，否则需要降级方案（事实查证中）。

### D30 — Session fork（W3）

**用户裁定**：fork 是与回退**独立**的动作，**文件不动**，从第 N 轮分叉出新会话。

**事实**：ACP 实测 OMP 在 `initialize` 中广告 `sessionCapabilities.fork`；具体语义（能否指定分叉点、继承什么）查证中。

### D31 — 上下文占用与手动压缩（W4）

**用户裁定**：入口是**会话面板底部的细状态条**（已用 / 上限 + 一键压缩 + fork / 回退入口）。

**待事实**：占用数据的来源（ACP `usage_update`？RPC `get_session_stats`？）与手动压缩的调用方式。

### D32 — 架构立场：抽象优先（G1，**覆盖 D7 的"ACP 为脊"表述**）

**用户裁定**：**抽象优先，ACP 只是一种实现。**

- Core 只定义**会话 / 轮次 / 变更 / 能力 / 权限 / 用量 / 分支**的抽象与**能力声明**。
- **adapter 自行决定底层通道**（ACP、CLI/RPC、SDK，乃至组合），并对不支持的项**如实降级**。
- ACP 从"脊"降级为"**覆盖面最广的一份实现**"（它的价值是可移植性，不是能力上限）。
- D7 的其余部分不变，尤其是 **(e)**：把 AHP 的数据模型当 Core 的对齐目标。

**用户原话（动机）**："这种 acp 协议没定义的功能应该由 adapter 进行实现。"

**事实支撑**：ACP 里根本没有 revert / rollback / branch / steer（v1 稳定与 v2 draft 全文零命中），这些都是 harness 原生能力，只能由 adapter 用各自通道去够。

### D33 — 回退 / 分叉 / 压缩 / 用量的落地方案（F1 / F2 + 事实）

**用户裁定**：这四件事**全部由 adapter 负责实现**；明确要求"**可以以任意一个 message 做 fork**"。

**事实与由此确定的实现路径**：

1. **文件回退**：OMP 自己不提供任何文件快照与回退（`checkpoint`/`rewind` 只折叠上下文，文档逐字说明它 *不调 git、不拍文件系统快照*；文件回滚只有 git 级操作）⇒ **文件回退必须由 AgentDock 的 changeset 台账逐轮反向还原**（D5 / D8 已具备地基）。**任何 harness 都帮不上**。
2. **会话侧回退 / 任意 message 分叉**：ACP 无此能力 ⇒ 由 adapter 走 harness 原生通道。对 OMP 对应 `branch(entryId)`——它**只接受 user message**，恰好匹配"以任意一个 message 做 fork"；但**只暴露在 RPC 与 TUI**，ACP 侧只有整会话的 `session/fork`（UNSTABLE 方法）。
3. **压缩**：ACP 可触发——OMP 把 `compact` 放进 available commands，客户端以 `session/prompt` 文本 `/compact [mode] [focus]` 调用（ACP 无专用方法）。
4. **上下文用量**：ACP 仅在**每轮结束**推一次 `usage_update{size,used,cost}`；RPC 的 `get_session_stats` 提供全量（tokens 分类 / cost / `contextUsage.percent`）。

5. ~~**通道配置待定**~~ **→ 由 D34 结清**：用户原话是"**等可行性结论再定**"，结论已到（D34）：两条通道**不能在同一进程共存**（mode 互斥、各自独占 stdio），且**双进程驱动同一会话会撞 `SessionWriteConflictError`** ⇒ **一期 RPC 单通道**。

### D34 — OMP adapter 的通道选择（H1）

**用户裁定**：**一期 RPC 单通道** —— OMP adapter 直接走 `omp --mode rpc`。

**事实依据**（见 `facts.md` §12）：

1. 对 OMP 而言 ACP 与 RPC **不可能在同一进程共存**（mode 互斥、各自独占 stdio，`rpc-ui` 不是双通道）。
2. **双进程并发驱动同一会话不受支持**：两个进程可以 attach 同一个会话文件，但写入按 per-write 锁串行，后写者会撞 `SessionWriteConflictError`。⇒ "ACP 主 + RPC 补"的组合方案不成立。
3. **RPC 在能力上几乎是 ACP 的超集**：`branch(entryId)`（任意 user message 分叉）、`steer` / `follow_up`、`compact` / `set_auto_compaction`、`get_session_stats`（全量用量）、`get_messages_page`、`set_host_tools` / `set_host_uri_schemes`。
4. **唯一实质让步**：审批退化为通用扩展 UI 帧（`extension_ui_request` → `select ["Approve","Deny"]`），**没有** ACP 那套 `allow_once / allow_always / reject_once / reject_always` 的类型化选项。这与 D9 一致——权限真相本就在 harness 自己手里，IDE 只做转接。
5. **额外收益**：`set_host_tools` 可**随时增删改工具**，因此 **D13 里"能力 server 集合在会话创建后不可变"的硬约束只对 ACP 通道成立**；RPC 通道没有这个限制。
6. 代价：RPC 是 OMP 的私有接口，随 OMP 版本变动。

**受 H1 影响的既定决策（语义不变，实现层改写）**：

| 决策 | 影响 |
| --- | --- |
| D7 / D32 | ACP 不再是首个实现；它的定位是"**可移植性 + 第二个 harness**"，推到 M2（此时才真正被需要） |
| D13 | "tool 只在该出现时出现"在 RPC 下用 `set_host_tools` 动态注册（比 MCP 更直接）；MCP 路径留给 ACP adapter |
| D17 | ⚠️ **已重新推导（可行，但带保真度上限）**：原设计建立在 ACP `terminal/create`（终端由客户端创建，因此可完整 tee）之上；RPC 下 agent 的 shell 跑在 OMP 进程内，我们拿不到那个终端。替代路径已由 `facts.md` §12 证实：`tool_execution_update.partialResult` 是**约 50ms 节流的尾部快照**（够做实时视图），而**完整原始流由 OMP 写在会话 artifacts 目录的文件里**（事件内联文本受 `artifactSpillThreshold` 默认 50 KB 限制，超出只给头尾采样并以 `[raw output: artifact://N]` 指路）⇒ **"agent 终端视图"改为读 artifact 文件**，不依赖事件文本完整性。残留未核：artifact 目录路径的获取方式 |
| D10 / D12 | 能力层的**传输由 adapter 决定**：OMP-RPC 走 host tools，ACP 走 MCP server；Core 只定义能力本身 |
| D25 | RPC adapter 声明 `steer = true`，因此"插话"入口在一期即可出现 |
| D31 | 用量走 `get_session_stats`（全量），而非 ACP 的每轮 `usage_update` |

### D35 — RPC 驱动面的实测约束与由此推出的实现选择

**事实**（见 `facts.md` §13）：

1. **审批默认关闭**：`tools.approvalMode` 的 schema 默认是 **`yolo`** ⇒ 不配置就**没有任何停顿**；开启了才是阻塞式的 `Approve/Deny` 往返。
2. **shell 输出的真实形态**：事件与历史里的文本**有 50 KB 内联上限**（超出只给头尾采样）；**完整原始流写在会话 artifacts 目录的文件里**，事件里以 `[raw output: artifact://N]` 指路；`tool_execution_update.partialResult` 提供约 50ms 节流的尾部快照。`stdout`/`stderr` 合并为一条流。
3. **写入前 baseline 的窗口**：`tool_execution_start.args` 已含目标路径（`write.path` / `edit` targets / `ast_edit.paths[]` / `bash.command`），且 start 先于工具体执行——**但只有开启审批才会被真正阻塞**，否则存在竞态。
4. `branch` **不返回新会话 id**（随后用 `get_state` 取）；`switch_session` 按**文件路径**寻址；RPC **不提供文件读取，也没有 cwd**。

**[AI 决定，可否决] 由 H1 推出的实现选择**：

1. **D17 的终端日志改为"引用 artifact"**：不再需要（也不可能）tee 一个客户端终端；**pill 给 agent 的是工具输出 artifact 的真实文件路径**，agent 自己读；UI 用 `partialResult` 做流式显示。这比原设计更干净——引用的是一个真实存在的文件。
2. **baseline 三级策略**：① 收到 `tool_execution_start` 时按 args 里的路径**抢拍快照**；② 竞态（抢拍晚于写入）时用**工具结果里的 `oldText` 前像**补齐；③ 两者都不可得 ⇒ 该 hunk 标为**不可还原**并在 UI 明示（不假装能 Reject）。
3. **审批默认关闭必须写进首次运行引导与后果声明**：IDE 引导用户选择 approval mode，但**不替 harness 决定**（D9）。

### D36 — OMP 集成方式：SDK + 复用现有 Bun（I1）

**用户裁定**：**一期用 OMP 的 SDK 做 in-process 集成，复用用户已装的 Bun**（不在一期自编译 / 分发二进制）。**覆盖 D34 的"RPC 单通道"。**

**事实前提**（官方文档，`omp://sdk.md`）：

- SDK 是官方定义的 **in-process 集成面**。原文："The SDK is the **in-process** integration surface… Use it when you want direct access to agent state, event streaming, tool wiring, and session control **from a Bun process**. If you need cross-language/process isolation, use RPC mode instead." 并注明 "**Requires Bun 1.3.14 or newer**"。
- **VS Code 扩展宿主是 Node 进程** ⇒ 即便走 SDK 也**必须有一个 Bun 进程**。因此 OMP adapter 的形态是：**扩展 ↔ 我们自己的 Bun sidecar（自有 IPC）↔ SDK**。与 RPC 的本质区别是：**边界是我们自己的脚本**，而不是 OMP 的 CLI 契约。

**SDK 相对 RPC 的实质增量**：

- `setToolUIContext(uiContext, hasUI)` —— **审批与工具 UI 的正规入口**（不再是 RPC 那个通用 `Approve/Deny` 帧）。
- `customTools` + `setActiveToolsByName` + `refreshMCPTools` —— **动态工具集**，直接支撑 D13 的"条件式自描述工具"。
- `session.subscribe` 全事件流（含 `agent_end.isTerminal` 的**真正完成**语义，与 D2 的 turn 边界定义一致）。
- `steer` / `followUp` / `deliverAs: "aside"`（D25）。
- `SessionManager`（resume / open / list / fork）与 `Settings.isolated`。
- **`AuthStorage` / `ModelRegistry` 由我们掌控** —— 正是 D16 要的凭据与模型生命周期。

**代价**：

1. 深耦合一个**高速演进的非公开 API**（repo 约 2.4 万次提交）。
2. **用户侧多一个运行时前提**：需要 Bun（OMP 用户通常已有）。

**连带影响**：

| 决策 | 影响 |
| --- | --- |
| D34 / D35 | RPC 通道不再是一期路径；D35 的"三级 baseline 策略"是否简化，取决于 `registerFileWriteFallback` 能否让**宿主自己执行写入**（待 `OmpSdkSurface` 结论） |
| D17 | 终端捕获可能回到"**我们拥有终端**"的形态，取决于 UI context 是否包含终端创建（待结论） |
| D13 | 动态工具改走 `customTools` / `setActiveToolsByName`；MCP 路径只留给 ACP adapter |
| D23 | 分发阶段新增：**Bun 的发现 / 版本校验 / 引导**（或未来自编译） |
| D23 | 锁定 `@oh-my-pi/pi-coding-agent` 版本；sidecar 上报版本，不匹配则明确拒绝运行 |

### D37 — SDK 通道的实测修正（D36 的补充）

**事实**（见 `facts.md` §14）：

1. **Bun 是硬性前提**（`engines` 只有 `bun`、入口是裸 `.ts`、依赖图直接 import `bun` / `bun:sqlite` / `bun:ffi` / `bun:jsc`）⇒ **Node 扩展宿主不可能 import SDK**，sidecar 或编译产物是**必需**而非选择。D36 的形态判断成立。
2. **写所有权的答案与预期相反**：`registerFileWriteFallback` **只是沙箱 `EPERM` 时的回退，写入者仍是 agent**；**真正的写所有权来自用 `customTools` 遮蔽 `write` / `edit`**（`sdk.ts:2942`）——IDE 自己执行字节写入。
   ⇒ **D35 的三级 baseline 策略塌缩为一级**：只要遮蔽生效，baseline 就是**精确且无竞态**的。三级策略只保留给未遮蔽路径（bash 内的 `sed -i` / `git apply`），而按 D8 它们本来就不入 ChangeSet。**[D42 修正]** `ast_edit` 不再是"未遮蔽路径"——它是**内置文件变更工具**，按 T1 必须精确归因（`customTools` + `ctx.invokeTool` 通用包裹）。
3. **审批并不更强**：SDK 与 RPC 的审批是同一个硬编码 `uiContext.select([...])`。D34 中"审批退化为通用帧"这句对 SDK 通道**同样成立**；D36 里把 `setToolUIContext` 计为优势的说法**作废**。
4. **打包成本高**：`bun build --compile` 可行，但 ~48 MB 二进制 + 171 MB 原生插件 ⇒ **一期"复用用户已装的 Bun"是正确的取舍**。
5. **版本漂移真实存在**：本机 18.2.1 vs npm 最新 18.2.5。

**[AI 决定，可否决]** 由此确定的实现要点：

- OMP adapter 的 sidecar **必须注册自己的 `write` / `edit` 工具实现**，把字节写入握在手里——这是 baseline 精确性的唯一来源。
- bash 类改动与脚本/程序产物**不在归因范围**（D8；**[D42 修正]** shell 降为 best effort，而 `ast_edit` 升入 **T1 必须精确归因**——它不再属于"未归因"），UI 如实呈现为"未归因改动不可审阅"。
- 版本闸门：sidecar 启动时上报 `@oh-my-pi/pi-coding-agent` 与 Bun 版本，不满足则**明确拒绝运行**（而不是半坏）。

### D38 — Adapter 形态分类与泛化顺序（U 系列问题的沉淀）

**用户问题**："还有哪些 harness 可以通过 SDK 这种方式实现？Codex 和 Claude Code 支持吗？"

**结论**（事实见 `facts.md` §15）：

1. **adapter 的形态由 harness 提供什么决定，而不是由协议决定**，共三档：
   - **进程内 SDK**（库即 agent loop）⇒ 需要与 harness 相同的运行时 ⇒ **必须 sidecar**。代表：OMP（Bun）。
   - **包装型 SDK**（库驱动自家 CLI 子进程）⇒ **Node 18+ 扩展宿主直接可用，无需额外运行时**。代表：**Claude Code、Codex、GitHub Copilot CLI**。
   - **只有协议（ACP）** ⇒ 协议客户端即可。代表：Gemini CLI（原生）、Goose、Cursor、OpenCode…；Claude Code / Codex 另有 ACP 桥作为第二条路。
2. **是的——Claude Code 与 Codex 都有官方 SDK，而且都比 OMP 好接**：包装型、Node 原生、控制面更丰富（权限、hooks、会话 `resume or fork`）。
3. 三条必须写进文档的负面事实：**Claude Agent SDK 是 Anthropic 商业条款（非开源）、自述会收集使用数据、有品牌限制**；Codex SDK 依赖 `codex` CLI 且默认要求 git 仓库；二者都**不提供"IDE 拥有文件写入"**（写仍由 harness 自己做），所以 baseline 精确性这条优势**只有 OMP 的 `customTools` 遮蔽路能拿到**。
4. **[AI 决定，可否决] 阶段 8 的泛化顺序按 adapter 成本排序**：先做**包装型 SDK** 的三个（Claude Code / Codex / Copilot CLI），再做 **ACP adapter**，最后才考虑 CLI 解析型。理由：包装型 SDK 比 ACP 更便宜且控制面更强，且覆盖使用量最大的两个 harness——"接入第二个 harness 不改 Core"这条验证优先在这里做。

### D39 — baseline 保真度阶梯（D37 的修正）

**触发**：用户追问"其他带 SDK 的都不带读写事件通知吗？如果有的话理论上应该是有办法的？"

**事实**（见 `facts.md` §15 的"写入拦截能力"与阶梯表）：**不止有，而且比预期强**——

- **Claude Code** 的 `PreToolUse` 钩子**默认阻塞**（*"the agent waits for your hook to return before proceeding"*），且 *"hooks run before every other step, and a hook deny applies even in `bypassPermissions` mode"*；还能用 **`updatedInput`** 改写工具参数。
- **Copilot SDK** 的 **permission handler** 可 approve / deny / customize 工具调用（阻塞）。
- **Codex** 的 app-server 把 **approvals** 列为职责之一（细节待核实）。

**修正**：D37 / §5.1 里用**布尔值** `write.ownership` 描述这件事是**错的模型**。正确模型是**保真度阶梯**（`write.intercept`）：

`own`（我们执行写入，精确）→ `blocking-hook`（写入前阻塞式钩子，精确）→ `async-signal`（写入前但不等我们，有竞态）→ `post-hoc`（写入后通知 + 声明 diff，依赖声明）→ `none`（不可审阅）。

**结论**：

1. **`own` 与 `blocking-hook` 都能给出精确 baseline**——所以"IDE 拥有写所有权"不是精确性的必要条件，我在 D37 里把它当成唯一来源是**过度收敛**。
2. 对一期（OMP）**仍然选 `own`**（`customTools` 遮蔽 `write`/`edit`）：它**不依赖审批被开启**，而 OMP 的审批默认是 `yolo`（D35）——`blocking-hook` 在默认配置下根本不会触发。
3. 将来的 adapter 按阶梯如实声明 `write.intercept` 级别；**UI 必须按级别说明可还原性**，不能让用户以为 Revert 到处都逐字节可靠。
4. Codex app-server 的 `generate-ts` / `generate-json-schema` 能产出**与当前版本完全一致的 schema** ⇒ 这是对"私有 API 版本漂移"的现成缓解手段，接入 Codex 时应优先用 app-server 而非 wrapper SDK。

### D40 — OMP 的拦截粒度（用户追问"非工具写入能否同样拦"）

**用户问题**："所以对于 omp 是不是也有 hook，可以对没调用读写工具的其他方式写入进行同样的拦截机制？"

**事实**（见 `facts.md` §16）：

1. **有等价的 `tool_call` 钩子**：**执行前**触发、可 `{ block: true }` 阻止（handler 抛错亦 fail-closed）、**可 `input` 改写执行参数**，且改写会被重新校验、并被审批门看到；覆盖**所有**工具（含内置与扩展工具）。
2. **但粒度是"工具"**：`bash` 只有不透明的 `command` 字符串 ⇒ **可整体拦、不可事前归因**。
3. **`registerFileWriteFallback` 不是拦截点**（仅 `EPERM`/`EACCES`/`EROFS` 时咨询），官方明说它 *"deliberately not an interception of every write"*，够不到 archive / SQLite / ACP bridge / lsp+formatter 的子进程写入。
4. **OMP 无文件系统沙箱**；要用"沙箱 + fallback"逼所有写入经过我们，得**我们自己在宿主侧造沙箱**，且例外仍漏。

**结论**：

- **D8 的边界成立**：非工具写入（`sed -i` / `git apply` / formatter 子进程）**事前不可归因**，只能标为"未归因变化"。**[D41 / D42 修正]** 其中"简单形态的 shell 写入"后被提升为 best effort（T2），脚本与程序产物仍是 T3。
- **"可拦"与"可归因"必须分开说**：`tool_call` 能给的是一道**粗粒度安全闸**（整条 bash 命令批准/拒绝），它**不是**归因手段。混为一谈会让 UI 给出错误承诺。
- 沙箱路线（迫使所有字节写入经 `registerFileWriteFallback`）**代价大且不完整**，不建议在一期考虑。

### D41 — 用命令行解析尽量归因（Z1 的用户修正）

**用户裁定（原话）**："不是要拦截和审批，而是**通过解析命令行参数获取修改意图来尽可能归因**，**无法可靠归因的直接跳过**。"

**这修正了 D40 的落点**：不把 `tool_call` 当安全闸，而是把它当作**事前的"意图声明"来源**。因为 `tool_call` **在执行前**触发且带 `event.input.command`，我们可以在命令真正跑起来之前：

1. 解析命令行，得出**它将要修改的路径集合**（仅在能可靠解析时）；
2. 对这些路径**抢拍 baseline**（于是也是精确的）；
3. 命令结束后**核对实际变化** —— 变了才入 ChangeSet 并归因，否则丢弃。

**设计规则（必须保守）**：

- **宁可漏，不可错**：错误归因会导致 Reject 把**不属于 agent 的改动**复原（数据损坏）。解析不出、多解、或涉及无法静态判定的路径（变量、子 shell、脚本文件、`make` / `npm run` 这类间接入口）⇒ **整条跳过**：不入 ChangeSet、不拍快照、不留半成品记录。
- 这层是**纯函数**（`command → { paths, confidence }`），**宿主无关、可单测**，属于 **Core** 而不是 adapter。
- **不改变安全模型**：不拦截、不审批、不阻断（与 D9 一致——权限真相在 harness）。**"可拦"与"可归因"始终分开表述。**
- **D8 的边界不变**：这层只是把"能可靠归因的 bash 改动"从"一律跳过"提升为"有时能看见"；脚本内部写入、formatter 子进程等仍按未归因处理。**[D42 修正]** `ast_edit` 不在其中——它是内置文件变更工具，属 **T1**，必须精确归因。

**[AI 决定，可否决]** 首批只支持**简单形态**：单命令 + 字面量路径参数（`sed -i`、`rm`、`mv`、`cp`、`touch`、重定向 `>` / `>>`、`tee`）。凡含 `&&` / `||` / 管道 / `$( )` / 反引号 / 变量展开 / 脚本文件，一律判为**不可靠**。**方言维度见 D43**（`bash` / `PowerShell` / `cmd` 各一份规则，方言在运行期由 adapter 提供）。

### D42 — 归因的三层政策（Z1 用户定稿）

**用户裁定（原话）**："best effort 就行，然后 adapter 中需要对该 harness **内置的文件读写 tool 调用做准确的归因处理**，shell 的 best effort 就行，**用脚本或通过用户程序生成的文件就不做任何归因**，原则就是尽量把 agent 的修改意图捕捉，**harness 的内置读写工具则要求完全准确归因**。"

| 层 | 对象 | 要求 | 失败时 |
| --- | --- | --- | --- |
| **T1** | **harness 内置的文件变更工具**（`write` / `edit` / `apply_patch` / `ast_edit` …） | **完全准确归因**——硬要求，落在 **adapter 契约**里 | adapter 做不到 ⇒ 必须按 `diff.declared` / `write.intercept` 如实降级，**UI 明确说明该 harness 的 review 不完整**；不允许假装 |
| **T2** | **shell / bash** | **best effort**：命令执行前从 `input.command` 解析将修改的路径，能可靠解析才抢拍 baseline 并归因 | 解析不出 / 多解 / 间接入口 ⇒ **整条跳过**（D41） |
| **T3** | **脚本或用户程序生成的文件**（脚本内部写入、formatter 子进程、`make` / `npm run` 的产物） | **不做任何归因** | 直接跳过：不入 ChangeSet、不拍快照 |

**对 OMP 的实现（修正 D37 的过度收敛）**：

- D37 只遮蔽 `write` / `edit`，把 `ast_edit` 排除在外；按 T1 的硬要求，**`ast_edit` / `apply_patch` 等内置文件变更工具同样必须精确归因**。
- 手段：用 `customTools` **按名字包裹全部内置文件变更工具**，在包裹实现里用 **`ctx.invokeTool` 委托给原生工具**（官方支持"重注册内置名字后 `ctx.invokeTool` 跑原生实现"）——**不重写任何工具语义**，只在前后拍快照并归因。是**一个通用 wrapper**，不是每个工具写一遍。

**[AI 解读，可否决]** "读写工具"里的**读**不产生变更，因此**不进 ChangeSet**；"agent 读过什么"属于 activity 展示，**当前不做**。

### D43 — T2 的方言支持（bash / PowerShell / cmd）与实测方言

**用户裁定**：**`bash`、`PowerShell`、`cmd` 三个方言都要支持**。

**实测（源码）**：**OMP 的 `bash` 工具是 POSIX 设计**——Windows 上走 **Git Bash / `bash.exe`**，`cmd.exe /c` 只是"没有 bash 时的 spawn 兜底"（`src/tools/bash.ts:145-152` 逐字：*"Git Bash / `bash.exe` on Windows (`cmd.exe /c` as the last-resort fallback when no bash exists on the host)"*；另见 `src/exec/bash-executor.ts:502-503` 的 *"Never wrap in cmd.exe…"*）。工具语义按 POSIX（`$VAR` / `$(...)` / `source` / POSIX quoting / `-l`）。

**但同一份代码里有 `isCmdShell` 分支**（无 bash 时的兜底）⇒ **方言是运行期事实，不是编译期常量**：同一个 harness 在不同宿主上方言可能不同。（检索范围限 `src/exec/*` 与 `src/tools/bash.ts`，其中**未见 PowerShell 分支**；不排除包内他处有。）这直接强化了下面的第 1 条：**方言必须由 adapter 在运行期提供，不能写死、也不能从命令文本猜**。

**[AI 决定，可否决] 解析规则**：

1. **方言由 adapter 运行期提供**（它知道自己的 shell 工具用哪个），**不从命令文本猜**；
2. 方言无法确定 ⇒ **整条跳过**（宁可漏不可错，与 D41 一致）；
3. Core 里的解析器做成**多方言注册表**（`bash` / `powershell` / `cmd` 各一份），共用同一个 `{ paths, confidence }` 契约；
4. **设备名与特殊目标不算路径**：`nul` / `con` / `prn` / `aux` / `com1..9` / `lpt1..9` / `/dev/null` 等出现在参数或重定向目标位置时**必须跳过**，否则 ChangeSet 里会凭空多出一个文件条目。（`cmd` 的 `>nul` 是常规写法，不是边角情形。）

**可复用（已核实）**：**OMP 自带一个 POSIX 命令分词器** `src/tools/shell-tokenize.ts`（`tokenizeShellSegments` 处理 `;` / `&&` / `||` / `|` / `&` / 子 shell / 换行；另有 `extractLiteralAndChainSegments`、`extractLeadingCdTarget`），服务于它自己的 bash 审批分段。**它是公开子路径、可导入**：`package.json` 的 `exports` 有 `"./tools/*": { import: "./src/tools/*.ts" }`，`files` 含 `src`，且模块是扁平文件 `src/tools/shell-tokenize.ts` ⇒ `import { tokenizeShellSegments } from "@oh-my-pi/pi-coding-agent/tools/shell-tokenize"` 可用。**T2 的 bash 分段规则应与它一致**，否则同一条命令我们会与 harness 自己得出不同结论；可作为**差分测试的对照实现**。注意：**Core 不能依赖它**（Core 宿主无关），它只能落在 OMP adapter 侧或被当作测试 oracle。

### D44 — 三个包装型 harness 的实测归位（"有 SDK" ≠ "能力够"）

**取证**：两个 scout 直读官方源码与文档（2026-09-18），明细见 `facts.md` §15。

| harness | 该用哪条通道 | 保真度 | 能否改写输入 |
| --- | --- | --- | --- |
| Claude Code | `@anthropic-ai/claude-agent-sdk` 的 `PreToolUse` 钩子 | **L2** | 能（`updatedInput`） |
| Copilot CLI | `@github/copilot-sdk` 的 **`onPreToolUse`**（改写）+ `onPermissionRequest`（审批） | **L2** | 能（`modifiedArgs`） |
| Codex | **`codex app-server`**，**不是** `@openai/codex-sdk` | **L2−** | 不能（只有 accept / decline） |

**两处必须记住的坑**：

1. **"有 SDK" ≠ "能力够"**：`@openai/codex-sdk` 只是 `codex exec --experimental-json` 的**薄壳**，没有审批回调；`FileChangeItem` 只给 `path` + `kind`、**连 diff 都没有**，且 patch 成败**之后**才发 ⇒ 走 SDK 是 **L4**（比 ACP 通道还差）。要 L2 必须上 app-server。**D38 里"包装型 SDK 的控制面比 ACP 更强"这句话对 Codex 不成立**。
2. **参数改写与审批是两层**：Copilot README 那句 *"approve, deny, or customize tool calls"* 里的 **customize 指的是"启停工具"**（下一句自己限定了）；真正的改写是 `onPreToolUse` 的 `modifiedArgs`，而 `onPermissionRequest` 的结果类型里**没有任何 args 字段**。**不能把"能改写"记在 permission handler 头上。**

**两条新增的产品级事实**：

- **Copilot 是 deny-by-default，且未注册 handler 时请求会 *"left pending"*** ⇒ adapter **必须无条件注册** handler（哪怕策略是自动放行），否则 agent 静默挂住、用户只看到"没反应"。这条要写进能力声明。
- **Copilot SDK 要求 Node `^20.19.0 || >=22.12.0`**（Node 18 不支持）⇒ D38"Node 18+ 原生"的表述**作废**；若 VS Code 宿主的 Node 不满足，退路是让它 spawn 自带的 CLI 进程（同样是 JSON-RPC），而不是作为库 import。**旁证**：VS Code 1.138 的 `product.json` 自己就 pin 了 `copilotVersions.sdk = 1.0.13` 与 `agentSdk.codex = 0.153.0`（见 `facts.md` §15），说明平台侧跑得动这批 SDK，但**扩展宿主进程能否直接 import 仍未实测**。

**阶梯补一档**：`blocking-hook` 与"阻塞但不能改写"是两件事 ⇒ 新增 **L2−**（`facts.md` §15）。对我们而言二者**等价可用**——我们只需要"写入前精确快照"，从来不需要改写输入。

### D45 — "保留，但内容是你的"必须能被识别并回传（用户修正 D19 的终态集合）

**用户裁定（原话要点）**："如果用户对 added/new 文本进行了修改，但是没有点 accept，我感觉是 pending；但后期实行文件级别或者全局 Accept all 时、或者单独点 accept 后，实际应该是 stale，并且下一轮是要让 agent aware 的内容。" 后续裁定：**用 `accepted` + `userEdited` 表达，不新增状态值。**

**结论**：

1. 未裁决时保持 `pending`——"用户改过 new 侧"只是一个标记，不是状态迁移。
2. 裁决之后，**同一个标记换个含义**：`accepted` + 用户改过 ＝ 保留的是**用户的文本**，不是 agent 写的。这是**第三个终态语义**，与 `accepted`（保留 agent 原文）、`rejected(user)`、`rejected(conflict)` 并列。
3. **不新增状态值**：状态机仍是 `pending | accepted | rejected(reason)`；区分由 `userEdited` 承担，并由模型显式命名（`hunkKeepsUserText`），以免它退回成"没人读的布尔量"。
4. **它必须回传**：这是 D3.3"agent 需要知道上一轮用户修改了哪些"的落地方式。D13 的条件式工具据此注册，且**只报状态标签不算 aware**——要按 hunk 给出区域、agent 当初写的文本、该区域当前文本。
5. **文件级 / Accept All 必须逐 hunk 分流并汇总**（例如"3 处按你的文本保留"），否则一次 Accept All 就把这件事抹平。
6. **回退的连带后果**：`revertTo` 逐字节回写该轮 baseline，会盖掉这些"按你的文本保留"的区域 ⇒ 含此类 hunk 的轮次在回退前必须警告。
7. 标记的精度上限：它记录"一次非 agent 的编辑落在 new 侧内"，不保证那些字节此刻仍在——"是否还在"由第 4 条的文本比对回答。裁决**之后**的继续编辑不改变终态（与 D3.4 一致：pending / accepted 不做特殊记忆）。

**与 D19 的关系**：D19 取消的 `stale` 是 PoC 的**冻结终态**（跨边界编辑后动作全禁，用户既不能 accept 也不能 reject）；本条要的是**裁决产生的终态**，不禁用任何动作。二者不是同一件事，**`stale` 一词维持 D19 的取消**，不再复用。

---

## 二、问题台账（Q6–Q23、R1–R4、T1–T5、U1–U2、W1–W4、F1–F2、G1–G2、H1、I1、Z1–Z2）

| # | 问题 | 结论 |
| --- | --- | --- |
| Q6 | Adapter 战略 | D7 |
| Q7 | ChangeSet 归因边界 | D8 |
| Q8 | 能力层词汇与协商 | D10 |
| Q9 | 权限与审批归属 | D9 |
| Q10 | 跨轮反馈通道 | D13 |
| Q11 | 渲染轨与分发 | D11 |
| Q12 | 阶段重心 | D12 |
| Q13 | 拉取的发现机制 | D13 |
| Q14 | 输入入口 / UI 边界 | D14 |
| Q15 | 会话记录归属 | D15 |
| Q16 | provider / model / credential | D16 |
| Q17 | prompt 上下文 | D17 |
| Q18 | 并发范围与 harness 绑定 | D18 |
| Q19 | 外部修改与冲突 | D19 |
| Q20 | 异常终止 | D20 |
| Q21 | 第一阶段 DoD | D21 |
| Q22 | 仓库与包结构 | D22 |
| Q23 | 分发 / 版本 / 遥测 / 合规 | D23 |
| R1 | 会话副本的真相 | D15 |
| R2 | 偏好真相与凭据 | D16 |
| R3 | 重应用与冲突 | D19 |
| R4 | pill 的语义 | D17 |
| T1 | 凭据通道 | D16 |
| T2 | 终端捕获范围 | D17 |
| T3 | Changes 视图形态 | D24 |
| T4 | turn 中途干预 | D25 |
| T5 | 未归因变动与冲突归属 | D19 |
| U1 | 无 ACP 的 harness | D27 |
| U2 | 写盘时机 | D28 |
| W1 | 回退后历史处置 | D29 |
| W2 | prompt 抓回完整度 | D29 |
| W3 | 回退与 fork 的关系 | D29 / D30 |
| W4 | 状态与压缩入口 | D31 |
| F1 | fork 的粒度 | D32 / D33 |
| F2 | 会话侧回退的降级 | D33 |
| G1 | 架构立场 | D32 |
| G2 | 一期通道取舍 | **D34（RPC 单通道）** |
| H1 | OMP adapter 通道 | **D34**（已被 D36 覆盖） |
| I1 | OMP 集成方式 | **D36（SDK + 复用现有 Bun）** |
| Z1 | 非工具写入的处理 | **D41 / D42（三层归因政策）** |
| Z2 | 包装型 harness 该走哪条通道 | **D44（Codex 必须走 app-server；SDK 只是壳）** |

## 三、AI 自行决定、须知会用户的其余事项（写进设计正文）

- [AI 决定，可否决] harness 的选择入口：设置 + 面板内的选择器；选择只发生在**新建 session 且尚未发送第一条 prompt**时（D18）。
- [AI 决定，可否决] 首次运行引导（发现 harness → 检测版本 → 凭据配置 → 建 session）的流程，须满足 D16 的"用户只操作 IDE"；harness 的来源可包括 **ACP Registry**（官方 curated 索引，含认证校验）。
- [AI 决定，可否决] 本地隐私**不单独处理**（用户裁定：本就是本地文件，且 harness 自己的 session 信息里也会有）。
- [AI 决定，可否决] 产品名 / 扩展 id / 包名的最终形态。
