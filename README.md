# dsh-ide-mode

一个「IDE 模式」面板：会话标题栏加一个按钮，点一下把主面板换成自绘的三栏 —— 文件树 / **CodeMirror 6 可编辑代码区（Ctrl+S 保存）** / **真实对话**。再点一下（或点面板顶栏唯一的「退出 IDE」）回到原生对话。

包名 `@inory/dsh-ide-mode`（GitHub 仓库 `dsh-ide-mode`），Plugin Manager 里的**显示名是 `dsh-ide-mode`**（`locale/{zh,en}.json` 的 `meta.title`，中英两侧一致）；标题栏按钮仍写「IDE 模式」—— 那是动作名，不是插件名。

## 安装

市场索引：`https://raw.githubusercontent.com/Inorysekiro2333/dsh-ide-mode/main/index.json`

1. 侧栏 **插件 → 实验性插件旁的「更多」→ 启用「自定义插件市场」**；
2. **插件 → 发现 → 添加索引源**，粘贴上面的 URL，选中它；
3. 在条目上点 **安装**。

不想用市场也可以：**添加插件** 里直接填 `https://github.com/Inorysekiro2333/dsh-ide-mode`（跟随默认分支），或某个提交的 spec `git+https://github.com/Inorysekiro2333/dsh-ide-mode.git#<commit>`。要求 DSH ≥ 0.2.1-rc.3（见 `engines.dsh`）。升级需先卸载再安装。

- 注册：`conversation.session.header.utilities`（`id: dsh-ide-mode:toggle`，`order: -20`）与 `main` / `key: 'ide'`。
- 进入 = `ctx.get('layout').selectPanel('ide')`，退出 = `ctx.get('layout').selectPanel(null)`（**每次现取**，不缓存失败结果）。**仅此两件事**。
- 顶栏只有一个动作：「退出 IDE」= `selectPanel(null)` + 清空本会话的 IDE 偏好。工作目录只在左栏文件树头部显示，顶栏不再重复渲染（标题占满剩余宽度，窄宽度下不换行）。
- 不碰右栏、不调 `openRightbar`/`openTab`、不猜页签 kind、不碰左栏折叠态。
- 文件**读**走宿主已授权的 Remote（`remote.workspaceFiles`）；文件**写**走本插件自己的唯一一条 Host 端点 `POST /dsh-ide-mode/write`（fail-closed 鉴权 + 工作区路径双重校验 + 沙箱二次把关 + 版本 CAS）—— 见「保存链路」与「写盘边界」。
- 编辑器是**按需加载**的独立 chunk（`client.editor.js`，650 KiB / gzip 228 KiB）：只有真正打开文件时才 `require.async` 它，首屏不付这份流量；chunk 挂了就退回只读 `<pre>`，面板绝不因此崩。
- 注册进 `main` 的不是面板本身，而是类组件 `IdePanelBoundary`：面板的任何渲染异常都变成一张可读卡片，绝不让 React 18 卸载整棵树（白屏），并带崩溃熔断 —— 见「白屏护栏」。
- 标题栏按钮**只在「没有会话」时禁用**；「布局服务在不在」「`ide` 面板注册没注册」都是**点击时**判定，探测不到只是 `unknown`，绝不会把按钮变灰 —— 见「按钮与进入门禁」。

## 按钮与进入门禁（点击时判定）

`dsh.client.immediately: true`，`inject` 只有 conversation / renderer，所以本插件**可能先于 `ui-layout` 激活**。因此：

| 项 | 规则 |
| --- | --- |
| `disabled` / `aria-disabled` | 只看 `sessionId === ''`。`aria-pressed` 仍如实反映 `activePanelId === 'ide'` |
| `layout` 服务 | 每次用时 `ctx.get('layout')` 现取。**成功**的 face 缓存作兜底，**失败绝不缓存** —— 晚一帧挂载，下一次点击就能拿到 |
| `panelInfo` | 同上现取（只接受有 `getSnapshot` + `subscribe` 的形态），否则 `aria-pressed` 会永远是 `false` |
| `main` 注册探测 | `ctx.slots.entriesOfSlot('main')` → `ctx.slots.entries('main')`，两者都在 `try/catch` 里；都不可用返回 `'unknown'`（**不是** `false`，也不是 `'no'`） |
| 点击 | 有 `selectPanel` 就调；抛错只 `console.warn('[dsh-ide-mode] gate', { hasLayout, hasSelectPanel, panelRegistered, detail })`，并在按钮上留 `data-ide-toggle-error="<分项原因>"` + `title` 追加一行原因。疑似「面板还没注册」时（`panelRegistered !== 'yes'` 或错误信息像未注册）在**下一帧**重试一次 |
| 清除 | 下一次成功（`enter`/`exit`）即清掉 `data-ide-toggle-error` 与 `title` 追加行；一帧重试成功也会自己撤回痕迹 |

`canEnter()` 仍然保留，但它只喂 `gate at activation` 这条日志，不参与任何 `disabled` 计算。分项原因的格式是 `layout=yes|missing selectPanel=yes|no panel=yes|no|unknown`，加上抛错时的 `selectPanel("ide") threw: <原始 message>` —— 用户截一张按钮 tooltip 就能定位是哪一项拦的。


## 为什么自己画三栏，而不是借右栏

上一版把第三栏交给宿主右栏（`openRightbar` + 某个对话类页签）。这条路已被源码与审查共同判死：

1. 右栏的会话座条件是 `activePanelId === null` —— 与「主面板被我们的 key 占据」互斥；
2. 客户端包里没有 `kind` 为 `chat` 的右栏注册，真实存在的是 `plan` / `terminal` / `subagentchat` / `session-inspector-log` / 内置 `guide`，靠正则猜 kind 会命中 `subagentchat`、`session-inspector-log` 这类错误目标；
3. 右栏开合是可观察的宿主状态，插件一旦参与就要负责还原，用户从宿主 UI 离开时必然留下半开界面。

因此本版把三栏完全画在自己的面板里，进出只动一个 `activePanelId`。

## 文件

| 路径 | 职责 |
| --- | --- |
| `index.js` | Host 半：注册唯一一条 `POST /dsh-ide-mode/write`（零 import；服务全部 `ctx.get` + `ctx.inject(['webServer'], …)`，缺一个也只是 503，不阻塞激活） |
| `client.js` | Client 半：按钮 + 面板 + 两个把手 + 对话嵌入 + 文件数据层 + 编辑器挂载 + 保存状态机 |
| `client.editor.js` | **构建产物**：CodeMirror 6 打包成的官方 chunk（`window.__ModuleLoader__.load({id:'dsh-ide-mode', chunk:'client.editor.js', …})`）。点号命名是硬要求 —— 宿主的 `/plugins/<id>/` 只服务 `^client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$` |
| `cordis.patch.yml` | 一行插入本包 |
| `locale/{zh,en}.json` | 只有 `meta.title` / `meta.description`（Plugin Manager 读取）：`meta.title` 是**包名本身** `dsh-ide-mode`（两侧一致），`meta.description` 保持能力说明；运行时文案在 `client.js` 的字典里，单一真相 |
| `icon.svg` | 插件图标 |

## 三栏与两个把手

| 参数 | 值 |
| --- | --- |
| 可用宽度 | `容器宽 − 2 × 8`（两个把手各 8 px 计入预算，任何宽度下 `tree + chat + 16 + code = 容器宽`） |
| 文件树宽 | 180–480 px（容器过窄时这条下限本身按预算收缩）；上限还受「对话栏保住自己的最小值」约束 |
| 对话栏宽 | 260 px – `max(260, 容器宽 × 0.45)`（下限同样按预算收缩）；上限同理受文件树最小值约束 |
| 代码区 | `flex: 1 1 auto; min-width: 0`，内容在自身内部横向滚动；保底 `min(240, 可用宽度 × 0.4)` |
| 默认宽 | 文件树 280，对话 420 |
| 窄容器让步 | 两侧最小值按同一预算收缩为 `min(180, 可用 × 0.45)` / `min(260, 剩余)`，所以 700 px、500 px、320 px 都不会溢出；代码区永远是「剩下的那一份」，不会为负 |
| 键盘 | ←/→ ±8，Shift + ←/→ ±32，Home/End 到当前有效边界，Enter 复位 |
| 指针 | `setPointerCapture` + rAF 预览；**只在 pointerup 提交**；双击复位 |
| 落盘 | 提交后 500 ms 合并写入 localStorage（键盘连按不会逐次写盘） |
| ARIA | `role="separator"`、`aria-orientation="vertical"`、`aria-valuenow/min/max`（三者全部来自**归一化之后**的有效区间）、`aria-label` |

把手 A 向右拖变宽文件树；把手 B 向左拖变宽对话栏（`side` 决定符号）。把手内的指针监听挂在元素自身（指针捕获后事件会重定向到该元素），没有 window 监听；`useEffect` 兜底在卸载时取消 rAF 并释放捕获。

键盘与 ARIA 的一致性：提交一侧宽度时会**同时**把另一侧压到「剩余可用宽度」以内（不低于它自己的最小值），因此 `aria-valuenow` 永远不会落到 `[valuemin, valuemax]` 之外。

这条保证有一个**硬边界**：`容器宽 ≤ 696 px` 时两侧的最小值正好吃满预算（`treeMin === treeMax === 180`、`chatMin === chatMax === 260`，代码区拿到 `min(240, 40%)`），两个把手都被钉死 —— 此时方向键、拖动、双击都不会改变任何宽度，`aria-valuemin === aria-valuemax` 如实反映「这里没有可调范围」。`容器宽 > 696 px` 时至少各有 1 px 余量，方向键两个方向都能产生一次有效变化；到边界后不再抖动。

