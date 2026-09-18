# AgentDock 产品设计

> v1 · 2026-09-18。**证据**见 `reference/facts.md`；**每条决策的裁定人与理由**见 `reference/decisions.md`（D1–D44）；**实现步骤**见 `02-implementation-plan.md`。
> 本文是产品行为的规范来源；与决策台账冲突时以后者为准（台账更靠近用户原话）。

## 1. 一句话

**把 IDE 变成 agent 的宿主环境**：IDE 拥有体验、能力、审阅、策略与偏好；harness 拥有 agent loop、模型、provider、上下文、工具与运行时；adapter 负责两者之间的翻译。

它**不是**：一个新的 AI IDE、某个 harness 的插件、也不是模型网关。

## 2. 边界

| 归 IDE（Core + VS Code 宿主） | 归 Harness | 归 Adapter |
| --- | --- | --- |
| 会话 / 轮次 / 变更集的记录与呈现 | agent loop、上下文工程 | 会话生命周期映射 |
| 变更的归因、快照、reconcile、裁决 | 模型调用、推理参数、工具策略 | 事件翻译、能力注入（MCP） |
| 审阅体验（编辑器内联 + Changes 视图） | **权限与沙箱的最终裁决** | 权限转接 |
| 偏好与凭据的配置**体验** | provider 语义主权 | 凭据的实际落地 |
| 工作区、LSP、终端、测试、调试 | | |

## 3. 用户与阶段

- **短期（自用）**：作者本人在 VS Code + OMP 上每天使用。
- **长期**：公开开源产品；Core 可复用于其他 IDE，adapter 可接任意 harness。
- **第一阶段 DoD**（D21）：**在三个真实任务里用它完成 review 即可。**

## 4. 差异化：我们只押一格

竞品事实（见 `reference/facts.md` §6）：

- **"用一个 ACP 客户端接任意 harness" 已商品化** —— ≥10 个上架扩展在做（ACP Client 31K 安装、Multicoder 5K、ACP Pro、ACP Patchbay、Exo…）。
- **"把 IDE 能力作为 MCP 工具喂给 agent" 已有人实现** —— ACP Patchbay 在 `session/new.mcpServers` 注入本地 MCP server，暴露当前文件、选区、打开的编辑器、诊断、工作区布局。
- **没有人做**：普通编辑器内的**逐 hunk 裁决 + 用户编辑后的 reconcile**；以及**树已经往前走之后，回看第 N 轮的 hunk 并重新裁决**。
- 反例：VS Code 自家的 Agent Host 路径**根本没有待审阅态**（编辑直接落盘到工作区）。

⇒ 本产品**只押变更的审阅层**。能力层是"让 agent 少走弯路"的第二步（D12），不是卖点；聊天、harness 接入都不是。

## 5. 架构

```
VS Code Extension（宿主）
├─ 编辑器内联渲染：insets + decorations + CodeLens 动作行
├─ Changes 视图（webview view）+ 文档顶部导航（editor title）
├─ 会话面板（webview）
├─ 能力 MCP server（在 session/new 注入）
└─ 权限转接 UI
        │   内部契约（既不认 VS Code，也不认 harness）
        ▼
Core —— 纯 TypeScript、零 vscode 依赖
├─ Session / Turn / ChangeSet / FileChange / Hunk 模型与状态机
├─ 归因器（协议声明 + IDE 写通道）
├─ baseline 快照 + 变更观测
├─ diff/hunk 推导 + reconcile（重应用 / 冲突）
├─ 台账（turn、裁决、reject 原因）
└─ Adapter 接口 + 能力声明
        │
        ▼
Adapter（底层通道只是各自 adapter 的实现细节，由 adapter 自选）
├─ OMP Adapter（一期；**SDK sidecar**：扩展 ↔ 我们的 Bun 宿主脚本 ↔ OMP SDK；
│   用 customTools 遮蔽 write/edit 以握住写所有权，用 setActiveToolsByName 动态挂工具）
├─ ACP Adapter（通用、可移植；M2 起，同时用于接第二个 harness）
├─ CLI Adapter（**抽象先定义**，一期不做具体实现）
└─ AHP 对齐（只对齐数据模型，将来当 host 的桥）
```

