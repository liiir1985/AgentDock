# 事实台账

> **as of 2026-09-18。** 本文件是 AgentDock 设计文档唯一的证据台账：把 8 份只存在于内部 artifact 的 scout 事实表（`agent://{AcpSurface, OmpSurface, PriorArtReview, VscodeReviewApis, VscodeAgentApis, PocInventory, AhpAgentHost, VscodeAcpClients}`）合并为可长期引用、可追溯来源的一手材料。产品章程见 `README.md`；技术 PoC 的结论与探针原始数据见 `poc/editor-review/RESULTS.md`，本文件**不复制**其结果，只在构成设计约束时引用。另一个作者拥有 `docs/reference/decisions.md`。
>
> **证据等级**（按主张标注，高者优先）：
> **实测** = 本机运行/断言得到的观测（`omp acp` 握手、PoC 探针、DOM 计算样式）；**一手源码** = 随包发布的源码/schema/`.d.ts`/release notes（给出行号）；**官方文档** = 厂商文档站、spec 站、Marketplace/Open VSX 元数据；**推断** = `[INFERENCE]`，未验证的推理或 "not found" 类证据（检索不到 ≠ 不存在）。
>
> **脱敏**：密钥与私有端点一律写作 `<redacted>`。行号约定：`file:line` 指向本机安装的具体版本（VS Code 1.138.0 / OMP 18.2.1）。未逐条标注的单元格继承该段落声明的来源。

## 0. 本机实测

### 0.1 `omp acp` 实时握手（2026-09-18，逐字）

```
$ omp --version   -> 18.2.1
$ omp acp  (JSON-RPC over stdio)
--> initialize {"protocolVersion":1,...}
<-- {"protocolVersion":1,"agentInfo":{"name":"oh-my-pi","title":"Oh My Pi","version":"18.2.1"},
     "authMethods":[{"id":"agent","name":"Use existing local credentials",...}],
     "agentCapabilities":{"loadSession":true,"mcpCapabilities":{"http":true,"sse":true},
       "promptCapabilities":{"embeddedContext":true,"image":true},
       "sessionCapabilities":{"list":{},"fork":{},"resume":{},"close":{}}}}
--> session/new {"cwd":"D:\\svn\\AgentDock","mcpServers":[]}
<-- {"sessionId":"01a0b344-f072-7234-b190-3fb3de1d647a","configOptions":[
      {"id":"mode","category":"mode","type":"select","currentValue":"default"},
      {"id":"model","category":"model","type":"select","currentValue":"vivi/deepseek-v4.1-flash",
       "options":[{"value":"vivi/deepseek-v4.1-flash","name":"Deepseek v4.1 Flash"}]},
      {"id":"thinking","category":"thought_level","type":"select","currentValue":"high",
       "options":[{"value":"off"},{"value":"auto"},{"value":"low"},{"value":"high"},{"value":"max"}]}],
     "modes":{"availableModes":[{"id":"default"},{"id":"plan"}],"currentModeId":"default"}}
<-- session/update ≤ {sessionUpdate:"available_commands_update", availableCommands:[19 OMP slash commands]}
<-- session/update ≤ {sessionUpdate:"session_info_update"}
```

**注意点**：`session/new.mcpServers: []` 被接受 —— 这正是能力注入通道（IDE 侧 MCP server 随会话注入）。`configOptions` 里的 `model`（category `model`）与 `thinking`（category `thought_level`，取值 `off|auto|low|high|max`）是 README §5「统一 Provider/Model 偏好」在标准协议上的落点。首个 `session/update` 是 `available_commands_update`（19 条 OMP slash 命令），随后 `session_info_update`；两者都是通知，无响应。

### 0.2 环境事实

| 项 | 值 | 来源 |
|---|---|---|
| OMP 版本 | **18.2.1**（`omp --version`；`package.json` 中全部 `@oh-my-pi/*` 同为 18.2.1） | 实测 / 一手源码 |
| OMP 安装根 | `C:\Users\Admin\AppData\Roaming\npm\node_modules\@oh-my-pi\pi-coding-agent`（含 `src/`、`dist/cli.js`、`CHANGELOG.md` 242.9 KB、`THIRD-PARTY-NOTICES.txt` 1.0 MB） | 一手源码 |
| OMP shim | `omp` / `omp.cmd` / `omp.ps1`；`omp.cmd` 调 `bun` 执行 `dist/cli.js` | 一手源码 |
| OMP 配置根 | `C:\Users\Admin\.omp\` → `agent/`、`logs/`、`puppeteer/`、`run/daemons/`、`natives/18.2.1/`、`gpu_cache.json` | 一手源码 |
| 模型 provider（本机） | 自定义 provider `vivi`，`api: openai-responses`，`apiKey` `<redacted>`，`baseUrl` `<redacted>`，模型 `deepseek-v4.1-flash`（512 000 ctx / 32 000 max tokens，`reasoning: true`，`input: [text, image]`） | 一手源码 |
| 本项目会话存储 | `~/.omp/agent/sessions/--D--svn-AgentDock--/`；SQLite `agent.db`、`models.db`、`history.db`；`skills/grill-me`、`skills/grilling` | 一手源码 |
| 项目级配置 | **不存在** `D:/svn/AgentDock/.omp/`（仓库只有 `README.md`、`LICENSE`、`.gitignore`、`poc/`） | 一手源码 |
| VS Code | **1.138.0**，build `7debcd0e2a`，commit `7debcd0e2acdea1c52de81bf9ee1620444407dda` | 实测 |
| VS Code 安装 | `C:\Users\Admin\AppData\Local\Programs\Microsoft VS Code`，应用载荷 `7debcd0e2a/resources/app`，`Code.exe` 可直接作 `vscodeExecutablePath` | 实测 |
| Node / npm | 24.14.1 / 11.11.0 | 实测 |
| PoC 扩展 | `poc/editor-review`，`engines.vscode ^1.137.0`，`enabledApiProposals: ["editorInsets"]`，`@types/vscode 1.137.0`、`@vscode/test-electron 3.1.0`、`typescript 7.0.2` | 一手源码 |
| PoC 运行参数 | `--enable-proposed-api=agentdock.agentdock-editor-review-poc`（方案 C 必需）；集成测试用 `VSCODE_EXECUTABLE`；`agentReview.autoApply` 默认 `true` | 一手源码 |
| PoC 结果 | 13 个纯逻辑单测；`npm run test:integration` → `apply suite: all assertions passed` / `integration suite passed`（`Exit code: 0`） | 实测 |
| 点击→消失延迟 | 装饰 25 ms；Comments 标题栏按钮 41 ms；CodeLens 动作行 393 / 421 ms（两次） | 实测 |
| 版本漂移 | 本次验证期间本机由 1.137.0（`645f29cc31`）自动升级到 1.138.0（`7debcd0e2a`），全部结论在 1.138.0 复测通过 | 实测 |

## 1. ACP 协议面

来源：`agent://AcpSurface`（spec 站 + schema 全文 + CHANGELOG + registry）。

| 项 | 事实 |
|---|---|
| 稳定版本 | **v1 stable**，wire version 整数 `1`；JSON-schema artifact release **1.8.0（2026-09-17）**。v2 为 **Draft**（2026-07-20 公布），明确「Don't ship it by default in production」（`/announcements/acp-v2-draft`） |
| 仓库 | 从 `zed-industries/agent-client-protocol` 迁至中立组织 **`agentclientprotocol/agent-client-protocol`**（docs `agentclientprotocol.com`；4.3k★，2,238 commits） |
| v1 近期稳定化 | 会话配置项（2026-02-04）、`session/list`（03-09）、`session/resume`+`close`（04-22/23）、`logout`（05-21）、`additionalDirectories`（06-01）、message ids / `usage_update` / `session/delete`（06-05）、`model_config` category（06-24）、`$/cancel_request`（06-29）、boolean 配置项（07-06）、elicitation（07-22）、tool-call `name`（09-17） |
| v1→v2 破坏性变更 | `authenticate`→`auth/login`；`logout`→`auth/logout`；`session/load` **删除**（改用 `session/resume`+`replayFrom`）；`session/set_mode` 删除（由 configOptions 取代）；`fs/*`+`terminal/*` **删除** |

**客户端→agent 方法（agent 实现）**：`initialize`（`protocolVersion` 必填、`clientCapabilities`、`clientInfo{name,title,version}`）；`authenticate{methodId}`；`logout`（受 `agentCapabilities.auth.logout` 门控）；`session/new{cwd,mcpServers[],additionalDirectories?}` → `{sessionId,modes?,configOptions?}`；`session/load`（需 `loadSession`，返回前以 `session/update` 重放全部历史）；`session/resume`（需 `sessionCapabilities.resume`，恢复上下文但**不重放**）；`session/list{cwd?,cursor?}` → `sessions[]{sessionId,cwd,title,updatedAt}`+`nextCursor`；`session/close`；`session/delete`；`session/prompt{sessionId,prompt:ContentBlock[]}`（**整个 turn 期间保持 pending**，以 `stopReason` 结束）；`session/set_mode`（已废弃）；`session/set_config_option{configId,value}`（返回**完整**配置状态）。

**agent→客户端方法（客户端实现）**：`session/request_permission`（基线，永远可用）；`fs/read_text_file`（`fs.readTextFile`；返回含未保存编辑器状态的 `content`）；`fs/write_text_file`（`fs.writeTextFile`；文件缺失时客户端 **MUST** 创建）；`terminal/create`、`terminal/output`、`terminal/wait_for_exit`、`terminal/kill`、`terminal/release`（`terminal:true`）；`elicitation/create`（`elicitation.{form,url}`）。

**通知**：`session/update`（agent→client，承载全部进度：消息块、工具调用、plan、命令、模式、配置、会话信息、用量；**无响应**）；`elicitation/complete`；`session/cancel`（client→agent；agent MUST 以 `cancelled` 结束 `session/prompt`）；`$/cancel_request`（双向；2026-06-29 稳定；响应为合法结果或错误 `-32800`）。

| 扩展机制 | 事实 |
|---|---|
| `_meta` | 「All types in the protocol include a `_meta` field with type `{ [key: string]: unknown }`」——覆盖请求/响应/通知乃至嵌套类型（content block、tool call、plan entry、capability 对象） |
| 自定义方法 | 以 `_` 开头的**方法名被保留**给扩展；请求必须被应答（否则 `-32601`），无法识别的自定义通知 SHOULD 忽略；文档示例 `_zed.dev/workspace/buffers` |
| 自定义能力 | SHOULD 在 capability 对象的 `_meta` 中广播，例如 `agentCapabilities._meta."zed.dev".workspace` |
| 硬限制 | 「Implementations **MUST NOT** add any custom fields at the root of a type that's part of the specification.」根键仅 `traceparent`/`tracestate`/`baggage`（W3C trace context）例外 |
| 能力协商 | 「Clients and Agents **MUST** treat all capabilities omitted in the `initialize` request as **UNSUPPORTED**」 |
| MCP 直通 | (1) 客户端提供的 MCP server：`session/new|load|resume` 的 `mcpServers[]`（stdio 必选，HTTP/SSE 受 `mcpCapabilities` 门控）；(2) MCP-over-ACP（RFD，unstable）：`"type":"acp"` 传输 + `mcp/connect|message|disconnect`，受 `mcpCapabilities.acp` 门控 |

**LSP 级能力缺口（逐项，按 5,960 行生成的 v1 schema 全文 grep 验证：`textDocument`/`codeAction`/`diagnostic`/`hover`/`references`/`symbol`/`workspace/` 命中数为 0）**

| 能力 | 今天可经 ACP 表达？ | ACP 提供的替代 |
|---|---|---|
| definition / references / symbols / rename / code actions / diagnostics | **NO** | 无：无方法、无能力、无内容类型 |
| 跑测试 | **NO**（无专用方法） | 只有通用 `terminal/create`（且 v2 将其删除）；或客户端提供的 MCP 工具 |
| 调试 | **NO** | spec 中无（`acpdbg` 是第三方 LLDB→agent 连接器，不是 ACP 方法） |
| 任意 IDE 工具 | **未标准化** | (a) 客户端提供的 MCP server（可移植、已落地：Zed「Zed-configured MCP servers may be forwarded to External Agents over ACP」）；(b) `_` 前缀扩展方法（不可移植）；(c) proxy chains RFD（draft） |
| 内联编辑预测 | **仅 RFD** | Next Edit Suggestions：`nes/start|suggest|close` + LSP-3.17 `Position` 语义，非稳定 |

**变更上报（文件修改如何抵达客户端）**：只能经 `session/update` → `tool_call` / `tool_call_update`，载体为 `ToolCallContent[]` 的三种变体：`content`（包 MCP `ContentBlock`）、`diff`、`terminal`。`diff` 形状 `{type:"diff", path, oldText|null, newText}`（`oldText` 为 null 表示新文件）。v1 无法区分「删除」与「空文件」，也无法表达 move/copy/binary（RFD `diff-delete`；v2 另有 `diff-file-states`）。另有 `ToolCallLocation{path,line}` 用于 follow-along。**没有 per-turn changeset**：无 turn id、无聚合对象；客户端只能在 `session/prompt` 发出到其 `stopReason` 返回之间缓冲 diff 来**启发式**近似，而规范明确允许 `session/update` 出现在 turn 之外。v2 按设计加剧这一点：「a prompt response is the indication that the message was acknowledged by the agent, **not the end of the turn**」；v2 新增结构化 `changes[]`（`operation: add|delete|modify|move|copy` + 可选 `patch`（`git_patch` 文本）），但仍按 tool call 归属、仍无 turn 分组。

**Turn / session 语义**：turn = 一个 `session/prompt` 请求的存续期，以 `stopReason ∈ end_turn|max_tokens|max_turn_requests|refusal|cancelled` 结束；中间信号 `agent_message_chunk` 的**可选** `messageId` 只是消息级而非 turn 级；`tool_call*` 不带 turn id。session = `sessionId` + 独立上下文；`cwd` 建立后不可变；`additionalDirectories` 扩展根集合；单连接可多会话并发。

**权限**：调用方是 agent，裁决方是「用户经客户端」（客户端可自动允许/拒绝）；参数 `sessionId`、`toolCall`（`ToolCallUpdate`）、`options: PermissionOption[]`；`kind ∈ allow_once|allow_always|reject_once|reject_always`（仅作图标/UI 提示）；响应 `{outcome:{outcome:"selected",optionId}}` 或 `{outcome:{outcome:"cancelled"}}`。**选项集合由 agent 撰写**——IDE 只能决定存在哪些选项、标签/顺序、是否自动应答，无法注入自己的策略分类、持久规则或作用域。（v2/RFD 更丰富：必填 `title`、可选 `description`、可扩展 `subject`，仅 draft。）

**生态（SDK 版本 @ 2026-09-18）**：Rust 运行时 `agent-client-protocol` crates.io **2.1.0**（Apache-2.0；1.0 于 2026-06-25）；Rust 类型 `agent-client-protocol-schema` **1.8.0**；TypeScript `@agentclientprotocol/sdk` **1.4.0**（Apache-2.0；含 `experimental/v2`、ws/http 传输）；Python `agent-client-protocol` **0.12.1**（PyPI `license: null`，`[unverified]`；Python ≥3.10,<3.15）；Kotlin `com.agentclientprotocol:acp` **0.1.0-SNAPSHOT**；Java `acp-core`/`acp-agent-support`/`acp-websocket-jetty` **0.16.0**（Java 17+）。**ACP Registry** 2026-03-09 稳定，索引 `https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json`（每小时 cron 更新）。

> 缺口：OMP 未出现在 ACP 的 agents 列表、registry 或 libraries 中，且无一手 OMP 文档提到 ACP → `agent://AcpSurface` 记为 `[INFERENCE]`「OMP 今天没有公开 ACP 实现」（**本机实测已推翻，见 `冲突与修正` (d)**）。Python/Java/Kotlin 的许可证与发布状态无法独立核实（`search.maven.org` 对 `com.agentclientprotocol` 返回 0 结果；GitHub API 403 导致无法确认各 repo 的 SPDX）。第三方客户端/agent 的完整数量与版本无法验证（列表由文档维护、registry 小时级更新）。`*/providers/*`、`mcp/connect|message|disconnect`、`proxy/*`、session compaction/fork、plan 操作、end-turn token usage、`nes/*`、session notices 均只在 RFD/unstable 中存在，不在稳定 v1 schema 中。**ACP 无法**独立确立：任何 LSP 级能力的语义、任何 turn 边界的服务端保证、任何跨 IDE 的扩展命名空间互操作（`_meta."zed.dev"` 是文档中唯一示例，无共享注册表）。

## 2. OMP（harness）接口面

来源：`agent://OmpSurface`（本机安装的 `src/`、`package.json`、`omp://` 内嵌文档 131 个文件、GitHub 页面）。该 scout **没有 shell**，其 `omp --help`/`--version` 类结论来自源码与文件系统；本台账 §0 的握手补上了运行时证据。

| 字段 | 值 |
|---|---|
| 命令 / 包 | `omp`（`omp launch` 为默认命令）；`@oh-my-pi/pi-coding-agent`，`bin: { omp: dist/cli.js }` |
| 厂商 / 许可 | **Stencil Labs, Inc.**（贡献者 Mario Zechner）/ **MIT** |
| 站点 / 仓库 | `https://omp.sh`；`git+https://github.com/can1357/oh-my-pi.git`，目录 `packages/coding-agent`；公开仓库 31.7k★ / 3.3k forks / 23,940 commits |
| 溯源 / 运行时 | 「Fork of Pi by @mariozechner」（`badlogic/pi-mono`）；Bun ≥ 1.3.14，原生 Rust core `crates/*` → `@oh-my-pi/pi-natives` |
| 分发 | `omp.sh/install[.ps1]`、Homebrew `can1357/tap/omp`、`bun install -g`、Nix flake、mise；`omp update --stable/--canary` |

