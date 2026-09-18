# 实现步骤拆分

> v1.3 · 2026-09-18（按 **D36 / D37：一期 OMP adapter = SDK sidecar + 复用现有 Bun** 改写；**D42 / D43** 补入归因三层与 shell 方言）。与 `01-product-design.md`（产品行为）和 `reference/decisions.md`（D1–D44）配套；冲突时以决策台账为准。
>
> **拆分原则**：每个阶段结束时产品必须在真实环境里**端到端可用**；退出标准是**可测行为**，不是"代码写完"。顺序按 D12（review → LSP 能力 → 调试）与"最快开始自用"编排。

## 0. 起点：PoC 给了什么、缺什么

可复用资产只有 3 个纯 Node 模块（`model/changeSet.ts` 108 行、`model/reconcile.ts` 91 行、`model/fixture.ts` ~136 行，**零 `vscode` 依赖**），其余是渲染与接线。

| 能力 | PoC 现状 | 产品需要 |
| --- | --- | --- |
| 纯模型（`Hunk` / 状态机 / `computeAnchor` / `applyRejectEdit`） | 有 | 扩展为 Core |
| 变更推导（baseline → hunk） | **无**（hunk 手写在 `sample.patch.json`） | diff/hunk 推导引擎 |
| 多文件 / Session / Turn 身份 | **无**（单文件 `TurnChangeSet`） | `Session → Turn → ChangeSet → File → Hunk` |
| baseline 快照 | **无** | 由 IDE 执行写入 ⇒ **精确 baseline**（D37） |
| 文档变更观测 | 仅吸收自身编辑（`isOwnEdit`） | 归因器（写所有权 + adapter 声明） |
| Accept 落地 | 记账（语义且是错的，见 D26） | **Accept 不改文档**；只有 Reject 写盘 |
| Reject 还原 | 4 种形状逐字节可逆 | 保留，扩到文件级与 rename |
| 渲染 | 两套 | 收敛为**单轨**（insets） |
| 持久化 / 历史 | **无** | turn 台账 + 历史回看 |
| Agent 接入 | **无**（假 patch） | **OMP SDK sidecar Adapter** |
| 会话回退 / fork / 压缩 / 用量 | **无** | 台账（文件侧）+ adapter（会话侧） |

## 阶段 0 — Core：宿主无关的变更模型

**目标**：纯 TypeScript、零 `vscode`、可在 Node 里单测。

**交付物**

1. `Session / Turn / ChangeSet / FileChange / Hunk` 与状态机 `pending | accepted | rejected(reason: user | conflict)`；文件级 `new / remove / rename` 为一等实体（D6）。
2. **Diff/Hunk 推导引擎**：baseline + 当前文本 → 行级 hunk；`rename` 是真 rename。
3. **Reconcile**：扩展现有 4 规则决策表，覆盖跨 hunk 边界、一次编辑命中多 hunk、文件级操作，并实现 **D19 的"重应用 / 冲突"**（替换 PoC 的 `stale` 冻结）。
4. **Baseline 快照**：拍摄时机由 `write.intercept` 级别决定（`own` / `blocking-hook` = 写入前**精确**拍摄；`async-signal` = 抢拍 + 声明 diff 兜底；`post-hoc` = 只能用声明 diff）；与 Git 零耦合（D5）。
5. **归因器接口（三层，D42）**：① **T1 = harness 内置文件变更工具，要求精确**（由 adapter 保证，Core 只接收结果）；② **T2 = shell，best effort**：纯函数「命令行意图解析器」（D41）在**执行前**从 `input.command` 解析将修改的路径，能可靠解析才抢拍 baseline 并归因，否则整条跳过；③ **T3 = 脚本 / 用户程序生成的文件，不归因**。接口用 `write.intercept` 级别表达降级。解析器是**多方言注册表**（`bash` / `powershell` / `cmd` 各一份，共用 `{ paths, confidence }` 契约），**方言由 adapter 在运行期提供**，不明即跳过（D43）。不做全盘监控（D8）。
6. **回退执行器**：给定轮次 N，按 changeset **逐轮反向还原**（D33）——纯函数，可单测。
7. **Adapter 接口 + 能力声明表**：`session.resume/list/branch/revert` · `permission.request` · `diff.declared` · **`write.intercept`（`own`｜`blocking-hook`｜`async-signal`｜`post-hoc`｜`none`）** · `config.options` · `capability.transport` · `steer` / `followUp` · `usage.detail` · `compact` · `runtime.requirements`（如 Bun）。CLI adapter 的抽象在此就位（D27）。