首帧不画列：容器还没测量时渲染骨架（`data-ide-skeleton`），测到真实宽度后才上三栏，避免先用 `window.innerWidth` 猜一个宽度再跳一次。`FALLBACK_WIDTH`（1280）只是**完全测量不到**时的兜底除数，既不参与首帧，也不会决定任何一帧的可见布局。

## 对话嵌入

调用点（`client.js` 的 `EmbeddedConversation`）：

```js
props.renderFactorySlot('conversation.content', {
  variant: 'embedded',
  phase: blank ? 'hero' : 'active',
  hero: blank,
})
```

`blank` 取自会话列表快照（`useSessions(s => s.byId[sessionId]?.blank)`）；返回值是 `null` / `undefined` 时走降级卡片（见下）。**注意**：宿主的 `phase` 是三输入（`shellPhase` + 会话打开状态 `openState` + `summaryBlank`，且含 `settling` 档），我们只拿到 `summaryBlank` 这一个输入 —— 见「已知限制」。
**不传 `sessionId`**，这是源码实证结论：

- `conversation.content` 是 `session-maybe` 工厂（`ui-conversation` 的 `registerFactory`），`sessionId` 已由渲染器的 session scope 标准 props 提供（`ui-session` 的 `BUILTIN_SOURCE`：`props: ['sessionId']`）；
- 渲染器对工厂入参做 `assertNoPropOverlap`，再传一次 `sessionId` 会抛 `SlotAssemblyError: ... received duplicate prop 'sessionId'`；
- 该工厂在 root 作用域面板里可用，因为 `createSlotRenderer` 把 `RootOutlet` 包在 `ScopeProvider scope="session-maybe"` 里，`useScopeBinding()` 在 root 面板中返回的就是**当前会话**（`ui-session` 的 `publishMain()` 选取规则与 `retainedBy.mainView` 完全一致）。

第三栏跟随宿主当前会话；面板自己用 `props.useSessions` + 同一条 `retainedBy.mainView` 规则取 `sessionId`，供文件树与 Remote 调用使用。

### 降级路径

| 情况 | 表现 |
| --- | --- |
| 渲染正常 | 真实对话（含 composer，无主对话 WidthControls） |
| 渲染抛错 / `SlotAssemblyError` 重抛 | 自写 `ChatBoundary` 接住 → 卡片：本地化标题 + 说明 + 技术原因 + 「重试」+「切回对话」 |
| `renderFactorySlot` 本身抛错（同步） | `EmbeddedConversation` 里的 `try/catch` 就地接住 → 同一张卡片，技术原因是错误原文 `Name: message`（**不依赖边界**，边界在下面还有一层） |
| `renderFactorySlot` 不存在 | 同一张卡片（原因文案指明缺 `renderFactorySlot`） |
| `renderFactorySlot` 返回 `null` / `undefined` | 同一张卡片，文案是「对话视图不可用」（工厂合法地表示这次不渲染，但不能变成静默空白） |
| `chatSurface = 'none'` | 第三栏空态提示，**完全不调用**工厂 |
| 没有会话 | 「还没有会话」空态，不渲染工厂 |

工厂入参是 `{ variant: 'embedded', phase, hero }`。**只按一个输入映射**：会话快照里 `blank === true` → `{ hero: true, phase: 'hero' }`，其余 → `{ hero: false, phase: 'active' }`。这不是「跟随宿主的 `phase`」：宿主的 `phase` 由三个输入算出（`shellPhase` + 会话打开状态 `openState` + `summaryBlank`），还包含 `settling` 档，本面板的入参里只有 `summaryBlank` 一项 —— 已知限制，见下节。

`chatSurface` 是模块常量（默认 `'embed'`），启动时读 `localStorage['dsh-ide-mode.v1.chatSurface']` 覆盖；出现意外时用户把它设成 `'none'` 并刷新即可让第三栏停止渲染对话，不必重装。

## 白屏护栏（顶层边界 + 崩溃熔断）

**背景**：React 18 对「未捕获的渲染错误」的处理是**卸载整棵树**。宿主的槽位就在这棵树里，所以面板子树里任何一个 `TypeError` 都不是「一栏坏了」，而是整页白屏、并且插件的注册一起被撤下（`main` 里本条目从 `active: true` 变成 `false`，其它条目正常）。这正是「点一下 IDE 模式就白」的形态。

**一个真实的漏网例子（后续修正）**：读取 `ctx.get('remote')?.workspaceFiles` 在 Cordis 服务代理上会抛 `cannot get property "remote.workspaceFiles" without inject`，而 `getFiles()` 是在**渲染期**被调用的（`IdePanel` 用它决定空态）—— 边界把它接住，用户看到的就是整块面板变成一张卡片。边界只是兜底，不该替「服务取用方式」背锅：文件 face 已改为用 `ctx.inject` 声明获得（见「数据通路」），`getFiles()` / `lookupFiles()` 也全部包了 `try/catch`，异常只会变成「文件服务不可用」空态。

**结构**：注册进 `main` / `key: 'ide'` 的组件是类组件 `IdePanelBoundary`，`IdePanel` 只是它的唯一子节点。边界：

| 约定 | 实现 |
| --- | --- |
| 接住任何子树错误 | `static getDerivedStateFromError` 写 `state.error`；`render()` 据此改画卡片，**永不重抛** |
| 留证据 | `componentDidCatch` → `console.error('[dsh-ide-mode] panel crashed', error)`，并写熔断标记 |
| 崩溃熔断 | `localStorage['dsh-ide-mode.v1.crashed']` = `{ version, message, ts, rev? }`（JSON）；**进入面板时**只有 `version` 等于当前 `PLUGIN_VERSION` 才熔断（只画卡片、**不挂载子树**）。别的版本、或旧版写进去的裸字符串，一律视为陈旧：读到即删、正常挂载，不弹任何提示 —— 见「熔断与版本」 |
| 唯一出口 | 卡片「重试」：清标记 + `mount` 自增（子节点换 `key`，从零重挂载）；「切回对话」：`ctx.get('layout').selectPanel(null)` |
| 证据优先 | 卡片里的 `<code>` 是 `error.name + ': ' + error.message` 原文（压成单行、`data-ide-crash-detail` 便于定位），不翻译、不截断、不用「未知错误」代替 |

用户会看到的文案（`zh` 源字符串，一字不差）：

- 实时崩溃（`data-ide-crash="crash"`）
  - 标题：`IDE 面板出错了`
  - 说明：`面板渲染时抛错，已用这张卡片代替；界面其余部分照常工作。下面的原始错误可以复制给我们定位问题，也可以重试或切回对话。`
  - 按钮：`重试` / `切回对话`
- 熔断（`data-ide-crash="halted"`，上次崩过、本次只画卡片）
  - 标题：`IDE 面板上次崩溃，已暂停挂载`
  - 说明：`上一次进入 IDE 模式时面板渲染抛错。为避免刷新后再次白屏（同一版本内才会暂停；插件更新后会自动清除），这里只显示卡片、不挂载面板；点「重试」会清除标记并重新挂载。`
  - 按钮：`重试` / `切回对话`
  - `<code>`：上次记录的错误原文
  - 只有**同一版本**留下的记录才会画出这张卡；陈旧记录（别的版本、旧版裸字符串、形状不对）在读取时就被静默清掉，用户看到的是正常面板（见「熔断与版本」）

样式只用现有 token（`dsh-ide-root` 面板底色 + 一张 `dsh-ide-card` 小卡片，`margin: 12px`，无白底大块）。英文文案见 `en` 字典同名键。

**同一轮加的其他护栏**（都不改变功能，只把异常从「白屏」降级成「卡片」）：

| 位置 | 护栏 |
| --- | --- |
| 四个会话选择器 | `state` / `state.byId` / `session` 的存在性容错 + `Object.values` 外包 `try/catch`；返回稳定标量（`undefined` / `''` / `false`），**不抛** |
| 宽度计算 | `resolveWidthsSafe` 包住 `resolveWidths`，抛错落到 `FALLBACK_LAYOUT` |
| 文件树展平 | `safeFlattenRows` 包住 `flattenRows`，抛错画「文件树渲染出错」列内卡片（带重试），另两栏照常；`dirs` / `expanded` 取不到时用空对象 |
| 首帧 | `containerWidth === 0` 只画骨架，**不**展平、**不**渲染第三栏、**不**调 `renderFactorySlot` |
| 标准 prop | `useSessions` / `usePanelInfo` / `renderFactorySlot` 都先判「存在 + 类型」；缺失时改用内部恒定 hook（`useSyncExternalStore(noop…)`），**每次渲染 hook 数量一致**；`usePanelInfo` 只喂 `data-ide-active` 诊断属性，不参与任何分支 |
| 工厂调用 | `renderFactorySlot(...)` 外再包一层 `try/catch`（同步抛错 → 对话位降级卡，不依赖边界） |
| 会话为空 | `sessionId === ''` 时 `list` / `read` 一次都不发（冒烟断言里锁住了） |

控制台三行（用户复制即可）：

```
[dsh-ide-mode] active { version, hasLayout, hasSelectPanel, hasPanelInfo, hasLocale, hasRemoteFiles, chatSurface }
[dsh-ide-mode] gate at activation { version, layoutNow, panelNow, canEnterNow }
[dsh-ide-mode] panel mounted { version, hasUseSessions, hasUsePanelInfo, hasRenderFactorySlot, haltedByPreviousCrash }
```

`gate at activation` 一定在注册之后打，所以 `panelNow` 正常是 `'yes'`；`layoutNow: false` **是允许的**（插件可以在 `ui-layout` 之前激活，见下条），它只是说明那一刻谁还没到，不决定按钮状态。

