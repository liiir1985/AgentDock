# Editor Review PoC — 结果与 §14 决策门结论

## 结论速览

- **Rendering**：new 侧（真实文档文本）在普通 Text Editor 里可以做到与代码行完全一致；**old 侧在稳定 API 下无法成为"夹在上一行与 new 文本之间"的一行** —— 附件不参与布局（P1–P4、P7），只能落在上一行行尾 / 新行行首 / 新行行尾三选一。
  可达该形态的两条路：**Comments widget**（稳定 API；线程 range 锚到 `targetRange.start - 1` 后，widget 落在上一行与 new 文本之间并把 new 侧顶下去，但形态是区块）与 **`editorInsets`**（proposed API；N 行 old = N 行真实行，插在 new 侧正上方）。
- **Interaction**：逐 hunk Accept / Reject、冻结、stale 这些定位与语义完全由稳定 API 表达；但**行内可点击的动作面只有 CodeLens**，而 VS Code 以定时器刷新它（实测 393 / 421ms）。
  装饰与 inset 本身是即时的（25ms；inset 清空 HTML 后瞬时），因此 Accept / Reject 的视觉提交被**同步到 CodeLens 的那次 provider 查询回调**里，三者同一 tick 落地（实测同一采样点 393ms），文档只跳一次。唯一即时的按钮形态是 Comments widget 的标题栏按钮（41ms），但它是区块而非行内。
- **Reconciliation**：纯模型决策表 + `rejectEdit` 在所有形状上逐字节可逆（纯插入 / 纯删除 / 原地替换 / 多行替换 / 文件头删除 / EOF 追加）；跨边界编辑正确转 `stale` 并冻结动作；用户手改 new 侧后 Accept 采纳当前文本、Reject 丢弃。自编辑吸收（`pendingSelfEdits`）与用户编辑严格区分。
- **§14 决策门**：**第二分支** —— 稳定 API 足够做 Review 的定位、语义、交互与单行 old，但 README §8 的"多行 old 内联代码行"需要 proposed API（`editorInsets`，已实测达成）；该提案自 2019 年冻结、不可上架 Marketplace，因此这一形态只能靠自有分发或 fork 交付。触发该结论的具体不通过项与探针编号见 §6。

## 1. 环境

| 项 | 值 |
| --- | --- |
| VS Code | **1.138.0**，commit `7debcd0e2acdea1c52de81bf9ee1620444407dda`（`code --version`） |
| 安装路径 | `C:\Users\Admin\AppData\Local\Programs\Microsoft VS Code`（应用载荷在 `<install>/7debcd0e2a/resources/app`，根目录 `Code.exe` 为 Electron 宿主，可直接作为 `vscodeExecutablePath`） |
| Node / npm | 24.14.1 / 11.11.0 |
| 扩展 | `poc/editor-review`，`engines.vscode: ^1.137.0`（实测运行于 1.138.0），仅使用稳定 API |
| 日期 | 2026-09-16 初版；2026-09-17–18 追加 h6（多行删除 + 新增）、old 行锚点规则、点击时延与同步（R6） |

> 说明：本机在本次验证过程中由 1.137.0（`645f29cc31`）自动升级到 1.138.0（`7debcd0e2a`）。所有结论均在 1.138.0 上复测通过。

## 2. 运行步骤

```bash
cd poc/editor-review
npm install
npm run compile
npm test                     # 13 个纯逻辑单测
npm run test:integration     # 真实 VS Code 扩展宿主内的端到端断言
```

人工目检（或用 F5）：

```bash
# 需要 ELECTRON 宿主二进制；等价于 launch.json 的 Run Extension
"C:\Users\Admin\AppData\Local\Programs\Microsoft VS Code\Code.exe" \
  --extensionDevelopmentPath="D:\svn\AgentDock\poc\editor-review" \
  --disable-extensions --new-window "D:\svn\AgentDock\poc\editor-review\fixtures"
```