**退出标准（可测）**

- 任意 baseline + 任意编辑序列：`reject(all)` 后文本**逐字节**等于 baseline。
- 同一编辑序列重放两次，ChangeSet 完全一致（无隐藏状态）。
- `revertTo(turn N)` 后，涉及文件**逐字节**等于第 N 轮开始前的状态；跨 hunk 边界编辑不产生 `stale` 而重应用，冲突被标 `rejected(conflict)`。
- 构建产物出现 `require('vscode')` 即失败。
- **T1 层不得漏**（D42）：adapter 包裹的内置文件变更工具集合必须等于该 harness 声明的内置写工具集合（清单以 `get_state` 的 `dumpTools` 与官方文档为准），**漏一个即失败**；被包裹的每个工具都要有"前拍快照 → 执行 → 变化归因"的用例。
- **命令行意图解析器有三份标注集**（`bash` / `PowerShell` / `cmd` 各一）：单命令 + 字面量路径判为**可靠**——bash：`sed -i` / `rm` / `mv` / `cp` / `touch` / `tee` / 重定向；PowerShell：`Set-Content` / `Out-File` / `Remove-Item` / `Move-Item` / `Copy-Item` / `New-Item` / `Tee-Object` / 重定向；cmd：`del` / `erase` / `copy` / `move` / `ren` / `md` / `rd` / `type x > f` / `echo x > f` / 重定向。含 `&&` / `||` / 管道 / `$( )` / 反引号 / 变量展开（`$VAR`、`%VAR%`）/ 脚本文件 / 命令替换 / 别名 / `call *.bat` / 嵌套 shell（`powershell -c`）判为**不可靠**。**把不可靠误判为可靠 = 测试失败**（错误归因比漏掉更危险，它会让 Reject 复原不属于 agent 的改动）；**方言不明也必须跳过而不是猜**；**设备名（`nul` / `con` / `/dev/null` 等）不得被解析成路径**（D43）。

## 阶段 1 — Review 闭环（OMP SDK sidecar + 单轨渲染）

**依赖**：阶段 0；用户环境需有 **Bun ≥ 1.3.14**（D36）。

**交付物**

1. **OMP SDK sidecar**：一个跑在 Bun 里的宿主脚本，import `@oh-my-pi/pi-coding-agent` 的 `createAgentSession`；扩展 ↔ sidecar 之间是**我们自己的 IPC**（不是 OMP 的 CLI 契约）。sidecar 负责：会话创建/恢复（`SessionManager`）、`session.subscribe` 全事件流转发、`prompt` / `abort` / `steer` / `followUp`，并以 **`agent_end.isTerminal !== false`** 判定 turn 真正结束（D2）。启动时上报 SDK 与 Bun 版本，不匹配则**明确拒绝运行**（D37）。
2. **T1 层归因：内置文件变更工具，要求完全准确**（D42）：用 **`customTools` 包裹全部内置文件变更工具**（`write` / `edit` / `apply_patch` / `ast_edit` …），包裹实现里用 **`ctx.invokeTool` 委托原生工具**——不重写工具语义，只在前后拍快照并归因。可选地在 `write` / `edit` 上**亲自执行字节写入**以取得最强保证（D37），但**不得因此漏掉任何内置文件变更工具**。
3. **动态工具通道**：`customTools` / `setActiveToolsByName` 打通（阶段 5 才真正用它挂 `review.lastOutcome`）。
4. **编辑器内渲染（唯一路径）**：old 侧 insets + new 侧 decorations + CodeLens 动作行，三者同步到同一次 `provideCodeLenses` 查询提交（D11）。
5. **文档顶部**：editor title 菜单的 Accept All / Reject All / `< 1/10 >` 导航（D24）。
6. **Changes 视图**：webview view 文件列表（`+N -M`、行右 `√/×`、悬停 diff 浮窗、底部 Accept All / Reject All）。
7. **三级裁决 + 写盘语义**：Accept 不改文档；Reject 用 `WorkspaceEdit` 恢复；**一律立即保存**（D26 / D28）。