### 5.1 Adapter 能力声明（禁止假装可用）

Core **不假设**任何 harness 的能力。每个 adapter 必须声明，UI 与流程据此开关：

| 能力 | 含义 | 缺失时的降级 |
| --- | --- | --- |
| `session.resume` / `session.list` | 能否恢复、列举会话 | 每次新建；IDE 只读副本成为唯一历史 |
| `permission.request` | 能否在破坏性操作前询问 | **无前置闸门**，UI 必须明示（D9） |
| `diff.declared` | 能否提供变更归因 | 该 harness **没有可审阅内容**，review 门为空 |
| `write.intercept` | 我们能**多早、多确定**地知道某次写入：`own`（我们执行写入）｜`blocking-hook`（写入前的阻塞式钩子，需我们作答才继续）｜`async-signal`（写入前但不等我们）｜`post-hoc`（写入后才有通知 + 声明 diff）｜`none` | **`own` 与 `blocking-hook` 都能给出精确 baseline**；`async-signal` 有竞态；`post-hoc` 依赖声明且第三方改动后作废；`none` 不可审阅。**UI 必须按级别如实说明可还原性**，不能让用户以为 Revert 到处都逐字节可靠。**判定只看"写入前是否阻塞"，"能否改写输入"不进级别**（我们只需要快照，不需要改写；Codex app-server 因此也算 `blocking-hook`，D44） |
| `config.options` | 模型 / 推理档 / Mode 是否可作为配置项 | 偏好层退化为 hint |
| `mcp.injection` | 能否在 `session/new` 注入能力 server | 能力层与反馈回路对该 harness 不可用 |
| `steer` / `followUp` | 能否在 turn 中插话 | 只提供"中断当前 turn"（D25） |

**为什么必须显式**：CLI 型 harness 通常没有权限协议、没有会话恢复，也拿不到 diff 归因；这些缺失如果被 Core 假设为存在，产品会给出错误的安全承诺。

## 6. 变更模型

层级：`Session → Turn → ChangeSet → FileChange → Hunk`

- **Turn**（D2）：从用户输入 prompt 到 agent **完全完成处理**。账本由 IDE 维护（协议只提供时间窗，不提供分组）。
- **ChangeSet = agent 的修改意图集合**（D8）：只收录**明确可归因**的修改，按**三层政策**（D42）：
  1. **harness 内置的文件变更工具 → 要求完全准确归因**（adapter 契约；做不到必须如实降级，并在 UI 上明说该 harness 的 review 不完整）；
  2. **shell → best effort**：命令执行**前**从 `input.command` 解析它将修改的路径，能可靠解析才抢拍 baseline 并归因，否则**整条跳过**（D41）。**方言必须感知**：`bash` / `PowerShell` / `cmd` 三套语法都要支持；**方言由 adapter 在运行期提供、不从命令文本猜**，方言不明即跳过（D43）；
  3. **脚本 / 用户程序生成的文件 → 不做任何归因**。
  **不做全盘磁盘监控**；且"**可拦**"与"**可归因**"始终分开表述（D40）。
- 文件级 `new` / `remove` / `rename` 是**一等实体**（D6）；`rename` 是真 rename，不是 delete+add。
- Hunk 状态：`pending` / `accepted` / `rejected(reason: user | conflict)`。**`stale` 作为终态已取消**（D19）。
- **baseline**：IDE 自持懒快照，与 Git 零耦合（D5）。**破坏性操作（delete / move）被批准之前必须先拍快照**，否则 Reject 无法还原。

### 6.1 裁决语义（最容易写错的一处）

| 动作 | 是否修改文档 | 说明 |
| --- | --- | --- |
| Accept hunk / file / turn | **否** | 文档**已经是 agent 改后的状态**，Accept 只是确认保留 |
| Reject hunk / file / turn | **是** | 用 baseline 恢复 |
| 用户改过 new 侧后 Accept | **否** | 采纳当前文本 |
| Accept 一个新建文件 | 否 | 文件已经在了 |
| Reject 一个新建文件 | 是 | 删除该文件 |
| Accept 一个删除 | 否 | 文件已经删了 |
| Reject 一个删除 | 是 | 从快照复原 |
| rename | — | Accept 无动作；Reject 反向重命名 |