打开后 `agentReview.autoApply`（默认 true）会自动把固定 fake patch 应用到 `fixtures/sample.ts`，
无需任何 Agent。依次执行 `Agent Review: Run Rendering Probe`、`Agent Review: Set Render Mode`（切到 `comments` / `insets`）
即可按 R 表逐项核对。

方案 C（`insets`）用的是 proposed API，必须带 `--enable-proposed-api=agentdock.agentdock-editor-review-poc` 启动；
`launch.json` 与集成测试的启动参数里都已包含该开关，命令行手工启动时也要加上，否则扩展不会激活。

## 3. 检查表

### R1 同一普通编辑器内同时可见 new 与 old —— **通过（有形态限制）**

- new 侧是真实文档文本，带 `diffEditor.insertedLineBackground` 整行底色（早期版本还带 `+` 装订线图标，现已按 R5 的结论移除）：
  实测计算样式 `background-color: rgba(52, 125, 57, 0.15)`，对应 h1 的 3 行插入与 h3/h5/h6 的新行。
- old 侧由附件渲染（`::after` / `::before` 伪元素），实测计算样式：
  `text-decoration-line: line-through`、`background-color: rgba(201, 60, 55, 0.15)`（`diffEditor.removedLineBackground`）。
  该行只放**首个删除行**；剩余行数由同一 hunk 的 CodeLens 项 `deleted N more line(s)...` 表示，
  鼠标悬停该行弹出**仅含删除行**的浮窗（`Hunk h2 · 2 lines deleted` + `- ` 前缀逐行），点击该 CodeLens 项会定位到锚点行并调用 `editor.action.showHover`，弹出同一个浮窗。
- **old 行借用哪一行**（`computeAnchor`，`src/model/changeSet.ts`）：
  hunk 有 new 侧 → 借用**该 hunk 自己的最后一条新行**，删除块接在这一行行尾（实测 h3：删除行 `return \`${countDone(tasks)}/${tasks.length}\`;` 与它替换出来的新行同一行，y=451 / 绿行 y=450；h6：删除首行 `if (task.done) {` 与 h6 的新行同一行，y=302 / 绿行 y=301）；
  纯删除（new 侧为空）→ 借用**上一行**，即删除位置最近的一条存活行（h2 因此独占一行，y=191）。
  早期版本一律借用上一行，导致 h3 的删除块被贴在无关的 `export function summarise(...) {` 行尾，已改。
- 实测存在的 old 行：h4（`before` 挂第 0 行，1 行）、h2（独立一行：首行 + `deleted 1 more line...`）、h3（挂在自己新行行尾，1 行，无标记）、h6（3 行删除 → 首行挂在自己新行行尾 + `deleted 2 more lines...`）。
- new 侧不挂 hover（本身就是完整可编辑文本），h1/h5 这类纯插入没有任何 old 行。
- 限制：一个 hunk 的 old 侧只能占**一行**（见 P1–P3），因此多行删除内容折叠为「首行 + `deleted N more line(s)...`」，完整内容在 hover 里。

### R2 old 侧不可编辑、new 侧正常可编辑 —— **通过（有形态限制）**

- old 侧文本不在文档里：集成测试断言补丁后 `document.getText()` 逐字节等于 `fixtures/sample.expected.ts`，
  且被删除的 4 处 baseline 文本（首行注释、两行遗留注释、`count += 1;`）不再出现在文档中 → old 内容只存在于渲染层，无法被光标编辑。
- new 侧就是普通 `TextDocument`，LSP/补全/跳转不受影响（PoC 未注册任何语言特性，未做任何拦截）。
- 限制：old 行的删除线在部分主题/缩放下像素对比度较低；`width:'100%'` 变体会把同一锚点行自身的文本挤出可视区（见 P3/P4），因此实现里没有使用 `width:'100%'`。

### R3 每个 hunk 有独立 Accept / Reject，点击命中正确 hunk —— **通过**