**退出标准（可测）**

- 真实 VS Code + 真实 OMP：agent 改一个文件 → 逐 hunk 裁决 → 用户手改后仍能正确定位裁决 → 文本逐字节符合预期。
- **Accept 之后撤销（Ctrl+Z）不影响文档**；**Reject 之后 Ctrl+Z 能回到 agent 的状态**。
- 文件级：新建文件的 Reject 会删除它，删除文件的 Reject 会复原它。
- 拔掉 Bun（或改成低版本）时，扩展给出明确错误而不是半坏。

**不做**：能力层、会话生命周期操作、多 session、第二个 harness、历史回看。

## 阶段 2 — 台账、持久化与历史

**交付物**：turn / ChangeSet / 裁决结果持久化（含 reject 原因）；**历史回看**（回看第 N 轮并重新裁决）；异常终止与正常结束的一致性（D20）；只读对话副本（D15）。

**退出标准**：重启 VS Code 后第 N 轮的 hunk 可定位、可裁决，Reject 结果与当初一致。

## 阶段 3 — 权限转接与 adapter 能力矩阵

**交付物**：审批转接（OMP 侧是 `setToolUIContext` 下的 `select([Approve, Deny])`，**与 RPC 等价、不更强**，D37）；**首次运行引导必须提示 OMP 的审批默认是 `yolo`**——不配置就没有任何闸门（D35）；破坏性操作前的**快照拍摄**（D26）；能力声明的完整落地与**降级 UI**（D9）；`steer` 的按能力开关（D25）。

**退出标准**：agent 触发破坏性动作时出现审批；adapter 未声明 `permission.request` 时 UI 明确说明"无前置闸门"。

## 阶段 4 — 会话生命周期操作（回退 / fork / 压缩 / 用量）

**依赖**：阶段 2（台账）与阶段 1（adapter）。

**交付物**

1. **回退到第 N 轮**：文件侧逐轮反向还原（阶段 0 的回退执行器）+ 会话侧 `branch(entryId)`；把该轮 prompt 文本抓进输入框；后续记录连同只读副本一并删除（D29）。
2. **Fork**：整会话或按 user message 分叉新会话，**文件不动**（D30）。
3. **上下文用量与压缩**：会话面板底部状态条（占用百分比 + 一键压缩）（D31）。
4. **插话（steer）入口**（D25）。

**退出标准**：回退后文件逐字节等于第 N 轮前、输入框只剩该轮 prompt 文本、副本里对应区段消失；fork 出新会话而工作区文件零变化；状态条显示占用并能触发一次压缩。

## 阶段 5 — 反馈回路

**交付物**：`review.lastOutcome` 经 **`customTools` + `setActiveToolsByName` 动态挂载**；**仅当存在用户修改/拒绝时才注册该工具**，描述自述其意；输出区分 `rejected(user)` 与 `rejected(conflict)`（D13 / D19）。

**退出标准**：拒绝一处 hunk 后，**工具在下一次模型请求中可用**；agent 调用后其后续行为体现它知道这处是被冲突丢弃而非用户审阅拒绝。

## 阶段 6 — 能力层：LSP 级

`ide.*` 能力经 `customTools` 暴露；`ide.capabilities.describe`；每个能力的 `fallback: allow | forbidden`（D10）。