**写盘策略**（D28）：IDE 对文档的任何修改（agent 写入、Reject 还原）**一律立即保存**。后果：用户在该文件里此前的未保存改动会被一并提交——这是明确接受的取舍，不得隐藏。

### 6.2 外部修改与冲突（D19）

- **不监控**未归因的改动，**也不提示**。
- turn 开始前的外部修改不构成问题：hunk 以**当时的文件实际情况**为基准产生。
- 打开含 changeset 的文件时，**以文件最新内容为 baseline 重新应用 hunk**（类似 merge）：
  - 能干净应用 ⇒ 照常渲染与裁决；
  - 冲突 ⇒ **hunk 级丢弃**，标记 `rejected(conflict)`。
- **被丢弃的 hunk 必须可见**（列表/提示里能查到），不能静默消失。
- **冲突丢弃 ≠ 用户拒绝**：两者必须可区分，并在反馈回路里如实反映。

## 7. 审阅体验

### 7.1 编辑器内（一期唯一渲染路径）

- **new 侧**：真实文档文本 + 整行 `diffEditor.insertedLineBackground` 底色。
- **old 侧**：**每个删除行一个真实行**，靠 proposed API `editorInsets`（D11：一期单轨，因此不走 Marketplace）。
- **动作面**：CodeLens 一行（`✓ Accept | ✗ Reject | 状态`）。**insets、decorations、CodeLens 三者同步到同一次 `provideCodeLenses` 查询提交**，避免文档跳两次；已知 CodeLens 有 ~250ms 级刷新下限，接受。
- **文档顶部**（editor title 菜单）：Accept All / Reject All / `< 1/10 >` 形式的 hunk 计数与快速定位。

### 7.2 Changes 视图（webview view）

- 轻量文件列表：`foo.cs  +100 -80`；每行右侧 `√ / ×` 做**文件级**裁决；悬停显示常规 diff 浮窗、点击跳转到文档；列表底部 Accept All / Reject All。
- **为什么是 webview view 而不是 TreeView**：TreeView 没有页脚区域，无法满足"按钮在列表最下方"；代价是我们自维护一层 UI（主题、无障碍、本地化）。

## 8. 会话与交互

- **单窗口、单 session、单工作区根**（D18）。数据模型按 sessionId 键化以便后扩。
- **session 与 harness 绑定**：harness 只能在**新建 session、且第一条 prompt 发出之前**选择；不能中途更换。
- **会话面板**：自建薄 webview（对话流 + turn 列表 + activity）（D14）。开发行为留在原生编辑器 / SCM / 终端。
- **中途干预**（D25）：adapter 声明 `steer` / `followUp`；不支持则只提供"中断当前 turn"。
- **记录**（D15）：IDE 全量存一份**只读**对话副本（搜索 / 导出 / 离线回看），**绝不写回 harness**；恢复以 harness 的 `session/resume` 为准，resume 失败时降级为"只读回看 + 新建 session"。
- **异常终止与正常结束无差别**（D20）：已产生的 changeset 已经对文件生效，照常逐个或整体裁决。
- **历史回看**：可回看第 N 轮的 hunk 并重新裁决——这是无人实现的差异化能力。

### 8.1 回退到第 N 轮（D29 / D33）

回退 = **两件事同时做**，缺一不可：

1. **文件侧**：按 changeset **逐轮反向还原**到第 N 轮开始前的状态。**这件事没有任何 harness 能代劳**——OMP 明确"不调 git、不拍文件系统快照"（`checkpoint`/`rewind` 只折叠上下文），文件回滚只有 git 级操作。只能由 AgentDock 的台账实现（D5 / D8 的地基）。
2. **会话侧**：由 adapter 用 harness 原生能力实现（OMP = `branch(entryId)`，只接受 user message）。

其余规则：

- **抓回输入框的只有 prompt 文本**：pill 与其它附件一律丢弃——回退之后那些引用很可能已经失效（D29）。
- 第 N+1 轮及之后的记录**直接丢弃，不留档**；连带推论：**IDE 只读副本中对应区段也一并删除**（否则"丢弃"只是假象）。
- **回退与 fork 是两个独立动作**：回退动文件，fork 不动文件。