- 实现：`src/render/actions.ts` 为每个 pending hunk 在锚点行输出 CodeLens（Accept / Reject / 状态），
  同 hunk 的 `deleted N more line(s)...`（若有折叠行）也是**同一行**的一项 —— 一个 hunk 的动作与计数永远只占一行。
  命令参数就是 `hunk.id`（不依赖光标位置，因此不可能点错）。
- 实测：在真实窗口中点击 h6 那一行的 `Accept`（`a` 元素中心 x=471, y=328），该 hunk 的动作行（含 `deleted 2 more lines...`）与它的 old 行立即消失
  （CodeLens 行 6 → 5，带删除线的 old 行 3 → 2），其余 hunk 的动作行与 old 行不变 → 只冻结 h6。
- `Agent Review: Reset Fixture` 后 change set 清空（CodeLens 0 行），再 `Apply Fake Patch` 恢复为 6 个 `pending`。

### R4 手工编辑附近代码后，hunk 仍正确定位，Accept / Reject 结果正确 —— **通过**

集成测试（真实 VS Code）逐步断言：

| 步骤 | 断言 |
| --- | --- |
| 应用补丁 | `document.getText()` 逐字节 == `sample.expected.ts` |
| 状态 | 6 个 hunk 全 `pending`，`targetRange` == `applyHunks` 计算值（h1[12,14] h2[23,22] h3[34,34] h4[0,-1] h5[36,37] h6[27,27]） |
| reject h2 | 文档逐字节 == 纯模型 oracle；h2 变 `rejected`/冻结；其下 h3→36、h5→38，其上 h1 仍 12、h4 仍 0 |
| 在 h3 上方插 3 行 | h3→39、h5→41 各 +3；h4、h1 与更靠上的 h6 不变；h3 仍 `pending` 且 `userEdited=false` |
| acceptFile | 文本不变（含用户手写的 3 行），5 个 hunk 变 `accepted`，无 pending |
| resetFixture | 文档逐字节 == `sample.ts` |
| 再应用后 rejectFile | 文档逐字节 == `sample.ts`（含顶部删除与 EOF 追加两处边界） |

纯逻辑单测另外覆盖：跨边界编辑 → 两个 hunk 同时 `stale`/冻结且动作返回 no-op；
改写 new 侧后 reject 会丢弃该改动并恢复 baseline；空 new 侧内插入整行归属该 hunk（对应假设 7）。

### R5 三种方案的观感对比 —— **C 达成目标形态；A 缺多行 old 行；B 是稳定 API 下唯一能完整展示多行 old 内容的方案**

| | 方案 A（装饰 + CodeLens） | 方案 B（Comments API） | 方案 C（webview insets） |
| --- | --- | --- | --- |
| new 侧 | 真实文本 + 整行绿色底 | 同左（不额外渲染） | 同左（装饰只画 added 行） |
| old 侧 | 一行：首个删除行（删除线 + 红底）+ `deleted N more line(s)...` 的 CodeLens 项（点击弹出 hover）；hover 只列删除行 | 评论 widget，Markdown `diff` 代码块内 `- ` / `+ ` 前缀的**逐行完整**内容 | **每个 old 行一个真实行**（无行号），删除线 + `removedLineBackground` 底，文本左缘与代码列齐平 |
| 动作 | 行内 CodeLens `Accept / Reject / 状态`，紧贴 hunk 内容下方（见下） | 线程标题栏图标按钮（`comments/commentThread/title`，`when: commentController == agentdock.review && commentThread == agentdockHunkPending`） | 同 A（行内 CodeLens） |
| 位置 | 紧贴代码行，无额外区块 | 线程 range 锚在 `targetRange.start - 1`（new 侧正上方那一行），widget 渲染在 range 最后一行下方 → 落在**上一行与 new 文本之间**；占独立区块并顶开下方代码（实测 widget 高：h1 159px、h2 140px、h3 140px、h6 178px；视口外的 hunk 不渲染） | 插在 `targetRange.start - 1` 行下方（有 new 侧时即 new 侧正上方）的独立行区：**N 行 old = N 行真实行**（实测 h2 的 2 行 = 38px、h6 的 3 行 = 57px，均无空白）；销毁时先清空 HTML 再 dispose，见 R6 |
| 装订线 | 无（见下） | 无 | 无（inset 不覆盖装订线） |
| 机制 | 稳定 API | 稳定 API | proposed API（`editorInsets`）+ 每 hunk 一个 webview |
| 不可行点 | 多行 old 无法成为多行独立行（P1–P3） | 不是代码行形态，无逐行对齐感；`contextValue` 为 `agentdockHunkStale` 时按钮按 `when` 隐藏，实测 widget 仍保留 | 不能上架 Marketplace；提案 API 可能 break；inset 内的 old 文本对 Ctrl+F / 选择不可见 |