冒烟断言在仓库外的 `.smoke/smoke.mjs`（`node .smoke/smoke.mjs`，716 条）：边界接住且不冒泡、卡片含错误原文、`selectPanel(null)` 只调一次、熔断后只出卡片且子树未挂载、重试后重挂载、工厂同步抛错走对话卡、缺 `useSessions` 不抛且 hook 数恒定（含「有 hook / 无 hook 两次挂载 hook 数相等」），空/半水合快照（`{}`、`{ byId: null }`）只是未命中而不是 `TypeError`，以及第 4 轮新增的 15 组：写盘根取 `session.header.cwd`（与 `workingDirectory.get` 不一致 / 缺失 / 相对 / POSIX 绝对）、force 不建文件、超限 body 排空或关连接、刷新不动脏 buffer、CRLF 不被改写、草稿三态（同 path 才出卡 / 走 dirty 确认 / 读失败不丢）、保存快照竞态（保存中输入、迟到响应）、冲突卡「取消」、缺 version 拒绝、超时分级、会话切换停车；第 5 轮新增 4 组（按钮门禁）：`entries`/`entriesOfSlot` 都不存在时按钮仍可点且点击恰好 `selectPanel('ide')` 一次、`layout` 先 `undefined` 后出现时第一次点击失败不崩而第二次成功、`selectPanel` 抛错时 warn + `data-ide-toggle-error` 且按钮不灰（下一次成功即清除、含一帧重试）、`sessionId === ''` 时仍 disabled 且 tooltip 是「没有会话」；第 6 轮新增 4 组（文件服务 face 改为注入）：源码（剥掉注释后）不再有 `ctx.get('remote')` / `safeGet(ctx, 'remote')` / 可选链式 `.workspaceFiles`，而桩里的 `ctx.get('remote')` 是「读任意属性即抛 `cannot get property ... without inject`」的 Proxy，`remoteProbeHits` 必须全程为 0；服务缺失时三栏骨架照常渲染、文件树与代码栏显示「文件服务不可用」+ 重试、无 `data-ide-crash`、点重试也不崩；服务后到（`env.provideRemote`）时只发一次根目录 `list` 并渲染出条目；注入被撤销（`env.inject` 的 disposer 跑掉）后回到空态、不崩，再提供一次还能恢复。本轮新增：顶栏只剩一个 `data-ide-action="exit"`（不存在 `back`，点一次 `selectPanel(null)` 一次）、顶栏不再渲染工作目录面包屑而左栏文件树头部仍显示路径；逐页读取（2000/2000/500 行 → 编辑器拿到 4500 行、`file-open.lines=4500`、保存写完整内容且 CAS 用第一页 `version`）、超上限（25,000 行 → 只读 + 精确文案 + 不进编辑器）、第 2 页失败整体报错且不渲染半截并可重试、逐页请求都带 signal 且卸载时全部 abort；诊断预算 `DIAG_MAX_EVENTS = 256`（第 257 条不发）；第 10 轮把「选中自动引用」改成**编辑器右键菜单**，19 组断言覆盖：选中 500 ms 后仍零插入、菜单出现在指针位置、无选区两项禁用且点击零调用、Shift + 右键放行、Esc/外部点击/滚动/失焦/切文件/卸载各能关闭且监听真被移除、`role="menu"` 键盘导航、复制引用不动草稿、无 shell 降级为复制、含空格路径、旧 `refAutoOnSelection` 被忽略且不再写入，以及源码层「顶栏没有 ref-toggle/ref-insert、没有 250 ms 去抖、菜单样式只用主题 token」。第 11 轮把熔断记录绑到版本上：同版本的记录只画卡片且 `useSessions` 调用数为 0、点「重试」后挂载并清键；`{"version":"0.3.0",…}` 的记录和旧版裸字符串（`Error: boom` / `{"version":"0.4.0"}` / `{}` / `null`）全部被丢弃、键被删除、正常挂载且零 error 零 warn；渲染崩溃写入的是 `{version, message, ts}`（源码里 `setItem(CRASH_KEY` 只有一处、`writeCrashMark` 只有一个调用点）；loader 的 `?rev=` 会被抄进记录的 `rev`；`package.json` 版本、`PLUGIN_VERSION`、`activation.version` 与挂载日志四处一致。`node --check` 覆盖 `index.js` / `client.js` / `.smoke/smoke.mjs`。

### 熔断与版本

**什么时候熔断**：只有 `IdePanelBoundary.componentDidCatch` —— 即面板**渲染或生命周期**里真的抛了一次（React 边界语义）。事件处理器里的异常、定时器回调、编辑器 chunk 加载失败、文件读失败、`renderFactorySlot` 同步抛错，全都就地降级成各自的卡片，**不写这个键**（它们不是白屏，也就不该暂停面板）。

**存在哪 / 什么格式**：

```js
localStorage['dsh-ide-mode.v1.crashed'] = {
  version: '0.4.0',            // 写它的那次构建的 PLUGIN_VERSION（client.js 顶部常量）
  message: 'Error: ...',       // 那次错误的 name: message 原文，单行
  ts: 1760000000000,           // 写入时刻，epoch ms
  rev: 'm3x8k2',               // 可选：loader 的 ?rev=（没有这个 rev 就不写该字段）
}
```

- **唯一写入口**是 `componentDidCatch`（源码里 `localStorage.setItem(CRASH_KEY, …)` 只有一处、`writeCrashMark` 只有一个调用点，冒烟测试锁住）；
- **读**发生在边界构造时：`readCrashMark()` → `parseCrashMark()`，只认上面这个形状；
- **删除**只有两条路径：卡片「重试」，以及读到陈旧记录时的静默清理。

**为什么绑定版本**：这张记录描述的是**某一次构建**的渲染缺陷。修好之后如果它还生效，用户每次升级都得先点一次「重试」才能看到面板 —— 纯粹的误伤，而且用户会以为「插件坏了」。所以把版本写进记录并比对：

| 读到的东西 | 判定 | 行为 |
| --- | --- | --- |
| `{ version: '0.4.0', … }`（= `PLUGIN_VERSION`） | 本版本的熔断 | 只画「上次崩溃，已暂停挂载」卡片，**不挂载子树**；点「重试」清键 + `mount++` |
| `{ version: '0.3.0', … }` 等别的版本 | 陈旧 | **静默**丢弃 + 删键 + 正常挂载，**不弹任何提示** |
| 旧版裸字符串（`'Error: boom'`）或任何非该形状的 JSON（`{}` / `{"version":"0.4.0"}` / `null`） | 陈旧 | 同上：丢弃 + 删键 + 正常挂载 |

也就是说：**只有同一版本内重复崩溃才继续熔断**；升级后第一次进入就是正常面板，不需要先点重试。`rev` 只用来在报告里区分同版本的不同构建，**不参与**陈旧判定 —— 同版本重打一次 chunk 不该让熔断复活，也不该让它失效。

两个边界：`version` 相同但 `message` 是空字符串时仍然熔断（卡片正文回落到「未知错误」）；存储被禁用/写满时读写都吞掉，内存里的边界状态照常工作（刷新后熔断自然消失，这是最坏情况下的已知退化）。

## 数据通路

文件服务通过 **`ctx.inject(['remote.workspaceFiles'], cb)` 声明获得**（回调拿到的是「注入了该服务」的**新 ctx**，用 `injected['remote.workspaceFiles']` 取；`apply` 作用域里的 `filesFace` 持有它，注入与撤销时 `notifyFilesFaceChanged()` 通知面板重算可用性）。**不再有 `ctx.get('remote')?.workspaceFiles`**：那句会抛 `cannot get property "remote.workspaceFiles" without inject`，且它是在渲染期执行的（`IdePanel` 用 `getFiles()` 决定空态），于是异常被面板边界接住、整块面板换成崩溃卡。拿不到 face 时是**可重试**的「文件服务不可用」空态，**不**回落到 `uiWorkspace.listDirectory`；`getFiles()` / `lookupFiles()` 只读 `filesFace`，且整段 `try/catch`：任何异常 → `undefined` → 空态，绝不让异常冒到渲染。装配故障有两种形态：调用直接抛错（命名空间还没挂、方法不在这个 face 上、没有连接），或返回 `{ ok: false }` 且 `code` 属于装配类 —— 共 10 个：`gateway/service-unavailable`、`gateway/method-unavailable`、`gateway/lookup-unavailable`、`gateway/definition-unavailable`、`gateway/invocation-unavailable`、`gateway/context-unavailable`、`gateway/context-failed`、`gateway/binding-invalid`、`gateway/provider-mismatch`、`gateway/peer-disposed`。两种都会重新解析并**重试一次**；重试后仍失败才按下面的分级表展示。

### 为什么 `ctx.inject` 能拿到，`ctx.get('remote').x` 不能

Cordis 的 `ctx` 是服务代理：**只有本 fiber 声明过的名字才可读**。`ctx.get('remote')` 返回的那个对象上，读取任何未声明的属性都会抛 `cannot get property "remote.workspaceFiles" without inject` —— `try/catch` 只能包住 `ctx.get`，包不住**它外面**那一次 `.workspaceFiles`。`ctx.inject(['remote.workspaceFiles'], cb)` 则是把依赖**声明**出去：服务在则立刻（或稍后）用注入了该服务的 ctx 调 `cb`，服务不在则 `cb` 不跑、fiber 也不挂起。所以 face 的获取方式从「读属性」改成了「声明 + 回调」，这也是唯一不会在渲染期抛错的方式。**不要**把 `remote.workspaceFiles` 加进 `package.json` 的 `dsh.client.inject`：那是加载排序，不是服务注入，硬依赖会让插件在服务缺失时永不激活。