### 8.2 Fork（D30 / D33）

- 由 adapter 实现。ACP 的 `session/fork` **只能整会话**（无轮次参数，且是 UNSTABLE 方法）；OMP 的 `branch(entryId)` 可按**任意 user message** 分叉并产生**新的会话文件与 id**。
- **fork 不动工作区文件**（OMP 只克隆上下文与 artifacts）。

### 8.3 压缩与上下文用量（D31 / D33）

- 入口：**会话面板底部的细状态条**（已用 / 上限 + 一键压缩 + fork / 回退入口）。
- 用量来源由 adapter 决定：OMP 侧给**全量**（tokens 分类 / cost / `contextUsage.percent`）；ACP 通道只有每轮结束一次的 `usage_update{used,size,cost}`。
- 手动压缩由 adapter 实现：OMP 侧有专用入口，ACP 侧只能把 `/compact` 当文本发 `session/prompt`。

## 9. 上下文与 pill（D17）

- **默认上下文**：当前打开的文件。
- **pill 来源**：document 选区、终端选取内容、日志。**pill 只发引用**，不发内容快照。
- **终端 / 命令输出**（按 SDK 集成改写）：agent 的 shell 跑在 sidecar 进程内，**我们不拥有那个终端**。但输出有两份可用形态：事件里约 50ms 节流的**尾部快照**（`tool_execution_update.partialResult`，用于 UI 流式显示），以及**写在会话 artifacts 目录里的完整原始流**（事件里以 `[raw output: artifact://N]` 指路）。因此 **pill 给 agent 的是一条指向 artifact 真实文件路径的引用**（符合"只发引用"），agent 自己读全文——比"我们 tee 一份日志"更干净，因为它引用的是一个真实存在的文件。
- **用户自己的终端默认不碰**，另提供显式命令"把当前终端内容抓进日志"，执行前明确提示会覆盖剪贴板（D17 / T2）。
- 事实约束：`Terminal.selection` 仍是 proposed；`OutputChannel` 只写不读；pill 无原生 UI 原语，必须在自建 webview 内渲染。

## 10. 权限与策略（D9）

- Core 只做两件事：**配置向的 hint** + **审批操作的转接**。**权限的最终裁决在 harness。**
- **两门严格分离**：权限门回答"允不允许它做这件事"（含 delete / move 等破坏性操作），review 门回答"这次改动留不留"。
- Core **没有策略引擎**、**没有 `allow_always` 存储**、**不能追加选项**；"自动接受编辑"这类档位作为 hint 表达为 **harness 自己的配置**。
- **后果声明**：当 harness 不提供审批、或用户把它设为全自动时，**IDE 侧不存在第二道闸**，唯一把关是 review 门；若 adapter 声明 `permission.request = false`，UI 必须明示。

## 11. 反馈回路（D13）

- **纯拉取**：IDE **不向 prompt 注入任何内容**（避免干扰 harness 的 prompt）。
- 工具 `review.lastOutcome` **只在存在"用户修改或拒绝"时才出现在工具列表里**，其**描述自述其意**（"用户修改或拒绝了你的修改，用此工具查看明细"）；靠 MCP `tools/list_changed` 动态增删与改写。
- 输出必须区分 `rejected(user)` 与 `rejected(conflict)`（D19），否则 agent 会误判用户意图。
- **传输由 adapter 决定**（D32 / D36）：OMP 侧用 SDK 的 **`customTools` / `setActiveToolsByName` 动态增删工具**。ACP 通道则相反：必须把能力 MCP server 在 `session/new` 注入且**集合不可变**（OMP 在 ACP 模式下以 `enableMCP: false` 建会话，`.mcp.json` 被忽略），之后只能靠 `tools/list_changed` 变工具。

## 12. 能力层（D10 / D12）