**CLI**：`src/cli-commands.ts` 注册 42 个命令 + 隐藏 `__complete`（描述来自 `src/cli/command-help.ts`，非 `--help` 输出）。分组：Agent `launch`/`acp`；Auth `auth-broker`/`auth-gateway`/`token`；模型与配置 `models`/`config`/`tiny-models`；扩展 `plugin(s)`/`install`/`agents`；会话与协作 `join`/`share`/`worktree|wt`/`ps`；信息 `stats`/`usage`/`bench`/`gallery`/`render`/`grievances`；杂项 `commit`/`compress`/`cleanse`/`grep`/`read`/`search|q`/`shell`/`ssh`/`say`/`ttsr`/`update`/`gc`/`setup`/`completions`/`browser-relay`/`git`/`images|img`/`dry-balance`/`if-bench`。

**传输模式** `--mode <text|json|rpc|acp|rpc-ui>`：

| 模式 | 事实 |
|---|---|
| `json` | 结构化事件流，供 headless 消费（`omp -p --mode json`） |
| `rpc` | stdio 上的换行 JSON-RPC。ready 帧逐字：`{"type":"ready","protocolVersion":1,"supportedProtocolVersions":[1,2],"maxFrameBytes":1048576,"maxReassembledFrameBytes":67108864}`；1 MiB 物理帧；v2 经 `{"type":"negotiate_protocol","protocolVersion":2}` + base64 `rpc_chunk` 重组 |
| `rpc` 命令 | `prompt`、`steer`、`follow_up`、`abort`、`abort_and_prompt`、`new_session`、`get_state`、`set_fast_mode`、`set_model`、`cycle_model`、`get_available_models`、`set_thinking_level`、`compact`、`bash`、`get_session_stats`、`switch_session`、`branch`、`get_messages_page`、`set_todos`、**`set_host_tools`**、**`set_host_uri_schemes`**、`set_subagent_subscription`、`get_subagents` |
| `rpc` 事件 | `agent_start/end`、`turn_*`、`message_*`、`tool_execution_start/update/end`、`auto_compaction_*`、`auto_retry_*`、`model_changed`、`thinking_level_changed`、`ttsr_triggered`、`extension_ui_request`、`host_tool_call`、`host_uri_request` |
| `acp` | ACP v1 server over stdio（等价于 `acp` 子命令）；帮助文本「Run Oh My Pi as an ACP (Agent Client Protocol) server over stdio」；另有隐藏 `--acp-terminal-auth` |
| ACP 实现 | `ndJsonStream` / `AgentSideConnection` 来自 `@oh-my-pi/pi-utils/acp`（`src/modes/acp/acp-mode.ts`）；方法集见 `src/modes/acp/acp-agent.ts`：`initialize`、`authenticate`、`newSession`、`loadSession`、`listSessions`、`resumeSession`、`unstable_forkSession`、`closeSession`、`setSessionMode`、`setSessionConfigOption`、`prompt`、`cancel` |
| 客户端库 | TS `RpcClient`（`modes/rpc/rpc-client`）、Python `omp-rpc` |

**配置与偏好层**（README §5 的目标面）：

| 层 | 路径 / 机制 | 注 |
|---|---|---|
| 全局设置 | `~/.omp/agent/config.yml`（+ 遗留 `config.yaml`） | `omp config list/get/set/reset/path`，schema 驱动 |
| 项目设置 | `<cwd>/.omp/config.yml`、`.omp/settings.json` | 仅 cwd，**不向上遍历**；对象深合并，**数组整体替换** |
| 覆盖层 | `PI_CONFIG_FILES`，随后可重复 `--config <file>` | 仅进程；严格模式（缺失/非法 = 硬错误）；`--config` 被 `launch`、`acp`、`models` 接受 |
| 优先级 | `defaults ← global ← project ← PI_CONFIG_FILES ← --config ← runtime` | runtime = `--model/--smol/--slow/--plan/--thinking/--approval-mode/--api-key/…` |
| 模型角色 | `modelRoles.{default,smol,slow,vision,plan,commit,tiny,task,advisor}`；值可带 `:minimal…:max`；`modelRoleStorage: global\|project` | IDE「模型偏好」的自然落点 |
| 自定义 provider/model | `~/.omp/agent/models.yml`（`providers.<id>`） | `baseUrl`、`api`（9 值，含 `openai-responses`、`anthropic-messages`、`google-generative-ai`、`pi-native`）、`apiKey`（环境变量名或字面量，`!cmd`）、`headers`、`authHeader`、`auth: apiKey\|none\|oauth`、`discovery.type: ollama\|llama.cpp\|lm-studio\|openai-models-list\|proxy\|litellm`、`modelOverrides`、`compat{...}`（含 `reasoningEffortMap`、`thinkingFormat`、`supportsReasoningEffort`） |
| 思考等级 | `defaultThinkingLevel`（默认 `high`）、`thinkingBudgets.{minimal…max}`、`--thinking`、`providers.autoThinkingMaxEffort` | 阶梯 `off\|minimal\|low\|medium\|high\|xhigh\|max\|auto` |
| 凭据 | 顺序：`--api-key` → `models.yml apiKey` → stored OAuth → `/login` stored key → env/`.env` → 其他 stored → `models.yml` fallback；存储 `~/.omp/agent/agent.db` 或 auth-broker | `.env` 链：进程 → `<cwd>/.env` → `~/.omp/agent/.env` → `~/.omp/.env` → `~/.env`；`OMP_*` 镜像到 `PI_*` |
| provider 开关 | `enabledModels`、`enabledProviders`、`disabledProviders`（可路径作用域） | 在凭据之前检查 |
| profile | `omp --profile <name>`、`OMP_PROFILE`/`PI_PROFILE` → `~/.omp/profiles/<name>/agent/*` | 隔离用户级配置（含 MCP） |

**扩展/注入机制（IDE 侧可用的路径）**：客户端 MCP（`.omp/mcp.json`、`~/.omp/agent/mcp.json`、`.omp/.mcp.json`、根 `mcp.json`/`.mcp.json`；并导入 `.claude/`、`.codex/`、`.gemini/`、`.cursor/`、`.vscode/mcp.json`、`opencode.json`）；**host tools over RPC**（`set_host_tools`（name/label/description/JSON-Schema params、`hidden`、`loadMode`）→ OMP 发 `host_tool_call` → 宿主回 `host_tool_result`/`host_tool_update`，abort 时 `host_tool_cancel`）；**host URIs over RPC**（`set_host_uri_schemes`（`writable`/`immutable`）→ `host_uri_request`/`host_uri_result`，`security://` 保留）；扩展（`(pi: ExtensionAPI) => …`，`registerTool`/`registerCommand`/`registerProvider`/`registerFileWriteFallback`/`registerFileDeleteFallback`/`on(event)`，目录 `<cwd>/.omp/extensions`、`~/.omp/agent/extensions`，`--extension`/`-e`；**进程内 TS 模块，无沙箱**）；自定义工具（`~/.omp/agent/tools`、`<cwd>/.omp/tools`）；SDK `options.customTools`/`additionalExtensionPaths`/`preloadedExtensions`；遗留 hooks（`.omp/hooks/pre|post/*.{ts,js}`）；插件/市场（`omp plugin …`、`~/.omp/plugins`）；子 agent（`task` 工具 + `AgentRegistry` + `hub` + `agent://`/`history://`）。**ACP 不暴露任何工具注册方法**——其客户端能力集只有 file/terminal/permission/elicitation（`ClientBridgeCapabilities { readTextFile, writeTextFile, terminal, requestPermission }`）。

**变更上报**：ACP 客户端侧，diff 由 `src/modes/acp/acp-event-mapper.ts:728-758, 240-266` 从 `details.perFileResults[].{path,oldText,newText}` 逐文件发出（回退到 `details.{path,oldText,newText}`；`isError` 时跳过），tool-call `locations` 把 `path`/`file`/`paths`/`oldPath`/`newPath`/`from`/`to`/`source`/`destination`（绝对路径）解析到 cwd。写入侧 `src/tools/acp-bridge.ts`：客户端广播 `fs.writeTextFile` 时写模式工具改走 `fs/write_text_file` 以更新编辑器缓冲，OMP **再读回文件**并上报 `driftedFromRequest`（检测客户端 format-on-save）；内部 URL 与 plan 文件跳过该桥。审批侧 `src/session/acp-permission-gate.ts`：受门控工具 `{bash, edit, delete, move}` → `session/request_permission`，选项 `allow_once`/`allow_always`/`reject_once`/`reject_always`；通用审批走 form elicitation；`edit` 的删除/移动经 `editInspect` 识别。SDK 侧另有 `session.subscribe(AgentSessionEvent)`、`toolNames`/`restrictToolNames`、隐藏 `yield` 工具、`setActiveToolsByName`；会话为 cwd 下的 `.jsonl` 文件，完成信号是 `agent_end.isTerminal !== false`。

> 缺口：`omp://` 共 131 个文件但**没有 `acp.md`**——ACP 只作为 `approval-mode.md#acp-sessions` 的子节加源码存在（`[INFERENCE]`：ACP 支持相对 TUI/RPC 是次要路径）。OMP 内嵌（vendored）的 ACP SDK 版本**不可知**（`@oh-my-pi/pi-utils` 被打进 `dist/cli.js`，无独立 `node_modules` 目录），因此 OMP 具体实现到哪一版 ACP 无法从源码断定。未探测：`omp auth-broker`/auth-gateway 协议、`collab`/`my.omp.sh`、DAP/LSP 配置、SDK 运行时除 `setActiveToolsByName` 之外的工具集变更。`vivi` provider 不是 OMP 原生 provider（`providers.md` 无此 ID），是本机私有自定义端点。**AgentDock 目前没有任何 `.omp/`**——项目级还没有接线，任何「统一偏好层」都得写 `~/.omp/agent/{config.yml,models.yml,mcp.json}`（或 profile）和/或 `<cwd>/.omp/*`。该 scout 的 shell 缺失也使 `omp --help` 原文、`omp models` 输出、live ACP/RPC 握手未经它本人验证（本台账 §0 补齐了 ACP 部分）。

## 3. VS Code 渲染与 SCM API 面

来源：`agent://VscodeReviewApis`。验证基准：本机 `<install>/7debcd0e2a/resources/app/out/vscode-dts/vscode.d.ts`（745.5 KB / 21,238 行；`app/package.json` = `version 1.138.0`、`distro 9edcf676…`）+ 上游 tag `1.138.0` 源码。所有 `L…` 行号指该 d.ts。

**装饰（`TextEditorDecorationType` 族）**：`TextEditorDecorationType`（L740，仅 `key`/`dispose()`，不透明句柄）；`ThemableDecorationRenderOptions`（L987）含 `before`/`after`（L1107/1112）、`textDecoration`（L1065）、`gutterIconPath`（L1090）、`gutterIconSize`、`overviewRulerColor`（L1102）；`ThemableDecorationAttachmentRenderOptions`（L1119）的 `contentText` 类型是**窄的 `?: string`**（L1123），且**换行不生效**（真实 `\n` 会让元素根本不生成，见 microsoft/vscode#63600）；`DecorationRenderOptions`（L1174）含 `isWholeLine`、`rangeBehavior`（L1185，默认 `OpenOpen`，逐字 L1182-3）、`overviewRulerLane`（L1190）；`DecorationOptions`（L1206）的 `range` **不得为空**（L1208），`hoverMessage`（L1214）是**唯一**装饰悬停通道；`DecorationInstanceRenderOptions`/`ThemableDecorationInstanceRenderOptions`（L1228/1243）的实例级 `after.contentText` 存在已知渲染错乱（microsoft/vscode#242764）；`OverviewRulerLane`（L780：Left=1, Center=2, Right=4, Full=7）。

**布局事实**：d.ts 中**没有任何**装饰字段用于保留行/空间；PoC 实测 `display:block`/`width:100%` 附件会**盖住**下方真实行（`RESULTS.md` P3/P7；`.view-line` 计算高度固定 19 px，`overflow: visible`）。

**动作面（编辑器内可点击 UI）**：`CodeLensProvider`（L2875）+ `window.registerCodeLensProvider`——渲染在**独占的 view-zone 行**上；`CommentController`（L17756）/`CommentThread`（L17532）/`Comment`（L17643）——widget 是 **ZoneWidget view-zone 区块**（真实占位），`contextValue` 驱动 `comments/commentThread/title` 菜单（`when: commentThread == …`，逐字 L17578-99），回复经 `comments/commentThread/context`（`CommentReply`，L17722）；`QuickPickItem.buttons`（L1955）/`QuickPickItemButtonEvent`（L13408）——按钮**只在 `window.createQuickPick` 上渲染，`showQuickPick` 不渲染**（逐字 L1956-8）；`CodeAction`/`CodeActionProvider`（L2668/2745）——**受 range/selection 限制**，无自由行内按钮；`TreeItem.command`（L12344）；`InlayHintLabelPart`（L5582）的 `.command`（L5607）**自 1.65 起稳定**（release notes v1_65「The Inlay Hint provider API is now finalized」）——「The editor renders parts with commands as clickable links」；`InlayHint`（L5624）/`InlayHintsProvider`（L5703）自带 `textEdits`（双击应用）。

**刷新节流（引源码，tag 1.138.0）**：`src/vs/editor/contrib/codelens/browser/codelensController.ts` 中 `debounceService.for(_languageFeaturesService.codeLensProvider, 'CodeLensProvide', { min: 250 })`；`provider.onDidChange(() => scheduler.schedule())`——`onDidChangeCodeLenses` 只**调度**、不重绘；`_resolveCodeLensesScheduler = new RunOnceScheduler(..., this._resolveCodeLensesDebounce.default())`（min 250）；触发条件为内容变更、聚焦、provider `onDidChange`，**失焦取消**；`_updateLensStyle` 通过 `editor.changeViewZones(...)` 重排每一行（`codeLensHeight = fontSize*lineFactor|0`）。`src/vs/editor/common/services/languageFeatureDebounce.ts`：`min = config?.min ?? 50`、`max = config?.max ?? min**2`，生产默认 `(min*1.5)` ≈ **375 ms**，之后是 `SlidingWindowAverage(6)` 并 clamp 到 `[min,max]`；dev 构建为 `NullDebounceInformation(min*1.5)` = 恒定 375 ms。→ 与 PoC 实测 393/421 ms 吻合。

**Comments widget 定位（引源码，tag 1.138.0）**：`commentThreadZoneWidget.ts` 的 `arrowPosition(range)` 返回 `{ lineNumber: range.endLineNumber, column: … }`，显示/展开调用 `this.show(this.arrowPosition(this._commentThread.range), 2)`；`ZoneWidget._showImpl`（`zoneWidget.ts`）以 `accessor.addZone(...)` 插入 `afterLineNumber: position.lineNumber` 的 view zone → widget 渲染在线程 `range.endLineNumber` **下方**并顶开后续内容；`CommentThread.range` 文档（L17538-40）：「The thread icon will be shown at the last line of the range」。

**Diff / SCM**：`SourceControl`（L16583）/`SourceControlResourceGroup`（L16529）/`SourceControlResourceState`（L16485）/`scm.createSourceControl`（L16686）——面板条目，`resourceState.contextValue` → `scm/resourceState/context`（逐字 L16506-20）；`SourceControl.quickDiffProvider`（L16618）/`QuickDiffProvider.provideOriginalResource`（L16428）——**只给装订线 `+/-` 与概览标尺，不是行内 diff 文本**；`vscode.diff` 内建命令——参数按 commands 参考为 `left`、`right`、`title`（**无文档化的 options 参数**）；`TextDocumentContentProvider`（L1850）+ `registerTextDocumentContentProvider`（L14266）——「allows to add readonly documents」，按 `Uri.scheme` 供整篇虚拟内容；`FileSystemProvider`（L9603）+ `registerFileSystemProvider`（L14517）含 `options.isReadonly`（L14526，**since 1.23**）——readonly scheme 可服务旧版本，写会抛错，`isReadonly` 可带 `MarkdownString` 理由，但 provider 级 readonly 时**没有 per-URI 粒度**（`FileStat` 注 L9445-8）；`TextEditor.diffInformation`/`TextEditorDiffInformation`/`onDidChangeTextEditorDiffInformation` —— **proposed**（本地 d.ts 中不存在，自 2019 起 #84899），提供机器可读 `changes[]`（Addition/Deletion/Modification）+ `isStale`，并新增 `SourceControlDiffInformationProvider`/`window.createSourceControlDiffInformation(uri)` 支持非文本编辑器（webview）文档；`TabInputTextDiff`（L19182，1.67 期）。

**能参与布局的非可编辑内联内容（穷举，PoC 关键）**

