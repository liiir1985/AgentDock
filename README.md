# 开放式 IDE Agent Harness 集成方案

## 1. 项目目标

目标不是重新实现一个 AI IDE，也不是把某一个 Agent Harness 简单嵌入 VS Code。

项目的核心目标是：

> **把 IDE 改造成一个开放的 Agent Harness 运行与交互环境，让任意现代 coding agent 能够复用 IDE 已有的语言能力、编辑能力、审阅能力和开发工具，同时保留各 Harness 自己的 Agent Runtime、模型 Provider 与模型能力。**

其中：

* IDE 负责开发环境能力和用户体验；
* Harness 负责 Agent Runtime；
* Adapter 负责两者之间的转换；
* 模型和 Provider 的具体调用语义始终由 Harness 掌握。

第一阶段以 **VS Code + OMP** 作为 reference implementation，但整体设计不能绑定 OMP。

---

# 2. 核心设计原则

## IDE 不拥有 Agent Runtime

IDE 不负责：

* Agent Loop；
* Context Engineering；
* Provider API 实现；
* 模型调用协议；
* Reasoning 参数具体映射；
* Provider-specific 功能；
* Harness 内部 Tool Strategy。

这些全部属于 Harness。

例如：

```text
OMP
├─ Model Providers
├─ Model-specific capabilities
├─ Agent Loop
├─ Context Management
├─ Tools
├─ Subagents
└─ MCP
```

IDE 不重新实现这些能力。

---

## IDE 提供 Agent 所需的开发环境基础设施

IDE 负责提供：

```text
Language Intelligence
Editor
Workspace
Diagnostics
Diff / Review
SCM
Terminal
Tests
Debug
Permissions
Navigation
```

Agent 应该可以主动调用这些能力，而不是依赖用户手动把 IDE 上下文发送给 Agent。

最终交互模型是：

```text
用户表达意图
      ↓
Harness / Agent
      ↓
主动调用 IDE capabilities
      ↓
IDE 执行并返回结构化结果
```

而不是：

```text
用户手动收集 context
      ↓
发送给 Agent
```

---

# 3. 整体架构

顶层结构为：

```text
┌─────────────────────────────────────────┐
│                  IDE                    │
│                                         │
│ Editor / Review / Diff / Tests / SCM    │
│                                         │
│ IDE Capability Providers                │
│                                         │
│ Provider & Model Preferences            │
└─────────────────┬───────────────────────┘
                  │
             Open Agent Core
                  │
       ┌──────────┼──────────┐
       │          │          │
   Session     Changes     Policy
       │          │          │
       └──────────┼──────────┘
                  │
            Harness Adapter
                  │
          ┌───────┴────────┐
          │                │
         ACP           Other Adapter
          │                │
         OMP          Other Harness
```

Open Agent Core 是项目真正应该拥有的核心。

它不属于 VS Code，也不属于 OMP。

未来可以复用于：

```text
VS Code
Visual Studio
JetBrains
其他 IDE
```

以及：

```text
OMP
Claude Code
Codex
Gemini
其他 Harness
```

---

# 4. Harness Adapter

Harness Adapter 是 IDE 与具体 Agent Harness 之间唯一需要了解 Harness 差异的部分。

第一版：

```text
ACP Adapter
    ↓
OMP
```

未来：

```text
Harness Adapter
├─ ACP
├─ Claude
├─ Codex
├─ Gemini
└─ Other
```

如果多个 Harness 支持 ACP，应优先通过通用 ACP Adapter 接入，而不是为每个 Harness 单独实现。

Adapter 的职责包括：

* Session 生命周期映射；
* Agent Event 转换；
* IDE Capability 暴露；
* Permission 转换；
* Change 转换；
* Provider / Model Preference 转换；
* Harness capability compatibility 判断。

---

# 5. Provider 与 Model 配置

IDE 可以提供统一的 Provider / Model 配置体验，但不能变成统一 LLM Gateway。

用户只配置一次：

```text
Provider
Endpoint
Credential
Model
Reasoning Preference
Output Token Preference
```

这些信息属于：

> **Preference / Hint / Identity**

而不是具体 API 请求参数。

例如：

```text
reasoningEffort = high
```

表示用户希望较高 reasoning effort。

它不表示 IDE 必须向 Provider 发送：

```text
reasoning.effort = "high"
```

具体如何实现，由 Harness Adapter 决定。

因此流程为：

```text
IDE Model Profile
      ↓
Canonical Preferences
      ↓
Harness Adapter
      ↓
Harness-native configuration
      ↓
Harness
      ↓
Provider
```

核心原则：