- 自定义 **`ide.*`** 命名空间；**传输由 adapter 决定**（D32 / D36 / D37）：OMP 走 SDK 的 `customTools` + `setActiveToolsByName`（动态增删），ACP 走 MCP server。
- 协商分两层：**存在性** = `tools/list`（未列出即不支持）；**可用性** = 每次调用返回 `available: false + reason`。另提供 `ide.capabilities.describe` 供 agent 动手前查询。
- 每个能力带 **`fallback: allow | forbidden`**（IDE 权威的能力应标 `forbidden`，阻止 harness 用自己的 shell/LSP 绕过）。
- 建设顺序：**review → LSP 级（导航 / references / rename / code action / diagnostics）→ 调试 / 测试**。LSP 级的验收标准是**可观测的效率提升**（agent 少走 grep 弯路），不是"工具存在"。

## 13. Provider / Model / 凭据（D16）

- IDE 存 **canonical preference**，**包含凭据**（落 VS Code 加密 SecretStorage）。
- **凭据如何交给 harness 由 adapter 决定**；两条原则：① 用户不会与 IDE 同时使用同一个 harness 实例，配置文件冲突的后果由用户承担；② **用户只操作 IDE，不需要额外编辑配置文件**。
- harness 自己的 `configOptions`（实测 OMP 提供 `model` / `thought_level` / `mode`）**原样呈现**，经 `session/set_config_option` 回写。

## 14. 分发与合规（D23）

手动 VSIX 安装 + 有新版时提示；启动时检测 VS Code 版本，**不兼容则明确报错拒绝激活**（proposed API 半坏着跑比不可用更危险）；**零 telemetry**；vendored 的 proposed `d.ts` 保留 MIT 版权头并加 NOTICE 说明来源。

## 15. 明确不做（non-goals）

- 不做 agent runtime、上下文工程、provider 实现、模型网关。
- 不做聊天产品复刻：不用 `chatSessionsProvider`，不做大型 chat 应用。
- 不做多 session 并发、multi-root、remote agent、多客户端、后台守护。
- 不做 AHP host（只对齐数据模型）。
- 一期不做 CLI adapter 的具体实现，只做**抽象**（U1）。
- 不做全盘变更监控（D8）。
- 不替 harness 决定权限（D9）。

## 16. 必须公开的后果声明（不许藏）

1. **存在"文件被改了但没进 review"的情况**（D8：只记可归因的修改）。
2. 目标形态依赖 **proposed API** ⇒ 一期不能上架 Marketplace，每次 VS Code 升级都要复测（D11 / D23）。
3. 编辑器内动作面有 **~250ms 级延迟下限**（CodeLens 刷新机制）（D11）。
4. **冲突的 hunk 会被丢弃**（D19）——因此必须可见、且与"用户拒绝"可区分。
5. harness 无审批或设为全自动时，**IDE 侧没有第二道闸**（D9）。
6. **一律立即保存** ⇒ 会连带提交用户在该文件里未保存的改动（D28）。
7. **没有 ACP 的 harness** 需要各自的 adapter 或第三方桥；本产品不承诺"任意 CLI 都能接"（U1）。
8. 本地文件（会话只读副本、终端日志、baseline 快照）**会包含代码内容**；零 telemetry 不代表零本地留存。
9. **一期 OMP adapter 是 Bun sidecar + OMP SDK**（D36 / D37）：**Bun ≥ 1.3.14 是硬前提**（Node 扩展宿主无法 import 该 SDK）；深耦合一个高速演进的私有 API（本机 18.2.1 vs npm 最新 18.2.5）；审批与协议通道**等价**，只有通用 `Approve / Deny`，没有 ACP 那套 `allow_once / allow_always` 类型化选项（与 D9 一致——权限真相本就在 harness 手里，IDE 只做转接）。
10. **双进程并发驱动同一会话不被支持**（实测：后写者撞 `SessionWriteConflictError`）⇒ 不要指望"ACP 主 + RPC 补"的组合。
11. **OMP 的审批默认是关闭的**（`tools.approvalMode` 默认 `yolo`）⇒ 用户不主动配置就**没有权限门**。baseline 由**我们自己执行写入**来保证精确（D37），但 **T1 要求覆盖全部内置文件变更工具**（含 `ast_edit` / `apply_patch`，D42）；shell 只做 best effort（D41 / D43）；**脚本与程序产物一律不归因**（T3）。凡未归因的改动，UI 必须如实呈现为"未归因改动不可审阅"（D8）。