| 机制 | 稳定？ | 参与布局 | 形态/限制 |
|---|---|---|---|
| 装饰 `before`/`after` 附件 | 稳定 | **否** | 行内绝对定位、压盖邻行；`contentText` 单行（P1–P4、#63600、#242764） |
| `isWholeLine` 背景/边框 | 稳定 | 否（仅绘制） | 只做高亮 |
| **CodeLens** | 稳定 | **是**（独占 view-zone 行） | 文本 + `Command` 链接；高度被钉为 `codeLensHeight`；非自由 markup |
| **InlayHint**（+`InlayHintLabelPart.command`） | 稳定（1.65） | 是（行内，推开文本） | 仅文本提示，无块内容 |
| **Comments widget** | 稳定 | **是**（`range.endLineNumber` 下方的 ZoneWidget 区块） | 真正的块（标题、内边距、可折叠）；注释样式而非编辑器行；会顶开周围布局 |
| `window.createWebviewTextEditorInset`（`WebviewEditorInset`） | **proposed** `editorInsets`（#85682，2019-11-27，至今未改） | 是（N 行） | 任意 HTML/webview 当真实行；**不能上架 Marketplace**；`line`/`height` 为 `readonly`（移动须重建）；不被 Ctrl+F/选择覆盖 |
| 自定义编辑器 / Webview panel | 稳定 | n/a | 替换整个编辑器，非内联 |
| `TextDocumentContentProvider` | 稳定 | n/a | 只读整篇文档（用于 diff 标签页），非内联 |

→ 结论：**没有稳定 API 能在普通 `TextEditor` 内产出「多行、不可编辑、参与布局的代码行」**；稳定可达形态精确为三种：CodeLens 行、InlayHint 行内文本、Comments 区块。

**1.12x–1.13x 新增**：`editorInsets` 在 1.138.0 仍为 proposed（文件与 2019 年逐字节相同）；`textEditorDiffInformation` 仍为 proposed（新增 webview 友好的 provider）；新 proposed `vscode.proposed.agentEditorComments.d.ts`、`vscode.proposed.activeComment.d.ts`（面向 agent 的编辑器注释提案）；产品层 1.137「Smart diff editor layout」「Binary files in multi-file diffs」已发布，但未伴随新的稳定扩展 API。

> 缺口：权威 d.ts 中**没有 `@since`**（grep `@since`/`@proposed` 命中 0），因此稳定/提案与「自哪个版本」**无法从权威文件机器推导**；本节的 Since 值只在有 release note/文档引用处给出（InlayHint 1.65、`registerFileSystemProvider` 1.23、`workspace.fs` 1.37），其余标「long stable」而**具体版本未验证**（`CommentController`、SCM/`quickDiffProvider`、装饰、CodeLens 的起始版本本地文件均未声明）。提案 API **不在本机应用载荷内**（只发 `vscode.d.ts`），其形状验证依赖上游 main/tag。无稳定 `TextEditor`/`window` API 能添加 view zone、自定义 DOM 或任意行内 markup。无 per-decoration 布局成员；`contentText` 不能含换行。`vscode.diff` 的文档化参数只有 `left/right/title`。多个 inset / 数十个 webview 的开销、以及 inset 内 `command:` 链接是否可用，**未验证**（PoC 将其否定结论标为不可靠）。`comments/commentThread/title` 是**贡献菜单 id**（扩展点）而非 d.ts 符号，其 `when` 键 `commentThread`/`commentController` 记录在 `CommentThread.contextValue`/widget 上下文（d.ts L17578-99）。

## 4. VS Code agent/工具/会话 API 面

来源：`agent://VscodeAgentApis`。本机安装 `C:/Users/Admin/AppData/Local/Programs/Microsoft VS Code/7debcd0e2a/resources/app/package.json` → `"version":"1.138.0"`、`"distro":"9edcf676f14a3185aebf09cedb58013c8348e31d"`；**安装内不含任何 `vscode.proposed.*.d.ts`**，故 proposed 事实取自 `microsoft/vscode@main`（可能与 1.138 tag 不同）。

**验收问题**：「今天扩展能否通过任何稳定机制，把 IDE 能力作为可调用工具暴露给外部（非 VS Code）agent？」→ **No**。所有稳定路径都终止在 extension host / chat UI 内部。近失机制按可用性降序：(1) **AHP Agent Host**——客户端**可以**贡献工具（「Connected clients can also contribute tools… The Agent Host adds those definitions to the active session and routes a tool call back to the client that contributed it」，`code.visualstudio.com/docs/agents/concepts/agent-host`），但**从 VS Code 扩展注册第三方 harness adapter 或 tool provider 不是文档化的扩展 API**，harness 均为一手（Copilot/Claude/Codex）；(2) **proposed `chatSessionsProvider`**——扩展可注册 chat 会话类型并拥有 `requestHandler`（ext host 内跑任意 agent loop，含 ACP），但 proposed ⇒ 不能上架、无稳定性承诺；(3) **扩展自建 MCP server**——ext host 有 Node，可自行 spawn MCP stdio/HTTP server 服务第三方；但 `contributes.mcpServerDefinitionProviders`/`lm.registerMcpServerDefinitionProvider` 只把 VS Code 当 **MCP client**，**没有**把 `languages.*`/`tests`/`debug` 变成对外 MCP 工具的编辑器 API；(4) `commands.executeCommand`/`getCommands`——广而稳定的进程内命令面，无外部 IPC；(5) `lm.registerLanguageModelChatProvider`——反方向，VS Code 消费你的模型；(6) CLI——`code chat <prompt>`（1.102 起）在 cwd 启动 chat 会话，`code agent host` 启动独立 AHP server，两者都不接受外部工具注册表。

| API / 贡献点 | 稳定? | Since | 给什么 / 不给什么 |
|---|---|---|---|
| `lm.registerTool` / `lm.tools` / `lm.invokeTool` | **稳定** | pre-1.99 已 finalize（`updates/v1_99`）；1.138 d.ts L20777/20783/20811 | 任意扩展可枚举并调用所有已注册工具；**无外部进程访问**；`invokeTool` 输入只按声明 schema 校验；结果仅 text/tsx parts |
| `contributes.languageModelTools` | **稳定** | 同上 | 静态声明 `name`/`modelDescription`/`inputSchema`/`tags`/`canBeReferencedInPrompt`/`toolReferenceName`/`icon`/`when`；运行时增删须用 `lm.registerTool` |
| `lm.selectChatModels` / `LanguageModelChat.sendRequest` | **稳定** | 基础 LM API（finalize 版本未验证） | 编程式模型访问 + 用户同意流程；`LanguageModelError`（`NoPermissions`/`Blocked`/`NotFound`）；**不支持 system messages**；同意 ⇒ 必须用户发起 |
| `lm.registerLanguageModelChatProvider` | **稳定** | **1.104**（「we finalized the `LanguageModelChatProviders` API」） | 扩展把模型发布进 VS Code 选择器；**不是** agent loop/会话模型 |
| `lm.registerMcpServerDefinitionProvider` | **稳定** | **1.101**（「Extensions can now publish collections of MCP servers」） | 贡献 VS Code 去消费的 MCP server；**单向入内**，不是 VS Code 当 server |
| `chat.createChatParticipant` / `ChatRequestHandler` | **稳定** | chat participant API（1.90 期，近似） | `@` 触发；`ChatRequest.model`（用户选定）+ `toolReferences`；经 `request.model.sendRequest(...,{tools})`+`lm.invokeTool` 做 tool calling；**无会话列表/管理，非 VS Code 调用方不可见** |
| `ChatRequest.toolInvocationToken`（`ChatParticipantToolToken`） | 稳定但**被阉割** | — | 1.138 d.ts **L21070：`export type ChatParticipantToolToken = never;`**，真实 token 类型只在 `chatParticipantPrivate` 提案里 |
| `chatSessionsProvider`（proposed） | **proposed** | 1.138 未稳定 | `chat.registerChatSessionContentProvider(scheme, provider, defaultChatParticipant, capabilities)` + `ChatSession.requestHandler`（**L441 `ChatSession`、L487 `requestHandler`、L605 register**，文件 855 行）：注册一等公民 chat **会话类型**，由扩展宿主跑 agent loop；**不能上架，可能 break，无 AHP/远程语义保证** |
| `chatParticipantAdditions`/`chatParticipantPrivate`（proposed） | **proposed** | — | 内置件使用的 session/turn 管道（`ChatRequestTurn2`、`ChatResponseTurn2`、`sessionResource`、`permissionLevel`、`subAgentInvocationId`、工具调用流/终端/MCP/todo UI parts、编辑会话动作）；私有内置面，非公开契约 |
| `agentsWindow*`/`agentSessionsWorkspace`/`agentEditorComments`（proposed） | **proposed** | — | agents 窗口激活与配置开关、`workspace.isAgentSessionsWorkspace`；与会话/harness 注册无关 |
| `LanguageModelTool.prepareInvocation` → `PreparedToolInvocation.confirmationMessages` | **稳定** | 随 tool API | 工具自撰内联确认（「Continue/Cancel」，可「Always Allow」）；确认**只发生在 VS Code chat UI**，无程序化审批钩子、无宿主侧策略委派 |
| `workspace.isTrusted` / `onDidGrantWorkspaceTrust` | **稳定** | Workspace Trust（1.56 期，近似） | 仅工作区级信任门，无 per-tool/per-command 审批（L14532、L14537） |
| `authentication.registerAuthenticationProvider`/`getSession` | **稳定** | long stable | 扩展提供/消费认证会话（MCP OAuth 用）；**不是**权限机制（L18184） |
| 能力原语：`languages.*`、`commands.executeCommand`、`languages.createDiagnosticCollection`、`tests.*`、`debug.*`、`TerminalShellIntegration`（`executeCommand`、退出码、输出流）、`workspace.fs`、`workspace.applyEdit` | **稳定** | long stable（shell integration ~1.93；tests ~1.59；`workspace.fs` 1.37；debug 1.0，版本近似） | README §6 列出的「IDE capability」**在扩展内部**全部可调用；**全部在进程内，无一可被外部寻址**（d.ts L7721/7861/11023/14149/14822/17288/18276） |
| `code chat`、`code agent host` CLI | 稳定功能（非扩展 API） | `chat` 1.102；`agent host` 2026-08 | 外部进程可在 cwd 启动 chat 会话，或启动带连接令牌的独立 AHP host over WS；**无法注册外部工具进 chat 会话** |

**MCP：VS Code 是 server 吗？** 文档严格把 VS Code 定位为 MCP **client/host**：「Visual Studio Code implements the full MCP specification, enabling you to create MCP servers that provide tools, prompts, and resources for extending the capabilities of AI agents in VS Code.」（`/api/extension-guides/ai/mcp`）。消费的传输：stdio、Streamable HTTP、遗留 SSE；消费的能力：tools、prompts、resources+templates、elicitation、sampling、OAuth（DCR→client-credentials 回退）、server instructions、roots、MCP Apps，含本地 stdio server 的 `sandboxEnabled`。**没有文档化的「VS Code 当 MCP server」桥**，也未找到相应 CLI 开关 → `[INFERENCE]` 若存在也是未文档化的。VS Code 真正的「对外提供 IDE 能力」桥是 **AHP**，不是 MCP。

**与内置能力的重叠清单（勿重复造）**：内置 agent 工具集（`built-in tools`/`MCP tools`/`extension tools` 三类：editFiles、runCommands/terminal、search/#codebase、#fetch、#usages、task、todo、semantic search）；MCP client 1.102 GA（gallery 安装、`@mcp` 搜索、`.vscode/mcp.json`、dev mode、信任对话框、`MCP: Reset Trust`、autostart、mac/Linux 沙箱、Settings Sync）；审批/权限 UI（权限等级 **Manual / Assisted（LLM judge）/ Allow all**、`chat.permissions.default`、`chat.tools.eligibleForAutoApproval`、两步 URL 审批 `chat.tools.urls.autoApprove`、终端规则 `chat.tools.terminal.autoApprove`（含 `matchCommandLine`、deny 优先）、`PreToolUse` 钩子 `permissionDecision:"deny"`、`chat.tools.global.autoApprove`、`/yolo`）；Copilot chat 扩展本体 `<VS>/extensions/copilot` v0.66.0（大 JS bundle，非可读 spec）；Chat Sessions view / Agents window（1.104+，本地+贡献会话统一管理、远程/web、Dev Container、changesets）。

> 缺口：安装内**无 `vscode.proposed.*.d.ts`**，proposed 文件清单读自 `microsoft/vscode@main`（GitHub HTML listing 部分截断，`api.github.com` 返回 **HTTP 403**）；已确认文件名含 `activeComment`、`agentEditorComments`、`agentSessionsWorkspace`、`agentsWindowActivation`、`agentsWindowConfiguration`、`aiRelatedInformation`、`aiSettingsSearch`、`aiTextSearchProvider`、`authIssuers`、`authLearnMore`、`authProviderSpecific`、`chatParticipantAdditions`、`chatParticipantPrivate`、`chatProvider`、`chatSessionsProvider`、`editorInsets`（清单被截断）。**VS Code 无 ACP 支持**（无 `acp`/Agent-Client-Protocol 提案 d.ts，无文档提及）→ ACP↔VS Code 适配完全得由 AgentDock 自己做（`[INFERENCE]`，基于 harness 列表与文档缺失）。**无扩展 API 可向 Agent Host 注册 harness/adapter。无法稳定地对外暴露工具调用端点**（extension host 不暴露任何 socket/RPC/JSON 端点）。未验证：基础 LM API（`lm.selectChatModels`）的 finalize 版本、较老能力原语的版本（上文标 approximate）、`chatSessionsProvider` 是否已在 1.13x release notes 中被取代/更名（`main` 上仍是 proposed，且文档站**无** `/api/extension-guides/ai/chat-sessions` 页面 → HTTP 404，即对扩展作者未文档化）。

## 5. AHP 与 Agent Host

来源：`agent://AhpAgentHost`（spec repo、docs 站、shipped VS Code 源码路径、release notes、blog）。

| 问题 | 事实 |
|---|---|
| 拓扑 | **Host = server**（拥有会话与权威状态），**client = 订阅/控制方**（VS Code 窗口、Agents window、web、CLI）：「In AHP terms, those windows are clients and the Agent Host plays the server role.」→ 与 ACP **相反**，且明确是**多客户端协调层**（N clients → 1 session） |
| 传输 | **传输无关**，JSON-RPC 2.0 帧；VS Code 本地用 **MessagePort**，远程/独立用 **WebSocket**（「While AHP does not mandate a transport, **WebSocket** is the most common choice … and is what the VS Code implementation uses.」） |
| 开放性 | **开放**：spec 站 `microsoft.github.io/agent-host-protocol`，repo `microsoft/agent-host-protocol`，**MIT**（「Copyright (c) Microsoft Corporation」，LICENSE 逐字「MIT License」） |
| 核心抽象 | URI 寻址 **channels**（`ahp-root://`、`ahp-session:/<uuid>`、`ahp-chat:/<cid>`、`ahp-terminal:/<id>`、**`ahp-changeset:/<id>`**、`ahp-automations://`、`ahp-otlp:`）；不可变状态树 + 纯 reducer；带 `serverSeq` 的有序 action；重连时 snapshot + replay |
| 版本 | spec **0.9.0（2026-08-28）**；「Until `1.0.0` is reached, breaking changes may land in `MINOR` bumps」 |

**第三方可做的事（逐项）**：(a) 在 Agent Host **背后**实现 harness/agent —— 架构上可以，**但无公开注册契约**：spec 是 agent-agnostic 且要求 host 在 root state 公布 `AgentInfo[]`（provider、models、capabilities），`agent-host-protocol` 只 ship **server 参考实现**而非 provider SDK；VS Code host 的 `AGENTS.md` 显示 adapter（Claude/Copilot/Codex）是编译进去的 Node 类（`node/claude`、`node/copilot`、`node/codex`），经内部 `IAgentHostProviderService` 选择，无插件/贡献点（最后一句为 `[INFERENCE]`）。(b) 实现 **client** —— **YES**：「Because AHP is open, you can build clients that connect to an Agent Host」；一手库 Rust（`ahp`、`ahp-types`、`ahp-ws`）、TS（`@microsoft/agent-host-protocol`）、Kotlin、Go、Swift、.NET，另有第三方 `ahpx`；本地发现方式有文档（命名管道/Unix socket + `?tkn=<connectionToken>`）。(c) **从 client 向会话贡献工具** —— **YES**（见下）。(d) **从 VS Code 扩展注册 adapter** —— **NO**：`src/vscode-dts/vscode.d.ts` 对 `agentHost`/`AgentHost`/`ChatSession`/`chatSessions` **命中 0**，根 `package.json` 无 `contributes.agentHost`；文档：「Extensions can still contribute chat customizations such as tools, MCP servers, and custom agents, but **the agent runtime itself runs in the Agent Host process**」。

**工具贡献机制（已发布的具体形状）**：不是定制 RPC，而是会话 channel 上的**两个状态 action**——client 派发 `session/activeClientSet`（携带自己的 `SessionActiveClient`，按 `clientId` upsert、整体替换该 client 的条目；CHANGELOG 记录 0.5.0 移除了 `session/activeClientToolsChanged`：「An active client now updates its published tools by re-dispatching `session/activeClientSet` with its full, updated entry.」）；离开用 `session/activeClientRemoved`（host 也会在 unsubscribe/disconnect/宽限期到期时自动移除）。Schema 逐字：

```
SessionActiveClient {
  clientId: string,
  displayName?: string,
  tools: ToolDefinition[]            // REQUIRED — "Tools this client provides to the session"
  customizations?: ClientPluginCustomization[]   // Open Plugins format
}
ToolDefinition { name, title?, description?, inputSchema?, outputSchema?, annotations?, _meta? }
  // inputSchema/outputSchema/annotations/_meta explicitly "Mirror MCP"
SessionState.serverTools: ToolDefinition[]   // tools provided by the host itself
```