实测方案 B 的每个 hunk body（`comment-body` 文本）：

- h1：`Hunk h1 · pending` + `+ // h1: the agent normalised...` 等 3 行新增
- h2：`- // The next block is kept for compatibility with older callers.` + `- // It is scheduled for removal in the next cleanup pass.`
- h3：`- return \`${countDone(tasks)}/${tasks.length}\`;` + `+ return \`${countDone(tasks)} / ${tasks.length}\`;`
- h4：`- // Fixture for the AgentDock Editor Review PoC.`
- h5：`+ // h5: the agent appended...` 等 2 行
- h6：`Hunk h6 · 3 lines deleted · 1 line in the document` + `- if (task.done) {`、`- count += 1;`、`- }`、`+ count += task.done ? 1 : 0;`

### R6 交互项（由集成测试输出填充）—— **通过**

`npm run test:integration` 末尾输出 `apply suite: all assertions passed` / `integration suite passed`（`Exit code: 0`），
覆盖 R3 的 accept 路径、R4 的全部表格项，以及 `agentReview.validateFixture` 返回 `'ok'`。
点击类交互（CodeLens 点击、Comments 按钮）无法在扩展宿主内断言，已在真实窗口中人工点击验证并记录于 R3。
渲染项由渲染探针的 DOM 计算样式（`::before`/`::after` 的 `content`、`text-decoration-line`、`background-color`、
`getBoundingClientRect`）取证，非目测推断。

**点击 Accept / Reject 后的渲染延迟（2026-09-17 追加实测：真实窗口 DOM，`mousedown` → 元素消失，5ms 采样，1.138.0）**

| 被点的动作面 | 该 hunk 的渲染消失于 | 说明 |
| --- | --- | --- |
| 装饰（new 侧整行底色 + old 行） | **25ms** | `src/render/decorations.ts` 路径同步渲染，无节流 |
| Comments widget 标题栏按钮 | **41ms** | widget 与该 hunk 的装饰同时消失（`src/render/comments.ts`） |
| CodeLens 动作行（`✓ Accept / ✗ Reject`） | **393ms / 421ms**（两次） | VS Code 内部按定时器刷新 CodeLens：`onDidChangeCodeLenses` 立即触发也只能等到那一刻 |
| insets 的删除块（`dispose` 后） | 约 1s（人工观察）→ 改为先清空 HTML 后**瞬时**（人工确认） | 见下方 `InsetsRenderer.drop()` |

**动作行只能是 CodeLens**（唯一位置：有 new 侧时在该 hunk 内容下方，纯删除时在 old 行下方）。试过的三条替代路线如下，其中第 1 条只到"未验证"：

1. **inset webview 里的 `command:` 链接** —— **未复现成功，标记为未验证**。已加 `enableCommandUris: ['agentReview.acceptHunk','agentReview.rejectHunk']` 白名单，并用真实鼠标点击（frame 高 19px、链接坐标核对无误、href 为 `command:agentReview.acceptHunk?%5B%22h6%22%5D`）：点击后 2 秒内 iframe 数、链接列表、文档状态零变化。
   但同一套点击方法在同一个实例里对 CodeLens 行也有两次未生效（第三次才生效），**因此这个否定结论不可靠**，不能据此断言 inset 内无法承载按钮；要下结论必须先让点击投递可复现。当前实现按"未验证"处理：inset 只画 old 行，按钮留在 CodeLens。