**每次调用都重新解析**：命名空间在 API 装配时才 `$mount`，重连还会换一次，所以注入 `cb` 的 disposer 会把 `filesFace` 清回 `undefined`、面板退回空态，服务再来时再填回；面板通过 `useSyncExternalStore` 订阅一个单调递增的**数字**（epoch，不是对象，避免「每次快照都是新对象」的死循环），hook 数量恒定。

**身份未命中不算装配故障，不重试**：`gateway/lookup-not-found`（冷会话没有 persistence，重试永远不会成功）与 `gateway/context-not-found`（身份没解析出来，实际多是 session id 不对）是「答案」而不是「故障」，重试只会把一次注定失败的请求拖成两次、白花一倍延迟。

**一元调用返回 `RemoteResult`，不 reject**：正常是 `{ ok: true, value }`，业务失败是 `{ ok: false, error }`，`error` 是带 `code` / `details` / `message` 的 `RemoteError`。每处调用统一 `if (!res || res.ok !== true) throw res?.error ?? transportFailure(...)`，再由下面的分级表处理。把它当成返回值用（`listing.entries` / `page.text`）会让文件树永远「空目录」、预览永远「空文件」，分级、abort 与 15 s 超时全部失效。

**根路径 = 会话 cwd 的绝对路径**（`useSessions(s => s.byId[sessionId]?.cwd)`，与宿主自己的文件树同一条来源）。宿主的 `inspect()` 第一行就是 `if (path.length === 0) throw new RemoteError('gateway/bad-request', 'path is required', {})`，所以**永远不发空路径**：拿不到 cwd 就显示「这个会话还没有可用的工作区」空态，而不是发一个注定失败的请求。`list` / `read`（以及我们已不再调用的 `stat`）都接受「绝对路径或相对 workspace base 的路径」，本插件统一用绝对路径传参，界面显示相对路径；子项按 `父 + '/' + name` 拼。

| 调用 | 参数 | 用途 |
| --- | --- | --- |
| `files.list(sessionId, absolutePath, signal)` | 绝对路径（首屏 = 会话 cwd） | 一层目录；`{ path（相对 base，根为空串）, entries[{name,type,size?}], truncated }` |
| `files.read(sessionId, absolutePath, { offset, limit: 2000 }, signal)` | 1 基行窗口 | **逐页读到 `eof`**：每页 2000 行，直到 `page.eof === true`，页间用 `\n` 拼成完整文本；`{ absolutePath, version, bytes?, offset, text, lines, eof }` |
| 降级 | `limit` 被宿主 `maxLines`（默认 5000，可配置调小）拒绝时 | 只对 `gateway/bad-request` 且信息指向 `limit` 的情况**自动改用 200 行重试一次**；UI 的截断提示用 `page.lines`，所以用户看到的就是「前 200 行」 |

`stat` **不再调用**（`read` 前的预检已删除）：宿主 `read` 的第一步就是 `locateFile`（`lstat` 闸门 + `stat`），符号链接与其它非普通文件在**读任何字节之前**就被拒，返回 `workspace-file/not-regular-file`；预检只会多一个 RPC，并把 15 s 预算从 `read` 独占变成 `stat` + `read` 共享。客户端**也没有**「缺 version 时补一次 stat」的回退（那等于放弃 CAS，见「保存链路」）；`ctx.fs.stat` 只在 Host 端点的 `force` 分支上用来确认目标存在。

`type` 只有 `'file' | 'directory' | 'other'`（symlink 永不出现，宿主上报目标类型）：`'file'` 才允许点开，`'other'`（socket / fifo / 设备）直接给「此文件类型不支持预览」，**不发**请求；`read` 回 `workspace-file/not-regular-file`（例如 symlink → 文件）给同一条提示，不是红色错误块。

每个请求一个 `AbortController`：切会话、切文件、刷新、组件卸载都会 abort；另有 15 s 超时（超时先 abort 再按 timeout 分级）。文件正文是**逐页**请求，所有页共用**一次读取**的 scope（15 s 是整次读取的总预算，不是每页一份），每页请求都带同一个 `signal`，任何一页失败/被取消都让整次读取失败，绝不会把「读了一半」的文本交给编辑器。目录列表与文件正文各有一个 **epoch 计数器**：切会话/刷新 bump 目录 epoch，切文件/刷新/重试 bump 文件 epoch —— 晚到的响应即使 abort 来不及也写不进当前状态（不只是靠 abort）。

**刷新不清空已加载条目**：`loadDir` 失败时保留该层上次成功的 `entries`，错误行画在这些条目之上并带「重试」（`retryDir` 只重载那一层）；同一会话的「刷新」复用已加载的目录表与展开态，只重载根。只有切换会话或切换工作区基址才整表丢弃。树里的状态行 key 用 `kind + '\u0000' + path`（文件名里不可能出现 NUL），所以 `x#truncated` 这种真实文件名不会和状态行撞 key。

错误分级（全部走 locale，不直出英文原文）：

| 分级 | 触发 | 文案键 |
| --- | --- | --- |
| `service` | 没有 `remote.workspaceFiles`（不发请求，直接渲染这个空态） | `errorService` / `errorServiceHint` + 重试 |
| `transport` | ① 无 `code` 的异常（Remote 干脆没给结果）；② **`gateway/internal`** —— 宿主对「载体掉线/离线」与「贡献被撤下」（`carrierFailure` / `withdrawn`）都回这个码；它不是拒绝请求，而是根本够不着 | `errorTransport`；`gateway/internal` 的 code 仍然显示在细节行（`errorCode`） |
| `gateway` | `code` 以 `gateway/` 开头（`gateway/internal` 与 `gateway/cancelled` 已在上面单独归类） | `errorGateway`（带 code） |
| `host` | `code` 以 `workspace-file/` 开头 | 按后缀映射：`not-found` / `outside-workspace` / `too-large` / `not-regular-file` / `not-directory` / `unknown-workspace` / `watch-unsupported` |
| `timeout` | 15 s 未返回 | `errorTimeout` |
| `cancel` | abort，或宿主回的 `gateway/cancelled`（用户拖窗口/切会话时宿主自己的报告，**不是**被拒绝） | — （不展示红错） |

`workspace-file/not-text` → 「二进制文件」提示；`workspace-file/too-large` → 「超过预览上限」提示（都是提示，不是红色错误块）。

`workspace-file/outside-workspace` 是**普通可读错误**：落 `host` 档（不是 `gateway` 档），用 `errorOutside` 文案 + 重试，并渲染成通知样式（`dsh-ide-notice`、`data-ide-readable="true"`），不会被当成「宿主接口拒绝了这次请求」的红色错误块。

空页判据用 `page.lines` 而不是 `text === ''`：宿主对「越过末行」和「该页只有一行空行」都回 `text: ''`，前者 `lines === 0`（空文件），后者 `lines === 1`（一行空白）。

## 可编辑代码区（CodeMirror 6）

代码区不再是只读 `<pre>`：真正的编辑器是**按需加载的 chunk**，挂载与销毁都在 React 的生命周期里。

| 关注点 | 做法 |
| --- | --- |
| chunk 路径 | `'./client.editor.js'`（与 `client.js` 同目录）→ 宿主 `/plugins/<id>/` 路由按 `client.<name>.js` 服务，带 `?rev=` 校验与 `immutable` 缓存 |
| 加载时机 | **只在真正打开一个文件时**。首屏、进面板、切会话都不加载；650 KiB / gzip 228 KiB 不付在首屏 |
| 读取进度 | 逐页读取期间，代码栏状态行显示「读取中 3/8 页」；总页数由已知的文件字节数与已读行数估算，读完即消失 |
| 加载方式 | `require.async(EDITOR_CHUNK)` + 一层单飞 promise；失败**不缓存**，重试卡能真的重来。脚本注入、去重、HMR 失效全部由宿主的模块系统负责（本插件不注入 `<script>`、不引 CDN、不用 `ctx.modules.import`） |
| 挂载 | `useEffect` 里 `chunk.createEditor({ parent, doc, language, readOnly, theme, onChange, onSave })`，cleanup 里 `api.destroy()`（幂等），重试时先销毁再重建 |
| 切文件 | **同一个 EditorView**：面板决定「编辑器该拿哪份文档」时才换文档，`docToken` 是一个只在**采纳**一次读取时自增的键（`docView.key`），普通重读、刷新、CRLF 重读都不动它。用户敲键不会被任何 prop 回流重置光标或撤销栈 |
| 换行符（CRLF） | 读到文本时记下**首个换行序列**（`\r\n` / `\r` / `\n`）；编辑器里一律 `\n`（CodeMirror 的归一化），比较文档也先归一化（否则 CRLF 文件每次重读都会「内容不一致」而反复 `setValue`，光标与撤销栈被清），保存前按原始 EOL 还原（`split('\n').join(eol)`），整文件不会从 CRLF 变成 LF |
| 语言映射 | `js/mjs/cjs/jsx → javascript`、`ts/tsx → javascript`（chunk 里没有 TS 语法包，退回 JS 比纯文本好）、`json/jsonc → json`、`md/markdown → markdown`、`css → css`、`html/htm → html`、`py → python`，其余纯文本 |
| 主题 | 只读宿主的 `--dsw-alias-bg-base` 算亮度（算不出再看 `prefers-color-scheme`），决定 `light/dark`；不写死颜色，插件 CSS 只用 `--dsw-alias-*` |
| 降级（chunk 挂了） | 渲染原有只读 `<pre>` + 一张卡：「编辑器组件加载失败，已降级为只读预览」+ 原始原因 + 「重新加载编辑器」。**不写崩溃熔断标记、不上抛边界**，面板其余两栏照常 |
| 大文件保护 | 打开文件时**逐页读到 `eof`**，拼成完整内容；硬上限 **20,000 行或 2 MiB**（哪个先到算哪个）。未超上限 → 可编辑、保存写完整内容；超上限 → 只读 `<pre>`（最多渲染 2000 行）并给出明确文案「文件过大（≥20,000 行或 2 MiB），只读预览」，不把两万行塞进 CodeMirror |