回调路由：host 在 `SessionState.inputNeeded[]` 给出 `kind: 'toolClientExecution'` → `SessionToolClientExecutionRequest { turnId, clientId, toolCall }`（「the `clientId` expected to execute the tool」）；client 执行后派发 **`chat/toolCallComplete`**（可流式 `chat/toolCallContentChanged`）到 chat channel。相关 kind：`toolConfirmation`（经 `chat/toolCallConfirmed`/`chat/toolCallResultConfirmed`）与 `toolAuthentication`（经 AHP `authenticate` 带 Bearer token 回答，随后恢复调用）。调用上的贡献者身份是 `ToolCallRunningState.contributor`（`ToolCallClientContributor` 携带 `clientId`）。

**Agent Host vs Copilot / 落地状态**：可独立运行——`code agent host`（默认在 localhost 起服务并以连接令牌保护，`--tunnel` 经 dev tunnel 暴露；metadata `type` 为 `editor`（utility process）或 `standalone`）。**能驱动非 Microsoft harness**：Anthropic Claude Agent SDK 作为一手 adapter 加载，且 **SDK 不随 VS Code 发布，首次使用时下载**（「The Claude and Codex agents in the Agents window rely on an SDK that is not shipped with VS Code and is downloaded when you first need it.」）。三个 harness 均已验证：Copilot（GitHub Copilot SDK，作为子进程管理运行时）、Claude（「[its] adapter maps sessions, tools, permissions, and subagents into AHP while retaining features such as slash commands and hooks」）、Codex（`chat.agentHost.codexAgent.enabled`；支持 Copilot 或 ChatGPT 订阅、线程交接给 ChatGPT app、图像生成）；源码路径 `src/vs/platform/agentHost/node/{copilot,claude,codex}`。时间线：**1.129** 引入并以 `chat.agentHost.enabled` 选择加入；1.130 同样选择加入；**1.132** 移除 `ChatAgentHostEnabled` 管理策略并删掉选择加入说明；1.133/1.134 描述为「就在运行」；blog（2026-08-26）「The Agent Host is enabled in the latest VS Code Stable」；**release note 中没有任何一处使用字符串 "GA"**。本机 1.138.0 Stable 确认存在：`resources/app/out/vs/platform/agentHost/node/agentHostMain.js`，`nls.metadata.json` 含 `vs/platform/agentHost/browser/agentHostProtocolClient`、`agentHostConnectionsService`、`common/agentHostCustomizationConfig`；排障技能引用线日志设置 `chat.agentHost.ahpJsonlLoggingEnabled`；产品串 `vscode_agent_host` /「VS Code Agent Host」。

**与 ACP 的重叠（Microsoft 自己回答了）**：专门文档 `docs/guide/ahp-and-acp.md`（`https://microsoft.github.io/agent-host-protocol/guide/ahp-and-acp`）逐字：「**AHP is a coordination layer. ACP is a communication layer. They compose naturally.**」「**AHP is a mutex over ACP.**」「An AHP host implementation **can use ACP as its agent backend protocol**」「The host is acting as a bridge: it speaks AHP upstream (to clients) and ACP downstream (to agents)」；两者被框为不同问题而非竞品：「Most agent protocols describe a one-to-one conversation between a client and an agent. AHP solves a different problem: coordinating multiple independent clients around the same long-running agent session.」**但 VS Code 未 ship 任何 AHP↔ACP 桥**（已 ship 的 adapter 是 provider SDK，不是 ACP 线协议）→ `[INFERENCE]`（基于 adapter 清单）。Microsoft 侧的 VS Code 采纳 ACP 诉求：`microsoft/vscode` issue **#265496**「Add support in vscode for Agent Client Protocol (ACP)」——**open**，labels `chat-agent` + `under-discussion`，assignees `roblourens`、`connor4312`，49 comments，348 reactions（324 👍），created 2025-09-06，last updated 2026-06-05，已锁（原因：spam）；issue 正文「This is a new protocol developed by the ZedEditor … team for integrating 3rd party Agent CLIs.」；页面上无接受/路线图承诺。

**许可**：AHP spec/schemas/client libs = MIT；VS Code Agent Host **参考实现**源码在公开 `microsoft/vscode`（`src/vs/platform/agentHost/{browser,common,electron-browser,electron-main,node,test}`），仓库 `"license": "MIT"`；GitHub Copilot SDK（`github/copilot-sdk`）= MIT（「Copyright GitHub, Inc.」）；**注意**：shipped VS Code 产品与部分 Copilot 组件另有条款（安装内 `@vscode/copilot-api` 的许可文本是「a legal agreement between you … and GitHub, Inc.」）→ 开源 AHP ≠ Copilot 运行时/模型访问免费。

**第三方今天在 AHP 上能做/不能做**：能做完整 client（用 MIT 库连 `code agent host` over WebSocket + 文档化连接令牌；监视会话、审阅 changesets、审批工具调用、取消 turn）；能从 client 贡献工具（在 `session/activeClientSet` 广播 `ToolDefinition[]`，经 `session/inputNeeded`（`kind: 'toolClientExecution'`）收回调用，用 `chat/toolCallComplete` 完成；**不需要 Microsoft 账号或 VS Code 扩展**）。不能把 harness 插进 **VS Code 的** host（无扩展 API、无贡献点、无文档化 provider 注册契约；已 ship 的 Copilot/Claude/Codex 是编译进去的）；不能依赖 ACP 互通（设计上 AHP 可包 ACP 作下游，但无 ACP adapter ship，VS Code 的 ACP 请求 #265496 仍 `under-discussion` 且无承诺）；必须跟踪一个未到 1.0 的协议（0.9.0，`initialize` 协商版本，MINOR 可破坏 → 应 pin 并重新协商）。

> 缺口：**未找到** VS Code 内 ship 的任何 AHP↔ACP 桥（检索 AHP `ahp-and-acp.md`、`implementations.md`、v1_129–v1_138 release notes、`agentHost/AGENTS.md` adapter 清单）。**未找到** Agent Host 的字面 "GA" 公告（release notes 措辞是「progressively rolling it out」→ blog 的「enabled in the latest Stable」）。**未找到**注册 harness/AHP server 的扩展 API（对 raw `src/vscode-dts/vscode.d.ts` grep `agentHost`/`AgentHost`/`ChatSession`/`chatSessions`/`registerTool`/`createChatParticipant`/`SessionItemProvider` → 无命中）。无法引用 #265496 的 49 条评论（comments API **HTTP 403**，未认证）→ 该条目标记**部分未找到**。`implementations.md` 只列出 VS Code host 一个 **server**：**不存在第三方 AHP host 实现**。本份事实表全部来自一手抓取：`web_search` 的所有 provider 被 bot wall 拦下，未获交叉验证。

## 6. 同类产品与 VS Code ACP 客户端（竞品）

### 6.1 现有产品如何呈现/审阅/回收 agent 的文件改动

来源：`agent://PriorArtReview`。**范围说明**：今天的「Windsurf」实为 Cognition 的 **Devin Desktop**——`docs.windsurf.com` 重定向到 `docs.devin.ai/desktop`，changelog v3.9.19（2026-09-08）称「Cascade has been removed. Devin Local is now the only agent available in Devin Desktop.」

**行业基线（几乎人人都有）**：agent 面板按 turn 列出改过的文件并链到 diff；粗粒度 accept/reject（整 turn 和/或整文件）；**写盘前**审批 tool call（控制发生在 apply 之前）；非 Git 的 per-turn checkpoint/snapshot 还原（可选保留对话）；从更早 turn 重试的 message-edit / fork 路径。

**稀有（多数不做）**：**在普通文本编辑器内 per-hunk accept/reject**——只有 VS Code Copilot Chat（extension-host 会话的 hover 接受/拒绝）、Zed（`agent.single_file_review=true`）与 Continue **Edit** 模式（`Cmd/Ctrl+Alt+Y/N`）；**接受前编辑提案并告知 agent**——Claude Code（「If you edit the proposed content directly in the diff view before accepting, Claude is told that you modified it…」）；**代码与对话分别还原**——Cline、Claude Code、Kilo；**具名手建 checkpoint**——Windsurf/Devin；**把「用户编辑 vs 未接受提案」当真实冲突模型处理**——只有 Aider 的 dirty-file pre-commit（「keeps your edits separate from aider's edits」）与 Claude Code 的 edit-then-tell。

**今天没人做到**：通过**稳定公开扩展 API**、为**任意第三方 agent** 在普通编辑器内做 per-hunk 行内审阅（VS Code 需 proposed `editorInsets`，自 2019 冻结、不在 Marketplace，本仓库 PoC 实测）；集成协议里的**标准 changeset/「review」原语**（ACP v1 无 diff/hunk/changeset/accept-reject 概念）；**非破坏性的历史 per-hunk 复审**（「第 N+5 轮之后再看第 N 轮的 hunk」）——厂商给的是「回到 N」或「预览 N 时刻的文件」，不是在新树上选择性重新接受旧 hunk。

| 产品 | 提案展示位置 | 粒度 | 行内 per-hunk？ | 非 Git checkpoint / 事后复审 | 机制 · OSS | 来源 |
|---|---|---|---|---|---|---|
| VS Code Copilot Chat (agent mode) | ext-host：同一编辑器内 inline diff + 「files changed」条；Agent Host：改动直接落盘/落 worktree，**无 pending review** | 单次编辑（Keep/Undo）、整文件、Keep-all/Undo-all | **Y**（ext-host hover）；**N**（Agent Host） | **Y** 每次请求前非 Git 快照，per-response checkpoint；历史 checkpoint 只显示改动摘要（`chat.checkpoints.showFileChanges`）→ 只预览 | VS Code **core** 的 chat-editing pending-edit UI（非稳定公开 API）；Copilot harness = GitHub Copilot SDK | [1][2][3][4] |
| Cursor | 边做边落盘；审阅在 **diff view** | 整文件；**行内 per-change apply 已被移除**（社区回归报告） | **N** | **Y** 「snapshots… stored locally and separate from Git」；点时间线任意 checkpoint 预览当时文件 | 专有；「Cursor is based upon the VS Code codebase」（fork） | [5][6] |
| Windsurf → **Devin Desktop** | turn 显示折叠的 `+X −Y` 摘要，点击开该组的 **multi-diff editor** | per user-message 回退；per-file 导航 | `?` | **Y** 具名 checkpoint；hover prompt 即可回退到该步 | 专有；基于 VS Code 的编辑器；ACP 常开（「Enable ACP toggle is gone」） | [7][8] |
| Google Antigravity | **Artifacts** 审阅面板（交互式 plan + 「review visual code diffs」）；CLI 有键盘驱动的 review panel | 里程碑级 approve/steer；更细粒度 `?` | `?` | 概念上有：对 artifact 的行内文本反馈先于本地编辑；CLI 提到 session checkpoints | 专有；独立 app + 「Antigravity IDE」+ VS Code/JetBrains/Zed 扩展 | [9] |
| ByteDance Trae | `?` | `?` | `?` | `?` | 专有；**文档站点纯客户端渲染，SSR payload `__MODERN_SERVER_DATA__` 为空，`robots/sitemap/llms.txt` 只回 HTML 外壳，`r.jina.ai` 不可达，全部搜索 provider 失败** → 机制无法取证，一律 `?`，不猜 | — |
| Cline | chat 区块（绿底高亮拟议文件）+ **per tool call** Approve/Reject；「Compare」开 diff | tool call / 文件；per-hunk `?` | **N** | **Y** 影子 Git 仓库（独立于项目 Git），每次工具调用后提交，跨会话保留 | OSS `github.com/cline/cline`；VS Code 扩展 + shadow Git repo | [10] |
| Roo Code | chat + diff view；除 auto-approve 外独立 Approve 提示 | tool call（edit-files 权限）；per-hunk `?` | `?` | **Y** shadow Git repo，**修改前**建 checkpoint，task 作用域 | OSS，**repo 已于 2026-05-15 archived（read-only）**；`simple-git` 影子仓库 | [11] |
| Kilo Code | 每 turn 折叠 diff 摘要（add/del 计数）；点文件开 **VS Code 内并排 diff** | **per user message** 回退（非 per step/file） | **N** | **Y** 「git-based snapshots」，快照仓在**项目之外**（`~/.local/share/kilo/snapshot/...`），step 边界打快照；「N+5 复审 N」= `?` | OSS `github.com/Kilo-Org/kilocode`（现属 Anaconda） | [12] |
| Continue | **Edit** 模式：inline diff 流进你的文件；**Agent** 模式：每 tool call 权限提示 | Edit：**每个 change** + 全部接受/拒绝；Agent：tool call/文件 | **Y**（Edit 模式行内 diff，per-change `Cmd/Ctrl+Alt+Y/N`） | **N** 无 per-turn checkpoint 概念，回滚靠 Git | OSS `github.com/continuedev/continue`；VS Code + JetBrains | [13] |
| Claude Code（VS Code 扩展 + CLI） | **Manual** 模式：权限前 side-by-side diff；Auto/Edit-automatically 直接落盘；CLI 有 `/rewind` 菜单 | 每个待定文件编辑（accept / reject / 「tell Claude what to do instead」） | **N**（side-by-side） | **Y** 每个开启 turn 的 prompt 前建 checkpoint，每会话保留最近 100 个；rewind 菜单列出每个 prompt，但动作 = 恢复 | 专有；VS Code 扩展捆绑 CLI（可装进 VS Code fork，含 Devin Desktop/Kiro） | [14] |
| Zed agent panel (ACP) | `Review Changes`（Shift-Ctrl-R）开**专用 multi-buffer 标签页**；可选行内 | 单个 **change hunk** 或整组 | **Y** 当 `agent.single_file_review=true`（「the same keep/reject hunk controls」行内，临时覆盖该 buffer 的 git diff） | **Y** 原生 Zed Agent：每条消息「Restore Checkpoint」（即使编辑中断也出现）；**External Agents**「checkpoints… depend on the agent integration」 | OSS `github.com/zed-industries/zed`；External Agents 走 **ACP**（协议**无 diff/hunk/changeset 类型**） | [15] |
| Aider | 仅终端，无 GUI 审阅；改完自动提交 | 整 turn（`/undo` = 撤销上一次 aider 提交）；per-hunk **N** | N/A | **Y** 先把 dirty 文件提交，使用户编辑与 aider 编辑分离；changeset 就是 Git 提交本身（`/diff` 看上次消息以来的改动）；独立于 Git = **N** | OSS `github.com/Aider-AI/aider`；CLI，每次改动一个 commit（`--no-auto-commits`/`--no-git` 可关） | [16] |
| OpenHands | 浏览器 **Agent Canvas**；**Commits drawer**（近期提交 + 未提交改动）与 Files drawer | **未有文档化的接受/拒绝**；改动直接落工作区 | **N** | **N** 无 per-turn 文件 checkpoint；改为**会话分支**（`Branch from here`）+ 每会话持久化 | OSS `github.com/OpenHands/OpenHands`；浏览器 client + Agent Server（REST/WebSocket）；IDE 侧经 **ACP** | [17] |

判定口径：「行内 per-hunk in the normal editor」从严——**独立 diff 编辑器、chat 区块、multi-diff 标签页都算 N**。来源：[1] `code.visualstudio.com/docs/agents/run/review-code-edits` · [2] `/learn/foundations/reviewing-and-controlling-agent-changes` · [3] `/blogs/2026/08/26/agent-host-architecture` · [4] `poc/editor-review/RESULTS.md` · [5] `cursor.com/docs/agent/overview`、`/help/ai-features/agent.md`、`/docs/configuration/migrations/vscode.md` · [6] `forum.cursor.com/t/.../160856` · [7] `docs.devin.ai/desktop/cascade/cascade.md` · [8] `docs.devin.ai/desktop/changelog` · [9] `antigravity.google/docs/artifacts`、`/docs/getting-started`、`codelabs.developers.google.com/getting-started-google-antigravity` · [10] `docs.cline.bot/core-workflows/checkpoints.md`、`/usage/ide.md`、`/features/auto-approve.md` · [11] `roocodeinc.github.io/Roo-Code/features/checkpoints`、`/features/auto-approving-actions` · [12] `kilo.ai/docs/code-with-ai/features/checkpoints` · [13] `docs.continue.dev/ide-extensions/edit/quick-start`、`/ide-extensions/agent/how-it-works` · [14] `code.claude.com/docs/en/checkpointing`、`/en/vs-code` · [15] `zed.dev/docs/ai/agent-panel`、`/ai/external-agents`、`agentclientprotocol.com/protocol/v1/overview` · [16] `aider.chat/docs/git.html`、`/docs/usage/commands.html` · [17] `docs.openhands.dev/openhands/usage/agent-canvas/conversations`、`/overview` · [18] repos：`github.com/{zed-industries/zed, Aider-AI/aider, cline/cline, continuedev/continue, Kilo-Org/kilocode, OpenHands/OpenHands, RooCodeInc/Roo-Code}`。

### 6.2 VS Code / Open VSX 上的 ACP 客户端扩展

来源：`agent://VscodeAcpClients`（Marketplace 元数据、Open VSX JSON API、repo、设计文档；2026-09-18）。