2. **inlay hints 的 label part**（`InlayHintLabelPart.command`）—— 在本机 dev host 里没有观察到生成任何 `inlay-hint` 元素（未继续追查：同一位置会与 CodeLens 行重复，且它不是这个问题的必需路径）。
3. **去掉 CodeLens、只留 inset 行** —— 会产生"同一个 hunk 两行 Accept / Reject"或"没有动作行"，都不符合预期。

结论：稳定 API 下**已验证可点击的行内动作面只有 CodeLens**（约 400ms 的刷新节流无法规避）；Comments widget 的标题栏按钮是瞬时的，但形态是区块而非行内。inset 内能否承载按钮属于未验证项（见上），"瞬时且行内"的按钮在稳定 API 下目前没有已验证的实现。

**同步策略（Accept / Reject 时只跳一次）**：装饰、inset、CodeLens 行三者在**同一次** `provideCodeLenses` 查询里提交。VS Code 重建那一行之前必定会查询 provider（即上述 ~400ms 那一刻），这就等价于一个"行即将更新"的回调点：`extension.ts` 的 `refreshSynced()` 只置脏并 `codeLenses.refresh()`，真正的 `commitVisual()` 由 provider 的 `onQuery` 回调触发（另有 1s 兜底，防止该文档没被查询时状态卡住）。

实测（insets 模式，点 Accept，5ms 采样）：new 侧绿色底、old 行 inset、CodeLens 行**都在 393ms 的同一采样点**消失 → 文档只跳一次。文本驱动的更新（打字、应用补丁）仍是即时的 —— 否则高亮会落后于光标。

**insets 的销毁延迟（人工观察 → 已修）**：`dispose()` 之后 zone 与其行在编辑器里还要约 1 秒才消失，所以 `InsetsRenderer.drop()` 先 `webview.html = <空白页>`（可见行立刻消失），再 `dispose()`（zone 拆除在看不见的时候完成）。

## 4. 渲染探针（P1–P6）结论

| 编号 | 问题 | 实测结果 |
| --- | --- | --- |
| P1 | `contentText` 里的真实换行是否生效 | **不生效**：`'P1-first\nP1-second'` 的装饰元素根本没生成，只剩不下任何 old 第二行（对应 microsoft/vscode#63600）；用字面 `\n` 两个字符时只显示 `P1-first` |
| P2 | 同一锚点 3 个不同类型附件 | **全部渲染，但落在同一行**，按调用顺序水平排列：实测 y 全为 156，x=680/744/808 |
| P2b | 同 3 个类型各挂一行（对照组） | 3 行独立渲染：y=213/232/251 → 类型本身没问题，差异只在锚点位置 |
| P3 | 同一锚点 + `width:'100%'` + border + line-through | **不会各占一行**：仍同一行（y 全为 459），且首尾相接水平推挤，第 2/3 个的 x=1443/2066 已超出编辑器右边界（编辑器 x=353..1139）而不可见 |
| P4 | `before` 附件挂第 0 行 | 空闲时渲染于第 1 行行首（实测 `::before` 内容 `P4-BEFORE-LINE-0`，x=434）；与 h4 自己的 old 行同 offset 时只剩其一 → **同 offset 装饰互斥** |
| P5 | `ClosedClosed` 附件稳定性 | 采用 `DecorationRangeBehavior.ClosedClosed`（与实现一致）；锚点行的稳定性由 R4 的“上方插 3 行 → 目标 hunk 精确 +3”断言覆盖 |
| P6 | CodeLens 同行显示与命中 | 每个 pending hunk 的锚点行渲染成一行 `✓ Accept | ✗ Reject | ⓘ Agent change · pending`（有折叠行时 `deleted N more line(s)...` 加在同一行最前）；点击某个 hunk 的 Accept 只影响该 hunk（见 R3） |
| P7 / P7b | 通过 `textDecoration` 注入 `content` + `display:block` 能否做出多行 old 块 | **机制生效、但不能占位**：注入的声明原样进入生成的 CSS 规则（实测规则原文含 `content: "P7-OLD-1\a P7-OLD-2\a P7-OLD-3"; white-space: pre; display: block`），`contentText: ''` 时 VS Code 不会再写自己的 `content`，`\A ` 换行与 `var(--vscode-*)` 都被解析（实测背景 `rgba(201,60,55,.15)`、文字 `rgb(140,140,140)`）；元素高度实测 57px = 3×19px。**但**每一行盒高度固定 19px（`.view-line` computed height=19px，`overflow: visible`），装饰不参与布局：块占 97..154 时其下方真实行仍在 y=116 → 实测有 2 个真实行盒落在块的范围内，即**多行 old 块会盖住下方的真实代码**，与 P3 的结论同源（装饰无法创造行空间） |