`useEditor` 之类的 hook 封装没有用：它挂载时读初始 props、之后只在 `doc`/`language` 变化时同步，正好和我们「用户输入不回流」的约定冲突。

## 保存链路：读 → 编辑 → CAS → 写 → 新 version

```
workspaceFiles.read ──► page.text / page.version ──► 编辑器（buffer，EOL 归一化）
        ▲                                              │ 每一次 onChange
        │                                              ▼
        │                                       dirty（标题圆点）+ 脏按钮
        │                                              │ Ctrl+S / 保存按钮
        │                                              ▼
        │                      快照 { path, epoch, content, version }（只此一次）
        │                            POST dsh-ide-mode/write
        │                            { sessionId, path, content, version, force? }
        │                                              │
        │                       Host: 鉴权 → 方法 → JSON → ≤2MiB → session → header.cwd → 包含性
        │                             → （force 时）fs.stat 必须存在 → 沙箱策略
        │                                              ▼
        │                       ctx.fs.writeText(target, content,
        │                            { kind:'replaceIfVersion', version },   ← CAS
        │                            signal, ctx.sandboxPolicy.resolve({ session }))
        │                                              │
        └──── 200 { ok:true, value:{ version, bytes } } ─┘  → 缓存新 version；仅当 buffer 仍等于快照才清 dirty
              409 { ok:false, error:{ code:'FS_STALE_VERSION' } } → 冲突卡（见下）
              其它 5xx/4xx → 「保存失败，可重试」+ 具体原因
```

| 状态 | 界面 |
| --- | --- |
| 保存中 | 顶栏状态「保存中…」，按钮禁用；**期间仍可继续编辑**，且再按 Ctrl+S 会被忽略（不会并发写） |
| 已保存 | 「已保存」，圆点消失，缓存的 `version` 换成宿主回的新版本（后续保存继续 CAS） |
| 保存中又输入 | 响应回来后圆点**仍在**（落盘的是快照，不是后来的 buffer），状态回到「未保存」，不会谎称「已保存」 |
| 失败 | 「保存失败，可重试」+ 原因（`宿主拒绝了这次保存（CODE）` / `保存服务不可用（宿主端点未就绪）` / `请求超时（15 秒）` / `无法确认基线版本，请重新打开该文件后再保存`），原因显示在顶栏（`data-ide-save-detail`），脏标记**保留**，按钮可以再点 |

**快照与迟到响应**：保存开始时一次性取 `{ path, epoch, content, version }`；响应只在 `path === 当前 path && epoch === 当前 buffer 代次` 时生效（切文件/切会话会让代次自增），并且只有 `draftRef.current === 快照 content` 时才清 dirty。所以「保存中继续输入」不会丢字也不会被标成已保存，「切到别的文件后迟到的 200」也不会把新文件标成已保存或改掉它的 version。

**没有 version 就不保存**：宿主 `read` 没给 `version` 时**不会**去 `stat` 补一个——那等于把 CAS 守卫悄悄丢掉（文件可能早在读取之后被改过）。此时直接拒绝，文案「无法确认基线版本，请重新打开该文件后再保存」。

**三种用户可见的失败文案（一字不差）**：

1. chunk 加载失败 →「编辑器组件加载失败，已降级为只读预览」
2. 保存失败 →「保存失败，可重试」（原因见上一行）
3. CAS 冲突 →「文件已被修改：重新加载 / 强制覆盖 / 取消」（标题「文件已被修改」）

**409 冲突的语义**：`version` 是「读这一页时宿主的 stat 结果」，写的时候作为 `FsWriteIntent` 的 `replaceIfVersion` basis 送回去。文件在读到写之间被任何别的写者改过（另一个会话、外部编辑器、agent 的 `edit` 工具），版本就对不上，宿主回 `FS_STALE_VERSION`，我们**不覆盖**、**不清脏标记**，而是弹出冲突卡：

- 「重新加载」：重新 `read` 这个文件，丢弃本地改动（文档替换、脏标记清零、版本换成新读到的）；
- 「强制覆盖」：同一次请求带 `force: true`，宿主**丢掉 CAS 守卫**写回（唯一一处不带守卫的写，且只从这个按钮可达）。**目标必须已存在**：无 intent 的 `writeText` 会新建文件，端点先用 `ctx.fs.stat` 确认存在，不存在就是 404 —— 本插件永远不建文件；
- 「取消」：关掉冲突态（`phase` 回 `idle`），**缓冲区、脏标记与 CAS version 都保留**；再按 Ctrl+S 会带着同一个 version 重新问宿主，不会卡在死卡上。

**刷新不动编辑缓冲**：刷新按钮（以及错误行上的「重试」）只重读目录与**打开文件的磁盘版本**；脏缓冲区由基线 effect 守住——文本、CAS version、脏标记都不动，编辑器也不会被 `setValue`（光标/撤销栈保住）。要放弃本地改动只有两条明路：冲突卡的「重新加载」，或切文件时确认「放弃修改」。

**未保存改动的二次确认**（都用面板内 `dsh-ide-*` 卡片，不引 Modal 框架）：

| 触发 | 行为 |
| --- | --- |
| 切文件（点另一个树条目） | 不切，先弹「未保存的修改」；「放弃修改」才切，新增键「取消」保持原文件与原缓冲区 |
| 「退出 IDE」 | 先弹同一张卡；确认后才 `selectPanel(null)`，取消则什么都不做。顶栏只有这一个动作，对话降级卡上的「切回对话」走同一条路 |
| 「恢复草稿」（当前文件有脏改动时） | 走**同一条** `requestOpen` 路径：先弹「当前文件有未保存的修改，恢复草稿会丢弃这些修改。」，取消则原缓冲区一字不动 |
| 面板被卸载 | 卸载时来不及弹卡，于是：脏缓冲区**存进模块级草稿表**（按 `sessionId + path` 两条键），下次看到这个文件时弹出「上次离开时有未保存的修改」，「恢复草稿」把它接回编辑器（仍带原 `version`，所以磁盘真变了照样 409），「丢弃草稿」回磁盘内容。此外脏状态下挂 `beforeunload`，刷新/关窗由浏览器确认 |
| 切会话（宿主换了主会话，面板**没有**卸载） | 会话 id 一变，先把脏缓冲区**停车**进草稿表（按旧 session + path），再重置树/文件状态；切回来时草稿卡照旧出现。不依赖 unmount |

**草稿卡的显示条件**：只在该草稿的 `path` **就是当前打开的文件**、且没有更高优先级的编辑态（没有 restore 在进行、没有确认卡、没有冲突卡）时显示。打开别的文件时草稿卡不会跟着出现，草稿也不会被丢掉。草稿只在**读成功并采纳**之后才删除，读失败则原样留着。

Ctrl+S 只有**一个**入口：面板挂载期间在 `document` 上注册 `capture: true` 的 `keydown`。命中 Ctrl/Cmd+S 时依次 `preventDefault()` + `stopPropagation()`，再保存当前文件 —— 焦点在编辑器、对话 composer、文件树、顶栏按钮上都是同一条路。编辑器自己的 `Mod-s` keymap 仍然保留（chunk 加载失败或监听注册不了时的兜底），但它已经处理过的事件带着 `defaultPrevented: true`，`document` 监听看到它就退让，所以一次按键只会写一次。卸载时是真正的 `removeEventListener`（不是留一个失效标志）。三个入口各打一条 `save-intent{source, focus, hasDirty, hasVersion}`，`source` 分别是 `editor-keymap` / `button` / `document-keydown`。保存按钮只在「没有可编辑 buffer」或「正在保存」时禁用；`dirty=false` 也可以点，点击会留下 `save-failed{code:'no-request:not-dirty'}`，所以「点了没反应」永远有证据。

## 引用选区：在编辑器右键菜单里把选中代码放进对话草稿

中栏的编辑器支持「选中一段代码 → 右键 → **引用选区到对话**」，把这段代码作为引用放进右侧对话的草稿。

**没有自动行为**：选中本身不会插入任何东西，顶栏也没有开关或按钮。唯一入口是编辑器自己的右键菜单 —— 选区只是「可以引用」，是否引用由用户点。