| 扩展（id） | 发布者 · 安装量 · 更新 | 许可/仓库 | 做什么 · 文件改动如何呈现 | IDE 能力→agent | 会话存储 · proposed API |
|---|---|---|---|---|---|
| **ACP Client** `formulahendry.acp-client` | Jun Han · **31K** MS / 14,550 OVS · 0.2.0（OVS 2026-05-16） | MIT · `github.com/formulahendry/vscode-acp` | chat webview、per-agent 会话树、tool calls+thinking、slash 命令、mode/model 选择、终端、流量日志；**无 diff/review UI** | 仅 ACP `fs/*`+`terminal/*` | `session/list` 或本地 per-workspace 缓存 · 未声明（`^1.85`） |
| **ACP Patchbay** `SolutionsUnity.acp-patchbay` | Solutions Unity · **102** MS · 0.82.8（2026-07-22） | Apache-2.0 · `github.com/solutionsunity/acp-patchbay` | Agents+Sessions+Chat 融合 webview、权限 broker、能力矩阵、并行会话、MCP 集成；**文件级 Accept/Reject 先于落盘**（原生 diff，仅「brokered」agent）；**无 per-hunk** | **本地 MCP server** 经 `session/new.mcpServers`：当前文件、选区、已打开编辑器、**diagnostics**、布局、`request_user_input`（能看未保存缓冲） | **agent 独占 100%，不存会话记录**；审计 JSONL + machine JSON store + `SecretStorage` · 未声明（`^1.96`） |
| **ACP Pro** `duclvz.acp-pro` | Duc Lv · **867** MS / 7,702 OVS · 0.3.5（2026-09-15） | **闭源**「SEE LICENSE」（商业，license server）· 仓库是文档站 | 多标签 chat、会话切换、远程浏览器/手机桥（HTTP+WS）、@-context、plan/thinking 块；tool call 内 **chat-block inline diff**，点击跳到改动起始行；**无 per-hunk accept/reject** | 无 MCP；仅把编辑器选区/文件塞进 prompt | `session/load`\|`resume`，恢复上次活动；短期凭据不入 state · 未声明（`^1.96`） |
| **Multicoder** `multicoder.multicoder` | Multicoder · **5K** MS · 0.9.13 | **闭源**（release-only repo：`github.com/multicoder-ai/vscode-release`） | chat + 会话列表（含 CLI 历史）、Outline、subagent 运行、auth、per-session model/thinking/permission；**Changes view**：touched files + **聚合与逐 change diff + 编辑器内 prev/next 步进**，per-file 历史；接受/拒绝只到权限层 | 未知（无源码） | 本地 server 比窗口长寿；`~/.multicoder/settings.json` · 未知 |
| **Poolside Assistant** `poolside-ai.acp-assistant` | poolside · **1.2K** MS · 1.5.10 | **闭源**，无 repo | Marketplace 文本为通用描述，无功能细节 | 未知 | 未知 |
| **Exo** `AntonSubbotin.exo` | Anton Subbotin · **19** MS · 0.6.18 | GPL-3.0 · `github.com/skavans/Exo` | 侧栏 chat、**每会话独立 git worktree** 并行、会话选择器、`/`+`@`；**真实 diff editor**：改动先进 diff editor 待审再落盘；文件/edits 级，**无 per-hunk** | 无 MCP | agent 拥有会话，可 resume；每会话一个 worktree · 无明显 proposed API |
| **VSCode ACP** `omercnet.vscode-acp` | Omer Cohen · 4,271 OVS · 1.5.0（2026-09-14） | MIT · `github.com/omercnet/vscode-acp` | 侧栏 chat、Agent Sessions 树、tool-call 卡片、选区附加、MCP server 配置（`.vscode/mcp.json`）；**无 diff**（tool locations 只作链接） | 为 agent **配置** MCP server（不是把 IDE 状态做成 MCP） | 工作区历史 + `session/list`/`load`/`resume`；写入仅 Linux · 未声明 |

**其它（Open VSX 查询 "acp"/"acp agent"/"acp client"/"agent client protocol"/"zed agent protocol"）**：OpenAIDE `openaide.openaide-vscode-extension`（10,465 · 0.6.1 · 2026-09-16 · AGPL-3.0 · `OldKrab/OpenAIDE`，可见工具活动/权限/可恢复任务历史）；Agent Resume Panel `wuzhengzhe.agent-resume-panel`（12,384 · 2.11.2）；QueryMT `querymt.vscode-querymt`（2,246 · 0.4.0）；siGit Code `getsigit.sigit-code`（668 · 1.0.1）；Grok Build (Community) `PawelHuryn.grok-vscode-phuryn`（**113,106** · 4.8.0 · 2026-09-17 · FSL-1.1-MIT，本族安装量最高）；Grok Build (unofficial) `sr-web-studio.grok-build-unofficial`（1,744 · 0.2.2）与 `SergeyOhanyan.grok-build`（830）；Acpira `hotic.acpira`（1,960 · 1.3.1，「Inline approvals and shared sessions」）；MothX `MothxCodeAgent.mothx`（1,204 · 0.2.4）；Mirrors `pa-andreas.mirror-view`（1,035 · 26.7.0）；Rina Hermes ACP `JoveRina.rina-hermes-acp`（2,294 · 0.3.2）。**≥10 个在售扩展已把「换 harness = 换一个 ACP 客户端」商品化。**

**AgentDock 意图 vs 已在 VS Code 内 ship 的东西**

| AgentDock 意图（README §） | 状态 | 证据 |
|---|---|---|
| 可替换 harness（§4、§15） | **已 ship / 已商品化** | ACP Client、Patchbay、ACP Pro、Multicoder、VSCode ACP、Exo |
| chat 面板 + 会话列表 + 终端直通 + 权限（§9、§15） | **已 ship** | 同一批；Patchbay 另有统一权限 broker |
| agent 改动可审阅（§7） | **部分已 ship** | chat-block diff（ACP Pro）、文件级 diff-accept（Patchbay）、diff editor（Exo）、逐 change 步进（Multicoder） |
| **普通编辑器内 per-hunk 审阅 + 用户编辑后的 reconciliation（§8、§12、§13）** | **缺失** | 无任何扩展提供 per-hunk accept/reject；没有任何产品跟踪「提案跨过后续用户编辑」 |
| per-turn ChangeSet 模型（§7） | **缺失（仅近似）** | Patchbay 会话的「first-touch pre-image」；Multicoder 的 touched-files + per-change 历史 |
| **IDE 能力作为 MCP 工具回喂 agent（§6）** | **已 ship（部分）** | Patchbay：文件/选区/已打开编辑器/**diagnostics**/布局 + `request_user_input`；**无人**暴露 LSP definition/refs/symbols/rename/codeActions、tests、debug |
| Provider/Model 偏好呈现（§5） | **已 ship（部分）** | ACP Client 的会话 config options；Patchbay 的旋钮；ACP Pro 的 per-session model/effort |
| 轻量 UI / 不持久化会话（§9） | **有先例** | Patchbay 不存任何会话记录 |

> 缺口：**Trae（ByteDance）不可验证**——`docs.trae.ai`/`docs.trae.cn` 纯客户端渲染（`__MODERN_SERVER_DATA__` 为空），`robots`/`sitemap`/`llms.txt` 只回 HTML 外壳，`r.jina.ai` 不可达，全部搜索 provider 失败；其 `?` 格是**未知**而非「否」，机制是缺口（其文档页面存在于 `/ide/...`，产品仍在活跃）。**OS 许可证未被断言**：repo 页面可读但 GitHub API（403）与限流阻止 SPDX 核实，「open source」列只引公开 repo 而非许可证字符串。**四处「任何地方都未见文档」**：(i) ACP 中的标准 changeset/hunk/review 原语；(ii) 经稳定 VS Code API 为第三方 agent 做 per-hunk 行内 accept/reject；(iii) 在后续 turn 之后非破坏性复审旧 turn 的 hunk；(iv) 用户编辑与未接受提案交错时的一般化冲突模型（只有 Aider 的 dirty-precommit 与 Claude Code 的 edit-then-tell）。**Roo Code 已归档**（2026-05-15 起 read-only，能力视为冻结）；**Kilo Code** 现属 Anaconda。6.2 侧未找到 Marketplace 关键词搜索结果（`marketplace.visualstudio.com/search?term=…` 客户端渲染返回空，只能依赖 Open VSX 搜索 + ACP 目录 → 仅在 Marketplace 发布的扩展可能被漏掉）；也未找到 Marketplace 的「last updated」字段（item API 不提供，更新时间取自 Open VSX 时间戳或 repo changelog）；Poolside Assistant、Multicoder、ACP Pro 的内部机制**无源码可查**，标 **unknown** 而非推断；未覆盖 VS Code 之外的客户端（Visual Studio 的 `poolside-ai.vs-acp-assistant`、JetBrains/Zed/Emacs）。

## 7. PoC 代码盘点

来源：`agent://PocInventory`（`poc/editor-review` 全量源码）。

**可复用资产 = 三个纯 Node 模块**（`model/changeSet.ts` 108 LOC、`model/reconcile.ts` 91 LOC、`model/fixture.ts` ~136 LOC，合计约 270 LOC），**零 `vscode` import**，且是 `npm test`（`node --test out/test/unit/*.test.js`）唯一覆盖的部分。其余全是 VS Code 渲染/接线。

| 文件 | LOC | 职责 | import vscode |
|---|---|---|---|
| `src/model/changeSet.ts` | 108 | 纯类型/规则核心：`Hunk`、`HunkStatus`、`TurnChangeSet`、`computeAnchor`、`changeFromText`、`applyRejectEdit` | 否 |
| `src/model/reconcile.ts` | 91 | 4 条规则的内容变更→hunk 决策表（`reconcile`）、reject 计划与其行偏移（`rejectEdit`、`changeFromRejectEdit`） | 否 |
| `src/model/fixture.ts` | ~136 | 载入 `sample.ts`/`sample.expected.ts`/`sample.patch.json`，校验 `applyHunks(baseline) === expected`，构建初始 `Hunk[]`；唯一做 fs I/O 的 model 文件；重导出 `computeAnchor`（第 17 行） | 否 |
| `src/render/actions.ts` | 126 | `HunkCodeLensProvider`：每个 pending hunk 一行 CodeLens（Accept/Reject/状态/`deleted N more`），并作为视觉同步点（`onQuery`） | 是 |
| `src/render/decorations.ts` | ~140 | 方案 A：整行 added 高亮 + 每个删除块一条删除线附件行，按行文本缓存 | 是 |
| `src/render/comments.ts` | 88 | 方案 B：每个 pending hunk 一个 `CommentThread`，完整 diff 作 `MarkdownString`；id `agentdock.review`/`agentdockHunkPending`/`agentdockHunkStale` | 是 |
| `src/render/insets.ts` | ~158 | 方案 C（proposed `editorInsets`）：每个删除块一个 `WebviewEditorInset`，N 条 baseline 行 = N 条真实行；行高/tab-size 由 `editor.*` 配置推导 | 是 |
| `src/render/hunkText.ts` | 57 | Markdown 正文构造 `newSideLines`/`deletedLinesMarkdown`/`hunkDiffMarkdown`（唯一跨渲染器助手） | 是 |
| `src/render/probe.ts` | ~130 | `ProbeRenderer`：一次性实验装置（P1–P7），由 `agentReview.probeRendering` 驱动 | 是 |
| `src/extension.ts` | 499 | 激活、命令注册、变更事件吸收（`isOwnEdit`）、reject/accept 编排、模式分派、渲染调度 | 是 |
| `src/types/vscode.proposed.editorInsets.d.ts` | 18 | vendored 提案 d.ts（vscode tag 1.138.0） | 仅类型 |
| `src/test/...` | ~200+57+167+9+30 | 单测（`reconcile.test.ts`、`fixture.test.ts`）+ 集成（`suite/apply.ts` 8 步生命周期、`index.ts`、`runTest.ts` 带 `--enable-proposed-api`，二进制由 `VSCODE_EXECUTABLE` 指定） | 混合 |

依赖方向全部向下、无环：`model/changeSet ← model/reconcile|model/fixture`；`model/* ← render/hunkText`；`model/changeSet ← render/{actions,decorations,comments,insets}`；`render/* + model/* ← extension.ts`。

**变更模型（`changeSet.ts`）**：`HunkStatus`（L9）`'pending'|'accepted'|'rejected'|'stale'`；`LineRange`（L13-16）`{start,end}` **0-based 闭区间**，`end < start` 表示定位在 `start` 的空区间；`Hunk`（L18-33）`id`（`'h1'…`）、`baselineLines: string[]`（old 侧逐字、不可变）、`targetRange`、`anchorLine`（-1 = 前缀第 0 行）、`attachSide`、`status`、`userEdited`、`tracked`（false = 冻结）；`HunkChange`（L36-42）`{cs, ce, d}`；**`TurnChangeSet`（L45-48）= `{ file: string; hunks: Hunk[] }`**（整棵变更树的全部）；`RejectEdit`（L62-66）`{startLine, endLineExclusive, insertedLines}`；`changeFromText(cs, ce, text)`（L69-77）`d = newlines(text) - (ce - cs)`；`computeAnchor`（L92-102）new 侧非空 → `anchorLine = targetRange.end`/`after`，纯删除 → 上一行（`start-1`/`after`），第 0 行 → `(-1,'before')`——文档注明**每次 `targetRange` 变动后必须重跑**；`applyRejectEdit`（L106-108）纯 splice。

**状态迁移（代码实际行为）**：变更整体在上方（`ce < S`）→ pending，区间平移 `d`（reconcile.ts:30-35）；变更落在 new 侧内（`isInsideNewSide`，10-16）→ pending、`userEdited = true`、`end += d`（37-42）；整体在下方（`cs > max(S,E)`）→ 不变（44-47）；跨边界 → `stale`、`tracked=false`（49-50）；Accept（hunk id 或整文件）→ `accepted`、`tracked=false`，**不改文本**（extension.ts:250-263）；Reject → `rejected`、`tracked=false`，**在 `WorkspaceEdit` 落地前冻结**（283-303）；已 accepted/rejected/stale → 任何变更早退（`!tracked || status !== 'pending'`，reconcile.ts:24-26）。`userEdited` 只由规则 2 置位且**任何地方都不清除**（除 `resetFixture` 丢弃整个 change set，extension.ts:246）。`tracked=false` ⇒ 被所有渲染器过滤（`hunk.tracked && status === 'pending'`：decorations.ts:96、comments.ts:56、insets.ts:127-129）、被 `reconcile` 排除、`rejectEdit` 返回 `null`（reconcile.ts:61）；只有 `actions.ts:88-96` 仍出一行（命令为 `agentReview.resetFixture` 的 stale lens）。

**Reject 行数学（`extension.ts:203-219`、`reconcile.ts:80-87`）**：计划 → `Range(startLine,0 → endLineExclusive,0)`（越过 EOF 时 clamp 到最后一行文本长度）；文本 = `insertedLines.join(eolOf(document))`（非 EOF 处才补尾 EOL）。其它 hunk 的平移用 `changeFromRejectEdit` 的 `d` 而非变更事件，因为「a change event reports VS Code's normalised span, which is off by one line for a whole-line replacement」（extension.ts:14-18）；`changeFromRejectEdit` 置 `ce = start + max(replaced-1,0)`。可脱离 VS Code 测试的是 `model/` 全部 + `render/hunkText` 的字符串内容（但它返回 `vscode.MarkdownString`，需 shim）；不可脱离的是真实编辑器几何锚定、装饰/inset 渲染、CodeLens 时序、变更事件吸收。

**VS Code 耦合面（摘要）**：配置 `workspace.getConfiguration('agentReview'|'editor')`（extension.ts:52-54；insets.ts:33,37-42,54；共 4 个用户可配键 + `editor.lineHeight/fontSize/tabSize`）；**唯一写入通道** `workspace.applyEdit(WorkspaceEdit)`（159-166，返回 bool，回滚路径 305-317）且只用 `WorkspaceEdit.replace`（161，整行区间，**无 create/delete/rename**）；文档身份 `uri.toString() === fixtureUri.toString()`（`isFixture`，47-49）；`onDidChangeTextDocument`（324-346，注册于 483）→ `contentChanges[]` → `changeFromText`；`window`（`createOutputChannel`、`visibleTextEditors`、`showTextDocument`、`showWarningMessage/ErrorMessage`、`showQuickPick`、`onDidChangeVisibleTextEditors`、`onDidChangeActiveTextEditor`）；`commands.registerCommand`/`executeCommand`（14 个命令，外加宿主命令 `editor.action.showHover`，448）；`languages.registerCodeLensProvider`（482，`{language:'typescript'}`）；装饰族含主题键 `diffEditor.insertedLineBackground`/`removedLineBackground`/`removedTextBorder`、`editorOverviewRuler.added/deletedForeground`、`descriptionForeground`；`comments.createCommentController` + `contextValue` 驱动贡献按钮；proposed `window.createWebviewTextEditorInset`/`WebviewEditorInset`/`Webview`（insets.ts:153-154,62；几何只读 ⇒ 任何变化都要 dispose+重建，160-172）。

**贡献面（`package.json`）**：`activationEvents: onStartupFinished`（1 项）；`main: ./out/extension.js`；`engines.vscode ^1.137.0`；`enabledApiProposals: ["editorInsets"]`。14 个命令：用户可见 `applyFakePatch`/`resetFixture`/`acceptFile`/`rejectFile`/`setRenderMode`/`probeRendering`/`validateFixture`，隐藏（`commandPalette when:false`）`acceptHunk`/`rejectHunk`/`getState`/`showHunkDetails`/`showDeletedLines`/`acceptHunkFromThread`/`rejectHunkFromThread`。菜单：`editor/context` 组 `agentReview@1/@2`（`when: editorLangId == typescript`）、`comments/commentThread/title` 组 `navigation@1/@2`（`when: commentController == agentdock.review && commentThread == agentdockHunkPending`）。配置：`agentReview.renderMode`（`decorations|comments|insets`，默认 `decorations`）、`agentReview.autoApply`（bool，默认 `true`）、`agentReview.insetRowHeight`（number，默认 `0`）。**无 keybinding 贡献**。图标仅 `media/check.svg`、`media/x.svg`（两个 thread-title 命令用）。