**由此得到的实现约束（已写入 `src/render/decorations.ts` 的说明）**：一个 hunk 的 old 侧永远只用**一个**附件，
内容只放首个删除行；剩余行以 `deleted N more line(s)...` 的 CodeLens 项承载，全文放在 hover 里（仅删除行）。
不使用 `width:'100%'`，且绝不让两个附件落在同一 offset；new 侧不挂 hover。

## 5. 方案 C（`editorInsets`）实测

方案 C 已实现为 `agentReview.renderMode = "insets"`（`src/render/insets.ts`），是唯一达到 README §8 目标形态的方案。

**形态（真实窗口实测）**

- 每个有 old 内容的 pending hunk 生成一个 webview inset，插在 `targetRange.start - 1` 行**下方**（有 new 侧时即 new 侧正上方）：实测 h4（`targetRange.start = 0`，clamp 到第 0 行）的 inset 出现在第 1 行下方。
- **N 行 old = N 行真实行**：h2 删除 2 行 → inset 高 38px，视觉上是两条无行号、带删除线、底色为 `diffEditor.removedLineBackground` 的红色行，位于第 23 行与第 24 行之间；h6 删除 3 行 → inset 高 57px（3×19px），紧贴其上方的 new 行（inset y=130..187、绿行 y=187），**均无空白块**（对比修复前把 `height` 当像素传导致的 361px 空白）。
- **inset 之间不夹动作行**：inset 只画 old 行；Accept / Reject 由该 hunk 的 CodeLens 行承载（有 new 侧时在其下方、纯删除时在 inset 下方），因此每个 hunk 只有一个动作行。
- **销毁要先清空 HTML**：`dispose()` 之后 zone 与其行在编辑器里还要约 1 秒才消失（人工观察），所以 `InsetsRenderer.drop()` 先把 `webview.html` 换成空白页，再 `dispose()`。
- 文本左缘与代码列齐平（实测 inset 左缘与代码列同为一个 x，内缩 0；见下方「文本对齐」）。
- new 侧仍由装饰提供整行绿色底（insets 模式下装饰只画 added、不画 old），每 hunk 的 CodeLens（`✓ Accept | ✗ Reject | 状态`）照常；两侧都不再有装订线图标。
- inset 不覆盖装订线，因此做不出 diff editor 的 `-` 号 gutter 标记；实现里去掉了 marker，删除语义完全由删除线 + 底色表达。
- **行内动作行的锚点规则**（`src/render/actions.ts`）：CodeLens 渲染在其锚点行**上方**，所以锚点取 hunk 内容之后的那一行 ——
  有 new 侧时锚在 `targetRange.end + 1`（动作行落在新增行正下方），纯删除时锚在 `max(0, anchorLine) + 1`（动作行落在 old 行正下方）。
  实测：h3（原地替换）的 inset 占 y=336..355，其 new 行（绿行）在 y=355，动作行紧随该行下方 —— 紧贴内容，中间不再夹其它文本。