| 行为 | 细节 |
| --- | --- |
| 打开菜单 | 在编辑器里右键（`contextmenu`）：`preventDefault()` + `stopPropagation()`，菜单以 `position: fixed` 出现在**指针位置**（`clientX/clientY`），靠近右/下边缘时按视口夹住，不会溢出；首次布局后再用 `getBoundingClientRect()` 量一次真实尺寸，只按测出来的溢出量回移 |
| 菜单项 | 「引用选区到对话」（`data-ide-ref-action="insert"`）、「复制引用」（`copy`）、一条分隔线、「取消」（`cancel`） |
| 禁用条件 | 没有选区 / 选区折叠 / 选区 **<2 个字符**：两个引用项都 `aria-disabled="true"` + `opacity` 灰掉且不可点，`title` 是「先在编辑器里选中代码」；「取消」始终可用 |
| Shift + 右键 | **不拦**：不 `preventDefault()`、不弹我们的菜单，系统菜单照常出现（复制/剪切/粘贴走它，见下一节） |
| 插入 | 点「引用选区到对话」→ 按 `insertReferenceIntoDraft` 的约定插入 chip + ` 起-止 ` 纯文本尾巴 → 关菜单 → 代码栏标题行显示「已引用 3-5 行」，1.5 秒后自己消失 |
| 复制 | 点「复制引用」→ 把 `@path 起-止` 写进剪贴板并显示「已复制引用，粘贴到对话即可」；不碰草稿，也不需要对话已挂载 |
| 键盘 | 打开后焦点落在**第一个可用项**；`↑/↓` 只在可用项之间循环，`Enter`/空格执行，`Esc` 关闭；`role="menu"` + `role="menuitem"` + roving `tabIndex` |
| 关闭 | 菜单外任意 `pointerdown`、`Esc`、滚动、窗口失焦、窗口尺寸变化、切换文件/会话、面板卸载 —— 都关闭；监听**打开时注册、关闭/卸载时真 `removeEventListener`**（不是留一个失效标志） |
| 轻提示 | 只有右键的插入/复制会出现；选中本身不产生任何提示 |
| 去重表 | 模块级的 30 秒 `路径:起-止` 表保留（插入成功时记一条、最多 64 条），但**不再拦截**任何动作：右键是显式动作，同一个区间想插几次就插几次 |
| 行号 | **1 基、闭区间**：选中的最后一行就是区间末行（把选区拖到下一行行首时，下一行不算进来） |
| 路径 | **工作区相对路径**（树的绝对路径按会话 `cwd` 截断，分隔符统一 `/`），文件名取 basename；含空格的路径写成 `@"src/my file.js"` |
| 选区归属 | 选区连同「它属于哪个文件、哪个会话」一起记录；菜单拿的是**打开那一刻的快照**，切文件会关菜单，旧文件的选区也不会被当成新文件的选区去引用 |

### 为什么菜单里没有「复制 / 剪切 / 粘贴」

我们自己 `preventDefault()` 掉了系统菜单，所以再加这三项就等于**自己实现**剪贴板编辑：`paste` 要读剪贴板（权限、异步、还要把外部文本合进 CodeMirror 的编辑栈与撤销历史），`cut` 要同时动文档、选区与撤销栈，而浏览器原生菜单已经把这些做对了。所以菜单只放两件与「引用」有关的事 + 「取消」；需要原生剪贴板时按 **Shift + 右键**，那条路径一个字节都没被我们碰过。

### 为什么自己画菜单

宿主没有提供右键菜单插槽，第三方菜单库会带进自己的主题、定位与焦点管理；而这个菜单只有三个可聚焦项。自己画反而更小：`position: fixed` + `clientX/clientY` + 视口夹取 + `getBoundingClientRect()` 复核，样式只用 `--dsw-alias-*`（背景 `bg-overlay`、边框 `border-l2`、文字 `label-primary`、禁用态 `label-secondary` + `opacity`），键盘与关闭逻辑都在本组件内，卸载即移除监听。

### 用的是哪条 API

宿主给客户端插件留了一条 service-face path，**不需要注册插槽**：

```js
const shell = ctx.get('conversation')?.input?.shell(sessionId)   // SessionInputShell
```

造 chip 用 `shell.insertReference(refObj, span)`（宿主自己的 `@` 菜单走的也是这条，**保留现有草稿**）：

```js
refObj = {
  source: 'reference',
  ref: '@src/a.js',              // 含空格时：'@"src/my file.js"'
  label: 'a.js 3-5',             // 只用于 chip 显示
  appearance: 'file',
  clipboardText: '@src/a.js',
}
span = shell.actions.captureInsertion()   // { start, end, draftRev }
```

`span` **必须在插入前现取**：宿主在 span 上盖一个 `draftRev`，草稿在这两次之间动过就对不上，`insertReference` 会**静默返回 `false`（不抛错）**。所以被拒时**重取一次 span 再试一次**，两次都被拒才算失败（失败再走下面的剪贴板降级）。

行区间不走 chip，走**纯文本尾巴**：`shell.actions.insertText(' 3-5 ', span2)`。`insertText` 是**替换** span 而不是追加，所以 `span2` 同样是**插完 chip 之后**现取的折叠 span。

### 引用是指针

宿主把草稿序列化成消息时，引用会被压成**纯文本**：`@src/a.js 3-5`。

也就是说模型收到的是**一个指针**（文件路径 + 行区间文字），不是文件内容，也**不是结构化的 reference block** —— DSH 的对话协议里没有这种块。行区间只是**文字**：`3-5` 和 `@src/a.js` 之间没有语法绑定，宿主不会替模型展开这段代码，文件改动后也不会修正行号。要让模型看到内容，得它自己按路径去读；行号则可能在你继续编辑之后已经漂移。这是刻意的取舍：chip 是「把注意力指向某处」的记号，不是内容快照。

### 硬约束（为什么这样写）

- **绝不调用 `setDraft`**：它会 `root.clear()`，把用户已经敲进输入框的草稿清空。这里只用 `insertReference` / `insertText`，两者都是「在现有草稿上插一段」。
- **插入只发生在菜单动作里**：不在 render 里、也不在依赖 `draft`/`draftRev` 的 effect 里调用插入 API（那会形成更新环）。菜单动作由一个点击回调或菜单自己的 `Enter` 触发，`refMenu` 里的选区快照与 `refPipeRef` 里的当前会话/路径保证它拿的不是旧闭包。
- **只用一个坐标系**：detect 里 chip 占一个 `\uFFFC`，clipboard 里占整串——两套坐标不可混用，所以只用 `captureInsertion()` 给的 detect span。
- **选区来自 CodeMirror，不是 DOM**：监听走 chunk 里那个 `EditorView.updateListener`（`selectionSet` / `docChanged` 时回调），范围读 `view.state.selection.main` + `doc.lineAt`。**不用** DOM 的 `selectionchange`：它不是 per-editor，失焦、滚动都会发，也没有文档偏移。这个回调（`onCursor`）保留下来只做一件事：给右键菜单提供「当前选区」。
- **卸载即停**：卸载时清 1.5 s 提示定时器、清掉最后选区与菜单节点，此后的回调一律提前返回，不再插入；菜单的 document/window 监听由菜单自己的 effect cleanup 真正移除。

### 降级（拿不到 shell 时）

「引用选区到对话」拿不到 `conversation` 服务、`input.shell(sessionId)`、`insertReference` 或 `captureInsertion`（主对话未挂载、宿主版本不匹配、服务缺失）时：**不报错、不崩**，改为把 `@src/a.js 3-5` **复制到剪贴板**，并在面板内显示「已复制引用，粘贴到对话即可」。

「复制引用」本来就不需要 shell，所以没有这条降级路径；但它和「引用选区到对话」一样**要求有选区**——没有选区时两项都禁用（复制一个空指针没有意义）。

这条路径只留一行 `console.warn('[dsh-ide-mode] reference', …)`：宿主的 diag 事件表是**封闭的 14 个事件**，没有一条适合表达「引用插入失败」，**本次不新增埋点**（也不借用 `file-open` / `toggle-click` 这类语义不符的事件）。

## chunk 缓存：改完 chunk 必须 touch `client.js`

宿主的 rev（`?rev=`）只看 **`client.js` 自己的 mtime/ctime/size**，chunk 的元数据不参与；而 chunk 的响应头是 `cache-control: public, max-age=31536000, immutable`。所以：

- **重新生成 `client.editor.js` 之后，必须 touch 一次 `client.js`**（改一行再改回来也行）。否则 rev 不变，浏览器一年内不会重新下载 chunk —— 你会对着旧编辑器调一天。
- 反向也成立：只改 `client.js` 就够让新 chunk 生效，不需要改版本号。
- 本仓库这次复制 chunk 后已 touch 过 `client.js`。

## 写盘边界（Host 端点的四条纪律 + 两个前提）

`POST /dsh-ide-mode/write` 是**本插件唯一的写入口**，也是唯一需要 fail-closed 的地方。逐条：

1. **fail-closed 鉴权**：`ctx.get('connection')` 缺失 / 没有 `requestRejection` / 调用抛错 → 一律 **503**，绝不 `return true`；只有 `requestRejection(req) === undefined` 才继续往下走。这道栅栏是宿主的 Host/Origin 校验 + 登录 token cookie，先于任何 body 读取。
2. **只接受 `POST` + `application/json` + ≤2 MiB**：方法不对 405（带 `allow: POST`）、媒体类型不对 415、解析失败 400、形状不对（`sessionId`/`path`/`content` 非字符串，或缺 `version` 且没有 `force`）400。超限的两种收尾方式不同：`content-length` **声明**超 2 MiB 时不读 body，直接 413 并回 `connection: close`（防止未读 body 污染 keep-alive 上的下一个请求）；**流式**超限时继续消费到流的自然结束（只停止缓冲）再回 413 —— 提前 `return`/`break` 会 destroy 请求流，此时再 `req.resume()` 是无效的。
3. **路径双重校验**：`root` 只来自 **`session.header.cwd`**（`ctx.sessions.get(sessionId)` 取会话，sessionId 不存在是 404）。这一个字段就是宿主自己的文件树与每一次 `workspaceFiles` 调用用的基址（客户端快照里的 `session.cwd`），所以改过工作目录的会话写的就是面板正在展示的那棵树。**故意不用 `ctx.workingDirectory.get()`**：它回 `sessionProjections.stateOf(...) ?? process.cwd()`，对没有 cwd 的会话会给出部署默认目录，既会写错树，也让下面的 409 永远不可达。cwd 缺失 / 空 / 非绝对路径 → **409 `no-workspace`**，不回落到任何默认目录，也绝不信任 body 里的任何路径当根。然后 `target = await ctx.fs.resolve(path, { cwd: root })`、`rootTarget = await ctx.fs.resolve(root, { cwd: root })`，只有 `ctx.fs.contains(rootTarget, target) === true` 才继续，否则 **403**。`..`、越界绝对路径、`D:/ws2` 这种同前缀兄弟目录，全部被这一个后端的规范化包含性判掉。
4. **沙箱二次把关**：写调用携带 `ctx.sandboxPolicy.resolve({ session })`（`{ mode, workspaceRoot, sessionId }`），沙箱后端按模式与工作区基址再围一次，返回 `FS_SANDBOX_DENIED` → 403。它是路径校验之外的**第二道**，不是替代。