**可复用 vs 一次性**：product-grade 保留 `model/changeSet.ts`、`model/reconcile.ts`（4 规则 rebase 表与 `changeFromRejectEdit` 的 off-by-one 是被测试钉住的硬资产）；`render/hunkText.ts`「精神上可复用」（内容生成与宿主无关，但返回 `vscode.MarkdownString`）；`render/{decorations,comments,insets}.ts` = 探针脚手架，**保留作参考实现**（方案 C 仅提案 API）；`render/actions.ts` = 脚手架但含真实设计点（CodeLens 作同步点是 VS Code ~400 ms 重建的产物，状态/文案是产品相关的）；`extension.ts` = 探针接线（`renderRetries`、`VISUAL_FALLBACK_MS`、`serialise`、`pendingSelfEdits` 都是 PoC 补偿）；`model/fixture.ts` = 脚手架、部分可复用（`splitLines`/`applyHunks` 与 `applyHunks === expected` 不变量方向正确，但 `sample.patch.json` 是手写补丁，是 diff 引擎的替身）；`render/probe.ts` 明确是一次性 §12 实验装置；`fixtures/*` 一次性，`test/unit/**` 保留（钉住纯模型），`test/integration/suite/apply.ts` 是与 fixture 与 `agentReview.getState` 绑定的生命周期 smoke。

**产品化缺口（代码不做的）**：无 session/turn/file 树（`TurnChangeSet` 只有一个 `file`，changeSet.ts:45-48；extension.ts:43 单模块级 `changeSet`；`fixtureUri` 全局唯一，36）；**无 diff 引擎**（hunk 全部手写在 `fixtures/sample.patch.json`，`src/` 中没有任何从两段文本推导 hunk 的代码）；文件创建/删除/重命名（`applyDocumentEdits` 只造 `WorkspaceEdit.replace`，159-163；无 `createFile`/`deleteFile`/`renameFile`/`onDidRenameFiles`）；多文件/多根（渲染器只收一个 `TextDocument`，`commitVisual` 只挑唯一 fixture 编辑器，127-131）；二进制/编码（全部 `fs.readFileSync(..., 'utf8')` + 字符串 `splitLines`，fixture.ts:42-49,91-93，无二进制护栏）；多会话并发（hunk id 仅在一个 change set 内唯一；评论线程按 hunk id 存在单个 map，comments.ts:22）；**持久化**（`src/` 无 `globalState`/`workspaceState`/文件写入；`resetFixture` 丢弃 change set，246 → 状态随窗口消亡）；Git 交互（`src/` 中无任何 SCM/Git API 用法）；未接受 hunk 的 undo/redo（Reject 走 `applyEdit` 因而进入编辑器 undo 栈 `[INFERENCE]`；扩展不区分 undo 与用户编辑——`isOwnEdit` 只匹配仍在队列的 `pendingSelfEdits`，彼时已 drain，172-179 → undo 一次 reject 会被当成用户编辑 reconcile，极可能把邻居标 `stale`；无任何 `undo`/`redo` 处理）；accept 持久化/脏缓冲（`acceptHunkIds` 只改 `status`/`tracked`（250-263），**从不调用 `document.save()`**，也无 `onDidSave`/`isDirty` 处理 → 磁盘文件停在 baseline 而缓冲持有补丁）；无 un-accept / 无 re-review（accepted/rejected 变 `tracked=false` 被 `reconcile` 永久跳过，reconcile.ts:24，唯一出口是 `resetFixture`）；stale 恢复仅 `resetFixture`（且所有渲染器都过滤 `pending`，stale 无高亮只留 CodeLens 行）；**模式不一致**（`comments` 模式下被用户编辑的 hunk 得 `contextValue = THREAD_STALE`（comments.ts:81），而 package.json 要求 `commentThread == agentdockHunkPending` 才显示 Accept/Reject 按钮 ⇒ **按钮消失**，而 CodeLens 标题改成「Accept 采纳当前文本…」（actions.ts:104-107））；中文字符串硬编码（reconcile.ts:90、actions.ts:16-18,105、probe.ts:73-88）；外部文件变更/监视（无 `FileSystemWatcher`，`resetFixture` 手工重读磁盘，240）；时序与宿主耦合（视觉正确性依赖 `provideCodeLenses` 被调用（actions.ts:123）+ 1000 ms 兜底定时器（extension.ts:96）+ 5×200 ms 渲染重试（83-85），均不可移植到别的宿主）。

**搜索验证的「不存在」**（`src/` 内无命中）：`.save(`、`undo`、`redo`、`git`、`globalState`、`createFile`、`deleteFile`、`renameFile`、`onDidSave`、`isDirty`、`FileSystemWatcher`、`workspaceFolders`（扩展侧）、`session`、`turn`（作为代码标识符——只有类型名 `TurnChangeSet`）。

> 缺口：PoC 的结论**只对单一 fixture、单一文档、单一窗口**成立；`TurnChangeSet` 无 session/turn 维度，因此「per-turn changeset」「多文件」「历史复审」在本代码里**没有任何实现可参照**。三条产品化前置（diff/hunk 推导模块、多文件+会话身份层、accept 持久化路径）在 PoC 中均不存在。inset 数量级（几十/上百个 webview 的开销）、inset 内 Ctrl+F/选择不可见、点击 inset 后焦点进入 webview，`RESULTS.md` 明列为**未实测**；「inset 内 `command:` 链接」被 PoC 自己标为**不可靠的否定结论**（同一套点击方法对 CodeLens 也曾两次无效）。PoC 的时延数据（25/41/393/421 ms）来自单机单次采样，非统计结论。

## 8. MCP 工具的动态性（OMP 实测，来源 `agent://McpToolDynamics`）

**问题背景**：设计要求"只有存在用户修改/拒绝时，才向 agent 暴露 `review.lastOutcome` 工具，且工具描述自述其意"。

| # | 问题 | 结论 | 证据 |
| --- | --- | --- | --- |
| 1 | OMP 是否响应 `notifications/tools/list_changed`？ | **是**，会话中途即可增删工具、改写描述，**下一次模型请求前**生效；不要求 server 先声明 `tools.listChanged` | `src/mcp/manager.ts:510, 885-895, 1493-1509`；`sdk.ts:4363-4365`；`acp-agent.ts:2680-2683` |
| 2 | 何时枚举工具？ | **连接时一次**（`initialize` 之后）+ 事件驱动刷新（`list_changed` / 重连 / `/mcp reload` / `/mcp reconnect`）。**不存在按 prompt 枚举** | `manager.ts:723, 1451, 1493-1508` |
| 3 | 描述变更是否被模型看到？ | 是。刷新时用新 payload 重建工具对象，`description` 参与已应用工具签名，prompt 会被重建 | `tool-bridge.ts:685, 703-715`；`session-tools.ts:1838, 1877, 1893-1952` |
| 4 | `set_host_tools`（RPC）能否中途更新/移除工具？ | **能**：整个 host-tool map 被替换，重发即更新，省略某名字即移除 | `rpc-mode.ts:1335-1339`；`host-tools.ts:93-96` |

**三条路径加载 MCP 的差异（对设计有硬约束）**

| 路径 | 加载方式 | 是否可动态变更 |
| --- | --- | --- |
| `.mcp.json` / `~/.omp/agent/mcp.json` | 正常 SDK 启动发现 | 是（通知 / reload / reconnect） |
| **ACP `session/new.mcpServers`** | ACP 会话以 **`enableMCP: false`** 创建（`main.ts:523`）⇒ **`.mcp.json` 不被读取**，只有注入的 server 生效；`#configureMcpServers` 仅在 `session/new`、`session/load`、`session/resume`、`unstable_session/fork` 运行 | **server 集合在会话创建后不可更改**（无任何 ACP 方法可更新 `mcpServers`）；但该 server 自己的**工具列表**仍可通过 `tools/list_changed` 变化 |
| RPC `--mode rpc` + `set_host_tools` | 正常 SDK 会话（`.mcp.json` 生效）**加上** host 提供的工具 | 是 |

> `## 缺口`：未在真实 ACP 会话里端到端验证一次 `tools/list_changed` 的时序（结论来自安装源码路径）。

---

## 9. prompt 上下文的来源可得性（VS Code 1.138，来源 `agent://PromptContextSources`）

| 来源 | 稳定可得？ | API / 命令 | 结论 |
| --- | --- | --- | --- |
| 编辑器选区 | **是** | `TextEditor.selection(s)` + `TextDocument.getText(range?)` | 多选、整档都可取 |
| 诊断 | **是** | `languages.getDiagnostics()` / `onDidChangeDiagnostics` | 可直接作为 pill 来源 |
| 终端选区 / 缓冲区 | **否** | `Terminal.selection` 仍是 **proposed**（`vscode.proposed.terminalSelection.d.ts`，issue #188173） | 只能绕：`workbench.action.terminal.copySelection` + `env.clipboard.readText()`（**会覆盖用户剪贴板**、需焦点与选区）；或 shell integration 的 `TerminalShellExecution.read()`（**只能拿到订阅之后**的输出） |
| Output / 日志 | **部分** | `OutputChannel` 是只写的 | 只能读自己持有的 channel，或当前正在编辑器中打开的 output 文档 |
| pill 本身 | **无原生原语** | 内置聊天的附件模型是内部的 `IChatRequestVariableEntry`；扩展只能看到读侧的 `ChatPromptReference` | pill 必须在自建 webview 内渲染 |

> `## 缺口`：未验证用户终端在开启 shell integration 后订阅的稳定性与性能；未验证 `workbench.action.terminal.copyLastCommandOutput` 在无 shell integration 时的失败形态。

---

## 10. ACP 会话生命周期能力（来源 `agent://AcpSessionLifecycle`）

| 项 | 结论 | 证据 |
| --- | --- | --- |
| `session/fork` | **不在稳定 v1**。公开文档 schema 与官方 release `schema.json` 搜 `fork` 均 **0 命中**；`SessionCapabilities` 只列 `additionalDirectories / close / delete / list / resume`。它是 SDK 内的 **UNSTABLE** 方法，wire 名 **`session/fork`**（OMP 源码注释写的 `unstable_session/fork` 与 SDK v1.4.0 不符，以 SDK/schema 为准），TS 句柄 `unstable_forkSession`，能力项 `sessionCapabilities.fork` | `agentclientprotocol.com/protocol/v1/schema.md`；`@agentclientprotocol/sdk@1.4.0/schema/schema.json:4896,8239,3244-3248` |
| fork 的粒度 | **只能整会话**：入参 `sessionId`（必填）+ `additionalDirectories` / `cwd` / `mcpServers`，**无任何轮次/消息位置参数**。RFD 原文把"指定 message id"列为未来扩展。继承：`the same conversation context as the original` | `ForkSessionRequest` schema.json:8191-8239；`rfds/session-fork.md` |
| `session/load`（稳定，能力 `loadSession`） | **必须把完整历史以 `session/update` 重放**，且重放**含用户 prompt 文本**（`user_message_chunk`）⇒ 客户端可重建"第 N 轮用户说了什么" | v1 `session-setup.md`（Loading Sessions） |
| `session/resume`（能力 `sessionCapabilities.resume`） | 只恢复上下文与 MCP 连接，**明确 MUST NOT 重放历史** | v1 schema.md / session-setup.md |
| `usage_update` | **稳定 v1 通知**：`used` / `size` 必填，`cost` 可选 ⇒ 上下文占用有标准来源 | v1 schema.md:5271 |
| 触发 slash 命令 | **没有专用调用方法**，只能把 `/cmd args` 当普通文本发 `session/prompt` | v1 schema.md |
| revert / rollback / undo / checkpoint | **协议里完全没有**（v1 稳定与 v2 draft 均 0 命中）⇒ "回退会话"不是 ACP 能力 | v1 + v2 schema 全文检索 |
| v2 draft 的替代路径 | v2 删除 `session/load`，改为 `session/resume` + **`replayFrom`** 游标；但游标目前只有 `{type:"start"}`（重放整段对话），"identify a message 的未来游标"仅存在于 RFD | `@agentclientprotocol/sdk@1.4.0/schema/v2/schema.unstable.json:9735` |

> `## 缺口`：`session/fork` 的 UNSTABLE 期间，非 OMP 的 ACP harness 是否实现未逐一核实。

---

## 11. OMP 的回退、分支、压缩与用量（来源 `agent://OmpRevertAndCompact`）

| 项 | 结论 | 证据（逐字） |
| --- | --- | --- |
| **文件侧回退** | **OMP 不提供**。全仓无"每轮/每次编辑文件快照 + 回退"机制；`checkpoint`/`rewind` 只做**上下文**折叠，文档明说 `Despite the summary string ... the implementation does not call git and does not snapshot filesystem state`，且默认关闭 | `omp://tools/checkpoint.md` Notes；`settings-schema.ts:4564 checkpoint.enabled default false` |
| `edit` details 的 "snapshots" | **不是**回退快照：是源真值前后文 + 剪枝标志，供 diff 与自动修复 | `src/edit/renderer.ts:80,111` |
| `EditStore` | 每会话内存态：全文件快照用于 **mint hashline 标签** + 剪贴板寄存器 + no-op 守卫；**未找到** `restore/undo/revert` | `src/edit/store.ts:1-4`；`pi-natives/native/index.d.ts:124-154` |
| 文件回滚的真实入口 | 只有 git 级操作（autoresearch discard、git-tui discard） | `autoresearch/tools/log-experiment.ts:367`；`cli/git-tui/state.ts:767-792` |
| **会话侧回退（按消息）** | **有**：`AgentSession.branch(entryId)` 回退到某条 **user message** 并另起分支；入口 = RPC `branch`、TUI `/branch`（别名 `/rewind`）/`/tree`；**ACP 没有 branch 方法** | `src/session/agent-session.ts:9813,9821`（非 user message 会抛错）；`rpc-types.ts:81`；`builtin-session.ts:484-485` |
| `fork()` | **整会话克隆**：新 id / 新 jsonl、`parentSession` = 旧 id、拷贝 artifacts；**不复制工作区文件**；**不能按消息/轮次 fork** | `agent-session.ts:8405`；`session-manager.ts:1853`；`protocol.ts:261` |
| `/tree` 的 `navigateTree(targetId)` | 同文件内 leaf 移动（消息级），**不是**新会话 | `omp://tree.md` |
| **手动压缩（ACP 可触发）** | `compact` 带 `handle` ⇒ 进入 available commands；客户端以 `session/prompt` 文本 `/compact [mode] [focus]` 触发；**无专用 ACP 方法** | `src/slash-commands/builtin-lifecycle.ts:247`；`acp-agent.ts:971 executeAcpBuiltinSlashCommand` |
| 压缩（RPC） | `{type:"compact", customInstructions?}`、`set_auto_compaction`；自动压缩事件 `auto_compaction_start/end`，`reason: "threshold"｜"overflow"｜"idle"｜"incomplete"` | `rpc-types.ts:66,67`；`agent-session-events.ts:19` |
| **上下文用量** | ACP **会**推 `usage_update{size,used,cost}`，但**仅在每轮结束推一次**；RPC `get_session_stats` / `get_state` 返回全量 `SessionStats{tokens{input,output,reasoning,cacheRead,cacheWrite,total}, cost, contextUsage{tokens,contextWindow,percent}}` | `agent-session-types.ts:447-470`；`extensibility/extensions/types.ts:387-393` |

**由此得到的硬结论**：**文件回退不可能由任何 harness 代劳**（OMP 明确不存文件快照），必须由 AgentDock 的 changeset 台账逐轮反向还原；而**任意 message 的会话分叉**在 OMP 上只能经 RPC/CLI 的 `branch(entryId)`，ACP 侧无路径。

> `## 缺口`：未实测 `branch(entryId)` 对工作区文件的影响（文档层面它不动文件，但未在真实会话验证）。

---

## 12. OMP 两条通道的组合可行性（来源 `agent://OmpChannelComposition`）

| 问题 | 结论 | 证据 |
| --- | --- | --- |
| ACP `sessionId` 与 RPC 的 id 是同一空间吗？ | **是**。ACP `sessionId` = `session.sessionId` = `SessionManager.getSessionId()` = 会话 JSONL 头部的 `id`；文件名为 `<timestamp>_<id>.jsonl`；RPC `get_state.sessionId` 是同一字段。**给定 id，ACP 客户端可以 `session/load` 一个由 RPC 创建/分叉的会话**（`#findStoredSessionById` 有全局 by-id 回退） | `acp-agent.ts:694,742-752,2237-2253,1300-1320`；`session-manager.ts:2466-2468,1445,1479-1480`；`session-listing.ts:467`；`rpc-types.ts:108` |
| 两个进程能同时 attach 同一会话文件吗？ | **能 attach，但不能并发写**。无 ownership/PID 标记；写入由跨进程 `.lock` 串行（有界等待 500ms）；一个进程重写时另一个已追加 ⇒ 抛 `SessionWriteConflictError`（fail closed）。**无文档禁止，但按"实践上不支持"处理** | `session-storage.ts:276-284,397-399,434-451,62-75,380-391`；`SESSION_PUBLISH_LOCK_WAIT_MS:340` |
| 单进程能同时开两个模式吗？ | **不能**。`mode ∈ {text,json,rpc,rpc-ui,acp}` 单值，dispatch 是 if/else，两者各自独占 stdio；`rpc-ui` 只是 RPC + 工具 UI 上下文，**不是双通道** | `cli/args.ts:23`；`flag-tables.ts:123-126`；`main.ts:2013,2200-2204,1978` |
| RPC 下有没有逐动作审批？ | **有，但不是权限 API**：走通用扩展 UI 帧 `extension_ui_request` → `select ["Approve","Deny"]` | `src/modes/rpc/*`（approval 经 extension UI） |
| `branch(entryId)` 的产物 | **新建会话文件与 id**（原分支保留），因此 message 级 fork 在 RPC 上完全可表达 | 见 §11 |