> **IDE 统一配置体验，Harness 保留 Provider 语义主权。**

IDE 不应该强迫所有模型转换成 OpenAI、Azure 或任何其他单一 Provider API 形式。

---

# 6. IDE Capability Model

IDE 应作为 Agent 的能力提供者。

典型能力包括：

```text
language.definition
language.references
language.symbols
language.rename
language.codeActions

diagnostics

workspace.read
workspace.edit

terminal.execute

tests.run
tests.inspect

scm.status
scm.diff

debug.*

editor.selection
editor.navigation
```

这些能力需要支持 capability negotiation。

例如：

```text
TypeScript workspace

✓ definition
✓ references
✓ rename
✓ diagnostics
✓ tests

某个特殊语言 workspace

✓ diagnostics
✗ rename
✗ tests
```

Agent 必须能够知道：

* 能力是否存在；
* 当前是否可用；
* 调用失败时是否可以 fallback 到 Harness 自己的实现。

IDE capability 是增强 Harness，而不是取代 Harness 原有能力。

---

# 7. Change / Review 是项目核心能力

Agent 修改文件不能只被理解为：

```text
Agent → writeFile()
```

必须有独立的 Change Model。

基本层级：

```text
Session
  ↓
Turn
  ↓
Turn ChangeSet
  ↓
Files
  ↓
Hunks
```

例如：

```text
Turn 18
├─ parser.ts
│  ├─ Hunk A
│  └─ Hunk B
├─ lexer.ts
│  └─ Hunk C
└─ parser.test.ts
   └─ Hunk D
```

每个 Hunk 都有独立状态：

```text
Pending
Accepted
Rejected
```

同时支持：

```text
Accept Hunk
Reject Hunk

Accept File
Reject File

Accept Turn
Reject Turn
```

并且能够按 Turn 查看 Agent 产生的 ChangeSet。

ChangeSet 与 Git Diff 是两个不同概念：

```text
Git Diff
=
Workspace 相对于 Git revision 的变化

Turn ChangeSet
=
某一次 Agent Turn 产生的变化
```

项目必须拥有后者。

---

# 8. 目标编辑体验

目标不是传统 side-by-side Diff Editor。

目标体验类似 Antigravity：

```text
正常打开 foo.ts

普通 Text Editor 中直接看到修改

- original code
+ proposed code

[Accept] [Reject]
```

用户仍然处于正常编辑器中，可以：

* 阅读整个文件；
* 跳转代码；
* 使用 LSP；
* 手动继续编辑；
* 单独接受或拒绝某一个修改区域。

同时可以切换：

```text
Current Turn
Previous Turn
Cumulative Changes
```

并查看对应 ChangeSet。

Agent Changes UI 应更接近：

```text
Source Control / Change Review
```

而不是 Chat UI。

---

# 9. Agent UI 的结论

不复用当前 VS Code Agent UI。

最多参考其概念和交互经验。

原因是当前 Agent UI 与微软 Agent Host、Harness Provider 和其产品架构存在较深耦合，第三方完整 Harness 注册能力目前也不够开放。

因此第一阶段：

> **不依赖内置 Agent UI。**

同时也不重新实现一个大型 Agent Chat 应用。

项目自己的 UI 应尽可能薄，只承担：

```text
Session
Turn
Changes
Harness Selection
Model Preference
Permissions
Activity
```

具体开发行为尽量使用 IDE 原生界面：

```text
Editor
Problems
Terminal
Test Explorer
SCM
Navigation
```

---

# 10. AHP 的定位

AHP 不作为项目核心内部协议。

它被定义为：

> **未来可选的 interoperability adapter。**

当前核心场景：

```text
VS Code
   │
Open Agent Core
   │
ACP
   │
OMP
```

已经足够。

未来如果需要：

```text
Remote Agent Host
Persistent Background Sessions
Multi-client Sessions
AHP Ecosystem Compatibility
```

再增加：

```text
AHP Adapter
```

因此原则是：

> **支持 AHP，但不让 AHP 定义内部架构。**

同样，也不依赖 Microsoft Agent Host。

---

# 11. 实现策略

第一选择：

> **VS Code Extension。**

暂时不 Fork VS Code。

原因是绝大多数核心能力都可以通过 Extension API 实现：

```text
Editor integration
Decorations
Commands
CodeLens
Language providers
Diagnostics
Terminal
Testing
SCM
Navigation
Sidebar / Tree View
```

Fork VS Code 会额外带来：

```text
Upstream maintenance
Electron maintenance
Security updates
Distribution
Marketplace compatibility
Remote development compatibility
Release infrastructure
```

这些都不是当前项目的核心价值。