**force 也受第五条约束：只覆盖、不新建。** 不带 `FsWriteIntent` 的 `writeText` 会创建目标文件，而 `POST /dsh-ide-mode/write` 不是「在工作区里建任意文件」的原语，所以 `force: true` 先用 `ctx.fs.stat(target, signal)` 确认目标存在：不存在 → **404 `not-found`**；`fs.stat` 不可用 → 503 并点名 `fs.stat`。带守卫的写不需要这一步——`replaceIfVersion` 在文件缺失时本来就回 `FS_NOT_FOUND`。

**两个必须写明的安全前提（不是「已解决」，是设计边界）**：

1. **端点没有把写入绑定到某条 connection/session 的授权关系上**：护栏是「同用户的 trust fence + sessionId 必须是一个 live session + 路径必须落在该 session 的 cwd 内」。因此同一个已登录页面（同用户、同一 Host 进程）只要知道另一个 live sessionId，就能写那个会话工作区里的文件——它不校验「这个页面属于那个会话」。要收紧需要宿主暴露 connection↔session 绑定，本期没有。
2. **没有按内容类型限制目标**：端点只做路径包含性与（force 时）存在性检查，不判断目标是否是「文本」。真正的类型判断发生在后端——非文本/超大/非普通文件由 `writeText` 的 `FsError`（`FS_NOT_TEXT` / `FS_TOO_LARGE` / `FS_NOT_REGULAR_FILE` / `FS_IS_DIRECTORY`）拒绝并映射成对应状态码。也就是说：**它不会被前端绕过，但端点自身不预检**，换一个不检查类型的 fs 后端时这层保护就只剩后端。

服务缺失时的行为：`ctx.inject(['webServer'], …)` 只等 `webServer`（没有它就没有路由），其余四个服务（`fs` / `sessions` / `sandboxPolicy` / `connection`，外加 force 需要的 `fs.stat`）在**每次请求时**现取；缺哪个就 503 并把名字写进 `error.message`（`missing host service: fs, sandboxPolicy`）。**`workingDirectory` 不在依赖列表里**：没有它的 profile 也能保存。面板本身照常可用 —— 只是保存会失败并提示。

**写入 URL 的解析**：客户端不用裸相对路径，而是 `new URL('dsh-ide-mode/write', document.baseURI)` —— 保留「随文档 base 走」的语义（Electron 壳若把页面挂在不同 URL 前缀下，仍以文档 base 为准），但不再依赖调用点的隐式上下文。

**错误码映射（有意的差异）**：`FS_STALE_VERSION` 409、`FS_NOT_FOUND` 404、`FS_SANDBOX_DENIED` / `FS_PERMISSION_DENIED` 403、`FS_TOO_LARGE` 413、`FS_NOT_TEXT` 415、`FS_IS_DIRECTORY` / `FS_NOT_DIRECTORY` 400、`FS_ABORTED` 499，**`FS_NOT_REGULAR_FILE` 明确映射 400**（「请求的目标类型不对」比「没权限」更准确，前端也按 4xx 走「此文件类型不能编辑」的提示），这与宿主 `workspace-files` 自己用 403 的做法不同——**这是有意的，不要为了「对齐」改成 403**。本插件自己产生的两个码：`no-workspace` 409、`not-found` 404（force 目标不存在）。

响应形状：成功 `{ ok: true, value: { version, bytes, operation } }`；失败 `{ ok: false, error: { code, message } }`，`code` 保留 `FsError` 的稳定码（`FS_STALE_VERSION` / `FS_NOT_FOUND` / `FS_SANDBOX_DENIED` / `FS_NOT_TEXT` / `FS_TOO_LARGE` …）。`cache-control: no-store`。



## 持久化

`localStorage['dsh-ide-mode.v1']` = `{ version: 1, sessions: { [sessionId]: { treeWidth, chatWidth, activePath, mode } } }`（`activePath` 存绝对路径；切会话时若它不在新 cwd 之下就丢弃）

旧版本里的 `sessions[sessionId].refAutoOnSelection`（「选中自动引用」开关）**已经退役**：这一版不再读它、不再写它、也不再提供开关。已有用户 profile 里的旧值原样留在 blob 里（那是用户数据，不是我们写的），但它不影响任何行为；从没写过这个键的 profile 也不会因为本插件多出这个键。

- 模块级内存缓存，**激活时解析一次**，渲染期不 `JSON.parse`；
- 写入 500 ms 合并，卸载时立即 flush 并清掉定时器；
- 最多保留 **50** 个会话，按最近使用淘汰（Map 插入序即 LRU）；
- `mode` 记录 `'ide' | 'conversation'`，退出（含从宿主 UI 离开）都会写回 `'conversation'`。

另有一个**不属于偏好 blob** 的键：`localStorage['dsh-ide-mode.v1.crashed']` —— 面板崩溃熔断记录，值是 JSON `{ version, message, ts, rev? }`（`version` = 写它的那次构建的 `PLUGIN_VERSION`，`message` = 那次错误的 `Name: message` 原文，`ts` = epoch ms，`rev` = loader 的 `?rev=`，没有就不写）。由边界的 `componentDidCatch` 写入（唯一写入口）；**同版本**记录存在期间进入面板只画卡片、不挂载面板，删除只有两条路径：卡片「重试」，或读到陈旧记录时静默清理。别的版本、旧版裸字符串、形状不对的值都视为陈旧 —— 丢弃 + 删键 + 正常挂载。详见「熔断与版本」。它和偏好 blob 互不影响：清掉偏好不好，要恢复同版本的熔断请点「重试」或手动删这个键后刷新。

## 生命周期

| 顺序 | effect | 卸载时 |
| --- | --- | --- |
| 1 | 注册 locale 字典 | 反注册 |
| 2 | 插入 `<style>` | 移除节点 |
| 3 | `slots.inject` × 2 → 按钮 + **边界**（`main` 注册 `IdePanelBoundary`） | 反注册（逆序） |
| 4 | 订阅 `panelInfo`（用户从宿主 UI 离开时消费 restore 记录） | 退订 |
| 5 | 卸载还原（写回 mode、flush、必要时 `selectPanel(null)`） | 先执行（逆序第一） |

组件内部：`controllersRef` 里的每个 `AbortController` 在卸载时 abort（目录/读页请求**和**在途保存都在里面，所以卸载不会留下一条写请求在跑）；`useElementWidth` 的 resize 监听 / ResizeObserver / 待执行帧全部清理。键盘监听有两条，且都只在需要时存在：挂载期间常驻的是 `document` 上 `capture: true` 的 keydown（Ctrl+S），卸载时 `removeEventListener` 真正移除；右键菜单打开期间另外挂 `pointerdown` / `keydown`（Esc）/ window 的 `scroll` / `blur` / `resize`，关闭或卸载时逐条移除，所以关掉的菜单不会在 document 上留一个「只翻标志」的处理器。`CodeEditor` 的 `EditorView` 在它自己的 effect cleanup 里 `destroy()`（切文件不销毁、只有重试/卸载/失败才销毁）；脏状态下的 `beforeunload` 随 `dirty` 挂/摘；面板卸载时若有脏缓冲区，写进**模块级**草稿表（不进 localStorage），切会话时则由会话 effect 主动停车（不依赖卸载）。

Host 半：`ctx.inject(['webServer'], …)` 里一个 `ctx.effect` 注册 `/dsh-ide-mode/write`，卸载时反注册。故意不放进插件的硬 `inject`：那会让「缺一个服务」变成「整行不激活、按钮消失」。重复注册会因宿主的 `webserver: duplicate exact route` 抛错，而 `ctx.inject` 的回调在依赖服务变化时会重跑，所以注册失败只记日志、不抛出。

## 真机验证清单（审查要求，原样收录）