**结论**：对 OMP 而言 ACP 与 RPC **不可能在同一进程共存**，双进程并发驱动同一会话**也不被支持**——只能二选一。RPC 在能力上几乎是 ACP 的超集（`branch` / `steer` / `compact` / 全量 `get_session_stats` / `set_host_tools` 动态工具），**唯一实质让步是审批退化为通用 Approve/Deny 帧**，没有 ACP 那套 `allow_once / allow_always / reject_*` 的类型化选项。

> `## 缺口`（**已由 §12 回答**）：未实测 RPC 的 `tool_execution_*` 事件是否携带 shell 类工具的**完整输出** ⇒ §12 行 2/3（源码级证据）：**事件文本不完整**（受 `artifactSpillThreshold` 默认 50 KB 限制，超出只给头尾采样 + `[raw output: artifact://N]`），**但完整原始流由 OMP 写在会话 artifacts 目录的文件里** ⇒ D17 的"终端内容写入日志文件"改为**读 artifact 文件**。

---

## 13. `omp --mode rpc` 的驱动面（来源 `agent://OmpRpcDriverSurface`）

| # | 问题 | 结论 | 证据 |
| --- | --- | --- | --- |
| 1 | 工具事件形状 | `tool_execution_start{toolCallId,toolName,args,intent?}` / `_update{…,partialResult}` / `_end{…,result,isError}`；RPC **逐字转发** | `extensibility/extensions/types.ts:821-844`；`rpc-mode.ts:1090-1092` |
| 2 | **shell 输出的完整形态** | 事件里的文本是 `result.content[].text`，**有上限**：内联上限 = `artifactSpillThreshold`（默认 **50 KB**）；超出只给头尾采样并以 `[raw output: artifact://N]` 结尾。**完整原始流写在会话 artifacts 目录下的文件里**（artifact 上限默认 0 = 不限） | `tools/bash.ts:834-840,861-869`；`output-meta.ts:759-761`；`config/settings-schema.ts:891-893`；`session/streaming-output.ts:13-17` |
| 3 | 流式部分输出 | `tool_execution_update.partialResult` = 约 50ms 节流的尾部快照 | `tools/bash.ts:1450-1453,1553` |
| 4 | 归因 + 写入前 baseline | `tool_execution_start.args` 含目标路径（`write.path`、`edit` 的 targets、`ast_edit.paths[]`、`bash.command`），且 start **在工具体执行之前**发出 | `tools/write.ts:314-317`；`edit/index.ts:331,403-406`；`tools/ast-edit.ts:179-183`；`cursor.ts:247-257` |
| 5 | **是否会被驱动阻塞** | **默认不会**：审批 schema 默认 `tools.approvalMode: yolo` ⇒ **不开审批就没有任何停顿**。开启后是 `extension_ui_request` / `select ["Approve","Deny"]` 的往返，并**阻塞工具执行** | `config/settings-schema.ts`（默认值）；见 §12 |
| 6 | slash 命令 | `available_commands_update` + `get_available_commands`；用普通 `prompt` 文本发送；另有专用 `compact` / `bash` 帧 | `omp://rpc.md` |
| 7 | 历史 | `get_messages_page` → `{messages,totalMessages,nextCursor?}`，含 assistant 的 toolCall 块与 `toolResult` 消息 | `omp://rpc.md` |
| 8 | 文件读取 / cwd | **RPC 不提供**文件读取，也没有 `cwd` 字段 ⇒ 驱动必须使用自己的文件系统能力 | — |
| 9 | `branch` 的返回 | `{text, cancelled}`，**不返回新会话 id** ⇒ 需随后用 `get_state` 取 | `rpc-types.ts` |
| 10 | `switch_session` 寻址 | **按文件路径**，不是 id | §12 |

`stdout` 与 `stderr` 在工具结果里**合并为一条流**（单个 `OutputSink`），不分开。

> `## 缺口`：`pi-agent-core`（agent loop）未随包安装，"start 事件先于工具体执行"的排序结论部分依赖 coding-agent 侧的注释（来源已标 `[INFERENCE]`）。

---

## 14. OMP SDK vs `--mode rpc`（来源 `agent://OmpSdkSurface`）

**运行时（决定性）**

| 断言 | 证据 |
| --- | --- |
| **只支持 Bun**，`engines` 里没有 node | `package.json:engines = {"bun": ">=1.3.14"}`；`node_modules/@oh-my-pi/pi-utils/package.json:62-64` 同 |
| 入口是**裸 `.ts`**、纯 ESM，全无 `require` / `node` 条件 | `main: "./src/index.ts"`；`exports["."] = {types: "./dist/types/index.d.ts", import: "./src/index.ts"}` |
| 静态依赖图直接 import `bun` / `bun:sqlite` / `bun:ffi` / `bun:jsc` | `src/advisor/config.ts:5` `import { YAML } from "bun"`；`src/session/history-storage.ts:1`、`src/session/agent-storage.ts:1`；`src/eval/py/spawn-options.ts:9`；`src/debug/profiler.ts:5` |
| 普通路径使用 Bun 全局量 | `Bun.write`/`Bun.file`、`Bun.spawn`、`Bun.serve`、`Bun.deepEquals`；`src/session/session-storage.ts:357` 的 `"sleepSync" in Bun` 在 Node 下 `ReferenceError` |

⇒ **VS Code 扩展宿主（Node 进程）不可能 import 它**：必须有 Bun 进程，或分发 `bun build --compile` 产物。

**写所有权（最关键的答案，与直觉相反）**

- `registerFileWriteFallback` **不能让宿主拥有写入**：它只在沙箱 `EPERM` 时触发，**写入者仍然是 agent**（`src/tools/file-write-fallback.ts`）。
- **真正的写所有权来自 `customTools` 遮蔽 `write` / `edit`**（`sdk.ts:2942`）：IDE 注册自己的实现，**由 IDE 亲自执行字节写入** ⇒ baseline **精确、无竞态**。
- **修正（D42）**：`ast_edit` / `apply_patch` 等**内置文件变更工具属于 T1，必须精确归因**——用 `customTools` + `ctx.invokeTool` 做**通用包裹**即可，不必为每个工具重写实现；只有 shell（T2，best effort）与脚本 / 程序产物（T3，不归因）不在我们手里。

**审批**：SDK 与 RPC **完全等价**，都是硬编码的 `uiContext.select([...])`，**并不更强**。

**打包成本**：`bun build --compile` 确实存在（`scripts/compile-binary.ts:40-58`，目标见 `scripts/build-binary.ts:20-40`），原生插件随包内嵌、首次运行释放到 `~/.omp/natives/<version>`；代价是 **~48 MB 二进制 + 171 MB 原生插件**。

**版本**：本机装 **18.2.1**，npm 最新 **18.2.5** ⇒ 版本漂移真实存在。

> `## 缺口`：原生插件是 napi-rs（N-API，ABI 稳定）且 loader 对 `node:child_process` 有回退，因此**插件本身** Node 兼容；不兼容的是整包图。

---

## 15. harness 的"可编程嵌入面"地形（直读官方源，2026-09-18）

**三种形态——它决定 adapter 长什么样，而不是协议决定**

| 形态 | 定义 | 运行时要求 | adapter 的形态 | 代表 |
| --- | --- | --- | --- | --- |
| **进程内 SDK** | 库本身就是 agent loop | 与 harness 相同（可能是非 Node） | **必须 sidecar + 自有 IPC** | **OMP**（Bun ≥ 1.3.14） |
| **包装型 SDK** | 库驱动自家 CLI 子进程 | **Node 18+**（扩展宿主原生可用） | 扩展内直接 import，**无需额外运行时** | Claude Code、Codex、GitHub Copilot CLI |
| **只有协议** | 无官方 SDK，但有 ACP | 任意（stdio 协议） | 协议客户端 | Gemini CLI（原生）、Goose、Cursor、OpenCode… |

**逐个（已直读官方源核实）**

| harness | 包 | 形态 | 运行时 | 关键证据 |
| --- | --- | --- | --- | --- |
| **Claude Code** | `@anthropic-ai/claude-agent-sdk`（TS + Python；2026-06 由 `claude-code-sdk` 改名） | **包装型** | **Node 18+** | 官方 overview 首句："Build production AI agents with **Claude Code as a library**"；能力表含 **Permissions**（哪些工具自动跑、哪些需批准）、**Hooks**、**Sessions（resume or fork later）**、MCP、Subagents、Plugins |
| **Codex** | `@openai/codex-sdk` | **包装型** | **Node 18+** | README 逐字："wraps the `codex` CLI from `@openai/codex`. It **spawns the CLI** and exchanges **JSONL events over stdin/stdout**"；`runStreamed()` 给结构化事件（**含 file change 通知**）；`resumeThread`（会话存 `~/.codex/sessions`）；`env` 可控，README 明说 "useful for **sandboxed hosts like Electron apps**" |
| **GitHub Copilot CLI** | `@github/copilot-sdk` | **包装型** | Node（依赖 `vscode-jsonrpc`） | npm 元数据："TypeScript SDK for programmatic control of GitHub Copilot CLI via **JSON-RPC**"；**MIT**、1.0.14、周下载 2.4M |
| **Gemini CLI** | **没有** `@google/gemini-cli-sdk` | **只有协议（ACP，原生）** | — | npm registry 对 `@google/gemini-cli-sdk` 返回 **HTTP 404**；DeepWiki 的相关说法**不可靠** |

**写入拦截能力（决定 baseline 保真度；直读官方文档）**

| harness | 机制 | 阻塞？ | 能否改写 | 证据 |
| --- | --- | --- | --- | --- |
| **Claude Code** | **`PreToolUse` 钩子**（另有 `canUseTool` 回调、`PermissionRequest` 钩子） | **阻塞**：*"By default, the agent waits for your hook to return before proceeding"* | **能**：返回 `permissionDecision: allow/deny/ask/defer` + `permissionDecisionReason` + **`updatedInput`**（官方示例正是用 `updatedInput` 把 `file_path` 重定向到沙箱） | 官方 permissions 文档：*"For checks that must run on every tool call, use a `PreToolUse` hook: **hooks run before every other step, and a hook deny applies even in `bypassPermissions` mode**"*；钩子表含 `PreToolUse` / `PostToolUse`（可 `updatedToolOutput` 替换输出）/ `FileChanged` / `PreCompact` / `SessionStart` / `PreModelSwitch` / `WorktreeCreate` 等 |
| **Codex（app-server 通道）** | `item/commandExecution/requestApproval` / `item/fileChange/requestApproval`；客户端必须回 `accept` / `acceptForSession` / `decline` / `cancel`（命令另有 `acceptWithExecpolicyAmendment`） | **阻塞** | **不能改写工具输入/patch**（`acceptWithExecpolicyAmendment` 只改 execpolicy 允许规则）；但**文件改动审批前的 `item/started` 已带 proposed changes（含 diff）** | app-server 文档（Approvals 节，`learn.chatgpt.com/docs/app-server`）：*"Codex app-server is the interface Codex uses to power rich clients (for example, the **Codex VS Code extension**). Use it when you want a deep integration inside your own product: authentication, conversation history, **approvals**, and streamed agent events."*；JSON-RPC 2.0、`--listen stdio://`；原语 Thread/Turn/Item；**`turn/steer`**、**`thread/fork`**、`thread/resume`；**`codex app-server generate-ts` / `generate-json-schema` 产出与当前版本完全一致的 schema** |
| **Codex（TS SDK 通道）** | `@openai/codex-sdk` 0.155.0 = **`codex exec --experimental-json` 的薄壳**（spawn 子进程、stdin 传 prompt、stdout 读 JSONL）；公开面只有 `startThread` / `resumeThread` / `Thread.run` / `runStreamed` | **不阻塞**：`TurnOptions` 仅 `{outputSchema, signal}`，**无任何审批回调** | **不能** | `FileChangeItem` 只有 `changes[{path, kind}]` + `status(completed\|failed)`、**无 diff 字段**，注释逐字 *"Emitted once the patch succeeds or fails"*（`sdk/typescript/src/items.ts`；`codex-rs/exec/src/exec_events.rs`）⇒ **写入后通知**。许可 **Apache-2.0** |
| **GitHub Copilot CLI** | **`onPreToolUse` 钩子**（参数改写走 `modifiedArgs`）+ `onPermissionRequest`（**纯审批**：approve-once / for-session / for-location / permanently、reject、user-not-available、no-result——**结果类型里没有任何 args 字段**） | **阻塞**：handler *"is called before the agent executes each tool (file writes, shell commands, custom tools, etc.) and returns a decision"*；未注册 handler 时请求 *"left pending"* 等消费者应答；**deny-by-default**：*"All permission requests (file writes, shell commands, URL fetches, etc.) are denied unless your app provides an `onPermissionRequest` handler."* | **能，但不经 permission handler**：`onPreToolUse` 返回 `modifiedArgs`，文档逐字 *"Modify tool arguments"*，官方示例即改写 shell 命令参数 | 根 README 的 *"approve, deny, or customize tool calls"*，**下一句已把 customize 限定为** *"customize tool availability by configuring the SDK client options to enable and disable specific tools"* ⇒ 该词**不是**参数改写；改写依据 `docs/hooks/pre-tool-use.md` 与 docs.github.com `hooks/pre-tool-use`（*"Allow / deny / modify the call"*）。**MIT**、GA、semver、**BYOK 无需 GitHub 订阅**；**Node `^20.19.0 \|\| >=22.12.0`（Node 18 不支持）**；CLI 随 Node/.NET SDK 自动捆绑；会话态在 `~/.copilot/session-state/{sessionId}/` |

**⇒ 因此用布尔模型描述"IDE 是否拥有写所有权"是错的**：`Claude Code` 的 `PreToolUse` 与 `Copilot` 的 `onPreToolUse` 都是**写入前的阻塞式阻挡点**，在那一刻快照即可得到**精确 baseline**，根本不需要自己执行写入。正确的模型是保真度阶梯：

| 级别 | 机制 | baseline 精度 | 代表 |
| --- | --- | --- | --- |
| **L1 `own`** | 用宿主工具**遮蔽** harness 的写工具，由 IDE 执行写入 | **精确** | OMP `customTools` 遮蔽 `write`/`edit` |
| **L2 `blocking-hook`** | 写入前的**阻塞式**钩子/审批，必须由我们作答才继续，**且可改写输入** | **精确** | Claude `PreToolUse`（可 `updatedInput`）、Copilot `onPreToolUse`（可 `modifiedArgs`） |
| **L2− `blocking-no-rewrite`** | 写入前的**阻塞式**审批，但**没有改写输入的决策** | **精确**（我们只需快照，本来不需要改写） | Codex **app-server** 的 `item/*/requestApproval` |
| **L3 `async-signal`** | 写入**前**发信号但**不等我们** | **近似**（竞态） | OMP RPC 的 `tool_execution_start`（默认 `yolo` 时不等） |
| **L4 `post-hoc`** | 写入**后**才有通知，**声明 diff 可能有、可能没有** | **可还原但依赖声明**，第三方改动后作废 | Codex **TS SDK** 的 `FileChangeItem`（**无 diff**，只有 `path` + `kind` 与 completed/failed） |
| **L5 `none`** | 无任何信号 | **不可审阅** | bash 里的 `sed -i`（D8 已排除） |

**必须一并记录的负面事实**：Claude Agent SDK 适用 **Anthropic 商业条款（非开源）**，README 自述会**收集使用数据**（含代码接受/拒绝与对话数据），且有**品牌限制**（不得自称 "Claude Code"，只能用 "Claude Agent" 之类）；Codex SDK 依赖 `codex` CLI，且默认要求工作目录是 git 仓库（可用 `skipGitRepoCheck` 跳过）。

**其余（未核，且按用户裁定不再核实——它们不支撑任何决策，仅作为线索保留）**：Cursor 有 `@cursor/sdk`；Amp 有 TS+Python SDK；Qwen Code 有 TS/Python/Java SDK；Goose 有 "GDK"；OpenCode 有 SDK；**Roo Code 已停止运营**。

> `## 缺口`：上表"其余"六条**按用户裁定不再核实**（不支撑任何决策）；Claude Agent SDK 的控制面细节（`canUseTool` 的确切形状）未直读 API 参考。**已核实**：Codex SDK 许可 = **Apache-2.0**（npm `@openai/codex-sdk` 0.155.0 元数据），Copilot SDK = **MIT**。**未核**：VS Code 扩展宿主的 `process.versions.node` 是否满足 Copilot SDK 的 `^20.19.0 || >=22.12.0`（本机 1.138 未测）；若不满足，退路是让 SDK 去 spawn 它自带的 CLI 进程（同样走 JSON-RPC），而不是把它作为库 import 进扩展宿主。

**本机 VS Code 1.138 的旁证**（`<install>/7debcd0e2a/resources/app/product.json`）：**VS Code 自己 pin 的就是同一批 agent SDK**——`"copilotVersions": { "runtime": "1.0.84-4", "sdk": "1.0.13" }`，`"agentSdk": { "claude": { "version": "0.3.258" }, "codex": { "version": "0.153.0" } }`（按 `{sdkTarget}.tgz` 分发；PoC 的测试用户数据目录里也确实出现了 `agent-host/`）。含义有二：① **VS Code 自己就在消费这三个 SDK** ⇒ D38"先做包装型 adapter"的方向与生态一致，且这些 SDK 能在 VS Code 管得到的运行时里跑起来；② **版本对齐有参照点**（copilot-sdk 1.0.13 vs npm 1.0.14；codex 0.153.0 vs 0.155.0）。注意这**不等于**扩展宿主能直接 import——它只证明平台侧跑得动。