- **文本对齐**：实测代码列（`.view-line` 内首个 span）左缘 x=304，inset 左缘同为 x=304，因此 inset 内的文本内缩为 **0**（早先按 13px 内缩会让删除文本比正文右移约一个字符）；缩进用 `tab-size: <editor.tabSize>` 渲染，保证带 tab 的行仍与代码列对齐。
- **装订线图标全部移除**（`gutterIconPath` 已从 added 行装饰删除，`media/added.svg`、`media/removed.svg` 随之删除）：实测装饰元素里 `.cgmr`/`.cigr` 数量为 0。原因见 R5：inset 无法在装订线加低存在感的 `+/-`，与其只给 new 侧一个突兀的大图标，不如两侧都不加，改动信息只靠行底色表达。

**两个 API 事实（实测，写进代码注释）**

1. `createWebviewTextEditorInset(editor, line, height)` 的 `height` 是**行数**而不是像素：传 19 得到 361px 的 zone（19 × 19px 行高），传 1/2 得到 19px/38px。`InsetEntry` 因此按行数做几何比对。
2. inset 渲染在给定 `line` 的下方，且 `line` / `height` 都是 `readonly` —— 几何变化必须 dispose 后重建（实现里按 `line`+`rows` 变化才重建，避免每次编辑都闪）。

**约束与风险**

| 项 | 实测/说明 |
|---|---|
| 启用方式 | `package.json` 的 `"enabledApiProposals": ["editorInsets"]` + 启动参数 `--enable-proposed-api=agentdock.agentdock-editor-review-poc`（`launch.json`、`src/test/integration/runTest.ts` 均已加；集成测试实测仍然全绿） |
| 分发 | 用提案 API **不能上架 Marketplace**，只能 VSIX / 侧载 / 企业分发；提案 API 不保证跨版本兼容 |
| 类型 | `@types/vscode` 不含提案声明，已 vendor `src/types/vscode.proposed.editorInsets.d.ts`（取自 microsoft/vscode tag 1.138.0，签名与运行时一致：`WebviewEditorInset`） |
| 行高 | 本版 `TextEditorOptions` 已无 `lineHeight`，行高由 `editor.fontSize × 1.35` 推导（默认 14px → 19px，与实测行高吻合）；偏差可用 `agentReview.insetRowHeight` 覆盖 |
| 提案状态 | **2019-11-27 由 jrieken 开，至今 open**（issue #85682，labels：`api-proposal` / `editor-insets` / `feature-request`，milestone = Backlog，无 assignee、无关联 PR）；且 `main` 分支的 `vscode.proposed.editorInsets.d.ts` 与 1.138.0 tag **逐字节相同** —— 提案自 2019 年写下后没有过任何改动。据此判断它极可能永远不会 finalize，因此依赖它的扩展**无法上架 Marketplace**，且每次 VS Code 升级都要复测（本版 `height` 语义就与直觉不符，见上） |
| 自有分发的降低摩擦手段 | 实测 VS Code 的 `product.json` 存在 `extensionEnabledApiProposals` 白名单（本机列了一批扩展 id → proposals），主进程会读取。自带分发（企业安装器 / 便携版 / fork-lite）可把 `agentdock.*` + `editorInsets` 写进该白名单，用户就不需要 `--enable-proposed-api` 开关；但仍是自有分发，不是 Marketplace |
| 未实测 | 几十/上百个 inset 时每 inset 一个 webview 的开销、Ctrl+F 与选择无法命中 inset 内的 old 文本、点击 inset 后焦点进入 webview |

## 6. §14 决策门结论

**结论：稳定 API 足以完成 Review 的定位/语义/交互，但不足以实现 README §8 的“多行 old 内联代码行”；该形态需要 proposed API —— 已用 `editorInsets` 实测达成（见 §5）。即 §14 的第二分支。**