1. **文件树首屏能列出会话 cwd**（根请求带的是会话 cwd 绝对路径，不是空串；能展开子目录、能点开文件看到内容）；
2. `renderFactorySlot('conversation.content', {variant:'embedded'})` 在 root 作用域面板里是否真拿到当前会话（第三栏是不是活对话）；
3. 中栏实际宽度（侧栏 280 + 右栏 45% 时）下三栏的观感与裁切；
4. 125%/150% DPI 与 Windows 触摸板下的拖拽手感；
5. Electron 里按钮点击是否被标题栏 drag band 吞掉（我们没加 app-region，但要确认）；
6. 硬刷新/HMR 后 `<style>`、window 监听、restore 记录是否真的无残留；
7. 切会话/切文件时在途请求是否真的被 abort（观感：不再出现旧内容闪回）；
8. 桌面上侧栏折叠态（0px）进出 IDE 是否符合预期；
9. 容器被拖到 696 px 与 700 px 附近：≤ 696 px 时两个把手应 `aria-valuemin === aria-valuemax`（宽度钉死，键/拖都无效且不该有抖动），> 696 px 时 `valuenow` 始终落在 `[min, max]` 内、方向键两个方向都能动。
10. **崩溃护栏**：手动把 `localStorage['dsh-ide-mode.v1.crashed']` 设成**当前版本**的记录（`{"version":"0.4.0","message":"Error: manual","ts":1}`）后进入 IDE 模式 —— 应只看到「IDE 面板上次崩溃，已暂停挂载」卡片（三栏不渲染、控制台 `panel mounted` 那行的 `haltedByPreviousCrash: true`）；点「重试」后卡片消失、三栏回来、该键被删除。「切回对话」应恰好触发一次 `selectPanel(null)`。再把同一个键设成**别的版本**（`"version":"0.3.0"`）或旧版裸字符串（`Error: boom`）后进入 —— 应当**直接看到正常的三栏**、键被自动删除、控制台没有任何 error/warn（陈旧记录是正常路径）。
11. **chunk 真的能下载**：DevTools → Network 过滤 `client.editor.js`，**第一次点开文件时**才出现（不是首屏），状态 200，`content-type: text/javascript; charset=utf-8`，带 `?rev=`。若 404：确认文件名是 `client.editor.js`（点号）且与 `client.js` 同目录、`package.json` 的 `files` 含它。若控制台报 `require("react") missed the module table`，说明构建时把 react 打进了 chunk。
12. **编辑器观感**：打开 `.js`/`.json`/`.md`/`.py` 看高亮是否正确；切到另一个文件看是否**不闪白、光标在新文档开头**；主题（浅/深）下 CM 的背景是否与代码栏底色协调（`theme` 取自 `--dsw-alias-bg-base` 的亮度）。官方 `claimStyles` 是否把 `style-mod` 注入的 `<style>` 归给本插件并在卸载时清掉，jsdom 里观察不到。
13. **保存与冲突**：改一行 → 标题圆点出现 → Ctrl+S → 网络面板应看到一条 `POST dsh-ide-mode/write` 200，圆点消失、状态「已保存」；然后在外部改同一个文件再用编辑器保存 → 应出现「文件已被修改」卡，且圆点**还在**；点「强制覆盖」后磁盘内容应变成编辑器里的内容。
14. **端点的负路径**：`curl -X POST http://127.0.0.1:11157/dsh-ide-mode/write -H "content-type: application/json" -d '{}'`（无会话 cookie）应被宿主的 `connection` 栅栏挡下（401/403），而不是 200。
15. **刷新不动 buffer**：改一行（圆点出现）→ 点文件树刷新 → 编辑器里的内容与光标**不变**、圆点**还在**、不弹任何卡；再切到另一个文件才提示未保存。
16. **切会话停车**：在 A 会话改一行不保存 → 切到 B 会话（面板没消失）→ 切回 A → 代码栏出现「上次离开时有未保存的修改」，点「恢复草稿」原文本回来；再 Ctrl+S 若磁盘已变应出现冲突卡。
17. **force 不建文件**：删掉一个文件后（或直接对不存在的路径）用 `force: true` 打端点 → 应回 404 `not-found`，磁盘上不应出现新文件。
18. **CRLF 文件**：打开一个 `\r\n` 的文件 → 改一行保存 → 用 `git diff --stat` / 十六进制确认换行仍是 CRLF（不是整文件变 LF），且编辑器不会在每次刷新后跳到文件开头（光标/撤销栈未被重置）。
19. **引用 chip（右键菜单）**：在编辑器里选中 3 行 → 等 1 秒：**什么都不该发生**（没有 chip、没有提示、顶栏没有开关/按钮）→ 右键：菜单出现在指针位置，靠近右下角时仍在视口内；点「引用选区到对话」→ 右侧对话草稿里出现 `a.js 3-5` 的 chip，紧跟一段 ` 3-5 `，菜单关闭，代码栏标题行闪一条「已引用 3-5 行」并在 1.5 秒后消失；不选任何东西再右键：两项都灰掉、点了没反应、`title` 是「先在编辑器里选中代码」；「复制引用」应把 `@a.js 3-5` 放进剪贴板并提示「已复制引用，粘贴到对话即可」；**Shift + 右键**应出现浏览器原生菜单（含复制/剪切/粘贴）而**不是**我们的菜单；`Esc`、点菜单外、滚动、切文件都应关掉菜单，卸载后右键不应再弹菜单；把第三栏关掉（`chatSurface=none`）后再用「引用选区到对话」，应改为复制 `@a.js 3-5` 并提示，且**控制台没有 error**。

## 已知限制

- **只能改已有文件，不能新建/改名/删除**：带守卫的写要求 `ctx.fs.resolve` 能解析目标且落在会话工作区内，`replaceIfVersion` 让文件必须已被读到过；`force: true` 先用 `ctx.fs.stat` 确认目标存在，否则 404。新建文件需要 `createIfAbsent` 分支，本期不做（见「写盘边界」）。
- **一次保存写整份文件**：`writeText` 是整文件原子替换，不是增量 patch。编辑器只接管「逐页读到 `eof`」且未超硬上限（**20,000 行或 2 MiB**，先到者）的文件，所以实际载荷有上限；超限的文件仍是只读预览，并明确说明原因。
- **CAS 的粒度是「读那一页时的 stat 版本」**：宿主 `read` 前会 stat，那个 `version` 就是 basis。如果宿主将来改成「按行范围返回不同版本」或后端不提供稳定 version，冲突检测会退化——**此时前端直接拒绝保存**（「无法确认基线版本，请重新打开该文件后再保存」），不会再 `stat` 补一个版本号把守卫丢掉。
- **草稿只在内存里，而且按 `sessionId + path` 存**：面板卸载、切会话都能恢复（切会话时主动停车，不依赖卸载）；页面刷新（用户对 `beforeunload` 点了「离开」）就没了。刻意不做 localStorage 落盘草稿：那需要一整套「草稿 vs 磁盘 vs 版本」的三方合并语义。
- **端点没做限流**：鉴权 + 工作区包含性 + CAS 已经挡住了越权和覆盖，但同一个已登录的页面可以对工作区内文件高频写。宿主 webserver 本身没有 per-route 限流，本插件也没加（加了会误伤正常的连续保存）。
- **端点没有 session/connection 绑定、也不预检目标类型**：见「写盘边界」的两个前提；类型判断交给 fs 后端。
- **编辑器是「一个文档一个视图」**：保存期间继续输入保留在 buffer 里（脏标记不清），但落盘的只是按下保存那一刻的快照；超时被 abort 后不会自动重试。
- 预览是**逐页读全**（每页 2000 行；宿主 `maxLines` 调小后自动降到 200 行并沿用该页大小），超上限时只读并只渲染前 2000 行；二进制文件不提供十六进制视图。
- 目录列举用宿主 `workspaceFiles.list`，它的 `maxEntries`（默认 2000）在宿主侧生效；本插件的 `maxTreeEntries`（默认 5000，可用 `dsh-ide-mode.v1.maxTreeEntries` 覆盖）只约束**已加载条目的可见行数**，且在展平前就停。
- **对话的 `phase` 只有 `hero` / `active` 两档，且只由 `blank` 一个输入决定**：宿主的 `phase` 是三输入（`shellPhase` + 会话打开状态 `openState` + `summaryBlank`）且含 `settling` 中间态，本面板只能取到会话列表快照里的 `blank`，所以：
  - 空白会话按 `blank` 传 `hero`，其余一律 `active`；
  - 会话正在打开（宿主会传 `settling`）时，本面板仍按 `blank` 传两档之一；
  - 宿主因 `shellPhase` 切档（例如面板重建中的过渡态）时，本面板不跟随。
  这是**已知限制**，不是「与宿主一致」。
- **引用是「指针」不是「内容」**：草稿里的 chip 最终只序列化成纯文本 `@path 起-止`，模型拿到的是路径与行号文字（详见「引用是指针」）。宿主不会替它展开代码，文件改动后行号也不会自动修正；工作区之外的路径无法相对化，此时**不插入**，只留一条 `console.warn`。
- **右键菜单只挂在编辑器上**：只读预览（超限/二进制/编辑器 chunk 加载失败时的 `<pre>`）没有 CodeMirror 选区，也没有我们的菜单 —— 那里右键仍是浏览器原生菜单（含复制）。这是有意的：没有「可引用的选区」时，原生菜单更有用。
- **符号链接（指向普通文件）无法预览**：`list` 上报的是目标类型（`'file'`），而宿主 `read` 第一步的 `locateFile` 用 `lstat` 判型，会把 symlink 判成 `not-regular-file`；本插件把该 code 映射成「此文件类型不支持预览」，不是红色错误块。**注意**这不是零请求：我们不再先发 `stat`，而是直接发 `read`，由宿主在读任何字节之前拒绝（一次 RPC，不共享超时预算）。目录符号链接不受影响（`list` 照常展开）。
- 第三栏跟随宿主当前会话；没有「在 IDE 里钉住另一个会话」的能力（那需要 `SessionProvider` + 会话列表 UI，本期不做）。
- `chatSurface` / `maxTreeEntries` 在激活时读取，改动需要刷新页面。
- 未使用 `files.changes` 做外部变更推送；刷新靠手动按钮。
- `IdePanelBoundary` 保护的是 React 的**渲染/生命周期**路径（React 的边界语义）。事件处理器与定时器回调里的同步异常**不在**边界范围内：这些入口自己 `try/catch`（`controller.enter/exit`、`loadDir`、`readPage`、`selectConversationPanel`），不做「靠边界兜住」的假设。熔断记录**只在同一版本内有效**：升级后自动失效（读到即删、正常挂载），同版本内则不会自动过期 —— 删掉 `dsh-ide-mode.v1.crashed` 或点「重试」是唯一的解除方式（这是刻意的，按时间自动过期会让死循环回来）。