---

## 16. OMP 的拦截面与它的边界（`omp://hooks.md`、`omp://extensions.md` + 源码 grep）

**有等价于 Claude `PreToolUse` 的东西，而且更强**

| 机制 | 语义 | 证据 |
| --- | --- | --- |
| `pi.on("tool_call")` | **执行前**触发；可返回 `{ block: true, reason }` **阻止执行**（**handler 抛错也 fail-closed 阻止**）；也可返回 **`input` 改写工具的实际执行参数** | `omp://hooks.md`：`"tool_call" (pre-execution) → can return { block?: boolean; reason?: string; input?: Record<string, unknown> }`；"returned `input` replaces the arguments the tool executes with"；"if a handler throws, wrapper fails closed and blocks execution" |
| 覆盖面 | **所有工具**，"including built-ins and extension/custom tools" | `omp://extensions.md` |
| 时序保证 | 模型发起的调用**在 agent loop 的参数准备阶段**触发，因此改写后的参数会被**重新校验**，并被并发调度、执行事件、持久化的 assistant 消息、**以及审批门**同时看到 | `omp://extensions.md` |
| `pi.on("tool_result")` | 执行后可改写 `content` / `details` | `omp://hooks.md` |
| `tool_approval_requested` / `tool_approval_resolved` | 审批的**可观测**事件（无审批处理器时不发） | `omp://extensions.md` |
| `user_bash` / `user_python` | 用户自己 `!` 命令可被拦截或覆盖 | `omp://extensions.md` |

**边界（官方自己写明的）**

1. **粒度是"工具"，不是"文件"**：`bash` 的 `input` 只有不透明的 `command` 字符串，**事前不知道它会写哪些文件** ⇒ bash 类写入可以**整体拦**，但**无法事前归因**。
2. **`registerFileWriteFallback` 不是拦截点**：只在字节写入因 `EPERM` / `EACCES` / `EROFS` 失败时才被咨询；官方逐字写着 *"This is deliberately **not** an interception of every write the agent can make."*，并列出够不到的情况：**archive 成员写入、SQLite 行写入、ACP bridge 的 `writeTextFile`、`lsp` 工具自身的写入与 Biome formatter 的子进程写入——"a subprocess write no in-process seam can reach"**。
3. **OMP 没有文件系统沙箱**（`sandbox` 的命中只有 provider 端点模式与 git worktree 隔离）⇒ 若要用"沙箱 + fallback"把**所有**字节写入逼到我们手里，需要**我们自己在宿主侧造沙箱**，且上面的例外仍然漏。

**补：OMP 的 `bash` 工具是 POSIX 设计** —— Windows 上走 **Git Bash / `bash.exe`**，`cmd.exe /c` 只是"没有 bash 时的 spawn 兜底"（`src/tools/bash.ts:145-152` 逐字：*"Git Bash / `bash.exe` on Windows (`cmd.exe /c` as the last-resort fallback when no bash exists on the host)"*；`src/exec/bash-executor.ts:502-503`：*"Never wrap in cmd.exe…"*），工具语义按 POSIX（`$VAR` / `$(...)` / `source` / POSIX quoting / `-l`）⇒ **该 harness 的默认方言 = bash**；**但同一份代码里有 `isCmdShell` 兜底分支**（无 bash 时走 `cmd.exe /c`）⇒ **方言是运行期事实，不是编译期常量**。本次检索范围（`src/exec/*`、`src/tools/bash.ts`）内**未见 PowerShell 分支**，不排除包内他处有。另：OMP 自带一个 POSIX 命令分词器 `src/tools/shell-tokenize.ts`（`tokenizeShellSegments` 处理 `;` / `&&` / `||` / `|` / `&` / 子 shell / 换行；`extractLiteralAndChainSegments`、`extractLeadingCdTarget`），服务于它自己的 bash 审批分段，且**是公开子路径可导入**（`exports` 有 `"./tools/*"`，`files` 含 `src`）——T2 的分段规则应与它一致，否则同一命令会与 harness 得出不同结论。

**⇒ 结论**：**工具级拦截有**（且比 Claude 更强——可改写参数）；**"非工具写入"的拦截没有**，OMP 自己承认够不到子进程写入。唯一的事前闸门是"在 `bash` 这个工具层面整体拦"，**归因仍做不到**。

> `## 缺口`：`tool_call` 的 `input` 改写对 `bash` 命令的实际可用边界（例如改写后是否被 shell 解析差异绕过）未实测。

---

## 冲突与修正

| # | 冲突 | 权威一方 / 修正 |
|---|---|---|
| a | **OMP 的 ACP capability block**：`agent://OmpSurface` 依 `src/modes/acp/acp-agent.ts` 记作「lines 657-667：`agentCapabilities: { loadSession: true, mcpCapabilities: {http,sse}, promptCapabilities: {embeddedContext,image} }`」，并把自己的缺口写成「是否广播 `sessionCapabilities.{resume,close}` 与 fork **未验证**」。 | **修正**：同一文件 L668-671 还有 `sessionCapabilities: { list: {}, fork: {}, resume: {}, close: {} }`（本机源码复核），且 `listSessions`（L714）、`resumeSession`（L731）、`unstable_forkSession`（L742）、`closeSession` 均有 handler。**§0 的实时握手逐字广播了这四个能力** —— 两份证据自洽，OmpSurface 的 657-667 是**不完整摘录**（少读了 4 行）。附带事实：fork 的 handler 名 `unstable_forkSession` 带 `unstable_` 前缀，说明该 SDK 把 fork 视为**不稳定**方法；OMP 源码中**没有** `session/delete` 的实现，而 ACP v1 的 `sessionCapabilities` 家族含 `delete` —— 即 OMP 分片实现了 ACP 的 session 能力子集。 |
| b | **scout 假设 `@types/vscode` 可读出 `@since`**（`agent://VscodeReviewApis` 与 `VscodeAgentApis` 的 API 表都带 “Since” 列，并据此推断稳定/提案与起始版本） | **修正**：对本机权威文件 `<install>/7debcd0e2a/resources/app/out/vscode-dts/vscode.d.ts` 全文 grep `@since`/`@proposed` → **0 命中**。稳定 vs 提案与「自哪个版本」**无法从权威文件机器推导**；Since 值只在有 release note/文档引用处成立（InlayHint 1.65、`registerFileSystemProvider` 1.23、`workspace.fs` 1.37、`registerLanguageModelChatProvider` 1.104、`registerMcpServerDefinitionProvider` 1.101），其余一律标「long stable」且**版本未验证**。提案 API 形状必须去上游 `microsoft/vscode` tag/main 取（本机安装**不含** `vscode.proposed.*.d.ts`）。 |
| c | **「Windsurf」这个竞品标签**：多数产品调研会把 Windsurf 当作独立产品比 | **修正**：今天的 Windsurf = Cognition 的 **Devin Desktop**（`docs.windsurf.com` → `docs.devin.ai/desktop`；changelog v3.9.19（2026-09-08）：「Cascade has been removed. Devin Local is now the only agent available in Devin Desktop.」）。任何「Windsurf 的能力」陈述必须注明版本与日期，且 Cascade 时代的具名 checkpoint 语义已随 Cascade 消失。 |
| d | **`agent://AcpSurface` 的 `[INFERENCE]`：「OMP（Oh My Pi）今天没有公开 ACP 实现」** | **修正（本机实测推翻）**：§0 的 `omp acp` 握手成功完成 v1 协商并创建会话，OMP 源码中 `src/modes/acp/**` 是完整的 ACP server 实现。正确表述是：**OMP 有 ACP 实现，但从未进入 ACP 的 agents 列表/registry/libraries，也无一手文档**（`omp://` 131 个文件里没有 `acp.md`）。推论：ACP 生态的目录**不代表**可用 harness 的全集；判断某 harness 是否说 ACP 必须在本机实测，不能查表。 |
| e | **Agent Host 是否「GA」**：`agent://VscodeAgentApis` 摘要写作「the open Agent Host Protocol (AHP)（**GA in Stable**）」 | **修正**：`agent://AhpAgentHost` 对 v1_129–v1_138 release notes 与 blog 逐条检索后**未找到任何字面 “GA”**；实际措辞是 1.129 引入并以 `chat.agentHost.enabled` 选择加入 → 1.132 移除管理策略并删掉选择加入说明 → 1.133/1.134 描述为「就在运行」→ blog（2026-08-26）「enabled in the latest VS Code Stable」。对外表述应写「1.129 起可选加入，约 1.132–1.134 起默认启用」，**不要写 GA**。 |
| f | **AHP 官方指南说「AHP 没有工具注册表」**（`docs/guide/ahp-and-acp.md`：「AHP doesn't have a tool registry or tool schema. Tools are agent-internal.」） | **修正（文档滞后于实现）**：0.5.x–0.9.0 的 schema 已 ship `session/activeClientSet` + `ToolDefinition[]` + `session/inputNeeded{kind:'toolClientExecution'}` + `chat/toolCallComplete` 的完整客户端工具贡献/回调机制，且 0.5.0 CHANGELOG 明确记录了 `session/activeClientToolsChanged` 被移除并改为整体重发。以 schema 为准。 |
| g | **「ACP 没有 changeset 概念」的边界**：`agent://PriorArtReview` 与 `AcpSurface` 都断言 ACP 无 diff/hunk/changeset/accept-reject | **限定**：该断言**只对稳定 v1 成立**。v2 Draft 新增按 tool call 归属的结构化 `changes[]`（`operation: add\|delete\|modify\|move\|copy` + 可选 `git_patch` 文本 `patch`），仍未做 turn 分组。对外陈述应写「v1 无、v2 Draft 有 per-tool-call changes[]、两版都无 turn 级 changeset」。 |
| h | **行高来源**：`agent://PocInventory` 把 `editor.lineHeight` 列为 insets 读取的配置键 | **修正**：`RESULTS.md` §5 记录本版 `TextEditorOptions` **已无** `lineHeight`，行高改为由 `editor.fontSize × 1.35` 推导（默认 14 px → 19 px，与实测吻合），偏差可用 `agentReview.insetRowHeight` 覆盖。`editor.lineHeight` 只可能作为普通配置项被读到，不再是编辑器 API 成员。 |

## 对设计的直接约束

| 约束 | 证据 | 因此不能做什么 |
|---|---|---|
| `ThemableDecorationAttachmentRenderOptions.contentText` 是**窄类型的 `string`**，且换行不生效（真实 `\n` 使附件元素根本不生成，microsoft/vscode#63600；字面 `\n` 只显示前半） | d.ts L1119/L1123；`RESULTS.md` P1 | **不能用装饰渲染多行 old 块**；一个 hunk 的 old 侧永远只能承载一行文本，其余必须折叠成计数或另找容器 |
| 装饰（`before`/`after` 附件、`isWholeLine` 背景）**不参与布局**，d.ts 中没有任何保留行/空间的成员；`.view-line` 高度固定 19 px、`overflow: visible` | d.ts（无成员）；`RESULTS.md` P3/P7（块占 97..154 时下方真实行仍在 y=116，2 个真实行盒落在块内） | **不能让装饰在两个真实行之间「占一行」**；`display:block`/`width:'100%'` 只会盖住下方真实代码。old 行只能借用「上一行行尾 / 新行行首 / 新行行尾」之一 |
| 同一 offset 的多个行内装饰**互斥**；同一锚点的多个附件永远排在同一行（实测 y 全同、x 递增并挤出编辑器右边界）；实例级 `after.contentText` 另有已知渲染错乱（#242764） | `RESULTS.md` P2/P2b/P3/P4 | **不能走「每 old 行一个附件」**；也不能在同一位置叠两个附件 |
| `DecorationOptions.range` **不得为空**（d.ts L1208）；唯一悬停通道是 `hoverMessage`（L1214） | d.ts L1208/L1214 | **不能用空 range 装饰做行锚点**；old 全文只能塞进 `hoverMessage` 或另一容器 |
| **CodeLens 刷新有去抖下限 250 ms**，生产默认 ≈375 ms（`{min:250}` + `RunOnceScheduler` + `SlidingWindowAverage(6)`，`min*1.5`）；`onDidChangeCodeLenses` 只调度不重绘；**失焦取消**；无「行已刷新」回调 | `codelensController.ts`、`languageFeatureDebounce.ts`（tag 1.138.0）；`RESULTS.md` R6 实测 393/421 ms | **做不到「点下即消失」的行内动作面**；Accept/Reject 的视觉提交只能借 `provideCodeLenses` 那次查询同步提交（PoC 的 `refreshSynced`+1 s 兜底），且不能承诺刷新时延 |
| 稳定 API 下**唯一已验证可点击的行内动作面是 CodeLens**；Comments 标题栏按钮是瞬时的（41 ms）但形态是区块；inset 内 `command:` 链接的否定结论 PoC 自己标为不可靠 | `RESULTS.md` R6、§5 | **不能设计「行内即时按钮」**（除非接受区块形态或自研分发）；inset 承载按钮属于未验证项，不可作为设计前提 |
| **没有稳定 API 能在普通 `TextEditor` 内产出多行、不可编辑、参与布局的代码行**；该形态只能靠 proposed `editorInsets` | d.ts 全文；`RESULTS.md` §4 穷举 | **不能用 Marketplace 扩展交付 README §8 的「多行 old 内联代码行」**；只能退回 A（单行 old）+ B（widget 多行）组合 |
| `editorInsets`（#85682）**自 2019-11-27 冻结至今未改**（`main` 与 1.138.0 tag 逐字节相同），未 finalize、不在 Marketplace；`WebviewEditorInset.line`/`height` 是 `readonly`；inset 不覆盖装订线、不被 Ctrl+F/选择命中 | `RESULTS.md` §5；`VscodeReviewApis` §5 | **不能上架 Marketplace**；几何每次变化都要 dispose+重建（PoC 用「先清空 `webview.html` 再 dispose」避 1 s 残留）；**做不出 diff 的 `-` 号装订线标记**；`height` 语义是**行数不是像素**（传 19 → 361 px） |
| **ACP v1 没有 changeset / hunk / turn id / accept-reject 概念**，diff 只以 `ToolCallContent{type:"diff",path,oldText\|null,newText}` 挂在 tool call 上；规范允许 `session/update` 出现在 turn 之外；v2 更明确「prompt 响应是 ack，不是 turn 结束」 | ACP v1 schema 全文（5,960 行）；`AcpSurface` §4/§5 | **不能从 ACP 协议拿到 turn 级变更集**；客户端只能靠缓冲 `session/prompt` 到 `stopReason` 之间的 diff 做启发式近似；**接受/拒绝语义必须由客户端自造**，协议层没有可依赖的原语 |
| `diff` 的 `oldText: null` 只表示新文件，**无法区分删除与空文件**，也无 move/copy/binary | `AcpSurface` §4（RFD `diff-delete`） | **不能只靠 ACP 判断文件是被删、被清空还是被移动**；删除/重命名/二进制需要额外探测（客户端侧或 MCP 工具） |
| 权限选项集由 **agent 撰写**，`kind` 只有 `allow_once/allow_always/reject_once/reject_always` | `AcpSurface` §6 | **IDE 无法注入自己的策略分类/持久规则/作用域**；只能决定展示哪些选项、标签顺序、是否自动应答 |
| ACP **没有任何工具注册方法**，客户端能力集只有 `{readTextFile, writeTextFile, terminal, requestPermission}`；v2 更把客户端 fs/terminal **删除** | `AcpSurface` §1b/§3；`OmpSurface` §6 | **不能把 IDE 能力经 ACP 直接做成 agent 工具**；必须走 (a) `session/new.mcpServers` 注入的 MCP server，或 (b) OMP 专有的 `--mode rpc` `set_host_tools`（不可移植到别的 harness）；且**不应把设计压在 v1 的客户端 `fs/*`+`terminal/*` 上**——v2 已删除该面 |
| VS Code **没有任何稳定机制能把 IDE 能力暴露给外部进程**：`lm.registerTool` 等只有进程内可见；无外部工具调用端点；无 per-tool 审批钩子；**VS Code 没有 MCP server 模式** | `VscodeAgentApis` 验收问题与近失机制 1–6、MCP 段 | **不能靠 VS Code 稳定 API 直接实现 README §6「IDE 能力回喂 agent」**；可行路线只有 AHP 客户端工具贡献（需 host 支持）、proposed `chatSessionsProvider`（不能上架）、或扩展自建 MCP server 再喂给 harness |
| 1.138 d.ts **L21070：`export type ChatParticipantToolToken = never;`** —— 真实 token 类型只在 `chatParticipantPrivate` 提案里 | `VscodeAgentApis`；d.ts L21070 | **不能经稳定 API 把工具调用绑定到某个 chat request**（关联语义是私有的） |
| **VS Code 的 Agent Host 不接受第三方 harness/adapter 注册**：`vscode.d.ts` 对 `agentHost`/`AgentHost`/`ChatSession`/`chatSessions` 命中 0，无 `contributes.agentHost` | `AhpAgentHost` §2(d)；`VscodeAgentApis` | **不能把 OMP 作为一个 harness 注册进 VS Code 原生 Agent Host**；也不能复用 VS Code 的 chat session 类型（除 proposed `chatSessionsProvider`） |
| AHP 拓扑与 ACP **相反**（AHP host=server / N clients → 1 session；ACP client → 1 agent），