**交互时延落在同一条分界上**（R6 实测）：装饰与 inset 的更新是即时的（25ms；inset 清空 HTML 后瞬时），但稳定 API 下唯一行内可点击的动作面是 CodeLens，VS Code 以定时器刷新它（~400ms）且没有“行已刷新”回调 —— 只能借 `provideCodeLenses` 那次查询做同步提交，做不到“点下即消失”的行内按钮。Comments widget 的标题栏按钮 41ms 即可生效，但它是区块形态，不是行内。

进一步的分发结论（依据 §5 的提案状态：2019 年起冻结、main 与 1.138.0 逐字节相同）：**这个目标形态无法通过 Marketplace 扩展表达**。
于是取舍从“用哪个 API”变成“用哪种分发形态”：

- **Marketplace 扩展** → 目标形态不可达；可用组合是 A（行内单行 old）+ 打磨后的 B（widget 内完整多行）+ `quickDiffProvider`（稳定 API，提供低存在感的 `+/-` 装订线标记与概览标尺）。
- **自有分发**（VSIX 侧载 / 企业安装器 / 便携版，必要时用 `product.json` 的 `extensionEnabledApiProposals` 白名单）→ C 今天即可用。
- **fork**（Antigravity / Trae / Cursor 的做法）→ 可把该能力做成真正的稳定 API，并顺手修掉提案本身的两个坑（`height` 语义反直觉、inset 不覆盖装订线）；代价是构建、发布与安全更新全部自担。

触发该结论的具体不通过项（均为稳定 API 的硬限制）：

1. **P1** — `contentText` 不支持换行，单个装饰无法承载多行文本（microsoft/vscode#63600，仍未实现）。
2. **P2 / P3** — 同一锚点的多个附件永远排在同一行：既不能纵向堆叠成多行，`width:'100%'` 也只是把它们水平推挤并挤出可视区。
3. **P4** — 同 offset 的多个行内装饰互斥，且实例级 `renderOptions.after.contentText` 存在已知渲染错乱（microsoft/vscode#242764），
   因此“每 hunk 每 old 行一个附件”的方案在稳定 API 下不可行。
4. 因 1–3，方案 A 的 old 侧只能退化为“每 hunk 一行拼接文本”，且这一行只能是**上一行行尾 / 新行行首（把新文本右推）/ 新行行尾**三选一，
   无法在上一行与 new 文本之间占一行（附件不参与布局，P3/P7 已证 `width:'100%'` 与 `display:block` 只压盖下方真实行）。R1/R2 因此带形态限制。
   方案 B（Comments widget）是真实布局块：把线程 range 锚到 `targetRange.start - 1` 后，widget 落在**上一行与 new 文本之间**并把 new 侧顶下去，
   位置正确、且能完整显示多行 old；代价在形态 —— 它是区块（标题栏、内边距、可折叠），不是 19px 行盒，没有行号列与逐行对齐，与“被删掉的那几行代码还在那儿”的观感差一层。

稳定 API 仍然足够的部分（无需 proposed API 即可交付）：

- 逐 hunk 定位、Accept / Reject 语义、跨编辑 reconcile（含 stale 冻结）、old 内容在文档中不存在、
  CodeLens 动作行、Comments widget 的完整多行 diff、主题色（insertedLineBackground / removedLineBackground / line-through）。

已实测的 proposed 路径与后续取舍：

1. `window.createWebviewTextEditorInset`（`editorInsets`）—— **已在 §5 实现并实测达成目标形态**（多行 old 以真实行内联）。
   代价是分发：不能上架 Marketplace，需要 `--enable-proposed-api`，且 API 可能随版本变动。
   若第二阶段接受该代价，直接沿用 `agentReview.renderMode = "insets"` 这条路径。
2. 若必须能上架 Marketplace：退回 A（可用）+ B（补全多行内容）组合，接受 old 侧不是代码行形态。
3. `quickDiffProvider` + `textEditorDiffInformation`：用于把“Turn ChangeSet ≠ Git Diff”与编辑器自带 diff 视图打通，
   与多行内联渲染无关。
4. Minimal Core Patch（VS Code 侧改造编辑器内联装饰能力）：只有在 1 的分发代价不可接受、又必须上架时才考虑。