**注意**（事实）：**OMP 自带 LSP 集成且默认开启**，因此本阶段的价值不是"补上 LSP"，而是**复用 IDE 已配置、已启动、且能看到未保存缓冲区的语言服务器**，避免 OMP 再起一套。

**退出标准（D12：验收标准是效率提升）**：同一真实任务在"有能力层 / 无能力层"两次运行中，工具调用步数与 grep/read 次数显著下降。

## 阶段 7 — 调试与测试能力

按 `ide.*` 既有约定扩展。D12 排序中的第三档。

## 阶段 8 — 泛化与分发

- **先做包装型 adapter**（D38；**通道按 D44 修正**）：**Claude Code**（`@anthropic-ai/claude-agent-sdk`：`PreToolUse` 钩子，**L2**）、**Copilot CLI**（`@github/copilot-sdk`：`onPreToolUse` 改写 + `onPermissionRequest` 审批，**L2**；**Node `^20.19.0 || >=22.12.0`**，Node 18 不行）、**Codex**（**用 `codex app-server`，不是 TS SDK**——SDK 只是 `codex exec --experimental-json` 的薄壳，`FileChangeItem` 连 diff 都没有 ⇒ **L4**；app-server 的 `item/*/requestApproval` 才是 **L2−** 阻塞审批）。**"接入第二个 harness 不改 Core"这条验证优先在这里做**，因为性价比最高。
- **再做 ACP Adapter**（通用、可移植）：覆盖 Gemini CLI 等原生 ACP 的 harness。
- **CLI adapter 的第一个具体实现**（抽象早在阶段 0 就位）（U1）。
- OMP SDK 的高级能力：subagent 归属、artifact 访问、`Settings.isolated` 的配置隔离。
- AHP 数据模型对齐（immutable state + pure reducers + URI 寻址 changeset）。
- 分发：稳定轨与上架路径（此时才评估是否需要 fork，D11）；以及 **Bun 的发现 / 引导 / 或自编译 sidecar**（~48 MB + 171 MB 原生插件的取舍，D37）。

## 可停点

| 停在这里 | 得到什么 |
| --- | --- |
| 阶段 1 | 能看、能裁决，但重开就丢 |
| 阶段 3 | **可以每天自用**（权限转接到位，D21 的三个真实任务可完成） |
| 阶段 4 | 回退 / fork / 压缩 / 用量到位，日常"重试与探索"闭环成立 |
| 阶段 5 | review 结果能回流给 agent，闭环完整 |
| 阶段 8 | 才谈得上"长期公开开源产品" |

## 风险与回退

| 风险 | 回退 |
| --- | --- |
| **深耦合 OMP 私有、高速演进的 API**（本机 18.2.1 vs npm 18.2.5）（D36 / D37） | adapter 层隔离；sidecar 上报版本并在不匹配时明确报错；锁定依赖版本 |
| **用户环境缺 Bun 或版本过低** | 启动时明确报错并给出安装指引；分发阶段再评估自编译 sidecar（~48 MB + 171 MB 插件） |
| `customTools` 遮蔽 `write`/`edit` 后，OMP 的工具行为与内置版出现偏差 | 以 OMP 的 `edit` 语义为契约做兼容测试；偏差在 UI 上可见而不是静默 |
| `editorInsets` 随 VS Code 升级损坏 | 渲染层独立模块；最坏退回 decorations + Comments widget（PoC 已验证） |
| CodeLens 250ms 下限被感知为迟钝 | 三处同步提交已把"跳两次"变成"跳一次"；必要时把动作面移入 Changes 视图 |
| shell 与脚本/程序产物无法归因（T2 的 best effort 注定会漏，T3 一律跳过，D42） | UI 如实标为"未归因改动不可审阅"，不假装有 review |
| Copilot 的 **deny-by-default**：不注册 `onPermissionRequest` 时请求会 *"left pending"* ⇒ agent 静默挂住，用户只看到"没反应" | adapter **无条件注册** handler（哪怕策略是自动放行），并对挂起做超时提示（D44） |