因此只有在明确证明某个关键 UX 无法通过 Extension API 实现后，才考虑：

```text
Minimal VS Code patch
```

Fork 是最后手段，而不是默认方案。

---

# 12. 当前最大的未知风险

目前最关键的不确定性不是：

```text
OMP integration
ACP
Provider configuration
LSP integration
```

这些已经基本确认可行。

真正可能决定是否需要修改 VS Code Core 的问题是：

> **是否能够仅使用稳定 Extension API，实现 Antigravity-style 普通 Text Editor 内的 inline per-hunk review。**

尤其是：

```text
显示新增内容
显示被删除的旧内容
显示 replacement
每个 Hunk 独立 Accept / Reject
用户继续正常编辑
用户编辑后 Hunk 仍然可以正确追踪
```

新增内容通过 decorations 等机制比较容易。

真正需要验证的是：

> **已经从 TextDocument 中消失的多行 deleted content，能否以足够原生的方式嵌入普通 Text Editor，并形成完整 inline diff experience。**

这是目前整个方案最大的 Extension API boundary 风险。

---

# 13. 第一阶段唯一优先技术验证

在正式建设 OMP Adapter、Provider Manager、Agent Session 等模块之前，先完成一个独立 Editor Review PoC。

这个 PoC 不需要 Agent。

使用一个固定的 fake patch 即可。

测试流程：

```text
打开普通源代码文件
        ↓
应用一个模拟 Agent Patch
        ↓
在普通 Text Editor 中显示 Inline Diff
        ↓
显示多个独立 Hunk
        ↓
每个 Hunk：
Accept / Reject
        ↓
用户手工修改附近代码
        ↓
再次 Accept / Reject
        ↓
检查 Hunk 是否仍然正确定位
```

必须验证以下三件事：

### 1. Rendering

能否达到目标视觉体验：

```text
普通 Text Editor
+
inline inserted text
+
inline deleted text
+
replacement visualization
+
per-hunk actions
```

### 2. Interaction

能否稳定支持：

```text
Accept Hunk
Reject Hunk
Accept File
Reject File
```

同时不破坏正常文本编辑。

### 3. Reconciliation

当 Agent 修改完成后，用户又继续手工编辑文件时：

```text
Agent Proposal
      +
User Edits
```

Change Hunk 是否仍能正确定位、Accept 和 Reject。

这一点意味着最终 Change Model 不能只依赖静态行号，而需要支持 patch rebase / reconciliation。

---

# 14. 第一阶段决策门

完成 Editor Review PoC 后，根据结果决定后续架构。

```text
             Inline Review PoC
                    │
          ┌─────────┴─────────┐
          │                   │
 Stable Extension API     无法满足
     足够                  UX要求
          │                   │
          ▼                   ▼
继续 Extension         检查 Proposed API
                              │
                      ┌───────┴───────┐
                      │               │
                   可接受          仍不够
                      │               │
                      ▼               ▼
                隔离实验实现    Minimal Core Patch
```

只有最后一种情况才进入 VS Code Core 修改。

---

# 15. MVP 后续范围

Editor Review PoC 成功后，再按以下顺序建设：

```text
1. ChangeSet / Turn Patch Core

2. VS Code IDE Capabilities

3. ACP Adapter

4. OMP Integration

5. Provider / Model Preference Manager

6. Permission / Policy Layer

7. Session / Turn Management

8. Agent Changes View
```

第一阶段不考虑：

```text
AHP Host
Remote Agent
Multi-client
Background daemon
Visual Studio
JetBrains
大量 Harness
完整 DAP abstraction
复杂 Web UI
```

这些都属于后续扩展。

---

# 最终定义

这个项目最终不是：

> 一个 OMP VS Code 插件。

也不是：

> 一个新的 VS Code Agent UI。

更不是：

> 一个新的模型 Gateway。

它应该被定义为：

> **一个开放的 IDE Agent Integration Layer。**

它负责把：

```text
IDE 的开发能力
```

开放给：

```text
任意 Agent Harness
```

同时让：

```text
任意 Agent Harness 的工作结果
```

以 IDE-native 的方式呈现和审阅。

核心边界最终是：

```text
IDE owns:
Experience
Capabilities
Review
Policy
Preferences

Harness owns:
Agent Loop
Models
Providers
Context
Tools
Runtime

Adapter owns:
Translation
```

而当前已经明确的第一步不是接 OMP，也不是实现 ACP：

> **首先验证 VS Code Extension 能否实现目标中的 Antigravity-style inline per-hunk change review。**

这个验证结果将直接决定项目是否可以长期保持纯 Extension 架构，还是需要极小范围进入 VS Code Core。
