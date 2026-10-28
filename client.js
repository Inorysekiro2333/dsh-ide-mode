/**
 * dsh-ide-mode - Client half.
 *
 * One header button (`conversation.session.header.utilities`, id
 * `dsh-ide-mode:toggle`, order -20) and one keyed main panel (`main` / key
 * `ide`). The panel draws its own three columns - file tree, an *editable*
 * CodeMirror 6 code area, and the *real* conversation - and its own two
 * dividers; it never touches the native right sidebar, never calls
 * `openRightbar`/`openTab` and never guesses a tab kind. Entering IDE mode is
 * exactly `selectPanel('ide')`; leaving it is exactly `selectPanel(null)`.
 *
 * The third column renders the host's own `conversation.content` Component
 * Factory through the standard `renderFactorySlot` prop every slot entry
 * receives, wrapped in a local error boundary so a factory failure degrades to
 * a card instead of a blank pane. A factory that returns no node degrades the
 * same way. The factory input carries no `sessionId`: that value is a standard
 * session-scope prop supplied by the renderer, and passing it again is rejected
 * by the renderer's duplicate-prop check.
 *
 * The component registered into `main` is not the panel itself but a class
 * error boundary (`IdePanelBoundary`) that renders the panel as its only child:
 * an uncaught render error in React 18 unmounts the whole root, which is a
 * blank page no plugin can explain to a user. The boundary never rethrows, and
 * it renders a localized card carrying the raw `name: message` of the error.
 * The same boundary is the circuit breaker: a crash writes a *versioned* record
 * to `localStorage['dsh-ide-mode.v1.crashed']` (`{ version, message, ts, rev? }`),
 * and the next entry renders that card *without* mounting the subtree until the
 * user presses retry. That is what keeps a reload from turning one crash into a
 * permanent blank page. The record is bound to {@link PLUGIN_VERSION}: a mark
 * written by another build - or the bare `name: message` string earlier
 * releases wrote - is dropped on read and the panel mounts normally, so an
 * upgrade never asks the user to press retry first.
 *
 * File data comes from the host's authorized Remote namespace
 * (`remote.workspaceFiles`), which carries the Session identity on the wire and
 * answers every one-shot call with a `RemoteResult` (`{ ok, value }` or
 * `{ ok, error }`) instead of throwing. Paths are absolute - the Host refuses an
 * empty one - and the root is the session's `cwd`, the same field the host's own
 * file tree reads.
 *
 * Saving is the one write this module performs, and it goes to the package's own
 * host endpoint (`POST dsh-ide-mode/write`, document-relative because the shell
 * proxies unknown paths to the host listener). The body carries the `version`
 * the read reported, and the host turns it into an `FsWriteIntent`
 * (`replaceIfVersion`), so a file that changed in between fails with
 * `FS_STALE_VERSION` (409) instead of being clobbered. There is no other network
 * entry point here: no CDN, no absolute URL, no `fetch` outside this save.
 *
 * The editor itself is a *chunk* (`client.editor.js`, 650 KiB) loaded through
 * `require.async` on the first opened file and never on first paint. The host's
 * module system owns the URL derivation, the script tag, de-duplication, HMR
 * invalidation; this module only owns the single-flight promise, the mount /
 * `destroy` lifecycle and the degradation to the read-only preview.
 *
 * Everything is registered through `ctx.effect` / `ctx.slots.inject`, so
 * unloading removes the button, the panel, the stylesheet, the panel watcher
 * and the persisted-write timer.
 *
 * @module dsh-ide-mode/client
 */
window.__ModuleLoader__.load({
  id: 'dsh-ide-mode',
  // eslint-disable-next-line prefer-arrow-callback
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { Fragment } = React
    const { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } = React

    /** Plugin id: module loader id, log prefix, style dataset, error prefix. */
    const PLUGIN = 'dsh-ide-mode'
    /** The `main` slot key this plugin owns and selects. */
    const PANEL_KEY = 'ide'
    /** localStorage key holding per-session IDE preferences (LRU-capped). */
    const STORE_KEY = 'dsh-ide-mode.v1'
    /** localStorage override for the third column: 'embed' (default) or 'none'. */
    const CHAT_SURFACE_KEY = 'dsh-ide-mode.v1.chatSurface'
    /** localStorage override for the file-tree entry budget. */
    const MAX_ENTRIES_KEY = 'dsh-ide-mode.v1.maxTreeEntries'
    /**
     * Circuit breaker written by the panel boundary when a render throws, read
     * when the panel is entered. Its value is a *versioned* record, JSON encoded:
     * `{ version, message, ts, rev? }`. The `version` field is what keeps one
     * bad build from pausing the panel forever - see {@link readCrashMark}.
     */
    const CRASH_KEY = 'dsh-ide-mode.v1.crashed'
    /**
     * Mirrors `package.json`'s version. It is the only source of the version for
     * every log line, every beacon and the crash mark - never guessed from `ctx`.
     */
    const PLUGIN_VERSION = '0.4.0'
    /**
     * The build revision the loader served this bundle under, when it says so
     * (`client.js?rev=<rev>`), otherwise `''`. Only ever copied into the crash
     * mark, so two builds that share a version stay distinguishable in a report.
     */
    const BUILD_REV = readBuildRev()

    /**
     * The editor chunk, addressed the way the host's `/plugins/<id>/` route
     * serves it: a `client.<name>.js` file beside the package's `client.js`.
     * `require.async` derives the URL (with `?rev=`), injects the script,
     * de-duplicates concurrent loads and invalidates on HMR - this module does
     * none of that itself.
     */
    const EDITOR_CHUNK = './client.editor.js'
    /**
     * The host's write endpoint, kept relative so the panel stays independent of
     * the deployment's URL prefix. {@link writeUrl} resolves it against
     * `document.baseURI` at call time - the shell serves this page under a
     * prefix it owns, and the request must not depend on whatever base happened
     * to be implicit at the call site.
     */
    const WRITE_ROUTE = 'dsh-ide-mode/write'
    /**
     * Extension → CodeMirror language id. `ts`/`tsx` map to `javascript` on
     * purpose: the chunk bundles the JavaScript grammar only, and a missing
     * grammar id silently renders as plain text, which is worse than JS
     * highlighting on TypeScript.
     */
    const LANGUAGE_BY_EXTENSION = Object.freeze({
      js: 'javascript',
      mjs: 'javascript',
      cjs: 'javascript',
      jsx: 'javascript',
      ts: 'javascript',
      tsx: 'javascript',
      json: 'json',
      jsonc: 'json',
      md: 'markdown',
      markdown: 'markdown',
      css: 'css',
      html: 'html',
      htm: 'html',
      py: 'python',
    })
    /** Language used when the extension is unknown (or there is none). */
    const PLAIN_TEXT = 'plaintext'

    /** File-tree column contract: 180-480 px, capped by the container's side budget. */
    const TREE_MIN = 180
    const TREE_MAX = 480
    const TREE_DEFAULT = 280
    /** Chat column contract: 260 px up to 45% of the container. */
    const CHAT_MIN = 260
    const CHAT_DEFAULT = 420
    /** Space the code column keeps before either side column may take more. */
    const CODE_MIN = 240
    /** Width of one divider handle; two of them are part of every width budget. */
    const HANDLE_WIDTH = 8
    /**
     * Last-resort width, used only when the panel root cannot be measured at
     * all (no layout box, no viewport). The first frame is a skeleton at 0 and
     * never paints a column from this value, so it can never decide a visible
     * layout - {@link resolveWidths} only needs a positive number to divide.
     */
    const FALLBACK_WIDTH = 1280

    /**
     * Page size requested from `workspaceFiles.read`. The file is read one page
     * at a time until `eof`, so this is the granularity of the read and of its
     * progress line - not a read-only budget any more.
     */
    const PREVIEW_LINES = 2000
    /**
     * Page size retried once when the host's configured `maxLines` refuses
     * {@link PREVIEW_LINES}: the cap is a Host setting, so a smaller page is the
     * only request that can still succeed. Derived so it is smaller than the
     * requested page by construction, never by a runtime comparison.
     */
    const PREVIEW_LINES_FALLBACK = Math.min(200, PREVIEW_LINES - 1)
    /**
     * Hard cap on a file that may enter the editor: 20,000 lines. Past it the
     * file stays a read-only preview - CodeMirror over a hundred thousand lines
     * freezes the panel, and shipping the rest would only delay the refusal.
     */
    const MAX_EDITABLE_LINES = 20000
    /**
     * Hard cap on a file that may enter the editor: 2 MiB, the write route's own
     * body ceiling. A file whose bytes pass it could be read but never saved.
     */
    const MAX_EDITABLE_BYTES = 2 * 1024 * 1024
    /** One Remote call's budget before the request is aborted as timed out. */
    const REQUEST_TIMEOUT_MS = 15000
    /** Deferral between selecting an entry and reading it, so fast clicks coalesce. */
    const FILE_DEBOUNCE_MS = 40
    /** Coalescing window for localStorage writes of a session's preferences. */
    const PERSIST_DELAY_MS = 500
    /** Sessions whose preferences survive; the least recently used is evicted. */
    const PREF_SESSION_LIMIT = 50
    /** Default cap on visible file-tree rows, enforced while flattening. */
    const MAX_TREE_ENTRIES_DEFAULT = 5000
    /** Lifetime of one `path:start-end` record in the module-level table. */
    const REF_DEDUPE_MS = 30000
    /** Lifetime of the in-panel "quoted lines" / "copied" hint. */
    const REF_HINT_MS = 1500
    /** Shortest selection (characters) that counts as something to quote. */
    const REF_MIN_CHARS = 2
    /**
     * The context menu's box, used to keep it inside the viewport **before** it
     * has been laid out. Its content is fixed - two actions, a separator and a
     * cancel row - so an estimate is accurate enough to clamp with; the real box
     * is re-checked after the first paint (see the component's placement effect).
     */
    const REF_MENU_WIDTH = 208
    const REF_MENU_HEIGHT = 104
    /** Distance the menu keeps from a viewport edge. */
    const REF_MENU_MARGIN = 8
    /** Locale namespace registered with the locale service (dictionary lives here). */
    const DICT_NS = 'ideMode'

    /** Simplified Chinese copy - the single runtime source of truth. */
    const zh = {
      button: 'IDE 模式',
      tooltipEnter: '进入 IDE 模式',
      tooltipExit: '退出 IDE 模式',
      toggleErrorHint: '无法切换 IDE 模式：{reason}',
      noSession: '还没有会话：请先打开或新建一个会话',
      titleFallback: '会话',
      backToChat: '切回对话',
      exitIde: '退出 IDE',
      filesTitle: '文件',
      codeTitle: '代码预览',
      chatTitle: '对话',
      rootLabel: '工作区',
      refresh: '刷新文件树',
      loading: '加载中…',
      loadingFile: '正在读取文件…',
      emptyDir: '这个目录是空的',
      truncatedDir: '条目过多，仅显示前一部分',
      budgetReached: '文件树已达条目上限（{n}），折叠部分目录后再展开',
      noFile: '从左侧选择文件查看内容',
      emptyFile: '这个文件是空的',
      tooLarge: '文件超过只读预览上限，未加载内容',
      binary: '这是二进制文件，未加载内容',
      unsupportedFile: '此文件类型不支持预览',
      renderTruncated: '内容较长，仅显示前 {n} 行',
      readOnly: '只读预览',
      lines: '{n} 行',
      retry: '重试',
      errorGeneric: '读取失败',
      errorService: '文件服务不可用',
      errorServiceHint: '宿主没有提供 remote.workspaceFiles，文件树暂时不可用。',
      errorTimeout: '请求超时（{n} 秒）',
      errorTransport: '无法连接宿主文件服务（载体不可达或已离线）',
      errorGateway: '宿主接口拒绝了这次请求（{code}）',
      errorNotFound: '路径不存在',
      errorOutside: '路径不在会话工作区内，已拒绝',
      errorTooLarge: '文件超过预览上限',
      errorNotFile: '这不是普通文件',
      errorNotDirectory: '这不是目录',
      errorNoWorkspace: '这个会话还没有可用的工作区',
      errorWatchUnsupported: '该文件系统不支持变更监听',
      errorCode: '错误码：{code}',
      resizeTree: '调整文件树宽度',
      resizeChat: '调整对话栏宽度',
      resizeHint: '拖动调整宽度；双击或 Enter 复位，左右方向键 ±8，Shift ±32，Home/End 到边界',
      chatDisabledTitle: '对话嵌入已关闭',
      chatDisabledHint:
        'localStorage 里的 dsh-ide-mode.v1.chatSurface 是 "none"，第三栏不渲染对话。删掉该项或设为 "embed" 后刷新即可恢复。',
      chatFallbackTitle: '对话嵌入失败',
      chatFallbackHint: '第三栏没有渲染出对话，下面的技术原因可用来定位；也可以重试或切回原生对话。',
      chatFallbackMissing: '当前渲染器没有提供 renderFactorySlot（宿主版本不匹配，或本插件入口已释放）',
      chatFallbackUnavailable: '对话视图不可用：宿主工厂没有返回任何节点',
      chatFallbackUnknown: '未知错误',
      retryEmbed: '重试',
      crashTitle: 'IDE 面板出错了',
      crashHint: '面板渲染时抛错，已用这张卡片代替；界面其余部分照常工作。下面的原始错误可以复制给我们定位问题，也可以重试或切回对话。',
      crashHaltedTitle: 'IDE 面板上次崩溃，已暂停挂载',
      crashHaltedHint: '上一次进入 IDE 模式时面板渲染抛错。为避免刷新后再次白屏（同一版本内才会暂停；插件更新后会自动清除），这里只显示卡片、不挂载面板；点「重试」会清除标记并重新挂载。',
      treeCrashTitle: '文件树渲染出错',
      treeCrashHint: '文件树这一栏没算出来，代码预览与对话两栏不受影响。可以重试。',
      editable: '可编辑',
      save: '保存',
      saveHint: '保存到磁盘（Ctrl+S / Cmd+S）',
      saving: '保存中…',
      saved: '已保存',
      unsaved: '未保存',
      saveFailed: '保存失败，可重试',
      errorVersionMissing: '无法确认基线版本，请重新打开该文件后再保存',
      errorSaveRejected: '宿主拒绝了这次保存（{code}）',
      errorSaveUnavailable: '保存服务不可用（宿主端点未就绪）',
      editorLoading: '正在加载编辑器…',
      editorFailedTitle: '编辑器组件加载失败，已降级为只读预览',
      editorFailedHint: '文件内容仍然可以查看，只是不能编辑和保存。可以重试加载编辑器。',
      editorRetry: '重新加载编辑器',
      fileTooLarge: '文件过大（≥20,000 行或 2 MiB），只读预览',
      readingPages: '读取中 {i}/{n} 页',
      conflictTitle: '文件已被修改',
      conflictHint: '磁盘上的内容与打开时不同。重新加载会放弃本地修改；强制覆盖会用编辑器里的内容写回磁盘。',
      conflictReload: '重新加载',
      conflictOverwrite: '强制覆盖',
      confirmTitle: '未保存的修改',
      confirmSwitch: '「{name}」有未保存的修改，切换文件会丢弃这些修改。',
      confirmRestore: '当前文件有未保存的修改，恢复草稿会丢弃这些修改。',
      confirmLeave: '当前文件有未保存的修改，离开会丢弃这些修改。',
      confirmDiscard: '放弃修改',
      confirmCancel: '取消',
      draftTitle: '上次离开时有未保存的修改',
      draftHint: '「{name}」的草稿还留在这里。恢复后可以继续编辑并保存；丢弃则回到磁盘上的内容。',
      draftRestore: '恢复草稿',
      draftDiscard: '丢弃草稿',
      refMenuInsert: '引用选区到对话',
      refMenuCopy: '复制引用',
      refMenuCancel: '取消',
      refMenuDisabled: '先在编辑器里选中代码',
      refInserted: '已引用 {lines} 行',
      refCopied: '已复制引用，粘贴到对话即可',
    }

    /** English copy, same key set. */
    const en = {
      button: 'IDE mode',
      tooltipEnter: 'Enter IDE mode',
      tooltipExit: 'Leave IDE mode',
      toggleErrorHint: 'Cannot switch IDE mode: {reason}',
      noSession: 'No session yet: open or start a conversation first',
      titleFallback: 'Session',
      backToChat: 'Back to chat',
      exitIde: 'Exit IDE',
      filesTitle: 'Files',
      codeTitle: 'Code preview',
      chatTitle: 'Conversation',
      rootLabel: 'Workspace',
      refresh: 'Refresh the file tree',
      loading: 'Loading…',
      loadingFile: 'Reading file…',
      emptyDir: 'This folder is empty',
      truncatedDir: 'Too many entries: showing the first part only',
      budgetReached: 'The tree reached its {n}-entry budget; collapse a folder before expanding another',
      noFile: 'Pick a file on the left to preview it',
      emptyFile: 'This file is empty',
      tooLarge: 'File is above the preview limit; content not loaded',
      binary: 'Binary file; content not loaded',
      unsupportedFile: 'This file type cannot be previewed',
      renderTruncated: 'Long file: showing the first {n} lines',
      readOnly: 'Read-only preview',
      lines: '{n} lines',
      retry: 'Retry',
      errorGeneric: 'Read failed',
      errorService: 'File service unavailable',
      errorServiceHint: 'The host exposes no remote.workspaceFiles, so the file tree is unavailable.',
      errorTimeout: 'Request timed out ({n}s)',
      errorTransport: 'Cannot reach the host file service (carrier unreachable or offline)',
      errorGateway: 'The host refused this request ({code})',
      errorNotFound: 'Path does not exist',
      errorOutside: 'Path is outside the session workspace and was refused',
      errorTooLarge: 'File is above the preview limit',
      errorNotFile: 'That path is not a regular file',
      errorNotDirectory: 'That path is not a directory',
      errorNoWorkspace: 'This session has no usable workspace yet',
      errorWatchUnsupported: 'This filesystem cannot watch for changes',
      errorCode: 'Code: {code}',
      resizeTree: 'Resize the file tree',
      resizeChat: 'Resize the conversation column',
      resizeHint: 'Drag to resize; double-click or Enter to reset, arrows ±8, Shift ±32, Home/End to the limits',
      chatDisabledTitle: 'Conversation embedding is off',
      chatDisabledHint:
        'localStorage key dsh-ide-mode.v1.chatSurface is "none", so the third column renders no conversation. Remove it (or set it to "embed") and reload to restore.',
      chatFallbackTitle: 'Conversation embedding failed',
      chatFallbackHint: 'The third column could not render the conversation. The technical reason below helps diagnose it; retry or go back to the native chat.',
      chatFallbackMissing: 'This renderer provides no renderFactorySlot (host version mismatch, or this plugin entry was released)',
      chatFallbackUnavailable: 'Conversation view unavailable: the host factory returned no node',
      chatFallbackUnknown: 'Unknown error',
      retryEmbed: 'Retry',
      crashTitle: 'The IDE panel crashed',
      crashHint:
        'Rendering the panel threw, so this card took its place; the rest of the shell is unaffected. The raw error below is what a bug report needs - you can also retry or go back to the chat.',
      crashHaltedTitle: 'The IDE panel crashed last time and stays unmounted',
      crashHaltedHint:
        'Entering IDE mode threw last time. To keep a reload from blanking the page again (the pause only lasts within this version; updating the plugin clears it automatically), the panel is not mounted behind this card; retry clears the mark and mounts it.',
      treeCrashTitle: 'The file tree failed to render',
      treeCrashHint: 'This column could not be computed; the preview and the conversation are unaffected. Retry is available.',
      editable: 'Editable',
      save: 'Save',
      saveHint: 'Save to disk (Ctrl+S / Cmd+S)',
      saving: 'Saving…',
      saved: 'Saved',
      unsaved: 'Unsaved',
      saveFailed: 'Save failed - retry is available',
      errorVersionMissing: 'No baseline version is available; reopen this file before saving',
      errorSaveRejected: 'The host refused this save ({code})',
      errorSaveUnavailable: 'Save service unavailable (the host endpoint is not ready)',
      editorLoading: 'Loading the editor…',
      editorFailedTitle: 'The editor component failed to load; fell back to the read-only preview',
      editorFailedHint: 'The file is still readable, it just cannot be edited or saved. Reloading the editor is available.',
      editorRetry: 'Reload the editor',
      fileTooLarge: 'File too large (≥20,000 lines or 2 MiB); read-only preview',
      readingPages: 'Reading page {i} of {n}',
      conflictTitle: 'The file changed on disk',
      conflictHint: 'The file on disk differs from what was opened. Reloading drops local edits; forcing writes the editor content over it.',
      conflictReload: 'Reload',
      conflictOverwrite: 'Overwrite anyway',
      confirmTitle: 'Unsaved changes',
      confirmSwitch: '"{name}" has unsaved changes; switching files discards them.',
      confirmRestore: 'The current file has unsaved changes; restoring the draft discards them.',
      confirmLeave: 'The current file has unsaved changes; leaving discards them.',
      confirmDiscard: 'Discard changes',
      confirmCancel: 'Cancel',
      draftTitle: 'Unsaved changes from the last visit',
      draftHint: 'A draft of "{name}" is still here. Restoring keeps it editable and savable; discarding returns to the file on disk.',
      draftRestore: 'Restore the draft',
      draftDiscard: 'Discard the draft',
      refMenuInsert: 'Quote selection into the conversation',
      refMenuCopy: 'Copy reference',
      refMenuCancel: 'Cancel',
      refMenuDisabled: 'Select some code in the editor first',
      refInserted: 'Quoted lines {lines}',
      refCopied: 'Reference copied - paste it into the conversation',
    }

    /** Stylesheet: theme tokens only, every class under this plugin's prefix. */
    const CSS = `
.dsh-ide-root{display:flex;flex-direction:column;flex:1 1 auto;width:100%;height:100%;min-width:0;min-height:0;overflow:hidden;position:relative;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}
.dsh-ide-root[data-dragging="true"]{user-select:none}
.dsh-ide-root[data-dragging="true"] *{cursor:col-resize!important}
.dsh-ide-top{display:flex;flex-wrap:nowrap;align-items:center;gap:8px;flex:0 0 auto;height:36px;min-width:0;padding:0 8px 0 12px;border-bottom:1px solid var(--dsw-alias-border-l1);font-size:12px}
.dsh-ide-title{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}
.dsh-ide-actions{display:flex;align-items:center;gap:4px;flex:none}
.dsh-ide-cols{display:flex;flex-direction:row;align-items:stretch;flex:1 1 auto;min-width:0;min-height:0;overflow:hidden}
.dsh-ide-col{display:flex;flex-direction:column;min-width:0;min-height:0;overflow:hidden}
.dsh-ide-col-tree{flex:0 0 auto}
.dsh-ide-col-code{flex:1 1 auto;min-width:0;background:var(--dsw-alias-bg-layer-1)}
.dsh-ide-col-chat{flex:0 0 auto;min-width:0}
.dsh-ide-head{display:flex;align-items:center;gap:6px;flex:0 0 auto;height:30px;min-width:0;padding:0 6px 0 10px;border-bottom:1px solid var(--dsw-alias-border-l1);font-size:11.5px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden}
.dsh-ide-head-title{flex:none;font-weight:600}
.dsh-ide-head-text{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;font-family:var(--dsh-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11px;opacity:.85}
.dsh-ide-handle{position:relative;flex:0 0 8px;width:8px;padding:0;border:0;background:transparent;cursor:col-resize;touch-action:none}
.dsh-ide-handle::before{content:"";position:absolute;top:0;bottom:0;left:3px;width:2px;border-radius:1px;background:var(--dsw-alias-border-l1)}
.dsh-ide-handle:hover::before,.dsh-ide-handle[data-dragging="true"]::before{background:var(--dsw-alias-brand-primary)}
.dsh-ide-handle:focus-visible{outline:1px solid var(--dsw-alias-brand-primary);outline-offset:-1px}
.dsh-ide-tree{flex:1 1 auto;min-height:0;overflow:auto;padding:4px 0 12px}
.dsh-ide-li{display:block}
.dsh-ide-row{display:flex;align-items:center;gap:5px;width:100%;height:24px;padding:0 8px;border:0;background:none;color:inherit;font:inherit;font-size:12.5px;text-align:left;cursor:pointer;white-space:nowrap}
.dsh-ide-row:hover{background:var(--dsw-alias-bg-layer-2)}
.dsh-ide-row[aria-current="true"]{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-brand-primary)}
.dsh-ide-row:focus-visible{outline:1px solid var(--dsw-alias-brand-primary);outline-offset:-1px}
.dsh-ide-row-name{min-width:0;overflow:hidden;text-overflow:ellipsis}
.dsh-ide-mark{flex:none;display:inline-flex;width:12px;height:12px;color:var(--dsw-alias-label-secondary)}
.dsh-ide-mark[data-open="true"]{transform:rotate(90deg)}
.dsh-ide-note{display:flex;align-items:center;height:22px;padding:0 10px;font-size:11.5px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsh-ide-note[data-error="true"]{color:var(--dsw-alias-state-error-primary)}
.dsh-ide-note[data-retry="true"]{height:auto;min-height:22px;gap:6px;padding-top:3px;padding-bottom:3px;white-space:normal}
.dsh-ide-note-text{min-width:0;overflow:hidden;text-overflow:ellipsis}
.dsh-ide-body{flex:1 1 auto;display:flex;flex-direction:column;min-width:0;min-height:0;overflow:auto}
.dsh-ide-pre{margin:0;padding:8px 0 24px;font-family:var(--dsh-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:var(--dsh-code-font-size,12.5px);line-height:1.55;tab-size:2;color:var(--dsw-alias-label-primary)}
.dsh-ide-line{display:block;padding-right:12px;white-space:pre}
.dsh-ide-ln{display:inline-block;width:4.2em;padding-right:.9em;text-align:right;color:var(--dsw-alias-label-secondary);user-select:none}
.dsh-ide-chat-body{flex:1 1 auto;display:flex;flex-direction:column;min-width:0;min-height:0;overflow:hidden}
.dsh-ide-state{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;height:100%;padding:20px;text-align:center;font-size:12.5px;line-height:1.6;color:var(--dsw-alias-label-secondary);overflow:auto}
.dsh-ide-state-title{color:var(--dsw-alias-label-primary)}
.dsh-ide-card{display:flex;flex-direction:column;align-items:flex-start;gap:8px;margin:12px;padding:12px 14px;border:1px solid var(--dsw-alias-state-warn-primary);border-radius:8px;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-primary)}
.dsh-ide-root[data-ide-crash]{display:block;overflow:auto;padding-top:8px}
.dsh-ide-cards{display:flex;flex-direction:column;flex:0 0 auto}
.dsh-ide-root[data-ide-crash] .dsh-ide-card{max-width:560px}
.dsh-ide-card-title{font-weight:600}
.dsh-ide-card-code{max-width:100%;overflow-wrap:anywhere;font-family:var(--dsh-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11px;color:var(--dsw-alias-label-secondary)}
.dsh-ide-error{display:flex;flex-direction:column;gap:6px;margin:12px;padding:10px 12px;border:1px solid var(--dsw-alias-state-error-primary);border-radius:8px;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-primary)}
.dsh-ide-error-code{font-family:var(--dsh-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11px;color:var(--dsw-alias-state-error-primary);overflow-wrap:anywhere}
.dsh-ide-notice{margin:12px;padding:10px 12px;border:1px solid var(--dsw-alias-state-warn-primary);border-radius:8px;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-primary)}
.dsh-ide-btn{display:inline-flex;align-items:center;justify-content:center;gap:5px;height:24px;min-width:24px;padding:0 8px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer}
.dsh-ide-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.dsh-ide-btn[aria-pressed="true"]{color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-2)}
.dsh-ide-btn:disabled{opacity:.45;cursor:not-allowed}
.dsh-ide-btn:focus-visible{outline:1px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.dsh-ide-icon-btn{flex:none;display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;padding:0;border:0;border-radius:5px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
.dsh-ide-icon-btn:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.dsh-ide-icon-btn:focus-visible{outline:1px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.dsh-ide-dot{flex:none;display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-brand-primary)}
.dsh-ide-status{flex:none;font-size:11px;color:var(--dsw-alias-label-secondary)}
.dsh-ide-head-text[data-ide-save-detail]{flex:0 1 auto;max-width:46%;color:var(--dsw-alias-state-warn-primary)}
.dsh-ide-status[data-ide-save-state="error"]{color:var(--dsw-alias-state-error-primary)}
.dsh-ide-editor{flex:1 1 auto;display:flex;flex-direction:column;min-width:0;min-height:0;overflow:hidden}
.dsh-ide-editor .cm-editor{flex:1 1 auto;height:100%;min-height:0}
.dsh-ide-editor .cm-scroller{font-family:var(--dsh-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:var(--dsh-code-font-size,12.5px)}
.dsh-ide-confirm{position:absolute;inset:0;z-index:2;display:flex;align-items:center;justify-content:center;padding:16px;background:var(--dsw-alias-bg-base)}
.dsh-ide-confirm .dsh-ide-card{max-width:440px;margin:0;border-color:var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}
.dsh-ide-editor-shell{flex:1 1 auto;display:flex;flex-direction:column;min-width:0;min-height:0;overflow:hidden}
.dsh-ide-ref-menu{position:fixed;z-index:20;display:flex;flex-direction:column;min-width:180px;max-width:320px;padding:4px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);font-size:12.5px;line-height:1.4}
.dsh-ide-ref-menu-item{display:flex;align-items:center;width:100%;min-height:26px;padding:0 8px;border:0;border-radius:5px;background:none;color:inherit;font:inherit;font-size:12.5px;text-align:left;white-space:nowrap;cursor:pointer}
.dsh-ide-ref-menu-item:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}
.dsh-ide-ref-menu-item:focus-visible{outline:1px solid var(--dsw-alias-brand-primary);outline-offset:-1px}
.dsh-ide-ref-menu-item[aria-disabled="true"]{color:var(--dsw-alias-label-secondary);opacity:.55;cursor:not-allowed}
.dsh-ide-ref-menu-sep{height:1px;margin:4px 6px;background:var(--dsw-alias-border-l2)}
.dsh-ide-ref-hint{flex:none;max-width:40%;overflow:hidden;text-overflow:ellipsis;font-size:11px;color:var(--dsw-alias-brand-primary)}
`

    // -- module-level constants and pure helpers ---------------------------

    /** A frozen empty preference record, so a miss never allocates per render. */
    const EMPTY_PREFS = Object.freeze({})

    /**
     * The "no rows" flattening result: the first, unmeasured frame and every
     * failed flatten share it, so neither allocates a row array per render.
     */
    const EMPTY_ROWS = Object.freeze({ rows: Object.freeze([]), truncated: false, crash: '' })

    /** The absent observable source used by hooks when a service is missing. */
    const ABSENT_SOURCE = Object.freeze({
      getSnapshot: () => undefined,
      subscribe: () => () => {},
    })

    /** True when the platform exposes animation frames (tests and workers may not). */
    const HAS_RAF = typeof requestAnimationFrame === 'function'

    /**
     * Schedule one frame.
     * @param fn - callback.
     * @returns the frame handle.
     */
    function scheduleFrame(fn) {
      return HAS_RAF ? requestAnimationFrame(fn) : setTimeout(fn, 16)
    }

    /**
     * Cancel a handle produced by {@link scheduleFrame}.
     * @param handle - the handle, or null.
     */
    function cancelFrame(handle) {
      if (handle === null || handle === undefined) return
      if (HAS_RAF) cancelAnimationFrame(handle)
      else clearTimeout(handle)
    }

    /**
     * Clamp a number into an inclusive range.
     * @param value - candidate.
     * @param min - lower bound.
     * @param max - upper bound.
     * @returns the clamped number.
     */
    function clampNumber(value, min, max) {
      const number = Number.isFinite(value) ? value : min
      if (max < min) return min
      return Math.min(max, Math.max(min, number))
    }

    /**
     * Human-readable byte size.
     * @param value - byte count.
     * @returns the label.
     */
    function formatBytes(value) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return '—'
      if (value < 1024) return `${value} B`
      if (value < 1024 * 1024) return `${(value / 1024).toFixed(value < 10240 ? 1 : 0)} KB`
      return `${(value / (1024 * 1024)).toFixed(1)} MB`
    }

    /**
     * Resolve the three column widths for one container width.
     *
     * The two divider handles are part of the budget, so the columns can never
     * claim more than the container offers: the side columns share
     * `width - 2 * HANDLE_WIDTH` and the code column keeps
     * `min(CODE_MIN, 40% of that)`. Both side minimums are capped by the same
     * budget, so at every width `tree + chat + 2 * HANDLE_WIDTH + code` is
     * exactly the container width and the code column is never negative; below
     * roughly 700 px that means the documented minimums themselves shrink.
     * `treeMax`/`chatMax` are the widths reachable while the other side column
     * still keeps its own minimum, so they are what ARIA may advertise.
     * @param containerWidth - measured width of the panel root.
     * @param treePref - preferred file-tree width.
     * @param chatPref - preferred chat width.
     * @returns the resolved widths, the code width, and the bounds they came from.
     */
    function resolveWidths(containerWidth, treePref, chatPref) {
      const width = clampNumber(
        Math.round(Number.isFinite(containerWidth) && containerWidth > 0 ? containerWidth : FALLBACK_WIDTH),
        1,
        100000,
      )
      const usable = Math.max(0, width - 2 * HANDLE_WIDTH)
      const codeMin = Math.min(CODE_MIN, Math.floor(usable * 0.4))
      const sideBudget = Math.max(0, usable - codeMin)
      const treeMin = Math.min(TREE_MIN, Math.floor(sideBudget * 0.45))
      const chatMin = Math.min(CHAT_MIN, Math.max(0, sideBudget - treeMin))
      const ratioCap = Math.round(width * 0.45)
      const treeMax = Math.max(treeMin, Math.min(TREE_MAX, sideBudget - chatMin))
      const chatMax = Math.max(chatMin, Math.min(Math.max(CHAT_MIN, ratioCap), sideBudget - treeMin))
      let tree = clampNumber(Math.round(treePref), treeMin, treeMax)
      let chat = clampNumber(Math.round(chatPref), chatMin, chatMax)
      const excess = tree + chat - sideBudget
      if (excess > 0) {
        const treeRoom = tree - treeMin
        const chatRoom = chat - chatMin
        const room = treeRoom + chatRoom
        if (room > 0) tree -= Math.min(treeRoom, Math.round(excess * (treeRoom / room)))
        chat = Math.min(chat, Math.max(chatMin, sideBudget - tree))
      }
      return {
        tree,
        chat,
        code: usable - tree - chat,
        sideBudget,
        treeMin,
        treeMax,
        chatMin,
        chatMax,
        containerWidth: width,
      }
    }

    /**
     * The layout {@link resolveWidths} is replaced with if the arithmetic itself
     * ever throws. Pure number work cannot throw for finite inputs, so this is a
     * last-resort object rather than a real layout: it only keeps the panel
     * renderable (documented defaults, both side columns inside their contract)
     * instead of letting a `TypeError` reach React and unmount the root.
     */
    const FALLBACK_LAYOUT = Object.freeze({
      tree: TREE_DEFAULT,
      chat: CHAT_DEFAULT,
      code: CODE_MIN,
      sideBudget: TREE_DEFAULT + CHAT_DEFAULT,
      treeMin: TREE_MIN,
      treeMax: TREE_MAX,
      chatMin: CHAT_MIN,
      chatMax: CHAT_DEFAULT,
      containerWidth: FALLBACK_WIDTH,
    })

    /**
     * {@link resolveWidths}, never throwing.
     * @param containerWidth - measured width of the panel root.
     * @param treePref - preferred file-tree width.
     * @param chatPref - preferred chat width.
     * @returns the resolved widths, or {@link FALLBACK_LAYOUT}.
     */
    function resolveWidthsSafe(containerWidth, treePref, chatPref) {
      try {
        return resolveWidths(containerWidth, treePref, chatPref)
      } catch (error) {
        console.warn(`[${PLUGIN}] width resolution failed:`, error)
        return FALLBACK_LAYOUT
      }
    }

    /**
     * Select the session the main view retains (the shell's own rule, mirrored
     * from `ui-session`'s `publishMain`). Module-level so the selector identity
     * is stable across renders.
     *
     * Runs inside `useSyncExternalStore`, i.e. inside a render, on whatever the
     * store holds *right now*: before hydration that can be `{}`, `{ byId: null }`
     * or a half-built record. A throw here has no boundary of its own (the panel
     * boundary is the last resort, not the first), so every shape miss returns
     * `undefined` instead of raising a `TypeError`.
     * @param state - sessions list snapshot.
     * @returns the session summary, or undefined.
     */
    function selectMainSession(state) {
      try {
        const byId = state !== null && typeof state === 'object' ? state.byId : undefined
        if (byId === null || typeof byId !== 'object') return undefined
        for (const session of Object.values(byId)) {
          if (session === null || typeof session !== 'object') continue
          const retainedBy = session.retainedBy
          if (retainedBy !== null && typeof retainedBy === 'object' && (retainedBy.mainView ?? 0) > 0) return session
        }
      } catch {
        // A hostile snapshot (throwing getter, exotic proxy) is a miss, not a crash.
      }
      return undefined
    }

    /**
     * Select the same session's id.
     * @param state - sessions list snapshot.
     * @returns the session id, or undefined.
     */
    function selectMainSessionId(state) {
      const session = selectMainSession(state)
      return typeof session?.id === 'string' ? session.id : undefined
    }

    /**
     * Select the same session's title.
     * @param state - sessions list snapshot.
     * @returns the title, or undefined.
     */
    function selectMainSessionTitle(state) {
      const session = selectMainSession(state)
      return typeof session?.title === 'string' ? session.title : undefined
    }

    /**
     * Select the same session's workspace base - the absolute path every Remote
     * file call is addressed with. The host's own file tree reads exactly this
     * field, and the Host refuses an empty path outright.
     * @param state - sessions list snapshot.
     * @returns the absolute cwd, or undefined.
     */
    function selectMainSessionCwd(state) {
      const session = selectMainSession(state)
      return typeof session?.cwd === 'string' && session.cwd !== '' ? session.cwd : undefined
    }

    /**
     * Select whether that session has no conversation content yet. The host uses
     * the same `blank` summary flag to decide `phase`/`hero` for its own
     * `conversation.content` factory.
     * @param state - sessions list snapshot.
     * @returns the flag, or undefined.
     */
    function selectMainSessionBlank(state) {
      const session = selectMainSession(state)
      return typeof session?.blank === 'boolean' ? session.blank : undefined
    }

    /** Read the browser viewport width, or the documented fallback. */
    function readViewportWidth() {
      try {
        const width = window.innerWidth
        return Number.isFinite(width) && width > 0 ? width : FALLBACK_WIDTH
      } catch {
        return FALLBACK_WIDTH
      }
    }

    /**
     * Turn an unknown thrown value into the technical one-liner shown on a card.
     * @param error - the thrown value.
     * @returns the description.
     */
    function describeError(error) {
      if (error === null || error === undefined) return ''
      if (typeof error === 'string') return error
      const code = typeof error.code === 'string' ? error.code : ''
      const message = typeof error.message === 'string' ? error.message : ''
      if (code !== '' && message !== '') return `${code}: ${message}`
      return message !== '' ? message : code
    }

    /**
     * Collapse any text to one single line, so a card can show it in a `<code>`
     * element that is selectable and copyable in one gesture.
     * @param text - raw text.
     * @returns the single-line form.
     */
    function singleLine(text) {
      if (typeof text !== 'string' || text === '') return ''
      return text.replace(/[\r\n\t\u2028\u2029]+/gu, ' ').replace(/\s{2,}/gu, ' ').trim()
    }

    /**
     * Describe a *crashed render*: `Name: message`, exactly as the runtime wrote
     * it, on one line. This is the text a user copies out of the card - it is
     * never translated, never truncated and never replaced by a friendly
     * sentence, because it is the only evidence we get from a build with no
     * DevTools open.
     * @param error - the thrown value (usually an Error).
     * @returns the one-line description, possibly empty.
     */
    function describeCrash(error) {
      if (error === null || error === undefined) return ''
      if (typeof error === 'string') return singleLine(error)
      if (typeof error !== 'object') return singleLine(String(error))
      const name = typeof error.name === 'string' ? singleLine(error.name) : ''
      const message = typeof error.message === 'string' ? singleLine(error.message) : ''
      if (name !== '' && message !== '') return `${name}: ${message}`
      if (message !== '') return message
      return name
    }

    /**
     * The build revision of this bundle, e.g. the `rev` the host's `/plugins/`
     * route appends to the script URL.
     *
     * Read from `document.currentScript` *while the bundle is still executing* -
     * the loader injects the script tag, so that is the only moment the URL is
     * on the stack. Everything is guarded: no `document`, no `currentScript`, a
     * relative or malformed URL, or simply no `rev` all yield `''`, and the crash
     * mark then omits the field instead of inventing one.
     * @returns the revision, or an empty string.
     */
    function readBuildRev() {
      try {
        const script = typeof document !== 'undefined' ? document.currentScript : null
        const src = script !== null && typeof script?.src === 'string' ? script.src : ''
        if (src === '') return ''
        const rev = new URL(src).searchParams.get('rev')
        return typeof rev === 'string' && rev !== '' ? rev.slice(0, 64) : ''
      } catch {
        return ''
      }
    }

    /**
     * Parse a stored crash mark.
     *
     * The current shape is `{ version, message, ts, rev? }`: `version` is the
     * plugin version that crashed, `message` the one-line `Name: message`, `ts`
     * the epoch milliseconds and `rev` the build revision when the loader had
     * one. Anything else - most importantly the bare `name: message` string
     * earlier releases wrote - is *not* a mark this build can reason about, so it
     * parses to `null` and the caller discards it.
     * @param raw - the raw localStorage value.
     * @returns the parsed mark, or null when the value is not this shape.
     */
    function parseCrashMark(raw) {
      if (typeof raw !== 'string' || raw === '') return null
      let value
      try {
        value = JSON.parse(raw)
      } catch {
        return null
      }
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
      if (typeof value.version !== 'string' || value.version === '') return null
      if (typeof value.message !== 'string') return null
      if (typeof value.ts !== 'number' || Number.isFinite(value.ts) === false) return null
      return {
        version: value.version,
        message: value.message,
        ts: value.ts,
        rev: typeof value.rev === 'string' ? value.rev : '',
      }
    }

    /**
     * Read the circuit-breaker mark *for this build*.
     *
     * `null` means "mount the panel". A mark is honoured only when its `version`
     * equals {@link PLUGIN_VERSION}: a mark left by an older build describes code
     * that is no longer here, so honouring it would make every user press retry
     * once after every upgrade. A stale mark (a different version, a legacy bare
     * string, a truncated blob) is deleted on the spot and *silently* discarded -
     * that is a normal path, not a warning.
     * @returns the mark of this version, or null.
     */
    function readCrashMark() {
      let raw
      try {
        raw = window.localStorage.getItem(CRASH_KEY)
      } catch {
        return null
      }
      if (raw === null) return null
      const mark = parseCrashMark(raw)
      if (mark !== null && mark.version === PLUGIN_VERSION) return mark
      clearCrashMark()
      return null
    }

    /**
     * Record that *this build* crashed, so the next entry mounts the card only.
     *
     * The single writer of {@link CRASH_KEY}: the only caller is
     * `IdePanelBoundary.componentDidCatch`, and the record carries the version
     * that wrote it - which is exactly what makes it expire on upgrade.
     * @param detail - one-line crash description.
     */
    function writeCrashMark(detail) {
      const mark = {
        version: PLUGIN_VERSION,
        message: typeof detail === 'string' ? detail : '',
        ts: Date.now(),
      }
      if (BUILD_REV !== '') mark.rev = BUILD_REV
      try {
        window.localStorage.setItem(CRASH_KEY, JSON.stringify(mark))
      } catch {
        // Storage blocked or full: the in-memory boundary state still holds.
      }
    }

    /**
     * Remove the circuit-breaker mark. Two callers, both deliberate: the card's
     * "retry", and {@link readCrashMark} dropping a mark that another build (or an
     * older release's bare string) left behind.
     */
    function clearCrashMark() {
      try {
        window.localStorage.removeItem(CRASH_KEY)
      } catch {
        // Storage blocked: nothing to clear.
      }
    }

    /**
     * A failure no Remote code describes: the namespace produced no result at
     * all. It carries no `code`, so the classifier reports it as `transport`.
     * @param message - diagnostic text.
     * @returns the error.
     */
    function transportFailure(message) {
      const error = new Error(message)
      error.name = 'RemoteTransportFailure'
      return error
    }

    /**
     * Gateway codes that report an *assembly* fault carried as a result: the
     * endpoint, service, method, binding or provider the Client face holds is
     * not the one the Host currently has. Every one of them means "the call
     * never reached a method", so resolving the namespace again is the only
     * remedy and the one retry below is worth spending.
     *
     * The two identity-miss codes are deliberately absent:
     * `gateway/lookup-not-found` (a cold session holds no persisted lookup -
     * not recoverable by retrying) and `gateway/context-not-found` (the
     * identity itself did not resolve, in practice a wrong session id). Both
     * are answers, not faults, and retrying them only doubles the latency of a
     * request that cannot succeed.
     */
    const ASSEMBLY_CODES = new Set([
      'gateway/service-unavailable',
      'gateway/method-unavailable',
      'gateway/lookup-unavailable',
      'gateway/definition-unavailable',
      'gateway/invocation-unavailable',
      'gateway/context-unavailable',
      'gateway/context-failed',
      'gateway/binding-invalid',
      'gateway/provider-mismatch',
      'gateway/peer-disposed',
    ])

    /**
     * True when a failed RemoteResult reports an assembly fault rather than a
     * business refusal.
     * @param result - one RemoteResult.
     * @returns whether the namespace is worth resolving again.
     */
    function isAssemblyFailure(result) {
      const code = typeof result?.error?.code === 'string' ? result.error.code : ''
      return ASSEMBLY_CODES.has(code)
    }

    /**
     * True when the Host refused the *page size* rather than the path. The Host
     * caps `limit` at its configured `maxLines` and answers the overrun with
     * `gateway/bad-request`; only that shape may be retried with a smaller page.
     * @param error - one Remote failure.
     * @returns whether a smaller page may be attempted.
     */
    function isLimitRefusal(error) {
      if (error === null || typeof error !== 'object') return false
      if (error.code !== 'gateway/bad-request') return false
      const message = typeof error.message === 'string' ? error.message : ''
      if (/\blimit\b/iu.test(message)) return true
      const details = error.details
      return details !== null && typeof details === 'object' && 'limit' in details
    }

    /**
     * Join one directory path and one child name the way the Host resolves them:
     * a single `/` whatever the parent's own separators.
     * @param parent - absolute path of the listed directory.
     * @param name - the child's basename.
     * @returns the child's absolute path.
     */
    function childPath(parent, name) {
      return `${String(parent).replace(/[/\\]+$/u, '')}/${name}`
    }

    /**
     * True when a path is the workspace base itself or sits inside it.
     * @param path - candidate absolute path.
     * @param root - the session's absolute workspace base.
     * @returns whether the path belongs to that workspace.
     */
    function isUnderRoot(path, root) {
      if (typeof path !== 'string' || path === '' || root === '') return false
      const base = String(root).replace(/[/\\]+$/u, '')
      return path === base || path.startsWith(`${base}/`) || path.startsWith(`${base}\\`)
    }

    /**
     * The path shown in the UI: relative to the workspace base when it is inside
     * it (the wire always carries absolute paths), unchanged otherwise.
     * @param path - absolute path.
     * @param root - the session's absolute workspace base.
     * @returns the display path, empty for the base itself.
     */
    function displayPath(path, root) {
      if (typeof path !== 'string' || path === '') return ''
      const base = String(root).replace(/[/\\]+$/u, '')
      if (base === '') return path
      if (path === base) return ''
      if (path.startsWith(`${base}/`) || path.startsWith(`${base}\\`)) return path.slice(base.length + 1)
      return path
    }

    // -- references: selection -> conversation draft -----------------------
    //
    // The whole feature is one direction only: the panel *writes* a reference
    // into the host's conversation draft. It never reads the draft back and it
    // never rewrites it (`setDraft` clears the input, which would delete what the
    // user already typed), so everything below is expressed with the two
    // insertion primitives the host's own `@` menu uses.

    /**
     * A path as the conversation should see it: relative to the workspace base
     * the tree is rooted at, with one `/` separator whatever the host's own
     * separators were.
     * @param filePath - absolute path, as the tree carries it.
     * @param root - the session's absolute workspace base.
     * @returns the workspace-relative path (empty for the base itself).
     */
    function workspaceRelativePath(filePath, root) {
      if (typeof filePath !== 'string' || filePath === '') return ''
      return displayPath(filePath, root).replace(/\\+/gu, '/').replace(/^\.\//u, '')
    }

    /**
     * The last segment of a path.
     * @param filePath - any path.
     * @returns the basename (the whole value when it holds no separator).
     */
    function fileBaseName(filePath) {
      const value = typeof filePath === 'string' ? filePath : ''
      const at = value.lastIndexOf('/')
      return at < 0 ? value : value.slice(at + 1)
    }

    /**
     * The `@` mention of one file.
     *
     * A path with whitespace is quoted (`@"src/my file.js"`), the form the host's
     * own `@` menu produces and the only form that can carry a space in a
     * plain-text pointer.
     * @param relativePath - workspace-relative path.
     * @returns the mention, empty when there is no path.
     */
    function referenceMention(relativePath) {
      if (typeof relativePath !== 'string' || relativePath === '') return ''
      return /\s/u.test(relativePath) ? `@"${relativePath}"` : `@${relativePath}`
    }

    /**
     * The reference object the host expects from `insertReference`.
     *
     * `ref`/`clipboardText` are the `@path` pointer (what actually reaches the
     * model once the host serializes the draft); `label` is only what the chip
     * shows. The line range is *not* part of the reference: it travels as the
     * plain-text tail the caller inserts after the chip.
     * @param relativePath - workspace-relative path.
     * @param startLine - 1-based first line.
     * @param endLine - 1-based last line, inclusive.
     * @returns the reference object.
     */
    function buildReferenceObject(relativePath, startLine, endLine) {
      const mention = referenceMention(relativePath)
      return {
        source: 'reference',
        ref: mention,
        label: `${fileBaseName(relativePath)} ${startLine}-${endLine}`,
        appearance: 'file',
        clipboardText: mention,
      }
    }

    /**
     * Everything one recorded selection needs in order to become a reference,
     * computed once and shared by both context-menu actions.
     *
     * `relative` (and therefore `mention`/`pointer`) comes out empty for a path
     * outside the workspace base: there is no `@` pointer for a file the
     * conversation cannot name, and the callers report that instead of inserting
     * a half reference.
     * @param record - `{ selection, path, rootPath, sessionId }`.
     * @returns `{ filePath, relative, lines, mention, pointer, reference, key }`,
     *   or null when the selection is not something a user would call code.
     */
    function describeReference(record) {
      const selection = record === null || record === undefined ? undefined : record.selection
      if (!isQuoteable(selection)) return null
      const filePath = record === null || record === undefined || typeof record.path !== 'string' ? '' : record.path
      if (filePath === '') return null
      const root = typeof record.rootPath === 'string' ? record.rootPath : ''
      const relative = workspaceRelativePath(filePath, root)
      const lines = `${selection.startLine}-${selection.endLine}`
      const mention = referenceMention(relative)
      return {
        filePath,
        relative,
        lines,
        mention,
        pointer: mention === '' ? '' : `${mention} ${lines}`,
        reference: relative === '' ? null : buildReferenceObject(relative, selection.startLine, selection.endLine),
        key: `${filePath}:${lines}`,
      }
    }

    /**
     * Where the context menu goes for one pointer event.
     *
     * The menu is `position: fixed`, so client coordinates *are* its coordinates:
     * the pointer's own `clientX`/`clientY` become its top-left corner. The clamp
     * is what keeps a right-click near the right or bottom edge from pushing the
     * menu out of the viewport - a menu you cannot reach is worse than one that
     * opens slightly up and to the left.
     * @param x - the pointer's `clientX`.
     * @param y - the pointer's `clientY`.
     * @param width - viewport width (undefined when there is no window).
     * @param height - viewport height (undefined when there is no window).
     * @returns `{ x, y }` inside the viewport, at least {@link REF_MENU_MARGIN}
     *   from every edge.
     */
    function placeRefMenu(x, y, width, height) {
      // No viewport at all (a worker, a test double): fall back to the same 1280
      // box the width resolver uses, so the clamp never yields NaN.
      const viewWidth = Number.isFinite(width) && width > 0 ? width : FALLBACK_WIDTH
      const viewHeight = Number.isFinite(height) && height > 0 ? height : FALLBACK_WIDTH
      const maxX = Math.max(REF_MENU_MARGIN, viewWidth - REF_MENU_WIDTH - REF_MENU_MARGIN)
      const maxY = Math.max(REF_MENU_MARGIN, viewHeight - REF_MENU_HEIGHT - REF_MENU_MARGIN)
      const left = Number.isFinite(x) ? x : 0
      const top = Number.isFinite(y) ? y : 0
      return {
        x: Math.min(Math.max(REF_MENU_MARGIN, left), maxX),
        y: Math.min(Math.max(REF_MENU_MARGIN, top), maxY),
      }
    }

    /**
     * The editor's own selection, read off the CodeMirror state.
     *
     * Not the DOM selection: CodeMirror keeps its own selection in `EditorState`,
     * and only that one survives a re-render, a scroll or a blur with the real
     * offsets. `doc.lineAt` converts offsets to 1-based line numbers, and the end
     * line is the line of the last **selected** character - a selection dragged
     * to the start of the next line must not quote that next line.
     * @param view - the `EditorView` (or undefined while the chunk is loading).
     * @returns `{ from, to, chars, startLine, endLine }`, or null.
     */
    function selectionFromView(view) {
      try {
        const state = view === null || view === undefined ? undefined : view.state
        const main = state === null || state === undefined ? undefined : state.selection?.main
        const doc = state === null || state === undefined ? undefined : state.doc
        if (main === null || main === undefined || typeof doc?.lineAt !== 'function') return null
        const from = typeof main.from === 'number' ? main.from : -1
        const to = typeof main.to === 'number' ? main.to : -1
        if (from < 0 || to < from) return null
        const startLine = doc.lineAt(from)?.number
        const endLine = doc.lineAt(to > from ? to - 1 : from)?.number
        if (typeof startLine !== 'number' || typeof endLine !== 'number') return null
        return { from, to, chars: to - from, startLine, endLine }
      } catch {
        return null
      }
    }

    /**
     * True when a selection is something a user would call "some code".
     * @param selection - a {@link selectionFromView} result.
     * @param minChars - shortest accepted selection.
     * @returns whether it may be quoted.
     */
    function isQuoteable(selection, minChars = REF_MIN_CHARS) {
      if (selection === null || selection === undefined) return false
      if (typeof selection.chars !== 'number' || selection.chars < minChars) return false
      if (!Number.isInteger(selection.startLine) || !Number.isInteger(selection.endLine)) return false
      return selection.startLine >= 1 && selection.endLine >= selection.startLine
    }

    /**
     * Insert one reference chip into the conversation draft, then its line range
     * as plain text.
     *
     * Both spans are taken with `captureInsertion()` **immediately before** the
     * call that consumes them: the host stamps a `draftRev` on the span and
     * silently answers `false` (it does not throw) when the draft moved in
     * between, so a stale span is retried exactly once with a fresh one. The tail
     * gets a span of its own, captured after the chip exists: `insertText`
     * *replaces* a span, it never appends.
     *
     * `insertReference` keeps the existing draft; `setDraft` would clear it, which
     * is why nothing here ever calls `setDraft`.
     * @param shell - the host's `SessionInputShell`, or undefined.
     * @param reference - a {@link buildReferenceObject} result.
     * @param tail - the plain-text line range, e.g. `' 12-15 '`.
     * @returns `'ok'`, `'stale'` (two silent refusals) or `'unavailable'`.
     */
    function insertReferenceIntoDraft(shell, reference, tail) {
      const actions = shell === null || shell === undefined ? undefined : shell.actions
      if (typeof shell?.insertReference !== 'function'
        || typeof actions?.captureInsertion !== 'function'
        || typeof actions?.insertText !== 'function') return 'unavailable'
      for (let attempt = 0; attempt < 2; attempt += 1) {
        let span
        try {
          span = actions.captureInsertion()
        } catch {
          return 'stale'
        }
        if (span === null || typeof span !== 'object') return 'stale'
        let inserted = false
        try {
          inserted = shell.insertReference(reference, span) === true
        } catch {
          return 'stale'
        }
        if (inserted !== true) continue
        try {
          const tailSpan = actions.captureInsertion()
          if (tailSpan !== null && typeof tailSpan === 'object') actions.insertText(tail, tailSpan)
        } catch {
          // The chip is already in the draft; the text tail is best effort.
        }
        return 'ok'
      }
      return 'stale'
    }

    /**
     * Put one string on the clipboard, best effort, never throwing.
     *
     * `navigator.clipboard` is the only real path (and it needs a secure
     * context); the deprecated `execCommand('copy')` is tried only when the
     * async API is missing, so a browser without it still gets the pointer.
     * @param text - the text to copy.
     * @returns whether a copy path accepted it.
     */
    function writeClipboardText(text) {
      const value = typeof text === 'string' ? text : ''
      if (value === '') return false
      try {
        const clipboard = typeof window === 'undefined' ? undefined : window.navigator?.clipboard
        if (clipboard !== null && clipboard !== undefined && typeof clipboard.writeText === 'function') {
          const pending = clipboard.writeText(value)
          if (pending !== null && typeof pending === 'object' && typeof pending.catch === 'function') pending.catch(() => {})
          return true
        }
      } catch {
        // Fall through to the DOM path.
      }
      try {
        const doc = typeof document === 'undefined' ? undefined : document
        if (doc === null || doc === undefined) return false
        const body = doc.body
        if (body === null || body === undefined || typeof doc.execCommand !== 'function') return false
        const area = doc.createElement('textarea')
        area.value = value
        area.setAttribute('readonly', '')
        area.style.position = 'fixed'
        area.style.opacity = '0'
        body.appendChild(area)
        try {
          area.select()
          return doc.execCommand('copy') === true
        } finally {
          body.removeChild(area)
        }
      } catch {
        return false
      }
    }

    /**
     * The literal prefix of every degraded-path diagnostic. The plugin posts no
     * diagnostic beacon for references (the host vocabulary is closed and no
     * existing event fits), so the console line is the observability.
     * @param args - anything worth printing.
     */
    function warnReference(...args) {
      console.warn('[dsh-ide-mode] reference', ...args)
    }

    /**
     * `path:start-end` -> the time it was last referenced. Module scope on
     * purpose: it must survive a re-render and only a successful insertion writes
     * it. Since the automatic path is gone nothing *gates* on this table any
     * more - a menu action is the user repeating themselves on purpose - but the
     * record (30 s window, 64 entries) is kept as the one place that answers
     * "was this range just quoted", and a future automatic path must not have to
     * rebuild it.
     */
    const referencedAt = new Map()
    /** Bound on {@link referencedAt}: a long session cannot grow it forever. */
    const REFERENCED_LIMIT = 64

    /**
     * Whether one range was referenced inside the dedupe window.
     * @param key - `path:start-end`.
     * @param now - the current timestamp.
     * @returns whether the range is still inside the window.
     */
    function isRecentlyReferenced(key, now) {
      const at = referencedAt.get(key)
      if (at === undefined) return false
      if (now - at >= REF_DEDUPE_MS) {
        referencedAt.delete(key)
        return false
      }
      return true
    }

    /**
     * Remember one inserted range, dropping the oldest record past the cap.
     * @param key - `path:start-end`.
     * @param now - the current timestamp.
     */
    function markReferenced(key, now) {
      referencedAt.delete(key)
      referencedAt.set(key, now)
      while (referencedAt.size > REFERENCED_LIMIT) {
        const oldest = referencedAt.keys().next()
        if (oldest.done === true) break
        referencedAt.delete(oldest.value)
      }
    }

    // -- editor chunk + save channel ---------------------------------------

    /**
     * Single-flight loader for the CodeMirror chunk.
     *
     * `require.async` already owns the hard parts - it derives
     * `/plugins/<id>/client.editor.js?rev=<rev>`, appends the `<script>`, joins a
     * concurrent load, materializes once, and drops the module on HMR - so this
     * wrapper adds exactly two things: the promise is shared, and a failure is
     * *not* cached, so the retry card can try again without a reload.
     *
     * The loader is only ever called when a file is actually opened: mounting a
     * 650 KiB chunk on first paint would cost every user of this panel who never
     * opens a file.
     * @returns {Promise<object>} the chunk's exports (`createEditor` and friends).
     */
    let editorChunkPromise
    function loadEditorChunk() {
      if (editorChunkPromise !== undefined) return editorChunkPromise
      editorChunkPromise = Promise.resolve()
        .then(() => {
          if (typeof require?.async !== 'function') throw new Error('require.async is unavailable in this host build')
          return require.async(EDITOR_CHUNK)
        })
        .then((chunk) => {
          // Once per *real* load (the promise is cached, a retry loads again):
          // "the chunk never arrived" and "the panel stayed a read-only preview"
          // are different reports, and only this event separates them.
          beacon('chunk-load-ok', { bytes: chunkTransferBytes() })
          return chunk
        })
        .catch((error) => {
          // Do not cache the failure: the retry must be able to load again.
          editorChunkPromise = undefined
          beacon('chunk-load-failed', { message: truncateText(error instanceof Error ? error.message : error, 200) })
          throw error
        })
      return editorChunkPromise
    }

    /**
     * The first newline sequence of a text: `'\r\n'`, `'\r'`, `'\n'`, or `''`
     * when the text holds none.
     *
     * CodeMirror normalizes every newline to `'\n'` inside the document, so the
     * EOL of the *read* text is the only place the original convention survives;
     * a save has to put it back or a CRLF file silently becomes LF.
     * @param text - the read text (or an empty string).
     * @returns the EOL sequence to restore on save.
     */
    function detectEol(text) {
      if (typeof text !== 'string' || text === '') return ''
      const match = /\r\n|\n|\r/u.exec(text)
      return match === null ? '' : match[0]
    }

    /**
     * One text with every newline normalized to `'\n'` - what the editor buffer
     * holds, and therefore the only form two texts may be compared in.
     * @param text - any text.
     * @returns the normalized text.
     */
    function normalizeText(text) {
      return typeof text === 'string' ? text.replace(/\r\n|[\r\n]/gu, '\n') : ''
    }

    /**
     * One buffer text with the file's own EOL restored, ready to be written.
     * @param text - the normalized buffer.
     * @param eol - the EOL `detectEol` read from that file.
     * @returns the text to send to the host.
     */
    function restoreEol(text, eol) {
      const value = typeof text === 'string' ? text : ''
      if (eol !== '\r\n' && eol !== '\r') return value
      return value.split('\n').join(eol)
    }

    /**
     * Language id for one path, by extension.
     * @param path - the file path.
     * @returns {string} a CodeMirror language id, `plaintext` when unknown.
     */
    function languageForPath(path) {
      if (typeof path !== 'string' || path === '') return PLAIN_TEXT
      const name = path.slice(path.lastIndexOf('/') + 1).replace(/\\/gu, '/')
      const dot = name.lastIndexOf('.')
      if (dot <= 0 || dot === name.length - 1) return PLAIN_TEXT
      return LANGUAGE_BY_EXTENSION[name.slice(dot + 1).toLowerCase()] ?? PLAIN_TEXT
    }

    /**
     * Whether the shell is in a dark theme, for the editor's own light/dark kit.
     *
     * Read from the host's own background token (its luminance decides), never
     * from a stored preference: the panel must follow the shell the user is
     * actually looking at. Anything unreadable falls back to the OS preference,
     * then to light - this can only mis-tint the editor, never break it.
     * @returns {'light'|'dark'} the editor theme.
     */
    function resolveEditorTheme() {
      try {
        if (typeof getComputedStyle === 'function' && typeof document !== 'undefined' && document.documentElement !== undefined) {
          const raw = getComputedStyle(document.documentElement).getPropertyValue('--dsw-alias-bg-base').trim()
          const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/iu.exec(raw)
          const rgb = /^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/iu.exec(raw)
          let channels
          if (hex !== null) {
            const digits = hex[1].length === 3 ? hex[1].split('').map((c) => c + c).join('') : hex[1]
            channels = [0, 2, 4].map((at) => Number.parseInt(digits.slice(at, at + 2), 16))
          } else if (rgb !== null) {
            channels = [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])]
          }
          if (channels !== undefined && channels.every((value) => Number.isFinite(value))) {
            const [r, g, b] = channels
            return 0.2126 * r + 0.7152 * g + 0.0722 * b < 128 ? 'dark' : 'light'
          }
        }
      } catch {
        // Fall through to the media query.
      }
      try {
        if (typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches === true) return 'dark'
      } catch {
        // Fall through to light.
      }
      return 'light'
    }

    /**
     * The absolute URL of the write endpoint.
     *
     * `WRITE_ROUTE` is document-relative, so it is resolved against the
     * document's own base URL (`document.baseURI`) instead of leaning on the
     * caller's context. The electron shell may serve the page under a different
     * prefix; the document base is what it was served from, so the resolution
     * stays correct there too. A host build with no `baseURI` keeps the relative
     * form, which is what `fetch` documented for a page-relative URL anyway.
     * @returns {string} the request URL.
     */
    function writeUrl() {
      try {
        if (typeof document !== 'undefined' && typeof document.baseURI === 'string' && document.baseURI !== '') {
          return new URL(WRITE_ROUTE, document.baseURI).href
        }
      } catch {
        // Fall through to the relative form.
      }
      return WRITE_ROUTE
    }

    /**
     * One guarded write against the host endpoint.
     *
     * Document-relative on purpose: the shell serves this page from a different
     * origin scheme than the host's listener and proxies unknown paths to it,
     * exactly like the host's own browser clients address their routes.
     * @param payload - `{ sessionId, path, content, version, force }`.
     * @param signal - the request scope's cancellation.
     * @returns `{ status, body }`, where `body` is the parsed JSON or null.
     */
    async function postWrite(payload, signal) {
      const response = await fetch(writeUrl(), {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(payload),
        signal,
      })
      let body = null
      try {
        body = await response.json()
      } catch {
        body = null
      }
      return { status: response.status, body }
    }

    // -- diagnostic beacon (fire-and-forget, never load-bearing) ------------
    //
    // One POST per interesting state transition to the host's read-only diag
    // route, which appends it to `<os.tmpdir()>/dsh-ide-mode/diag.jsonl`. This is
    // the only way a *client* can leave evidence on disk, so it must never be
    // able to change what the panel does: no `await`, no returned value, no
    // thrown error, and scalars only - a beacon never carries file content.

    /** The diag route, kept relative and resolved against `document.baseURI`. */
    const DIAG_ROUTE = 'dsh-ide-mode/diag'
    /**
     * Hard cap on beacons per page: a render loop must not become a log storm.
     * One save now costs two beacons (`save-intent` + `save-ok`/`save-failed`),
     * so the budget has to cover a long editing session, not just 60 saves.
     */
    const DIAG_MAX_EVENTS = 256
    /** One `event` + identical data is sent at most once inside this window. */
    const DIAG_DEDUPE_MS = 5000
    /** Longest data key sent (the host refuses a longer one). */
    const DIAG_MAX_KEY_CHARS = 64
    /** Longest data value sent (the host truncates at the same limit). */
    const DIAG_MAX_VALUE_CHARS = 512

    /** Beacons sent by this page. One budget per page load, not per panel. */
    let diagSent = 0
    /** `event|json` → when it was last sent, for {@link DIAG_DEDUPE_MS}. */
    const diagSeen = new Map()
    /** Whether the current activation is mounted; `ctx.effect` clears it. */
    let diagAlive = false
    /** Chat-degradation reasons already reported (those paths run every render). */
    const chatFallbackSeen = new Set()

    /**
     * Cut one diagnostic value to a bounded length.
     * @param value - anything.
     * @param max - maximum characters kept.
     * @returns the bounded string.
     */
    function truncateText(value, max) {
      const text = typeof value === 'string' ? value : String(value ?? '')
      return text.length > max ? text.slice(0, max) : text
    }

    /**
     * UTF-8 byte length of one string, so a beacon can say how much was written
     * even when the host's answer carries no size.
     * @param text - the text.
     * @returns the byte count.
     */
    function utf8Length(text) {
      const value = typeof text === 'string' ? text : ''
      try {
        if (typeof TextEncoder === 'function') return new TextEncoder().encode(value).length
      } catch {
        // Fall through to the manual count.
      }
      let bytes = 0
      for (const character of value) {
        const point = character.codePointAt(0)
        bytes += point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4
      }
      return bytes
    }

    /**
     * Lowercased extension of a path, without the dot (`''` when it has none).
     * @param path - a path in either separator style.
     * @returns the extension.
     */
    function extensionOf(path) {
      if (typeof path !== 'string' || path === '') return ''
      const name = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
      const lastDot = name.lastIndexOf('.')
      if (lastDot <= 0 || lastDot === name.length - 1) return ''
      return name.slice(lastDot + 1).toLowerCase()
    }

    /**
     * Bytes the platform attributes to the editor chunk, when it measures
     * resource loads at all.
     *
     * The loader never sees the body (`require.async` owns the `<script>`), so
     * `0` is the documented "not measurable" answer: the event still proves the
     * load succeeded, and a non-zero value proves *which* body was served.
     * @returns the decoded body size, or 0.
     */
    function chunkTransferBytes() {
      try {
        if (typeof performance === 'undefined' || typeof performance.getEntriesByType !== 'function') return 0
        for (const entry of performance.getEntriesByType('resource')) {
          const name = typeof entry?.name === 'string' ? entry.name : ''
          if (!name.includes('client.editor.js')) continue
          const size = Number(entry.decodedBodySize ?? entry.transferSize ?? 0)
          if (Number.isFinite(size) && size > 0) return Math.round(size)
        }
      } catch {
        // Resource timing is optional: a host without it reports 0.
      }
      return 0
    }

    /**
     * One diagnostic beacon: fire-and-forget, silent, bounded.
     *
     * The guard order *is* the contract. A disposed activation sends nothing
     * ({@link diagAlive}), the per-page budget is finite, only scalars fit
     * through (a `string` is cut to 512, a non-finite number or an object is
     * dropped), an identical `event` + data is coalesced for five seconds, and
     * every failure - no `document`, a `fetch` that throws synchronously, a
     * request that rejects - is swallowed, so nothing here can reach a render, a
     * click handler or a save.
     * @param event - one event of the host's fixed vocabulary.
     * @param data - optional; scalars only.
     */
    function beacon(event, data) {
      try {
        if (diagAlive !== true) return
        if (diagSent >= DIAG_MAX_EVENTS) return
        const payload = {}
        if (data !== null && typeof data === 'object') {
          for (const key of Object.keys(data)) {
            if (key === '' || key.length > DIAG_MAX_KEY_CHARS) continue
            const raw = data[key]
            if (typeof raw === 'string') payload[key] = raw.length > DIAG_MAX_VALUE_CHARS ? raw.slice(0, DIAG_MAX_VALUE_CHARS) : raw
            else if (typeof raw === 'boolean') payload[key] = raw
            else if (typeof raw === 'number' && Number.isFinite(raw)) payload[key] = raw
          }
        }
        const now = Date.now()
        const seenKey = `${event}|${JSON.stringify(payload)}`
        const last = diagSeen.get(seenKey)
        if (typeof last === 'number' && now - last < DIAG_DEDUPE_MS) return
        diagSeen.set(seenKey, now)
        // Bounded memo: a page that lives for hours cannot grow it past this.
        if (diagSeen.size > 256) {
          for (const [oldKey, seenAt] of diagSeen) {
            if (now - seenAt >= DIAG_DEDUPE_MS) diagSeen.delete(oldKey)
          }
        }
        diagSent += 1
        // Relative, exactly like {@link writeUrl} and with the same fallback: the
        // document decides which prefix this page was served under, and a build
        // without a usable `baseURI` keeps the documented page-relative form
        // instead of losing the event.
        let target = DIAG_ROUTE
        try {
          if (typeof document !== 'undefined' && typeof document.baseURI === 'string' && document.baseURI !== '') {
            target = new URL(DIAG_ROUTE, document.baseURI)
          }
        } catch {
          target = DIAG_ROUTE
        }
        fetch(target, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ event, data: payload }),
          keepalive: true,
        }).catch(() => {})
      } catch {
        // A diagnostic must never fail anything.
      }
    }

    /**
     * Report one chat-column degradation, once per page per reason.
     *
     * Those fallbacks are decided *during render*, so an unguarded beacon would
     * fire on every pass; one event per distinct cause is what a log wants, and
     * {@link beacon}'s five-second window is the second net.
     * @param reason - a stable machine reason.
     */
    function beaconChatFallback(reason) {
      try {
        if (chatFallbackSeen.has(reason)) return
        chatFallbackSeen.add(reason)
      } catch {
        return
      }
      beacon('chat-fallback', { reason })
    }

    /**
     * Drafts of files that were edited but never saved, keyed by **session and
     * absolute path** (`sessionId \u0000 path`).
     *
     * A panel unmount (the host's own "back to conversation"), a session switch
     * or a file switch removes the buffer before any confirm card could render,
     * so the draft is parked here and the next mount/view of *that file* asks
     * what to do with it. In-memory on purpose: a page unload is already guarded
     * by `beforeunload`, and a draft that outlived the page would need a conflict
     * story of its own.
     */
    const draftStore = new Map()

    /**
     * The store key of one draft.
     * @param sessionId - the session the buffer belonged to.
     * @param path - absolute path of the file.
     * @returns {string} the key.
     */
    function draftKey(sessionId, path) {
      return `${sessionId}\u0000${path}`
    }

    /**
     * Park one dirty buffer, replacing any older draft of the same file.
     * @param sessionId - the session it belongs to.
     * @param draft - `{ path, text, version }`.
     */
    function writeDraft(sessionId, draft) {
      if (typeof sessionId !== 'string' || sessionId === '') return
      if (draft === null || typeof draft !== 'object') return
      const draftPath = typeof draft.path === 'string' ? draft.path : ''
      if (draftPath === '') return
      draftStore.set(draftKey(sessionId, draftPath), {
        path: draftPath,
        text: typeof draft.text === 'string' ? draft.text : '',
        version: typeof draft.version === 'string' ? draft.version : '',
      })
    }

    /**
     * Read (without consuming) the parked draft of one file.
     * @param sessionId - the session.
     * @param path - absolute path of the file.
     * @returns the draft, or null.
     */
    function peekDraft(sessionId, path) {
      if (typeof sessionId !== 'string' || sessionId === '' || typeof path !== 'string' || path === '') return null
      return draftStore.get(draftKey(sessionId, path)) ?? null
    }

    /**
     * Forget the parked draft of one file.
     * @param sessionId - the session.
     * @param path - absolute path of the file.
     */
    function dropDraft(sessionId, path) {
      if (typeof sessionId !== 'string' || sessionId === '' || typeof path !== 'string' || path === '') return
      draftStore.delete(draftKey(sessionId, path))
    }

    // -- persistence (module-level cache: never parsed during render) ------

    /** In-memory preference store: one parse per page load, writes coalesced. */
    const prefsCache = { loaded: false, sessions: new Map() }
    /** Pending coalesced write handle. */
    let prefsFlushHandle = null

    /** Load and parse the preference blob once, tolerating absent/corrupt storage. */
    function loadPrefs() {
      if (prefsCache.loaded) return
      prefsCache.loaded = true
      try {
        const raw = window.localStorage.getItem(STORE_KEY)
        if (raw === null) return
        const parsed = JSON.parse(raw)
        const sessions = parsed === null || typeof parsed !== 'object' ? undefined : parsed.sessions
        if (sessions === null || typeof sessions !== 'object') return
        for (const [id, value] of Object.entries(sessions)) {
          if (typeof id !== 'string' || id === '' || value === null || typeof value !== 'object') continue
          prefsCache.sessions.set(id, { ...value })
        }
      } catch {
        // Corrupt JSON or blocked storage: preferences are a convenience only.
      }
    }

    /**
     * Read one session's cached preferences (no parse, no allocation on a miss).
     * @param sessionId - the session.
     * @returns the preference record.
     */
    function sessionPrefs(sessionId) {
      if (typeof sessionId !== 'string' || sessionId === '') return EMPTY_PREFS
      loadPrefs()
      return prefsCache.sessions.get(sessionId) ?? EMPTY_PREFS
    }

    /** Schedule one coalesced write of the whole preference blob. */
    function scheduleFlush() {
      if (prefsFlushHandle !== null) return
      prefsFlushHandle = setTimeout(() => {
        prefsFlushHandle = null
        flushPrefs()
      }, PERSIST_DELAY_MS)
    }

    /** Write the preference blob now (also used on teardown). */
    function flushPrefs() {
      if (prefsFlushHandle !== null) {
        clearTimeout(prefsFlushHandle)
        prefsFlushHandle = null
      }
      if (!prefsCache.loaded) return
      try {
        const sessions = {}
        for (const [id, value] of prefsCache.sessions) sessions[id] = value
        window.localStorage.setItem(STORE_KEY, JSON.stringify({ version: 1, sessions }))
      } catch {
        // Storage full or blocked: drop the write, keep the in-memory view.
      }
    }

    /**
     * Merge a patch into one session's preferences and mark that session as the
     * most recently used; the least recently used record is evicted past the cap.
     * @param sessionId - the session.
     * @param patch - fields to merge.
     */
    function patchSessionPrefs(sessionId, patch) {
      if (typeof sessionId !== 'string' || sessionId === '') return
      loadPrefs()
      const current = prefsCache.sessions.get(sessionId) ?? {}
      prefsCache.sessions.delete(sessionId)
      prefsCache.sessions.set(sessionId, { ...current, ...patch })
      while (prefsCache.sessions.size > PREF_SESSION_LIMIT) {
        const oldest = prefsCache.sessions.keys().next()
        if (oldest.done === true) break
        prefsCache.sessions.delete(oldest.value)
      }
      scheduleFlush()
    }

    /**
     * Forget one session's preferences ("Exit IDE" resets the view).
     * @param sessionId - the session.
     */
    function clearSessionPrefs(sessionId) {
      if (typeof sessionId !== 'string' || sessionId === '') return
      loadPrefs()
      if (!prefsCache.sessions.delete(sessionId)) return
      scheduleFlush()
    }

    /**
     * Resolve the third column's behaviour: the module default, overridable from
     * localStorage so a user can recover from an unexpected host mismatch
     * without reinstalling the plugin.
     * @returns 'embed' or 'none'.
     */
    function resolveChatSurface() {
      try {
        const raw = window.localStorage.getItem(CHAT_SURFACE_KEY)
        return raw === 'none' ? 'none' : 'embed'
      } catch {
        return 'embed'
      }
    }

    /**
     * Resolve the file-tree entry budget (rows, not bytes).
     * @returns a positive integer.
     */
    function resolveMaxTreeEntries() {
      try {
        const parsed = Number.parseInt(window.localStorage.getItem(MAX_ENTRIES_KEY) ?? '', 10)
        if (Number.isFinite(parsed) && parsed > 0) return parsed
      } catch {
        // Fall through to the default.
      }
      return MAX_TREE_ENTRIES_DEFAULT
    }

    // -- shared UI atoms (module level: no service access) -----------------

    /** The mode glyph (16x16, currentColor). */
    function IconFrame() {
      return h('svg', {
        viewBox: '0 0 16 16', width: 14, height: 14, 'aria-hidden': 'true', focusable: 'false',
        fill: 'none', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round',
      },
      h('rect', { x: 1.5, y: 2.5, width: 13, height: 11, rx: 2 }),
      h('path', { d: 'M6 2.5v11' }),
      h('path', { d: 'M8.6 6.4 10.6 8l-2 1.6' }))
    }

    /** Expand/collapse chevron. */
    function IconChevron() {
      return h('svg', {
        viewBox: '0 0 16 16', width: 12, height: 12, 'aria-hidden': 'true', focusable: 'false',
        fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round',
      }, h('path', { d: 'M6 3.5 10.5 8 6 12.5' }))
    }

    /** Folder / file glyph. */
    function IconKind(props) {
      if (props.dir === true) {
        return h('svg', {
          viewBox: '0 0 16 16', width: 12, height: 12, 'aria-hidden': 'true', focusable: 'false',
          fill: 'none', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round',
        }, h('path', { d: 'M1.8 12.4V4.1h4l1.4 1.7h6.9v6.6a.9.9 0 0 1-.9.9H2.7a.9.9 0 0 1-.9-.9Z' }))
      }
      return h('svg', {
        viewBox: '0 0 16 16', width: 12, height: 12, 'aria-hidden': 'true', focusable: 'false',
        fill: 'none', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round',
      }, h('path', { d: 'M4 1.8h5.2L12.9 5v9.2H4Z' }), h('path', { d: 'M9 1.8V5.2h3.9' }))
    }

    /** Refresh glyph. */
    function IconRefresh() {
      return h('svg', {
        viewBox: '0 0 16 16', width: 13, height: 13, 'aria-hidden': 'true', focusable: 'false',
        fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round',
      }, h('path', { d: 'M13 8a5 5 0 1 1-1.6-3.7' }), h('path', { d: 'M13.2 2.4v2.8h-2.8' }))
    }

    /**
     * One centered state block.
     * @param title - headline.
     * @param detail - optional explanation.
     * @returns the element.
     */
    function renderState(title, detail) {
      return h('div', { className: 'dsh-ide-state', 'data-ide-state': '1' },
        h('div', { className: 'dsh-ide-state-title' }, title),
        detail === undefined || detail === null ? null : h('div', null, detail))
    }

    /**
     * The chat column's degradation card: localized headline + hint, the raw
     * technical reason, then "retry" and "back to chat".
     * @param t - translator.
     * @param onBack - goes back to the conversation panel.
     * @param reason - technical reason text.
     * @param onRetry - optional reset of the boundary.
     * @returns the element.
     */
    function renderChatFallback(t, onBack, reason, onRetry) {
      return h('div', { className: 'dsh-ide-card', 'data-ide-fallback': 'chat' },
        h('div', { className: 'dsh-ide-card-title' }, t('chatFallbackTitle')),
        h('div', null, t('chatFallbackHint')),
        h('code', { className: 'dsh-ide-card-code' }, reason === '' ? t('chatFallbackUnknown') : reason),
        h('div', { className: 'dsh-ide-actions' },
          onRetry === undefined ? null : h('button', {
            type: 'button', className: 'dsh-ide-btn', onClick: onRetry,
          }, t('retryEmbed')),
          h('button', {
            type: 'button', className: 'dsh-ide-btn', onClick: onBack,
          }, t('backToChat'))))
    }

    /**
     * The panel-level crash card: localized title and one sentence, the raw
     * error as one copyable `<code>` line, then "retry" and "back to chat".
     *
     * Tokens only, and no background of its own: it sits on the panel's normal
     * surface as a small bordered card, never as a white sheet over the shell.
     * @param t - translator (a plain function here: the boundary is a class).
     * @param options - `{ kind, title, hint, detail, onRetry, onBack }`.
     * @returns the element.
     */
    function renderCrashCard(t, options) {
      const detail = singleLine(options.detail)
      return h('div', {
        className: 'dsh-ide-root',
        'data-ide-root': '1',
        'data-ide-crash': options.kind,
      },
      h('div', { className: 'dsh-ide-card', 'data-ide-fallback': 'panel' },
        h('div', { className: 'dsh-ide-card-title' }, options.title),
        h('div', null, options.hint),
        h('code', {
          className: 'dsh-ide-card-code',
          'data-ide-crash-detail': options.kind,
        }, detail === '' ? t('chatFallbackUnknown') : detail),
        h('div', { className: 'dsh-ide-actions' },
          h('button', {
            type: 'button',
            className: 'dsh-ide-btn',
            'data-ide-action': 'crash-retry',
            onClick: options.onRetry,
          }, t('retry')),
          h('button', {
            type: 'button',
            className: 'dsh-ide-btn',
            'data-ide-action': 'crash-back',
            onClick: options.onBack,
          }, t('backToChat')))))
    }

    /**
     * The file-tree column's own failure card: a throw while the rows were
     * flattened. The other two columns keep working, so this is a column card
     * with a single retry, not the panel-level crash card.
     * @param t - translator.
     * @param detail - one-line description.
     * @param onRetry - recompute (refresh).
     * @returns the element.
     */
    function renderTreeCrash(t, detail, onRetry) {
      const text = singleLine(detail)
      return h('div', { className: 'dsh-ide-card', 'data-ide-fallback': 'tree' },
        h('div', { className: 'dsh-ide-card-title' }, t('treeCrashTitle')),
        h('div', null, t('treeCrashHint')),
        h('code', { className: 'dsh-ide-card-code' }, text === '' ? t('chatFallbackUnknown') : text),
        h('div', { className: 'dsh-ide-actions' }, h('button', {
          type: 'button',
          className: 'dsh-ide-btn',
          'data-ide-action': 'tree-retry',
          onClick: onRetry,
        }, t('retry'))))
    }

    // -- client plugin body ------------------------------------------------

    /**
     * Client plugin factory.
     * @param ctx - client context; only `slots` is a hard dependency.
     * @returns {{ inject: string[], apply: Function }} the Cordis plugin object.
     */
    function apply(ctx) {
      // The beacon's lifetime. `diagAlive` is module-scope (one budget per page)
      // but this activation owns it: disposing the plugin - unload, HMR, profile
      // switch - clears the flag, so a late render or a queued microtask cannot
      // post into a sink that no longer describes anything on screen.
      ctx.effect(() => {
        diagAlive = true
        return () => {
          diagAlive = false
        }
      }, `${PLUGIN}: diag beacon`)

      // `layout` / `locale` are optional *probes*: each is read with `ctx.get`
      // and guarded, and a miss only degrades a feature. The file face is not a
      // probe - it is **injected** (see the block below), because reading it off
      // `ctx.get('remote')` throws in a way that no guard survives.
      /**
       * The `layout` face read once at activation. Kept as a *hint* for logs and
       * as the last-resort fallback; nothing may pin it (see {@link resolveLayout}).
       */
      const layoutFace = safeGet(ctx, 'layout')
      const localeFace = safeGet(ctx, 'locale')

      /** The last `layout` face that actually answered with `selectPanel`. */
      let cachedLayout

      /**
       * The `layout` service as it is mounted **right now**.
       *
       * Reading it once during `apply` and closing over the result is the bug
       * this exists to prevent: this client is activated with
       * `immediately: true` and injects only conversation/renderer, so it can
       * run *before* `ui-layout` mounts. The face read at activation is then
       * `undefined` forever, the enter gate never passes, and the button stays
       * grey with "layout service missing".
       *
       * So every caller asks again. A **successful** read is remembered (it
       * makes the face survive a context that has since lost the service); an
       * unsuccessful one is deliberately *not* cached, so the first click after
       * a late mount sees the service.
       * @returns the face now, or undefined when there is none to use.
       */
      const resolveLayout = () => {
        const live = safeGet(ctx, 'layout')
        if (live !== undefined && typeof live.selectPanel === 'function') {
          cachedLayout = live
          return live
        }
        if (typeof cachedLayout?.selectPanel === 'function') return cachedLayout
        return live
      }

      /** The last panel-info store that passed the shape check below. */
      let cachedPanelInfo

      /**
       * The layout face's panel-info store as it is mounted right now.
       *
       * Same late-mount rule as {@link resolveLayout}: pinning it at activation
       * would make `aria-pressed` read `false` for the life of the page even
       * after the layout service appears.
       * @returns the store, or undefined when it is absent or of the wrong shape.
       */
      const resolvePanelInfo = () => {
        const candidate = resolveLayout()?.panelInfo ?? layoutFace?.panelInfo
        if (candidate !== undefined
          && typeof candidate.getSnapshot === 'function'
          && typeof candidate.subscribe === 'function') {
          cachedPanelInfo = candidate
          return candidate
        }
        return cachedPanelInfo
      }

      // -- the file face: injected, never probed ---------------------------
      //
      // Cordis's service proxy **throws** on an undeclared property, so the old
      // `ctx.get('remote')?.workspaceFiles` answered
      // `cannot get property "remote.workspaceFiles" without inject`. That throw
      // happened during render (`IdePanel` decides its empty state from
      // `getFiles()`), the panel boundary caught it, and the whole IDE turned
      // into a crash card. The face is therefore obtained the only way Cordis
      // allows: a *declared* injection whose callback is handed a context that
      // does declare the service.
      /** The authorized `remote.workspaceFiles` face, or undefined while absent. */
      let filesFace
      /**
       * Bumped on every {@link filesFace} change. A mounted panel reads it
       * through {@link useFilesFaceEpoch}, so "the service arrived late" and
       * "the service went away" are render-visible instead of frozen at the
       * first answer.
       */
      let filesFaceEpoch = 0
      const filesFaceListeners = new Set()
      /** Announce that {@link filesFace} changed; never throws at a listener. */
      const notifyFilesFaceChanged = () => {
        filesFaceEpoch += 1
        for (const listener of [...filesFaceListeners]) {
          try {
            listener()
          } catch {
            // A listener must never break the injection that changed the face.
          }
        }
      }

      /**
       * Read the face out of the *injected* context.
       *
       * `injected` is a context that declares `remote.workspaceFiles`, so the
       * bracket read (or its own `get`) returns the live namespace. Both reads
       * stay guarded: a face caught mid-unmount must still leave the panel
       * renderable.
       * @param injected - the context handed to the inject callback.
       * @returns the namespace, or undefined.
       */
      const readInjectedFace = (injected) => {
        try {
          const direct = injected?.['remote.workspaceFiles']
          if (direct !== undefined && direct !== null) return direct
          if (typeof injected?.get !== 'function') return undefined
          return injected.get('remote.workspaceFiles') ?? undefined
        } catch {
          return undefined
        }
      }

      // The single place the face is obtained. `ctx.effect` ties the injection to
      // this activation: unloading the plugin, or the provider withdrawing the
      // service, runs the disposer - the face is dropped rather than pinned.
      ctx.effect(() => {
        const dispose = ctx.inject(['remote.workspaceFiles'], (injected) => {
          filesFace = readInjectedFace(injected)
          notifyFilesFaceChanged()
          return () => {
            filesFace = undefined
            notifyFilesFaceChanged()
          }
        })
        // Cordis answers with a disposable function and older revisions with an
        // object that carries `dispose`: accepting both means neither shape can
        // leave the injection registered past this activation.
        return () => {
          if (typeof dispose === 'function') {
            dispose()
            return
          }
          if (typeof dispose?.dispose === 'function') dispose.dispose()
        }
      }, `${PLUGIN}: files face`)

      /**
       * The host's authorized file Remote namespace, as data.
       *
       * Only {@link filesFace} is consulted: no `ctx.get('remote')`, no property
       * read on a service proxy, no cache to invalidate (the injected face *is*
       * the current one). Every step is guarded because this runs **during
       * render** - a throw here reaches the panel boundary and turns the IDE
       * into a crash card. `undefined` is a normal answer: the panel renders the
       * retryable "file service unavailable" state, not an error.
       * @returns the namespace, or undefined.
       */
      const lookupFiles = () => {
        try {
          const candidate = filesFace
          if (candidate === null || candidate === undefined) return undefined
          if (typeof candidate.list !== 'function') return undefined
          if (typeof candidate.read !== 'function') return undefined
          // Not called any more (the preview needs no precheck), but its presence
          // is part of what makes this the complete authorized face rather than a
          // partially mounted one.
          if (typeof candidate.stat !== 'function') return undefined
          return candidate
        } catch {
          return undefined
        }
      }
      /**
       * The face for one call: same render-safe, never-throwing contract as
       * {@link lookupFiles}.
       * @returns the namespace, or undefined.
       */
      const getFiles = () => lookupFiles()

      /**
       * The host's conversation *input shell* for one session - the service face
       * path a client plugin uses instead of registering a slot.
       *
       * `ctx.get('conversation')` is a probe, not a hard dependency: on a host
       * without that service (or before the conversation mounts) it is
       * `undefined`, and the reference feature then degrades to the clipboard
       * instead of turning the panel into a crash card. Resolved **per call** -
       * the conversation may mount long after this plugin activated - and every
       * step is guarded, because a service proxy can throw on a property read.
       * @param targetSessionId - the session whose draft is addressed.
       * @returns the `SessionInputShell`, or undefined.
       */
      const resolveInputShell = (targetSessionId) => {
        if (typeof targetSessionId !== 'string' || targetSessionId === '') return undefined
        try {
          const conversation = safeGet(ctx, 'conversation')
          const input = conversation === null || conversation === undefined ? undefined : conversation.input
          if (input === null || input === undefined || typeof input.shell !== 'function') return undefined
          const shell = input.shell(targetSessionId)
          if (shell === null || shell === undefined) return undefined
          if (typeof shell.insertReference !== 'function') return undefined
          if (typeof shell.actions?.captureInsertion !== 'function') return undefined
          return shell
        } catch (error) {
          warnReference('shell-unavailable', describeError(error))
          return undefined
        }
      }

      /**
       * Call one namespace method and unwrap its `RemoteResult`.
       *
       * A one-shot Remote call never rejects for a business failure - it answers
       * `{ ok: true, value }` or `{ ok: false, error }` - so a throw here is an
       * assembly fault (namespace mounted later, method not on this face, no
       * connection), and so is a result carrying one of the gateway's
       * assembly codes ({@link ASSEMBLY_CODES}). Both resolve the namespace again
       * and retry exactly once; the caller still sees the raw result and
       * classifies whatever comes back. Identity misses are not assembly faults
       * and are not retried.
       * @param method - `list` or `read`.
       * @param args - the method's arguments, session id first.
       * @param signal - the request scope's cancellation.
       * @returns the RemoteResult, or undefined when no namespace is mounted.
       */
      async function callFiles(method, args, signal) {
        const namespace = getFiles()
        if (namespace === undefined) return undefined
        try {
          const result = await namespace[method](...args)
          if (signal?.aborted !== true && isAssemblyFailure(result)) {
            const again = getFiles()
            if (again !== undefined) return await again[method](...args)
          }
          return result
        } catch (error) {
          if (signal?.aborted === true) throw error
          const retry = getFiles()
          if (retry === undefined) throw error
          return await retry[method](...args)
        }
      }

      /**
       * Read exactly one page, in the Host's documented wire shape.
       * @param sessionId - the session owning the workspace.
       * @param path - absolute path of the file.
       * @param offset - 1-based first line of the window.
       * @param limit - maximum lines in the window.
       * @param signal - the request scope's cancellation.
       * @returns the page value (`{ text, lines, eof, version, bytes, offset }`).
       */
      async function readPageAt(sessionId, path, offset, limit, signal) {
        const result = await callFiles('read', [sessionId, path, { offset, limit }, signal], signal)
        if (result !== undefined && result.ok === true) return result.value ?? {}
        throw result?.error ?? transportFailure('Remote returned no result')
      }

      /**
       * Read a file to its last line, page by page, within the editable caps.
       *
       * Why a loop: the Host's `read` is a 1-based line window (`limit` defaults
       * to 5000 and any deployment may lower it), so "read the file" is never one
       * call. The loop stops at `eof`, or as soon as the file cannot be edited
       * anyway ({@link MAX_EDITABLE_LINES} / {@link MAX_EDITABLE_BYTES}) - a
       * hundred-thousand-line file must not be shipped over the wire only to be
       * refused at the end.
       *
       * One request scope for the whole read: the 15 s budget is total, not per
       * page, and the panel's `AbortController` cancels whichever page is in
       * flight (every page call receives that `signal`, and each page's result is
       * checked against the epoch before it is used). A failed page fails the
       * whole read: the caller sees a throw and renders the existing tiered
       * error, never a half file in the editor.
       *
       * Pages are joined with `\n` in order. The Host cuts whole lines and joins
       * each page with `\n` too, so the concatenation is the file's text; a page
       * holding one empty line is `text: ''` with `lines: 1`, which is why the
       * join and every counter use `lines`, never `text === ''`.
       *
       * `version` comes from the first page: every page runs the same stat chain,
       * so the versions agree, and the first one is this buffer's CAS basis.
       * @param sessionId - the session owning the workspace.
       * @param path - absolute path of the file.
       * @param signal - the request scope's cancellation.
       * @param onProgress - called before each page with `{ page, total }`.
       * @returns `{ tooLarge, pages, page }` where `page` is the joined window.
       */
      async function readWholeFile(sessionId, path, signal, onProgress) {
        /** A read the panel withdrew: classified as the cancel tier by `toFailure`. */
        const abortedRead = () => {
          const error = new Error('read aborted')
          error.name = 'AbortError'
          return error
        }
        const parts = []
        let lines = 0
        let totalBytes = 0
        let joinedBytes = 0
        let version = ''
        let offset = 1
        let limit = PREVIEW_LINES
        let pages = 0
        let total = 0
        for (;;) {
          // Never start a page for a read nobody is waiting for any more.
          if (signal?.aborted === true) throw abortedRead()
          pages += 1
          if (onProgress !== undefined) {
            onProgress({ page: pages, total: total === 0 ? pages : Math.max(total, pages) })
          }
          let value
          try {
            value = await readPageAt(sessionId, path, offset, limit, signal)
          } catch (error) {
            // The Host caps `limit` at its configured `maxLines`: retry the same
            // page once at the documented fallback size, then keep that smaller
            // page size for the rest of the file.
            if (pages === 1 && limit !== PREVIEW_LINES_FALLBACK && isLimitRefusal(error) && signal?.aborted !== true) {
              limit = PREVIEW_LINES_FALLBACK
              value = await readPageAt(sessionId, path, offset, limit, signal)
            } else {
              throw error
            }
          }
          // The panel aborted the read while this page was in flight: stop here
          // rather than asking for the next page of a file nobody is showing.
          if (signal?.aborted === true) throw abortedRead()
          const text = typeof value?.text === 'string' ? value.text : ''
          const pageLines = typeof value?.lines === 'number' && value.lines >= 0
            ? value.lines
            : (text === '' ? 0 : text.split('\n').length)
          parts.push(text)
          lines += pageLines
          // One separator per join, exactly as `parts.join('\n')` will write it.
          joinedBytes += utf8Length(text) + (pages > 1 ? 1 : 0)
          if (version === '' && typeof value?.version === 'string') version = value.version
          const reported = typeof value?.bytes === 'number' && Number.isFinite(value.bytes) ? value.bytes : 0
          if (reported > totalBytes) totalBytes = reported
          const eof = value?.eof === true
          // The Host's own stat size is the file size, so a 3 MiB file is refused
          // after its first page instead of after eleven. `joinedBytes` is the
          // fallback for a host that reports no size (and the proof of what was
          // really read, should `bytes` ever mean something else).
          const bytes = Math.max(totalBytes, joinedBytes)
          const overCap = lines > MAX_EDITABLE_LINES || bytes > MAX_EDITABLE_BYTES
            // Exactly at the line cap with lines still behind it: over the cap
            // even though this page did not overshoot it.
            || (eof !== true && lines >= MAX_EDITABLE_LINES)
          if (overCap) {
            return {
              tooLarge: true,
              pages,
              page: { text: parts.join('\n'), lines, bytes, version, offset: 1, eof: false },
            }
          }
          if (eof === true) break
          // A page with no lines and no `eof` cannot advance the window: that is a
          // broken answer, not a file, and must not become an editor buffer.
          if (pageLines === 0) throw transportFailure('read returned an empty page without eof')
          offset += pageLines
          // Page-count estimate from the bytes-per-line seen so far, so the
          // status line can say "reading page 3 of 8" without an extra request.
          if (bytes > 0 && lines > 0 && joinedBytes > 0) {
            const bytesPerLine = joinedBytes / lines
            if (bytesPerLine > 0) total = Math.max(pages + 1, Math.ceil(bytes / bytesPerLine / limit))
          }
        }
        const bytes = Math.max(totalBytes, joinedBytes)
        return {
          tooLarge: false,
          pages,
          page: { text: parts.join('\n'), lines, bytes, version, offset: 1, eof: true },
        }
      }

      /** Resolved once per activation; a reload is the documented way to change it. */
      const chatSurface = resolveChatSurface()
      /** Resolved once per activation. */
      const maxTreeEntries = resolveMaxTreeEntries()
      /** Sessions currently in IDE mode, so leaving them can be recorded. */
      const restoreRecords = new Map()

      // Parse the preference blob once, at activation, so no render ever parses.
      loadPrefs()

      // One copyable activation line: which optional faces this build actually
      // got. A crash report pasted from the console starts here.
      console.log(`[${PLUGIN}] active`, {
        version: PLUGIN_VERSION,
        hasLayout: layoutFace !== undefined,
        hasSelectPanel: typeof layoutFace?.selectPanel === 'function',
        hasPanelInfo: resolvePanelInfo() !== undefined,
        hasLocale: localeFace !== undefined,
        hasRemoteFiles: getFiles() !== undefined,
        chatSurface,
      })

      // -- locale ---------------------------------------------------------
      ctx.effect(() => {
        const locale = localeFace
        if (locale === undefined || typeof locale.register !== 'function') return () => {}
        try {
          const off = locale.register(DICT_NS, { zh, en })
          return typeof off === 'function' ? off : () => {}
        } catch (error) {
          console.warn(`[${PLUGIN}] locale dictionary registration failed:`, error)
          return () => {}
        }
      }, `${PLUGIN}: dictionaries`)

      /**
       * Translate one key with `{name}` interpolation against one active id.
       * Only an English tag selects the English dictionary: this panel is
       * authored for a Chinese UI, so an unknown or absent locale reads Chinese
       * instead of falling back to English fragments.
       */
      const translateWith = (active, key, vars) => {
        const dictionary = String(active).toLowerCase().startsWith('en') ? en : zh
        const template = dictionary[key] ?? en[key] ?? key
        if (vars === undefined) return template
        return template.replace(/\{(\w+)\}/g, (match, name) => (vars[name] === undefined ? match : String(vars[name])))
      }

      /**
       * Locale-aware translator hook. Always calls exactly one
       * `useSyncExternalStore`, so the hook count never depends on whether the
       * locale service exists.
       */
      function useT() {
        const subscribe = useCallback((listener) => {
          try {
            const locale = localeFace
            if (locale === undefined || typeof locale.subscribe !== 'function') return () => {}
            return locale.subscribe(listener)
          } catch {
            return () => {}
          }
        }, [])
        const getSnapshot = useCallback(() => {
          try {
            const snapshot = localeFace?.getSnapshot?.()
            return typeof snapshot?.active === 'string' ? snapshot.active : ''
          } catch {
            return ''
          }
        }, [])
        const active = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
        return useCallback((key, vars) => translateWith(active, key, vars), [active])
      }

      /** Panel-selection hook: one `useSyncExternalStore` whether or not `layout` exists. */
      function useIdeActive() {
        const subscribe = useCallback((listener) => {
          try {
            const store = resolvePanelInfo()
            return store === undefined ? () => {} : store.subscribe(listener)
          } catch {
            return () => {}
          }
        }, [])
        const getSnapshot = useCallback(() => {
          try {
            const snapshot = resolvePanelInfo()?.getSnapshot?.()
            return (snapshot?.activePanelId ?? null) === PANEL_KEY
          } catch {
            return false
          }
        }, [])
        return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
      }

      /**
       * The last failed toggle, as data.
       *
       * Kept outside React (a tiny store, not component state) because the
       * one-frame retry in {@link controller.enter} can *succeed* after the click
       * already failed: the trace the button shows must then retract itself
       * without a second click. It is also what makes the failure diagnosable
       * from a screenshot - `data-ide-toggle-error` plus a line in `title`.
       */
      let toggleError = ''
      const toggleErrorListeners = new Set()
      /**
       * Record (or, with `''`, retract) the trace of the last failed toggle.
       * @param next - the one-line reason, or `''`.
       */
      const recordToggleError = (next) => {
        if (toggleError === next) return
        toggleError = next
        for (const listener of [...toggleErrorListeners]) {
          try {
            listener()
          } catch {
            // A listener must never break the click that produced the trace.
          }
        }
      }
      /** The current trace; the button subscribes so a late retry can clear it. */
      function useToggleError() {
        const subscribe = useCallback((listener) => {
          toggleErrorListeners.add(listener)
          return () => {
            toggleErrorListeners.delete(listener)
          }
        }, [])
        const getSnapshot = useCallback(() => toggleError, [])
        return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
      }

      /**
       * "The file face changed" as a reactive value.
       *
       * Exactly one `useSyncExternalStore`, and the snapshot is a monotonic
       * **number**, never an object: an object snapshot would make React believe
       * the store changed on every call and re-render forever. The number itself
       * decides nothing - a component only needs the re-render, then asks
       * {@link getFiles} again.
       * @returns the current epoch of the file face.
       */
      function useFilesFaceEpoch() {
        const subscribe = useCallback((listener) => {
          filesFaceListeners.add(listener)
          return () => {
            filesFaceListeners.delete(listener)
          }
        }, [])
        const getSnapshot = useCallback(() => filesFaceEpoch, [])
        return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
      }

      // -- mode orchestration (no right bar, no tab kinds, no sidebar) -----
      /** True when the `main` keyed slot holds our key right now. */
      const isIdeActive = () => {
        try {
          return (resolvePanelInfo()?.getSnapshot?.()?.activePanelId ?? null) === PANEL_KEY
        } catch {
          return false
        }
      }

      /**
       * Whether the `main` slot declares our panel key: `'yes'`, `'no'`, or
       * `'unknown'` when the slot service offers no way to look entries up.
       *
       * Three states on purpose. `'unknown'` is *not* `'no'`: the previous
       * revision answered `false` for every probe failure (`catch { false }`)
       * and gated the button on it, so "I cannot tell" greyed the button out
       * forever. The live host exposes both `entriesOfSlot(key)` and
       * `entries(key)`; this probes `entriesOfSlot` first (the documented one),
       * falls back to `entries`, and only then admits it does not know.
       * @param key - the panel key registered into the `main` slot.
       * @returns 'yes' | 'no' | 'unknown'.
       */
      const mainPanelRegistered = (key) => {
        const probe = (list) => {
          try {
            const entries = list()
            if (!Array.isArray(entries)) return 'unknown'
            return entries.some((entry) => (entry?.options?.key ?? entry?.key) === key) ? 'yes' : 'no'
          } catch {
            return 'unknown'
          }
        }
        const slots = ctx?.slots
        if (typeof slots?.entriesOfSlot === 'function') {
          const answer = probe(() => slots.entriesOfSlot('main'))
          if (answer !== 'unknown') return answer
        }
        if (typeof slots?.entries === 'function') {
          const answer = probe(() => slots.entries('main'))
          if (answer !== 'unknown') return answer
        }
        return 'unknown'
      }

      /**
       * The enter gate as data, for diagnostics only.
       *
       * Nothing in the UI is disabled from this any more: `selectPanel` is
       * attempted and its own throw is what decides, so a probe that cannot see
       * the registration can never leave the button dead.
       * @returns `{ layout, hasLayout, hasSelectPanel, panelRegistered, ok, detail }`.
       */
      const inspectGate = () => {
        const layout = resolveLayout()
        const hasLayout = layout !== undefined
        const hasSelectPanel = typeof layout?.selectPanel === 'function'
        const panelRegistered = mainPanelRegistered(PANEL_KEY)
        return {
          layout,
          hasLayout,
          hasSelectPanel,
          panelRegistered,
          /** `'no'` still attempts: the registration can land a frame later. */
          ok: hasSelectPanel && panelRegistered !== 'no',
          detail: `layout=${hasLayout ? 'yes' : 'missing'} selectPanel=${hasSelectPanel ? 'yes' : 'no'} panel=${panelRegistered}`,
        }
      }

      /**
       * Whether entering is possible right now. **Diagnostics only** - it feeds
       * the console line and nothing else; the button's `disabled` is decided by
       * `sessionId === ''` alone.
       */
      const canEnter = () => inspectGate().ok

      /**
       * `selectPanel(id)` with the failure returned instead of thrown, so the
       * caller can report it instead of dying inside a click handler.
       * @param layout - the face, possibly undefined.
       * @param panelId - panel to select, or null for the conversation.
       * @returns undefined on success, an Error carrying the original message.
       */
      const trySelectPanel = (layout, panelId) => {
        if (layout === undefined || typeof layout.selectPanel !== 'function') {
          return new Error('layout service unavailable (no selectPanel)')
        }
        try {
          layout.selectPanel(panelId)
          return undefined
        } catch (error) {
          return error instanceof Error ? error : new Error(String(error))
        }
      }

      /**
       * Write the "this session is in IDE mode" record, once.
       * @param sessionId - the current session, or ''.
       */
      const markEntered = (sessionId) => {
        if (typeof sessionId !== 'string' || sessionId === '') return
        restoreRecords.set(sessionId, { at: Date.now() })
        patchSessionPrefs(sessionId, { mode: 'ide' })
      }

      const controller = {
        isActive: isIdeActive,
        /**
         * Enter IDE mode: `selectPanel('ide')` and nothing else.
         *
         * The gate is evaluated here, on the click, not at render: the layout
         * service and the `main` registration may both arrive after this plugin
         * activated, and both are re-read every time. A throw is reported (one
         * warning, one `data-ide-toggle-error` trace) and, when the panel looks
         * merely late, retried once on the next animation frame.
         * @param sessionId - the current session, for the record and the preference.
         * @returns whether the mode is active afterwards.
         */
        enter(sessionId) {
          if (isIdeActive()) {
            markEntered(sessionId)
            recordToggleError('')
            beacon('enter-ok', { detail: 'already-active' })
            return true
          }
          const gate = inspectGate()
          if (!gate.hasSelectPanel) {
            const detail = `${gate.detail} reason=no-layout-service`
            recordToggleError(detail)
            beacon('enter-failed', {
              detail: truncateText(detail, 200),
              message: 'layout service unavailable (no selectPanel)',
            })
            console.warn(`[${PLUGIN}] gate`, {
              hasLayout: gate.hasLayout,
              hasSelectPanel: gate.hasSelectPanel,
              panelRegistered: gate.panelRegistered,
              detail,
            })
            return false
          }
          const failure = trySelectPanel(gate.layout, PANEL_KEY)
          if (failure !== undefined) {
            const detail = `selectPanel("${PANEL_KEY}") threw: ${failure.message} (${gate.detail})`
            recordToggleError(detail)
            beacon('enter-failed', {
              detail: truncateText(detail, 200),
              message: truncateText(failure.message, 200),
            })
            console.warn(`[${PLUGIN}] gate`, {
              hasLayout: gate.hasLayout,
              hasSelectPanel: gate.hasSelectPanel,
              panelRegistered: gate.panelRegistered,
              detail,
              error: failure,
            })
            // "Panel unknown" is the not-registered case: the entry is
            // registered from an effect, so it can land one frame after the
            // click. Retry exactly once, late, and only then give up.
            const late = gate.panelRegistered !== 'yes'
              || /regist|unknown|not found|no such|missing panel/i.test(failure.message)
            if (!late) return false
            requestAnimationFrame(() => {
              const again = trySelectPanel(resolveLayout(), PANEL_KEY)
              if (again === undefined) {
                markEntered(sessionId)
                recordToggleError('')
                beacon('enter-ok', { detail: 'retried' })
                return
              }
              beacon('enter-failed', { detail: 'retry-failed', message: truncateText(again.message, 200) })
              console.warn(`[${PLUGIN}] gate`, {
                retried: true,
                detail: `selectPanel("${PANEL_KEY}") threw again: ${again.message}`,
                error: again,
              })
            })
            return false
          }
          recordToggleError('')
          markEntered(sessionId)
          beacon('enter-ok', { detail: 'selectPanel-ok' })
          return true
        },
        /**
         * Leave IDE mode: `selectPanel(null)` and record the intent. Idempotent -
         * a second call changes nothing and never steals another panel.
         * @param sessionId - the current session.
         * @param options - `reset` also forgets this session's view preferences.
         * @returns whether the mode was active when called.
         */
        exit(sessionId, options) {
          const wasActive = isIdeActive()
          if (wasActive) {
            // Resolved now, not at activation: the face may have re-mounted.
            const failure = trySelectPanel(resolveLayout(), null)
            if (failure === undefined) recordToggleError('')
            else console.warn(`[${PLUGIN}] selectPanel(null) failed:`, failure)
          }
          if (typeof sessionId === 'string' && sessionId !== '') {
            restoreRecords.delete(sessionId)
            // Reset first, then record the intent, so "Exit IDE" still leaves
            // `mode: 'conversation'` behind instead of an empty record.
            if (options?.reset === true) clearSessionPrefs(sessionId)
            patchSessionPrefs(sessionId, { mode: 'conversation' })
          }
          return wasActive
        },
        /** Toggle for the current session. */
        toggle(sessionId) {
          if (isIdeActive()) this.exit(sessionId)
          else this.enter(sessionId)
        },
      }

      // -- Remote data access (framework-authorized; no local network entry)
      /** One request scope: timeout plus the caller's cancellation, composed. */
      function openRequestScope(outerSignal) {
        const controller = new AbortController()
        let timedOut = false
        const onOuterAbort = () => {
          controller.abort()
        }
        if (outerSignal !== undefined) {
          if (outerSignal.aborted === true) controller.abort()
          else outerSignal.addEventListener('abort', onOuterAbort, { once: true })
        }
        const timer = setTimeout(() => {
          timedOut = true
          controller.abort()
        }, REQUEST_TIMEOUT_MS)
        return {
          signal: controller.signal,
          timedOut: () => timedOut,
          dispose() {
            clearTimeout(timer)
            if (outerSignal !== undefined) outerSignal.removeEventListener('abort', onOuterAbort)
          },
        }
      }

      /**
       * Classify a failure into the tiers the UI renders differently.
       *
       * `gateway/cancelled` is the Host's own report of a request the caller
       * withdrew (window resize, panel switch, session switch), so it must read
       * as a cancellation and never as a refused request.
       *
       * `gateway/internal` is the carrier-level report the Host returns both for
       * "the carrier behind this call is offline" and for "the contribution was
       * withdrawn" (`carrierFailure` / `withdrawn`). Neither is a refusal of the
       * request, so it belongs to the transport tier; the code stays visible in
       * the details line instead of becoming the user-facing sentence.
       * @param error - the thrown value.
       * @param scope - the request scope that produced it.
       * @returns `{ tier, code }` where tier is cancel | timeout | host | gateway | transport.
       */
      function toFailure(error, scope) {
        if (scope !== undefined && scope.timedOut()) return { tier: 'timeout', code: 'timeout' }
        const code = typeof error?.code === 'string' ? error.code : ''
        const aborted = scope?.signal?.aborted === true
          || error?.name === 'AbortError'
          || error?.code === 'ABORT_ERR'
          || code === 'gateway/cancelled'
        if (aborted) return { tier: 'cancel', code: code === '' ? 'aborted' : code }
        if (code.startsWith('workspace-file/')) return { tier: 'host', code }
        // Carrier lost / contribution withdrawn: unreachable, not refused.
        if (code === 'gateway/internal') return { tier: 'transport', code }
        if (code.startsWith('gateway/')) return { tier: 'gateway', code }
        return { tier: 'transport', code: code === '' ? 'network' : code }
      }

      /**
       * Codes that are a plain, user-explainable refusal rather than a fault, so
       * they render in the notice style (with a retry) instead of the red block
       * the gateway tier uses. `outside-workspace` is the only one today.
       */
      const READABLE_CODES = new Set(['workspace-file/outside-workspace'])

      /**
       * Localized sentence for one failure (never a raw English host message).
       * @param t - translator.
       * @param failure - result of {@link toFailure}.
       * @returns the sentence, or undefined for a cancellation.
       */
      const failureText = (t, failure) => {
        if (failure === undefined || failure.tier === 'cancel') return undefined
        if (failure.tier === 'timeout') return t('errorTimeout', { n: Math.round(REQUEST_TIMEOUT_MS / 1000) })
        if (failure.tier === 'gateway') return t('errorGateway', { code: failure.code })
        if (failure.tier === 'transport') return t('errorTransport')
        switch (failure.code) {
          case 'workspace-file/not-found': return t('errorNotFound')
          case 'workspace-file/outside-workspace': return t('errorOutside')
          case 'workspace-file/too-large': return t('errorTooLarge')
          case 'workspace-file/not-regular-file': return t('errorNotFile')
          case 'workspace-file/not-directory': return t('errorNotDirectory')
          case 'workspace-file/unknown-workspace': return t('errorNoWorkspace')
          case 'workspace-file/watch-unsupported': return t('errorWatchUnsupported')
          default: return t('errorGeneric')
        }
      }

      /**
       * One failure block: localized sentence, the machine code, and a retry.
       *
       * A readable code (`workspace-file/outside-workspace`) renders in the
       * notice style: it is a normal answer - the path is not inside this
       * session's workspace - so it must not look like the red gateway block.
       * @param t - translator.
       * @param failure - result of {@link toFailure}.
       * @param onRetry - retry action.
       * @returns the element.
       */
      const renderFailure = (t, failure, onRetry) => {
        const readable = failure !== undefined && READABLE_CODES.has(failure.code)
        return h('div', {
          className: readable ? 'dsh-ide-notice' : 'dsh-ide-error',
          'data-ide-error': failure?.tier ?? 'error',
          'data-ide-readable': readable ? 'true' : undefined,
        },
        h('div', { className: 'dsh-ide-error-code' }, failureText(t, failure) ?? t('errorGeneric')),
        h('div', { className: 'dsh-ide-card-code' }, t('errorCode', { code: failure?.code ?? 'error' })),
        onRetry === undefined ? null : h('div', null, h('button', {
          type: 'button', className: 'dsh-ide-btn', onClick: onRetry,
        }, t('retry'))))
      }

      /** Fail-closed empty state for a missing file service, with a retry. */
      const renderServiceState = (t, onRetry) => h('div', {
        className: 'dsh-ide-state',
        'data-ide-state': '1',
        'data-ide-service': 'missing',
      },
      h('div', { className: 'dsh-ide-state-title' }, t('errorService')),
      h('div', null, t('errorServiceHint')),
      h('button', { type: 'button', className: 'dsh-ide-btn', onClick: onRetry }, t('retry')))

      /** Directory listing entry normalizer: keep name/type/size, drop the rest. */
      function normalizeEntries(entries) {
        const rows = []
        if (!Array.isArray(entries)) return rows
        for (const entry of entries) {
          if (entry === null || typeof entry !== 'object') continue
          const name = typeof entry.name === 'string' ? entry.name : ''
          if (name === '') continue
          rows.push({
            name,
            type: typeof entry.type === 'string' ? entry.type : 'other',
            size: typeof entry.size === 'number' ? entry.size : undefined,
          })
        }
        return rows
      }

      // -- components ------------------------------------------------------

      /**
       * Header entry: one button, no global key listener.
       *
       * `disabled` is `sessionId === ''` and nothing else. The gate is a *click*
       * decision: the layout service and the `main` registration can both
       * arrive after this plugin activated, so a button disabled from what was
       * visible during render stays dead for the whole page. When a click does
       * fail, the reason lands on the button (`data-ide-toggle-error`, plus one
       * extra `title` line) instead of in a console the user never opens.
       */
      function ToggleButton(props) {
        const t = useT()
        const active = useIdeActive()
        const failure = useToggleError()
        const sessionId = typeof props?.sessionId === 'string' ? props.sessionId : ''
        const disabled = sessionId === ''
        const tooltip = sessionId === ''
          ? t('noSession')
          : active ? t('tooltipExit') : t('tooltipEnter')
        const reason = typeof failure === 'string' ? failure : ''
        return h('button', {
          type: 'button',
          className: 'dsh-ide-btn',
          'data-ide-toggle': '1',
          // Present only after a failed click; cleared by the next success.
          'data-ide-toggle-error': reason === '' ? undefined : reason,
          'aria-pressed': active ? 'true' : 'false',
          'aria-disabled': disabled ? 'true' : undefined,
          'aria-label': t('button'),
          title: reason === '' ? tooltip : `${tooltip}\n${t('toggleErrorHint', { reason })}`,
          disabled,
          onClick: () => {
            // A disabled button cannot fire in the DOM; the guard keeps that
            // contract true for a programmatic click as well.
            if (sessionId === '') return
            // What the gate looked like on *this* click: the panel registration
            // and the layout face can both change between two clicks, so the
            // click is the only honest place to sample them.
            beacon('toggle-click', { detail: inspectGate().detail })
            controller.toggle(sessionId)
          },
        }, h(IconFrame, null), h('span', { className: 'dsh-ide-btn-label' }, t('button')))
      }

      /**
       * The inner surface of the chat column: exactly the host factory call.
       * Kept as its own component so a synchronous throw from
       * `renderFactorySlot` lands inside the boundary below.
       *
       * The call is *also* guarded here, with no boundary involved: a factory
       * that throws synchronously (a host scope that is not ready, an assembly
       * refusal, a stale face) degrades to the same card right away, which keeps
       * the failure local to one column even if the boundary above is ever
       * removed. The factory may legally return `null` (a declined render), which
       * would be a silent blank pane, so that case becomes the same card.
       * `phase`/`hero` follow the host's own rule for `conversation.content`: a
       * summary flagged `blank` is a hero surface.
       */
      function EmbeddedConversation(props) {
        if (typeof props.renderFactorySlot !== 'function') {
          beaconChatFallback('no-render-factory-slot')
          return renderChatFallback(props.t, props.onBack, props.t('chatFallbackMissing'), props.onRetry)
        }
        let rendered
        try {
          rendered = props.renderFactorySlot('conversation.content', {
            variant: 'embedded',
            phase: props.blank === true ? 'hero' : 'active',
            hero: props.blank === true,
          })
        } catch (error) {
          console.warn(`[${PLUGIN}] renderFactorySlot threw:`, error)
          beaconChatFallback('factory-threw')
          const detail = describeCrash(error)
          return renderChatFallback(props.t, props.onBack, detail === '' ? props.t('chatFallbackUnknown') : detail, props.onRetry)
        }
        if (rendered === undefined || rendered === null) {
          beaconChatFallback('factory-returned-null')
          return renderChatFallback(props.t, props.onBack, props.t('chatFallbackUnavailable'), props.onRetry)
        }
        return rendered
      }

      /** Local error boundary: a factory failure degrades to a card, never a blank pane. */
      class ChatBoundary extends React.Component {
        constructor(props) {
          super(props)
          this.state = { error: null }
          this.retry = this.retry.bind(this)
        }

        static getDerivedStateFromError(error) {
          return { error: error ?? new Error('unknown') }
        }

        componentDidCatch(error) {
          console.warn(`[${PLUGIN}] embedded conversation failed:`, error)
          beaconChatFallback('boundary-caught')
        }

        retry() {
          this.setState({ error: null })
        }

        render() {
          if (this.state.error !== null) {
            return renderChatFallback(this.props.t, this.props.onBack, describeError(this.state.error), this.retry)
          }
          return this.props.children
        }
      }

      /** Third column: the real conversation, or the localized degradation. */
      function ChatColumn(props) {
        const { t, sessionId, onBack, renderFactorySlot, blank } = props
        if (sessionId === '') {
          beaconChatFallback('no-session')
          return renderState(t('noSession'))
        }
        if (chatSurface === 'none') {
          beaconChatFallback('chat-disabled')
          return renderState(t('chatDisabledTitle'), t('chatDisabledHint'))
        }
        if (typeof renderFactorySlot !== 'function') {
          beaconChatFallback('no-render-factory-slot')
          return renderChatFallback(t, onBack, t('chatFallbackMissing'), undefined)
        }
        return h(ChatBoundary, { key: sessionId, t, onBack },
          h(EmbeddedConversation, { renderFactorySlot, blank, t, onBack }))
      }

      /**
       * One draggable divider: pointer capture + rAF, ARIA separator semantics,
       * keyboard steps, double-click and Enter reset. Pointer listeners live on
       * the element itself, so an unmount mid-drag cannot leak a window listener;
       * the cleanup effect still releases capture and cancels the pending frame.
       */
      function SplitHandle(props) {
        const { side, value, min, max, resetValue, label, hint } = props
        const [dragging, setDragging] = useState(false)
        const drag = useRef(null)
        const live = useRef({
          onChange: props.onChange,
          onCommit: props.onCommit,
          onStart: props.onStart,
          min,
          max,
          resetValue,
        })
        live.current = {
          onChange: props.onChange,
          onCommit: props.onCommit,
          onStart: props.onStart,
          min,
          max,
          resetValue,
        }

        const stopFrame = useCallback(() => {
          const state = drag.current
          if (state === null || state.frame === null) return
          cancelFrame(state.frame)
          state.frame = null
        }, [])

        const release = useCallback(() => {
          const state = drag.current
          if (state === null) return
          try {
            state.element.releasePointerCapture?.(state.pointerId)
          } catch {
            // Already released or never captured.
          }
          drag.current = null
        }, [])

        const finish = useCallback((commit) => {
          const state = drag.current
          if (state === null) return
          stopFrame()
          const latest = state.latest
          release()
          setDragging(false)
          if (commit) live.current.onCommit(latest)
        }, [release, stopFrame])

        // Unmount safety: never leave a captured pointer or a queued frame behind.
        useEffect(() => () => {
          stopFrame()
          release()
        }, [release, stopFrame])

        const onPointerDown = useCallback((event) => {
          if (event.button !== 0 || drag.current !== null) return
          event.preventDefault()
          const element = event.currentTarget
          try {
            element.setPointerCapture?.(event.pointerId)
          } catch {
            // Capture is an optimisation; the element still receives moves.
          }
          drag.current = {
            element,
            pointerId: event.pointerId,
            startX: event.clientX,
            startValue: value,
            latest: value,
            frame: null,
          }
          setDragging(true)
          live.current.onStart?.()
        }, [value])

        const onPointerMove = useCallback((event) => {
          const state = drag.current
          if (state === null || state.pointerId !== event.pointerId) return
          const delta = event.clientX - state.startX
          const raw = side === 'start' ? state.startValue + delta : state.startValue - delta
          state.latest = Math.round(raw)
          if (state.frame !== null) return
          state.frame = scheduleFrame(() => {
            const current = drag.current
            if (current === null) return
            current.frame = null
            live.current.onChange(current.latest)
          })
        }, [side])

        const onPointerUp = useCallback((event) => {
          const state = drag.current
          if (state === null || state.pointerId !== event.pointerId) return
          finish(true)
        }, [finish])

        const onPointerCancel = useCallback(() => {
          finish(false)
        }, [finish])

        const commit = useCallback((next) => {
          live.current.onCommit(clampNumber(Math.round(next), live.current.min, live.current.max))
        }, [])

        const onKeyDown = useCallback((event) => {
          const step = event.shiftKey === true ? 32 : 8
          const direction = side === 'start' ? 1 : -1
          if (event.key === 'ArrowLeft') {
            event.preventDefault()
            commit(value - step * direction)
          } else if (event.key === 'ArrowRight') {
            event.preventDefault()
            commit(value + step * direction)
          } else if (event.key === 'Home') {
            event.preventDefault()
            commit(live.current.min)
          } else if (event.key === 'End') {
            event.preventDefault()
            commit(live.current.max)
          } else if (event.key === 'Enter') {
            event.preventDefault()
            commit(live.current.resetValue)
          }
        }, [commit, side, value])

        const onDoubleClick = useCallback(() => {
          commit(live.current.resetValue)
        }, [commit])

        return h('button', {
          type: 'button',
          className: 'dsh-ide-handle',
          'data-ide-handle': side,
          'data-dragging': dragging ? 'true' : undefined,
          role: 'separator',
          'aria-orientation': 'vertical',
          'aria-valuenow': value,
          'aria-valuemin': Math.round(min),
          'aria-valuemax': Math.round(max),
          'aria-label': label,
          title: hint,
          tabIndex: 0,
          onPointerDown,
          onPointerMove,
          onPointerUp,
          onPointerCancel,
          onLostPointerCapture: onPointerCancel,
          onDoubleClick,
          onKeyDown,
        })
      }

      /**
       * Flatten the loaded directory map into visible rows under a hard budget,
       * stopping the walk as soon as the budget is reached.
       *
       * Entry rows are keyed by their absolute path, because every Remote call is
       * addressed with one (the Host refuses an empty path, so `''` is never a
       * directory key). Status rows are keyed with a NUL separator and a kind
       * prefix: a file may legally be named `x#truncated`, so a `path + '#' + kind`
       * key would collide with the real row next to it, while no file name can
       * contain `\u0000`.
       *
       * A level that is reloading or failed keeps its last good listing: the level's
       * status row (loading text, or the failure plus its retry) comes first and
       * those kept children follow, so a failed refresh never collapses the tree
       * to an empty level.
       * @param dirs - per-absolute-path load records.
       * @param rootPath - the session's absolute workspace base.
       * @param expanded - expansion flags keyed by absolute path.
       * @param budget - maximum rows to produce.
       * @param t - translator.
       * @returns `{ rows, truncated }`.
       */
      function flattenRows(dirs, rootPath, expanded, budget, t) {
        const rows = []
        let truncated = false
        /** Append one row unless the budget is spent. @returns whether it landed. */
        const push = (row) => {
          if (rows.length >= budget) {
            truncated = true
            return false
          }
          rows.push(row)
          return true
        }
        /** Status row: kind-prefixed and NUL-separated, so no file name can collide. */
        const note = (kind, path, depth, fields) => ({
          kind: 'status',
          depth,
          key: `${kind}\u0000${path}`,
          ...fields,
        })
        /** One level's children (its last good listing), recursively. */
        const emitEntries = (path, node, depth) => {
          for (const entry of node.entries) {
            if (truncated) return
            const entryPath = childPath(path, entry.name)
            const isDirectory = entry.type === 'directory'
            if (!push({
              kind: 'entry',
              depth,
              key: entryPath,
              name: entry.name,
              path: entryPath,
              type: entry.type,
              isDirectory,
            })) return
            if (!isDirectory || expanded[entryPath] !== true) continue
            emitLevel(entryPath, depth + 1)
          }
          if (node.truncated === true) push(note('truncated', path, depth, { text: t('truncatedDir') }))
        }
        /** One directory: its own status row (when it has one), then its children. */
        const emitLevel = (path, depth) => {
          const node = dirs[path]
          if (node === undefined || truncated) return
          if (node.status === 'error') {
            push(note('error', path, depth, {
              text: failureText(t, node.failure) ?? t('errorGeneric'),
              error: true,
              retryPath: path,
            }))
          } else if (node.status === 'loading') {
            push(note('loading', path, depth, { text: t('loading') }))
          }
          emitEntries(path, node, depth)
        }
        emitLevel(rootPath, 0)
        return { rows, truncated }
      }

      /**
       * {@link flattenRows} behind a `try`/`catch`, plus the "not measured yet"
       * short circuit.
       *
       * Flattening walks data that comes off the wire: a malformed level, a
       * record replaced mid-walk or a hostile getter would throw during render,
       * where the only remaining net is the panel boundary - i.e. a whole-panel
       * card, or (before this boundary existed) a blank page. A throw here is
       * instead the tree column's own card, with the other two columns intact.
       * @param dirs - per-absolute-path load records.
       * @param rootPath - the session's absolute workspace base.
       * @param expanded - expansion flags keyed by absolute path.
       * @param budget - maximum rows to produce.
       * @param t - translator.
       * @param enabled - false on the first frame (the panel is not measured).
       * @returns `{ rows, truncated, crash }` where `crash` is a one-line description.
       */
      function safeFlattenRows(dirs, rootPath, expanded, budget, t, enabled) {
        if (enabled !== true) return EMPTY_ROWS
        try {
          const result = flattenRows(
            dirs !== null && typeof dirs === 'object' ? dirs : {},
            rootPath,
            expanded !== null && typeof expanded === 'object' ? expanded : {},
            budget,
            t,
          )
          return { rows: result.rows, truncated: result.truncated === true, crash: '' }
        } catch (error) {
          console.warn(`[${PLUGIN}] file tree rows failed:`, error)
          return { rows: EMPTY_ROWS.rows, truncated: false, crash: describeCrash(error) }
        }
      }

      // -- the editable code surface ----------------------------------------

      /**
       * The code column's editor: CodeMirror 6, loaded on first use.
       *
       * Three states, and the last one is a card plus the *original* read-only
       * rendering, never a blank column:
       *
       * - `loading` - the chunk is in flight (one shared promise, see
       *   {@link loadEditorChunk}); the host element is already in the DOM so the
       *   editor can be built into it the moment the promise settles.
       * - `ready` - a mounted `EditorView`. Switching files calls `setValue` on
       *   this same instance instead of tearing the panel down and rebuilding it:
       *   the panel is inside the shell's `main` slot, and remounting it would
       *   drop every other column's state with it.
       * - `failed` - the chunk could not be loaded (offline, a stale `?rev=`, a
       *   build without the file). The panel stays usable, the file stays
       *   readable, and a retry re-runs the same single-flight loader.
       *
       * `docToken` is what marks "this is a *new* document". It is derived from
       * the file's identity (`path`, the read `version`, the file's own EOL), not
       * from the whole `file` state object, so a re-read that changes nothing the
       * editor shows cannot swap the document. The comparison itself is
       * newline-normalized, because CodeMirror reports `'\n'` for every EOL and a
       * naive `getValue() !== doc` would reset the cursor and the undo history of
       * a CRLF file on every read.
       *
       * The text the user is typing is never fed back down, so a keystroke can
       * never reset the cursor or the undo history.
       */
      function CodeEditor(props) {
        const { t, doc, docToken, language, editable, fallback } = props
        const hostRef = useRef(null)
        const apiRef = useRef(null)
        // Latest callbacks without re-creating the view on every render.
        const live = useRef({ onChange: props.onChange, onSave: props.onSave, onSelection: props.onSelection })
        live.current = { onChange: props.onChange, onSave: props.onSave, onSelection: props.onSelection }
        const [phase, setPhase] = useState('loading')
        const [detail, setDetail] = useState('')
        const [attempt, setAttempt] = useState(0)

        useEffect(() => {
          let cancelled = false
          setPhase('loading')
          setDetail('')
          loadEditorChunk().then((chunk) => {
            if (cancelled) return
            const parent = hostRef.current
            if (parent === null || parent === undefined) {
              setPhase('failed')
              setDetail('editor host element is not mounted')
              return
            }
            try {
              apiRef.current = chunk.createEditor({
                parent,
                doc: normalizeText(typeof doc === 'string' ? doc : ''),
                language,
                readOnly: editable !== true,
                theme: resolveEditorTheme(),
                onChange: (value) => {
                  const callbacks = live.current
                  if (typeof callbacks.onChange === 'function') callbacks.onChange(value)
                },
                onSave: () => {
                  const callbacks = live.current
                  if (typeof callbacks.onSave === 'function') callbacks.onSave()
                },
                /**
                 * The selection sink.
                 *
                 * The chunk's `createEditor` installs exactly one
                 * `EditorView.updateListener` and calls this option from it on
                 * `selectionSet` **and** `docChanged`, handing over the cursor
                 * summary. The panel never listens to the DOM's `selectionchange`:
                 * that event is not per-editor, fires on blur and during scrolling,
                 * and carries no document offsets. The exact range comes from the
                 * same view's `state.selection.main` (see `selectionFromView`), and
                 * `apiRef` is read at call time because this callback can only fire
                 * after `createEditor` returned.
                 */
                onCursor: () => {
                  const callbacks = live.current
                  if (typeof callbacks.onSelection !== 'function') return
                  callbacks.onSelection(selectionFromView(apiRef.current?.view))
                },
              })
              setPhase('ready')
            } catch (error) {
              console.error(`[${PLUGIN}] editor mount failed:`, error)
              setPhase('failed')
              setDetail(describeError(error))
            }
          }).catch((error) => {
            if (cancelled) return
            console.warn(`[${PLUGIN}] editor chunk failed to load:`, error)
            setPhase('failed')
            setDetail(describeError(error))
          })
          return () => {
            // The view owns DOM inside this element: destroying it here is what
            // keeps a panel unmount (or a retry) from leaking a second editor.
            cancelled = true
            const api = apiRef.current
            apiRef.current = null
            if (api !== null) {
              try {
                api.destroy()
              } catch {
                // Already gone.
              }
            }
          }
          // Deliberately keyed on `attempt` only: `doc`/`language`/`editable` are
          // read off the freshest render closure when the effect runs, and must
          // not re-create the view afterwards - that is what the two effects
          // below are for.
        }, [attempt])

        // A new document (another file, or the same file re-read). The token only
        // changes for a *different* document, and the comparison is
        // newline-normalized, so a CRLF file is not re-set (cursor/undo reset) by
        // every read and a dirty buffer is not replaced by the disk text.
        useEffect(() => {
          const api = apiRef.current
          if (api === null) return
          const next = normalizeText(typeof doc === 'string' ? doc : '')
          if (normalizeText(api.getValue()) !== next) api.setValue(next)
        }, [docToken])

        // Language / permission changes reconfigure in place (Compartment).
        useEffect(() => {
          const api = apiRef.current
          if (api === null) return
          api.setLanguage(language)
          api.setReadOnly(editable !== true)
        }, [editable, language])

        if (phase === 'failed') {
          // The preview is a factory: see `renderPreview` - a fallback that is
          // never shown must cost nothing on a large file.
          const fallbackNode = typeof fallback === 'function' ? fallback() : fallback
          return h(Fragment, null,
            h('div', { className: 'dsh-ide-card', 'data-ide-editor': 'failed' },
              h('div', { className: 'dsh-ide-card-title' }, t('editorFailedTitle')),
              h('div', null, t('editorFailedHint')),
              detail === '' ? null : h('code', { className: 'dsh-ide-card-code' }, detail),
              h('div', { className: 'dsh-ide-actions' }, h('button', {
                type: 'button',
                className: 'dsh-ide-btn',
                'data-ide-action': 'editor-retry',
                onClick: () => setAttempt((value) => value + 1),
              }, t('editorRetry')))),
            fallbackNode)
        }
        return h('div', { className: 'dsh-ide-editor', 'data-ide-editor': phase, ref: hostRef },
          phase === 'loading' ? h('div', { className: 'dsh-ide-note' }, t('editorLoading')) : null)
      }

      /**
       * Where a save was asked for, as the `save-intent` beacon reports it.
       *
       * The field exists because two saves that look identical on disk are not
       * identical in the log: "the user pressed Ctrl+S with the caret in the
       * conversation" and "the editor's own keymap fired" used to behave
       * differently - only the second one ever ran - and nothing in the earlier
       * vocabulary could tell them apart. The answer is read off the DOM that
       * received the keystroke, never off component state: state says what the
       * panel thinks, focus says what the user was looking at.
       *
       * `closest` is the only DOM call, and its absence (a test double, a
       * detached node, a host without a DOM) reads as `other` instead of
       * throwing inside a key handler.
       * @param target - the event target, or an element such as
       *   `document.activeElement`.
       * @returns `'editor' | 'chat' | 'tree' | 'other'`.
       */
      function focusKindOf(target) {
        const closest = target !== null && typeof target === 'object' && typeof target.closest === 'function'
          ? (selector) => {
            try {
              return target.closest(selector)
            } catch {
              return null
            }
          }
          : undefined
        if (closest === undefined) return 'other'
        const inside = (selector) => {
          const node = closest(selector)
          return node !== null && node !== undefined
        }
        // The editor first: it lives inside the code column, so a broader
        // selector must never mask the one case where a second handler (the
        // editor's `Mod-s` keymap) may already own the keystroke.
        if (inside('[data-ide-editor]')) return 'editor'
        if (inside('[data-ide-col="chat"]')) return 'chat'
        if (inside('[data-ide-col="tree"]')) return 'tree'
        return 'other'
      }

      /** The IDE surface, registered as `main` / key `ide` (inside the boundary). */
      function IdePanel(props) {
        const t = useT()
        // Standard slot props: existence *and* type are checked, and each check
        // falls back to a hook that still calls `useSyncExternalStore` exactly
        // once. So the hook count of this component is identical whether or not
        // the renderer supplied the prop - a conditional hook here would swap
        // `useAbsentSessions` in and out between renders and change the count,
        // which React treats as a fatal render error.
        const useSessionsBound = typeof props?.useSessions === 'function' ? props.useSessions : useAbsentSessions
        const usePanelInfoBound = typeof props?.usePanelInfo === 'function' ? props.usePanelInfo : useAbsentPanelInfo
        const currentSessionId = useSessionsBound(selectMainSessionId)
        const currentSessionTitle = useSessionsBound(selectMainSessionTitle)
        const currentSessionCwd = useSessionsBound(selectMainSessionCwd)
        const currentSessionBlank = useSessionsBound(selectMainSessionBlank)
        // Same one-hook rule; the value is diagnostic (it names the active panel
        // on the root element) and never decides a branch, so a renderer whose
        // `usePanelInfo` has a different shape can only make it read `false`.
        const panelActive = usePanelInfoBound(selectIdePanelActive) === true
        const sessionId = typeof currentSessionId === 'string' ? currentSessionId : ''
        const sessionTitle = typeof currentSessionTitle === 'string' && currentSessionTitle !== ''
          ? currentSessionTitle
          : t('titleFallback')
        const renderFactorySlot = typeof props?.renderFactorySlot === 'function' ? props.renderFactorySlot : undefined
        // The absolute workspace base every Remote call is addressed with. The
        // Host refuses an empty path, so a session without a cwd has no file
        // tree at all - it gets the "no workspace" state instead of a request
        // that can only fail.
        const rootPath = typeof currentSessionCwd === 'string' ? currentSessionCwd : ''

        // Resolved on every render - the injected face may mount after this
        // plugin activates - and re-resolved whenever it changes, because
        // `useFilesFaceEpoch` subscribes to the injection. The snapshot returned
        // here is a number and is deliberately unused: the re-render is the
        // whole point, and `getFiles()` below is the answer.
        useFilesFaceEpoch()
        const filesAvailable = getFiles() !== undefined

        const rootRef = useRef(null)
        const containerWidth = useElementWidth(rootRef)
        const measured = containerWidth > 0
        /**
         * One `panel-mounted` beacon per mount, sent as soon as the panel has a
         * measured width.
         *
         * `width` is the whole point of the event: a panel that mounts into a
         * 0-px column shows its columns but no file, and no other evidence says
         * so. The measurement lands one frame after the first paint, hence the
         * `containerWidth > 0` gate (the panel falls back to the viewport width
         * when it cannot be measured at all, so this fires in practice).
         * `halted` is false by construction: the boundary renders its card
         * instead of this component, so a *mounted* panel was never halted.
         */
        const panelBeaconRef = useRef(false)
        useEffect(() => {
          if (panelBeaconRef.current) return
          if (containerWidth <= 0) return
          panelBeaconRef.current = true
          beacon('panel-mounted', {
            width: Math.round(containerWidth),
            hasUseSessions: typeof props?.useSessions === 'function',
            hasRenderFactorySlot: typeof props?.renderFactorySlot === 'function',
            halted: false,
          })
        }, [containerWidth, props?.renderFactorySlot, props?.useSessions])
        const initialPrefs = sessionPrefs(sessionId)
        const [prefWidths, setPrefWidths] = useState(() => ({
          tree: typeof initialPrefs.treeWidth === 'number' ? initialPrefs.treeWidth : TREE_DEFAULT,
          chat: typeof initialPrefs.chatWidth === 'number' ? initialPrefs.chatWidth : CHAT_DEFAULT,
        }))
        const [dragWidth, setDragWidth] = useState({ tree: null, chat: null })
        // Never throws: a failed division must not reach React, because React
        // unmounts the whole root for an uncaught render error.
        const layout = resolveWidthsSafe(containerWidth, dragWidth.tree ?? prefWidths.tree, dragWidth.chat ?? prefWidths.chat)
        const dragging = dragWidth.tree !== null || dragWidth.chat !== null

        const [dirs, setDirs] = useState({})
        const [expanded, setExpanded] = useState({})
        const [activePath, setActivePath] = useState(() => (typeof initialPrefs.activePath === 'string' ? initialPrefs.activePath : ''))
        const [activeKind, setActiveKind] = useState(undefined)
        const [file, setFile] = useState({ status: 'idle' })
        /**
         * Pages read so far vs the estimate, while a read is in flight; `null`
         * when nothing is being read. Kept apart from `file` on purpose: a
         * switch keeps the previous document mounted while the next one loads,
         * and the status line still has to report the read in progress.
         */
        const [readProgress, setReadProgress] = useState(null)
        /** Reload of the tree only; a plain refresh reuses every loaded level. */
        const [reloadToken, setReloadToken] = useState(0)
        /**
         * Reload of the *open file* only (conflict "reload", draft adoption, an
         * explicit refresh). Kept apart from {@link reloadToken} so bumping one
         * never forces the other: the tree's refresh token must not turn into a
         * document swap.
         */
        const [fileReloadToken, setFileReloadToken] = useState(0)
        /**
         * The editing slice of the open file: the CAS `version` this buffer was
         * read at, whether it differs from the disk, and the save phase
         * (`idle` | `saving` | `saved` | `error` | `conflict`).
         */
        const [edit, setEdit] = useState({ path: '', version: '', dirty: false, phase: 'idle', detail: '' })
        /** The live buffer text. Never a render input: a keystroke must not re-render. */
        const draftRef = useRef('')
        /**
         * The pending confirm, or null: `{ kind: 'switch' | 'exit', path?,
         * entryType?, restore? }`, where `restore` carries the parked draft a
         * draft-restore was asked to adopt.
         */
        const [pending, setPending] = useState(null)
        /**
         * Repaint trigger for the module-level draft store, which is not
         * reactive: parking or dropping a draft bumps it so the card appears or
         * disappears in this mount.
         */
        const [draftEpoch, setDraftEpoch] = useState(0)
        /**
         * The document the editor should hold, decided **once per adopted read**:
         * `key` changes then and only then. That is what keeps a plain refresh
         * (or a re-read of a CRLF file) from re-setting an identical document -
         * which would reset the cursor and the undo history - while still letting
         * a real adoption (another file, a reload, a restored draft) replace the
         * text.
         */
        const [docView, setDocView] = useState({ key: 0, path: '', text: '' })
        /** The draft the user chose to restore; its text replaces the read text. */
        const [restored, setRestored] = useState(null)

        /** Epoch bumped on every session switch / refresh: stale listings are dropped. */
        const epochRef = useRef(0)
        /** Epoch bumped on every file switch / refresh: a stale page never lands. */
        const fileEpochRef = useRef(0)
        /** Every request controller currently in flight, for teardown. */
        const controllersRef = useRef(new Set())
        /**
         * The buffer's baseline: the session and path it belongs to, the
         * newline-normalized disk text it was read at, the CAS `version` of that
         * read, and the file's own EOL. A ref because a keystroke must never
         * re-render, and because the save path has to compare against exactly
         * what the buffer was based on.
         */
        const bufferRef = useRef({ session: '', path: '', base: '', version: '', eol: '' })
        /**
         * Identity of the current buffer. Bumped only when a *different* file is
         * adopted (or a session switch resets the panel), never by a plain
         * refresh/re-read, so a save response can be tied to the buffer it was
         * taken from.
         */
        const bufferGenRef = useRef(0)
        /** The live editing slice, readable from effects with an empty dep list. */
        const editRef = useRef({ path: '', version: '', dirty: false, phase: 'idle', detail: '' })
        editRef.current = edit
        /** The live active path, readable from async continuations. */
        const activePathRef = useRef(activePath)
        activePathRef.current = activePath

        // -- editor context menu -> conversation reference -------------------
        //
        // There is exactly one entry point: the editor's own context menu. A
        // selection never inserts anything by itself - the panel offers, the
        // user picks. Everything below is deliberately *outside* the render
        // path: the insertion API runs from a menu action (a click handler or
        // the menu's Enter key), never while rendering, and never from an
        // effect that depends on the draft. Nothing here reads or writes the
        // draft, so there is no update loop to form.

        /**
         * The open menu, or null: `{ x, y, record, canQuote }`. `record` is a
         * snapshot taken when the menu opened, so a later selection change (or
         * the blur caused by clicking the menu itself) cannot swap the range
         * under an already-open menu.
         */
        const [refMenu, setRefMenu] = useState(null)
        /** Whether a menu is open - a plain boolean keeps the dismiss deps simple. */
        const refMenuOpen = refMenu !== null
        /** Which menu row holds focus: 0 insert, 1 copy, 2 cancel. */
        const [refMenuIndex, setRefMenuIndex] = useState(0)
        /** The 1.5 s hint line ("已引用 3-5 行" / "已复制引用…"); `''` hides it. */
        const [refHint, setRefHint] = useState('')
        /** The hint's own timeout. */
        const refHintTimerRef = useRef(null)
        /** The last selection the editor reported (collapsed ones included). */
        const refSelectionRef = useRef(null)
        /** False once this mount is gone: a queued action must not insert. */
        const refAliveRef = useRef(true)
        /**
         * Whether the missing-shell warning was already printed for this mount.
         * The degraded path still copies and still shows the hint, but a user who
         * right-clicks all afternoon must not turn one absent service into a log
         * storm.
         */
        const refShellWarnedRef = useRef(false)
        /** The menu element, so a pointer on the menu itself is not "outside". */
        const refMenuRef = useRef(null)
        /** The three rows, for roving focus (a browser hands over real nodes). */
        const refMenuInsertRef = useRef(null)
        const refMenuCopyRef = useRef(null)
        const refMenuCancelRef = useRef(null)
        /** Everything a menu action needs, refreshed on every render. */
        const refPipeRef = useRef({})
        refPipeRef.current = { sessionId, activePath, rootPath, t }

        /**
         * Show one short hint in the code column's header, replacing any hint
         * still on screen, and clear it after {@link REF_HINT_MS}.
         *
         * Only the two menu actions call this: with no automatic path left, a
         * selection on its own changes nothing on screen.
         * @param text - the line to show.
         */
        const showRefHint = useCallback((text) => {
          if (refHintTimerRef.current !== null) {
            clearTimeout(refHintTimerRef.current)
            refHintTimerRef.current = null
          }
          setRefHint(text)
          refHintTimerRef.current = setTimeout(() => {
            refHintTimerRef.current = null
            if (refAliveRef.current !== true) return
            setRefHint('')
          }, REF_HINT_MS)
        }, [])

        /**
         * Insert one reference for one quoted range into the conversation draft.
         *
         * Runs only from the menu's insert row. The file identity (absolute
         * path, workspace base, session) travels **with** the selection: the
         * record the menu carries was taken when it opened, so a file switch
         * either closed the menu or left the record pointing at the file the
         * selection came from - never at the new file with the old line numbers.
         *
         * When the host's conversation input shell is missing (no conversation
         * mounted, no service) or either insertion primitive is absent, the
         * pointer is copied to the clipboard instead and the panel says so - no
         * throw, no card, no console error, and the panel keeps rendering.
         * @param record - `{ selection, path, rootPath, sessionId }`.
         */
        const applyReference = useCallback((record) => {
          if (refAliveRef.current !== true) return
          const state = refPipeRef.current
          const described = describeReference(record)
          if (described === null) return
          if (described.relative === '' || described.reference === null) {
            warnReference('no-workspace-relative-path', described.filePath)
            return
          }
          // The shell is resolved per call, from the session the selection belongs
          // to: the conversation may mount late, and the draft being addressed must
          // be the one the excerpt came from.
          const shell = resolveInputShell(record.sessionId)
          const outcome = insertReferenceIntoDraft(shell, described.reference, ` ${described.lines} `)
          if (outcome === 'ok') {
            // Still recorded in the 30 s table. Nothing gates on it any more (a
            // menu action is the user repeating themselves on purpose), but it
            // stays the one place that answers "was this range just quoted".
            markReferenced(described.key, Date.now())
            showRefHint(state.t('refInserted', { lines: described.lines }))
            return
          }
          if (outcome === 'unavailable') {
            if (refShellWarnedRef.current !== true) {
              refShellWarnedRef.current = true
              warnReference('input-shell-unavailable', described.key)
            }
          } else {
            warnReference('insert-reference-refused', described.key)
          }
          // Degraded path: the same pointer is still useful as plain text.
          if (writeClipboardText(described.pointer)) {
            showRefHint(state.t('refCopied'))
            return
          }
          warnReference('clipboard-write-failed', described.key)
        }, [showRefHint])

        /**
         * Put `@path 起-止` on the clipboard without touching the draft.
         *
         * "复制引用" is the answer for a user who wants the pointer somewhere
         * else (another conversation, a terminal, a note); it needs no
         * conversation shell at all, only a selection.
         * @param record - `{ selection, path, rootPath, sessionId }`.
         */
        const copyReference = useCallback((record) => {
          if (refAliveRef.current !== true) return
          const state = refPipeRef.current
          const described = describeReference(record)
          if (described === null) return
          if (described.pointer === '') {
            warnReference('no-workspace-relative-path', described.filePath)
            return
          }
          if (writeClipboardText(described.pointer)) {
            showRefHint(state.t('refCopied'))
            return
          }
          warnReference('clipboard-write-failed', described.key)
        }, [showRefHint])

        /** Close the menu. Idempotent: the state is the only source of truth. */
        const closeRefMenu = useCallback(() => {
          setRefMenu(null)
        }, [])

        /**
         * Run one menu row.
         *
         * The menu closes first: a chosen row is a decision, and even the
         * degraded path (a copy plus a hint) is a result, not a reason to keep a
         * floating overlay on screen.
         * @param index - 0 insert, 1 copy, 2 cancel.
         */
        const activateRefMenuRow = useCallback((index) => {
          const menu = refMenu
          closeRefMenu()
          if (menu === null || menu.canQuote !== true) return
          if (index === 0) applyReference(menu.record)
          else if (index === 1) copyReference(menu.record)
        }, [applyReference, closeRefMenu, copyReference, refMenu])

        /**
         * The editor's `contextmenu` handler: open our menu at the pointer.
         *
         * Shift + right click is deliberately **not** intercepted. The browser's
         * own menu is the only place Cut/Copy/Paste live - this plugin does not
         * reimplement clipboard editing - so the modifier must keep reaching it.
         * @param event - the DOM `contextmenu` event.
         */
        const openEditorMenu = useCallback((event) => {
          if (event === null || typeof event !== 'object') return
          if (event.shiftKey === true) return
          if (typeof event.preventDefault === 'function') event.preventDefault()
          if (typeof event.stopPropagation === 'function') event.stopPropagation()
          if (refAliveRef.current !== true) return
          const record = refSelectionRef.current
          // A selection from another file (this handler may predate the switch
          // effect that closes the menu) must never be quoted as this file's.
          const canQuote = record !== null && record !== undefined
            && record.path !== ''
            && record.path === activePathRef.current
            && isQuoteable(record.selection)
          const viewport = typeof window === 'undefined' ? undefined : window
          const point = placeRefMenu(
            typeof event.clientX === 'number' ? event.clientX : 0,
            typeof event.clientY === 'number' ? event.clientY : 0,
            viewport === null || viewport === undefined ? undefined : viewport.innerWidth,
            viewport === null || viewport === undefined ? undefined : viewport.innerHeight,
          )
          setRefMenu({ x: point.x, y: point.y, record, canQuote })
          // The first *enabled* row takes focus; with no selection that is the
          // cancel row, because both quote rows are disabled.
          setRefMenuIndex(canQuote === true ? 0 : 2)
        }, [])

        /**
         * The editor reported a selection change.
         *
         * Fires from the chunk's `EditorView.updateListener` (on `selectionSet`
         * and `docChanged`), never from a DOM event. This is the menu's source
         * of truth for "what is selected right now": the record also carries the
         * file and the session the selection belongs to. Nothing is inserted
         * here - a selection is never an action on its own.
         * @param selection - a {@link selectionFromView} result (may be null).
         */
        const onEditorSelection = useCallback((selection) => {
          const state = refPipeRef.current
          refSelectionRef.current = {
            selection: selection === undefined ? null : selection,
            path: state.activePath,
            rootPath: state.rootPath,
            sessionId: state.sessionId,
          }
        }, [])

        // Teardown: no hint timer of this mount may fire into a gone panel, and
        // the last selection is dropped so a late callback has nothing to quote.
        // The menu's own listeners are removed by the effect below.
        useEffect(() => () => {
          refAliveRef.current = false
          if (refHintTimerRef.current !== null) {
            clearTimeout(refHintTimerRef.current)
            refHintTimerRef.current = null
          }
          refSelectionRef.current = null
          refMenuRef.current = null
        }, [])

        /**
         * The menu's dismissal contract: the first click anywhere outside it, an
         * Escape, a scroll, a blur, a resize, a file switch or the unmount closes
         * it.
         *
         * Registered only while a menu is open and removed on every close - an
         * effect that merely flipped a flag would leave one document handler
         * behind per opening, for the rest of the session.
         */
        useEffect(() => {
          if (refMenuOpen !== true) return undefined
          const doc = typeof document === 'undefined' ? undefined : document
          const win = typeof window === 'undefined' ? undefined : window
          const close = () => {
            setRefMenu(null)
          }
          const onPointerDown = (event) => {
            const menu = refMenuRef.current
            const target = event === null || event === undefined ? undefined : event.target
            // A click on the menu itself is the menu's own business; every other
            // target (the editor, the tree, the page around the panel) dismisses.
            if (menu !== null && menu !== undefined && typeof menu.contains === 'function'
              && target !== null && target !== undefined && menu.contains(target)) return
            close()
          }
          const onKeyDown = (event) => {
            if (event === null || event === undefined || event.key !== 'Escape') return
            if (typeof event.preventDefault === 'function') event.preventDefault()
            if (typeof event.stopPropagation === 'function') event.stopPropagation()
            close()
          }
          const onDismiss = () => {
            close()
          }
          if (doc !== undefined && doc !== null) {
            doc.addEventListener('pointerdown', onPointerDown, true)
            doc.addEventListener('keydown', onKeyDown, true)
          }
          if (win !== undefined && win !== null) {
            win.addEventListener('scroll', onDismiss, true)
            win.addEventListener('blur', onDismiss)
            win.addEventListener('resize', onDismiss)
          }
          return () => {
            if (doc !== undefined && doc !== null) {
              doc.removeEventListener('pointerdown', onPointerDown, true)
              doc.removeEventListener('keydown', onKeyDown, true)
            }
            if (win !== undefined && win !== null) {
              win.removeEventListener('scroll', onDismiss, true)
              win.removeEventListener('blur', onDismiss)
              win.removeEventListener('resize', onDismiss)
            }
          }
        }, [refMenuOpen])

        /**
         * Second look at the placement, once the menu exists.
         *
         * The estimate in {@link placeRefMenu} can only be wrong by being too
         * small (a wider font, a longer translation), so this only ever moves the
         * menu by the overflow it actually measures. A box with no size yet, or
         * one as large as the viewport, cannot be nudged into a viewport it
         * already fills - both are left where the pointer put them.
         */
        useEffect(() => {
          if (refMenu === null) return
          const menu = refMenuRef.current
          const win = typeof window === 'undefined' ? undefined : window
          if (menu === null || menu === undefined || win === undefined || win === null) return
          if (typeof menu.getBoundingClientRect !== 'function') return
          let rect
          try {
            rect = menu.getBoundingClientRect()
          } catch {
            return
          }
          if (rect === null || rect === undefined) return
          const width = typeof rect.width === 'number' ? rect.width : 0
          const height = typeof rect.height === 'number' ? rect.height : 0
          if (width <= 0 || height <= 0) return
          if (width >= win.innerWidth || height >= win.innerHeight) return
          const overX = (typeof rect.right === 'number' ? rect.right : 0) - (win.innerWidth - REF_MENU_MARGIN)
          const overY = (typeof rect.bottom === 'number' ? rect.bottom : 0) - (win.innerHeight - REF_MENU_MARGIN)
          if (overX <= 0 && overY <= 0) return
          setRefMenu((prev) => {
            if (prev === null) return prev
            const x = overX > 0 ? Math.max(REF_MENU_MARGIN, prev.x - overX) : prev.x
            const y = overY > 0 ? Math.max(REF_MENU_MARGIN, prev.y - overY) : prev.y
            if (x === prev.x && y === prev.y) return prev
            return { ...prev, x, y }
          })
        }, [refMenu])

        /**
         * Roving focus inside the menu: the row at `refMenuIndex` is the focus
         * target and the only row in the tab order. The arrow keys never land on
         * a disabled row, so this only ever focuses something activatable.
         */
        useEffect(() => {
          if (refMenu === null) return
          const node = refMenuIndex === 0
            ? refMenuInsertRef.current
            : refMenuIndex === 1 ? refMenuCopyRef.current : refMenuCancelRef.current
          if (node === null || node === undefined || typeof node.focus !== 'function') return
          try {
            node.focus()
          } catch {
            // A detached node cannot take focus; the menu is closing anyway.
          }
        }, [refMenu, refMenuIndex])

        // A menu belongs to the editor it was opened on: switching the file or
        // the session closes it, because the record it carries now describes
        // another document.
        useEffect(() => {
          setRefMenu(null)
        }, [activePath, sessionId])

        /** Abort every in-flight request of this panel instance. */
        const abortAll = useCallback(() => {
          for (const controller of controllersRef.current) {
            try {
              controller.abort()
            } catch {
              // Already aborted.
            }
          }
          controllersRef.current.clear()
        }, [])

        // Teardown: no request may outlive the panel.
        useEffect(() => () => {
          abortAll()
        }, [abortAll])

        /**
         * List one directory level through the host Remote.
         *
         * The path is always absolute: the Host's `inspect()` rejects an empty
         * path with `gateway/bad-request`, and a relative path is resolved
         * against the same workspace base anyway, so the absolute form is the one
         * every key and every request agrees on.
         * @param path - absolute directory path.
         */
        const loadDir = useCallback(async (path) => {
          if (sessionId === '' || path === '' || !filesAvailable) return
          const epoch = epochRef.current
          const controller = new AbortController()
          controllersRef.current.add(controller)
          const scope = openRequestScope(controller.signal)
          setDirs((prev) => ({
            ...prev,
            [path]: { status: 'loading', entries: prev[path]?.entries ?? [], truncated: false },
          }))
          try {
            const res = await callFiles('list', [sessionId, path, scope.signal], scope.signal)
            if (!res || res.ok !== true) throw res?.error ?? transportFailure('Remote returned no result')
            if (epoch !== epochRef.current) return
            const listing = res.value
            setDirs((prev) => ({
              ...prev,
              [path]: {
                status: 'ready',
                entries: normalizeEntries(listing?.entries),
                truncated: listing?.truncated === true,
              },
            }))
          } catch (error) {
            const failure = toFailure(error, scope)
            if (epoch !== epochRef.current) return
            if (failure.tier === 'cancel') {
              // Withdrawn without a newer request replacing it: drop the
              // placeholder instead of leaving a spinner behind.
              setDirs((prev) => {
                if (prev[path] === undefined || prev[path].status !== 'loading') return prev
                const next = { ...prev }
                delete next[path]
                return next
              })
              return
            }
            // Keep the level's last good listing: the error row is drawn above
            // it, so a failed reload never flashes the tree empty.
            setDirs((prev) => ({
              ...prev,
              [path]: { status: 'error', entries: prev[path]?.entries ?? [], failure },
            }))
          } finally {
            scope.dispose()
            controllersRef.current.delete(controller)
          }
        }, [filesAvailable, sessionId])

        /**
         * Invalidates the loaded tree when the session or the workspace base
         * changes; a plain refresh reuses it.
         */
        const treeIdentityRef = useRef('')

        /**
         * Park a dirty buffer in the module-level draft table before anything
         * wipes it.
         *
         * `editRef`/`bufferRef` carry the buffer's own facts (its session, its
         * path, whether it is dirty), so this is safe to call from an effect whose
         * render already belongs to the next session. Idempotent: the same file
         * parked twice replaces itself.
         */
        const parkDirtyBuffer = () => {
          const buffered = bufferRef.current
          if (editRef.current.dirty !== true || buffered.path === '' || buffered.session === '') return
          writeDraft(buffered.session, {
            path: buffered.path,
            text: draftRef.current,
            version: buffered.version,
          })
          setDraftEpoch((value) => value + 1)
        }

        // Session switch / workspace-base change: park the dirty buffer, drop every
        // cached level, reset the view, then load the root. Explicit refresh of the
        // same session keeps the loaded map and the expansion state, so a failed
        // reload shows its error above the last good listing instead of an empty
        // tree. The epoch bump is what makes the previous session's answers
        // unwritable, not just the abort.
        useEffect(() => {
          epochRef.current += 1
          abortAll()
          const identity = `${sessionId}\u0000${rootPath}`
          const sameTree = treeIdentityRef.current === identity
          treeIdentityRef.current = identity
          if (!sameTree) {
            // The host may keep this panel mounted across sessions, so the buffer
            // is parked here - before the reset below wipes it - instead of relying
            // on an unmount that may never happen (B5).
            parkDirtyBuffer()
            const prefs = sessionPrefs(sessionId)
            const saved = typeof prefs.activePath === 'string' ? prefs.activePath : ''
            setDirs({})
            setExpanded(rootPath === '' ? {} : { [rootPath]: true })
            setFile({ status: 'idle' })
            setActiveKind(undefined)
            setActivePath(isUnderRoot(saved, rootPath) ? saved : '')
            setPrefWidths({
              tree: typeof prefs.treeWidth === 'number' ? prefs.treeWidth : TREE_DEFAULT,
              chat: typeof prefs.chatWidth === 'number' ? prefs.chatWidth : CHAT_DEFAULT,
            })
            setDragWidth({ tree: null, chat: null })
            // The buffer belonged to the previous tree: forget its identity (so a
            // late save response cannot land in the new one) and clear the edit
            // slice. The text itself is already parked above.
            bufferRef.current = { session: '', path: '', base: '', version: '', eol: '' }
            bufferGenRef.current += 1
            draftRef.current = ''
            setDocView((prev) => ({ key: prev.key + 1, path: '', text: '' }))
            setRestored(null)
            setEdit({ path: '', version: '', dirty: false, phase: 'idle', detail: '' })
          }
          if (sessionId !== '' && rootPath !== '') void loadDir(rootPath)
        }, [abortAll, loadDir, reloadToken, rootPath, sessionId])

        // File body: debounced, abortable, and guarded by its own epoch, so a page
        // that arrives after the user picked another file is dropped instead of
        // overwriting it. There is no `stat` precheck: the Host's `read` already
        // starts with `locateFile` (an lstat gate + stat) and refuses a non-regular
        // file before a single byte is read, which is mapped to the same "this file
        // type cannot be previewed" notice below. A precheck would only add one
        // more RPC and split the 15 s budget between two calls instead of one.
        useEffect(() => {
          if (sessionId === '' || rootPath === '' || activePath === '' || !filesAvailable) {
            setFile({ status: 'idle' })
            setReadProgress(null)
            return undefined
          }
          fileEpochRef.current += 1
          const epoch = fileEpochRef.current
          // A superseded read's progress belongs to the file that just left.
          setReadProgress(null)
          const controller = new AbortController()
          controllersRef.current.add(controller)
          // `other` (socket, fifo, device) can never be previewed: say so instead
          // of spending a request the Host would reject.
          if (activeKind === 'other') {
            setFile({ status: 'unsupported', path: activePath })
            setReadProgress(null)
            controllersRef.current.delete(controller)
            return undefined
          }
          // A switch keeps the mounted document until the next page lands: the
          // editor is one view whose document is swapped, not one view per file.
          // (The `editable` guard is what stops a save from ever writing the old
          // buffer to the new path while the read is in flight.)
          if (file.status !== 'ready') setFile({ status: 'loading', path: activePath })
          const timer = setTimeout(async () => {
            const scope = openRequestScope(controller.signal)
            try {
              // Every page of the file, until `eof` or the editable caps: the
              // editor must never hold a window that a save would write back as
              // the whole file.
              const read = await readWholeFile(sessionId, activePath, scope.signal, (progress) => {
                if (epoch === fileEpochRef.current) setReadProgress(progress)
              })
              if (epoch !== fileEpochRef.current) return
              // One event per settled read: what was opened, how big it is, and
              // whether the editor may hold it. `editable` is the same rule the
              // render applies below (complete read and inside both caps),
              // computed here from the read that actually landed - a read-only
              // preview and an editable buffer fail differently.
              const openPage = read.page ?? {}
              const openText = typeof openPage.text === 'string' ? openPage.text : ''
              const openLines = typeof openPage.lines === 'number' && openPage.lines >= 0
                ? openPage.lines
                : (openText === '' ? 0 : normalizeText(openText).split('\n').length)
              beacon('file-open', {
                ext: extensionOf(activePath),
                bytes: typeof openPage.bytes === 'number' && Number.isFinite(openPage.bytes)
                  ? openPage.bytes
                  : utf8Length(openText),
                lines: openLines,
                editable: read.tooLarge !== true,
              })
              // `sessionId` travels with the page: a page that lands after a
              // session switch belongs to the session it was read in, and the
              // baseline effect refuses to adopt it for another one.
              setFile({ status: 'ready', sessionId, path: activePath, page: read.page, tooLarge: read.tooLarge === true })
            } catch (error) {
              const failure = toFailure(error, scope)
              if (epoch !== fileEpochRef.current) return
              if (failure.tier === 'cancel') {
                // A withdrawn request must not spin forever when nothing newer
                // replaced it (a superseding request already bumped the epoch).
                setFile({ status: 'idle' })
                return
              }
              // A failed read must not consume a draft the user asked to
              // restore: drop the *intent* (so the card can be offered again
              // after a successful read) but leave the parked draft in place.
              setRestored(null)
              if (failure.code === 'workspace-file/not-text') setFile({ status: 'binary', path: activePath })
              else if (failure.code === 'workspace-file/too-large') setFile({ status: 'too-large', path: activePath })
              else if (failure.code === 'workspace-file/not-regular-file') setFile({ status: 'unsupported', path: activePath })
              else setFile({ status: 'error', path: activePath, failure })
            } finally {
              scope.dispose()
              controllersRef.current.delete(controller)
              if (epoch === fileEpochRef.current) setReadProgress(null)
            }
          }, FILE_DEBOUNCE_MS)
          return () => {
            clearTimeout(timer)
            controller.abort()
            controllersRef.current.delete(controller)
          }
        }, [activeKind, activePath, fileReloadToken, filesAvailable, rootPath, sessionId])

        /**
         * Commit the file-tree width and make room for it: growing the tree
         * lowers the chat column's stored preference instead of silently
         * resolving to a width outside the advertised range, so the value a
         * keyboard step asks for is the value that is rendered.
         */
        const commitTree = useCallback((next) => {
          const target = clampNumber(Math.round(next), layout.treeMin, layout.treeMax)
          const chat = Math.min(prefWidths.chat, Math.max(layout.chatMin, layout.sideBudget - target))
          setDragWidth((prev) => ({ ...prev, tree: null }))
          setPrefWidths({ tree: target, chat })
          patchSessionPrefs(sessionId, { treeWidth: target, chatWidth: chat })
        }, [layout.chatMin, layout.sideBudget, layout.treeMax, layout.treeMin, prefWidths.chat, sessionId])

        /** The chat column's counterpart of {@link commitTree}. */
        const commitChat = useCallback((next) => {
          const target = clampNumber(Math.round(next), layout.chatMin, layout.chatMax)
          const tree = Math.min(prefWidths.tree, Math.max(layout.treeMin, layout.sideBudget - target))
          setDragWidth((prev) => ({ ...prev, chat: null }))
          setPrefWidths({ tree, chat: target })
          patchSessionPrefs(sessionId, { treeWidth: tree, chatWidth: target })
        }, [layout.chatMax, layout.chatMin, layout.sideBudget, layout.treeMin, prefWidths.tree, sessionId])

        /**
         * Open one entry in the preview.
         * @param path - absolute path of the entry.
         * @param kind - the type the listing reported, when it is known.
         */
        const openFile = useCallback((path, kind) => {
          setActiveKind(typeof kind === 'string' ? kind : undefined)
          setActivePath(path)
          patchSessionPrefs(sessionId, { activePath: path })
        }, [sessionId])

        const toggleDir = useCallback((path) => {
          const willExpand = expanded[path] !== true
          setExpanded((prev) => ({ ...prev, [path]: willExpand }))
          if (willExpand && dirs[path] === undefined) void loadDir(path)
        }, [dirs, expanded, loadDir])

        /**
         * Reload one level that failed, from its own error row. `loadDir` keeps
         * that level's last good listing, so the retry never blanks the tree.
         * @param path - absolute directory path.
         */
        const retryDir = useCallback((path) => {
          void loadDir(path)
        }, [loadDir])

        // -- the buffer: baseline, dirty tracking, saving ---------------------

        /** The page currently shown (an empty object when nothing is loaded). */
        const page = file.status === 'ready' ? file.page ?? {} : {}
        const pageText = typeof page.text === 'string' ? page.text : ''
        // The preview splits the *normalized* text: a CRLF page must count the
        // same lines the editor shows, and `lines` comes from the host anyway.
        const pageLines = pageText === '' ? [] : normalizeText(pageText).split('\n')
        const lineCount = typeof page.lines === 'number' && page.lines >= 0
          ? Math.min(page.lines, pageLines.length)
          : pageLines.length
        /**
         * Whether the editor may hold this file at all. A read that stopped at
         * either editable cap ({@link MAX_EDITABLE_LINES} / {@link MAX_EDITABLE_BYTES})
         * is a read-only preview: handing 20,000+ lines to CodeMirror freezes the
         * panel, and saving a partial buffer would truncate the file.
         */
        const tooLarge = file.status === 'ready' && file.tooLarge === true
        const editorAllowed = file.status === 'ready' && tooLarge !== true && page.eof !== false
        const editable = editorAllowed && activePath !== '' && file.path === activePath
        /** The dirty flag drives the title dot and the save button. */
        const dirty = edit.dirty === true && editable
        /**
         * What the editor should show: the text the panel last *adopted* for this
         * file, or the read text of a file that has not been adopted yet.
         *
         * The read text is never fed back down on every render: a dirty buffer is
         * the authority (B2), and an identical document must not be re-set (a
         * CRLF re-read used to reset the cursor and the undo history).
         */
        const docText = file.status === 'ready' && docView.path === file.path ? docView.text : pageText

        // A settled read is the new baseline for this buffer: text, CAS version,
        // dirty flag and save phase all restart from what the file holds now -
        // unless the read belongs to a buffer that already has unsaved edits. A
        // refresh re-reads the disk version; it never touches the editing buffer.
        useEffect(() => {
          if (file.status !== 'ready') return
          // A page read in another session (a switch landed while the read was in
          // flight) must not become this session's baseline.
          if (typeof file.sessionId === 'string' && file.sessionId !== '' && file.sessionId !== sessionId) return
          const nextPage = file.page ?? {}
          const raw = typeof nextPage.text === 'string' ? nextPage.text : ''
          const eol = detectEol(raw)
          const base = normalizeText(raw)
          const version = typeof nextPage.version === 'string' ? nextPage.version : ''
          if (bufferRef.current.path === file.path && bufferRef.current.session === sessionId && editRef.current.dirty === true) {
            // Same buffer, still dirty: keep its text, its version and its dirty
            // mark. (Adopting a newer disk version would silently move the CAS
            // basis of the buffer the user is holding.)
            return
          }
          if (bufferRef.current.path !== file.path || bufferRef.current.session !== sessionId) {
            bufferGenRef.current += 1
          }
          bufferRef.current = { session: sessionId, path: file.path, base, version, eol }
          const restore = restored !== null && restored.path === file.path ? restored : null
          const buffer = restore === null ? base : normalizeText(restore.text)
          draftRef.current = buffer
          // The one place the editor is told to take a new document. A read that
          // was *not* adopted (the dirty branch above) never bumps this key, so
          // the buffer's text and its undo history survive a refresh untouched.
          setDocView((prev) => ({ key: prev.key + 1, path: file.path, text: buffer }))
          setEdit({
            path: file.path,
            // A restored draft keeps the version it was edited at, so CAS still
            // fires when the file changed while the panel was away.
            version: restore === null ? version : (typeof restore.version === 'string' && restore.version !== '' ? restore.version : version),
            dirty: restore !== null && buffer !== base,
            phase: 'idle',
            detail: '',
          })
          // The draft is dropped only now that its text has really been adopted:
          // a read that failed leaves the parked copy in place (B3).
          if (restore !== null) {
            dropDraft(sessionId, restore.path)
            setDraftEpoch((value) => value + 1)
          }
          // `restored` is deliberately not a dependency: it is consumed here for
          // the first read that follows the restore click, and nowhere else.
        }, [file])

        // The browser's own guard for a reload/close while the buffer is dirty.
        useEffect(() => {
          if (!dirty) return undefined
          const guard = (event) => {
            if (event !== null && typeof event === 'object') {
              event.preventDefault()
              event.returnValue = ''
            }
            return ''
          }
          try {
            window.addEventListener('beforeunload', guard)
          } catch {
            return undefined
          }
          return () => {
            try {
              window.removeEventListener('beforeunload', guard)
            } catch {
              // The window is gone already.
            }
          }
        }, [dirty])

        // A panel unmount removes the subtree before any card could render, so the
        // dirty buffer is parked and the *next* mount (or the next view of that
        // file) asks what to do with it. `draftRef` is read here rather than off
        // the last render, because a keystroke after the dirty transition never
        // re-renders. `editRef`/`bufferRef` are the buffer's own facts, so a
        // session switch that already parked it does not park it twice.
        useEffect(() => () => {
          const current = editRef.current
          const buffered = bufferRef.current
          if (current.dirty !== true || buffered.path === '' || buffered.session === '') return
          writeDraft(buffered.session, {
            path: buffered.path,
            text: draftRef.current,
            version: buffered.version,
          })
        }, [])

        /**
         * The parked draft this panel may offer, or null.
         *
         * The store is module-level and not reactive, so this is computed per
         * render (and re-computed when a draft is parked or dropped). A draft is
         * only ever offered for the file that is *open right now*: a card for a
         * file the user has already left behind would restore text into a buffer
         * that is not showing (B3). A restore already in flight, an open confirm
         * and a conflict card all outrank it.
         */
        const armedDraft = useMemo(() => {
          if (sessionId === '' || activePath === '') return null
          if (restored !== null || pending !== null || edit.phase === 'conflict') return null
          if (file.status !== 'ready' || file.path !== activePath) return null
          return peekDraft(sessionId, activePath)
        }, [activePath, draftEpoch, edit.phase, file, pending, restored, sessionId])

        /**
         * The editor's text changed. Only a dirty *transition* reaches state, so
         * typing costs one string compare per keystroke and no re-render.
         *
         * The comparison is against the buffer's own normalized baseline, not
         * against `file.page.text`: a CRLF file must not read as dirty before it
         * was touched, and a re-read that is not adopted must not flip the mark.
         * @param value - the whole buffer.
         */
        const onEditorChange = useCallback((value) => {
          draftRef.current = typeof value === 'string' ? value : ''
          const nextDirty = normalizeText(draftRef.current) !== bufferRef.current.base
          setEdit((prev) => {
            // A save in flight owns the phase until its own response lands:
            // typing during it may not switch the status back to idle, and the
            // save is what decides the dirty flag (B4). A conflict card likewise
            // stays until the user answers it.
            if (prev.phase === 'saving' || prev.phase === 'conflict') {
              return prev.dirty === nextDirty ? prev : { ...prev, dirty: nextDirty }
            }
            if (prev.dirty === nextDirty && prev.phase !== 'saved') return prev
            return { ...prev, dirty: nextDirty, phase: nextDirty ? 'idle' : prev.phase }
          })
        }, [])

        /**
         * Save the buffer through the host's guarded write endpoint.
         *
         * The write is a **snapshot**: `{ path, epoch, content, version }` is
         * taken once, and the response may only touch the buffer it was taken
         * from (same path, same buffer identity). Text typed while the request is
         * in flight stays dirty - the bytes that landed are the snapshot, not the
         * live buffer - and a second Ctrl+S is ignored instead of racing a
         * concurrent write (B4).
         *
         * A guarded write needs the version the buffer was read at. There is no
         * `stat` fallback any more: inventing a fresh version would silently
         * *drop* the compare-and-swap guard (the file could have changed since
         * the buffer was taken), so the save is refused instead.
         *
         * `force` is the user's explicit "overwrite anyway" after a 409: it is the
         * only path that drops the compare-and-swap guard, and it is only ever
         * reachable from the conflict card.
         * @param options - `{ force }`.
         */
        const saveNow = useCallback(async (options) => {
          const force = options?.force === true
          // -- every refusal before the request leaves a distinct code --------
          //
          // "I pressed Ctrl+S and the file on disk did not change" has exactly
          // two shapes: the request was never sent, or it was sent and refused.
          // Each early return below therefore beacons `save-failed` with a
          // `no-request:<stage>` code *before* it returns: a silent `return` is
          // the one thing a disk log cannot explain afterwards. The checks are
          // ordered most-specific-first, and none of them is new behaviour - a
          // return is still a return.
          if (sessionId === '') {
            beacon('save-failed', { code: 'no-request:no-session', stage: 'no-session' })
            return
          }
          if (activePath === '') {
            beacon('save-failed', { code: 'no-request:no-active-path', stage: 'no-active-path' })
            return
          }
          if (!editable) {
            // `editable` is false for a read-only preview *and* for a panel whose
            // file face was withdrawn; the two are different bug reports.
            const hasFiles = getFiles() !== undefined
            beacon('save-failed', {
              code: hasFiles ? 'no-request:not-editable' : 'no-request:no-files',
              stage: hasFiles ? 'not-editable' : 'no-files',
            })
            return
          }
          if (edit.phase === 'saving') {
            beacon('save-failed', { code: 'no-request:saving', stage: 'saving' })
            return
          }
          if (dirty !== true && force !== true) {
            beacon('save-failed', { code: 'no-request:not-dirty', stage: 'not-dirty' })
            return
          }
          const snapshot = {
            path: activePath,
            epoch: bufferGenRef.current,
            content: draftRef.current,
            version: typeof edit.version === 'string' ? edit.version : '',
            eol: bufferRef.current.eol,
          }
          if (typeof snapshot.content !== 'string') {
            // The editor never handed a buffer back: nothing to write, and a
            // write of `''` would be worse than a refusal.
            beacon('save-failed', { code: 'no-request:no-buffer', stage: 'no-buffer' })
            return
          }
          if (snapshot.version === '') {
            // No baseline version: refuse rather than write without a guard.
            beacon('save-failed', { code: 'no-request:no-version', stage: 'no-version' })
            setEdit((prev) => ({ ...prev, phase: 'error', detail: t('errorVersionMissing') }))
            return
          }
          const content = restoreEol(snapshot.content, snapshot.eol)
          const controller = new AbortController()
          // Registered so a panel unmount aborts an in-flight save like every
          // other request; `openRequestScope` composes that with the 15 s budget.
          controllersRef.current.add(controller)
          const scope = openRequestScope(controller.signal)
          setEdit((prev) => ({ ...prev, phase: 'saving', detail: '' }))
          try {
            const result = await postWrite({
              sessionId,
              path: snapshot.path,
              content,
              version: snapshot.version,
              force,
            }, scope.signal)
            // A late answer belongs to a buffer that is no longer open: it must
            // not write state into whatever the panel shows now (B4). The host
            // *did* answer, so the log has to say why the panel ignored it.
            if (bufferGenRef.current !== snapshot.epoch || activePathRef.current !== snapshot.path) {
              beacon('save-failed', { code: 'stale-response', stage: 'stale', status: result.status })
              return
            }
            const body = result.body
            if (result.status === 200 && body?.ok === true) {
              const value = body.value ?? {}
              const nextVersion = typeof value.version === 'string' && value.version !== '' ? value.version : snapshot.version
              // What is on disk now *is* the snapshot, so it becomes the buffer's
              // baseline: the mark clears exactly when nothing was typed after
              // the write was taken (B4).
              bufferRef.current = { ...bufferRef.current, base: snapshot.content, version: nextVersion }
              setRestored(null)
              setEdit((prev) => {
                // Only what was actually written may clear the mark: anything
                // typed after the snapshot is still unsaved.
                const dirtyNow = draftRef.current !== bufferRef.current.base
                return {
                  ...prev,
                  version: nextVersion,
                  dirty: dirtyNow,
                  phase: dirtyNow ? 'idle' : 'saved',
                  detail: '',
                }
              })
              beacon('save-ok', {
                bytes: typeof value.bytes === 'number' && Number.isFinite(value.bytes) ? value.bytes : utf8Length(content),
                operation: typeof value.operation === 'string' && value.operation !== '' ? value.operation : 'update',
              })
              return
            }
            if (result.status === 409) {
              beacon('conflict-shown', { code: 'FS_STALE_VERSION' })
              setEdit((prev) => ({ ...prev, phase: 'conflict', detail: 'FS_STALE_VERSION' }))
              return
            }
            const code = typeof body?.error?.code === 'string' ? body.error.code : `HTTP ${result.status}`
            beacon('save-failed', { code, status: result.status, stage: 'rejected' })
            setEdit((prev) => ({ ...prev, phase: 'error', detail: t('errorSaveRejected', { code }) }))
          } catch (error) {
            // The scope is what carries the timeout: without it `toFailure`
            // cannot tell an aborted request from a timed-out one (重要 5).
            const failure = toFailure(error, scope)
            if (failure.tier === 'cancel') {
              beacon('save-failed', { code: failure.code === '' ? 'aborted' : failure.code, stage: 'abort' })
              return
            }
            if (bufferGenRef.current !== snapshot.epoch || activePathRef.current !== snapshot.path) {
              beacon('save-failed', { code: 'stale-response', stage: 'stale' })
              return
            }
            beacon('save-failed', {
              code: failure.code === '' ? 'network' : failure.code,
              stage: failure.tier === 'timeout' ? 'timeout' : 'transport',
            })
            setEdit((prev) => ({
              ...prev,
              phase: 'error',
              detail: failure.tier === 'timeout'
                ? t('errorTimeout', { n: Math.round(REQUEST_TIMEOUT_MS / 1000) })
                : t('errorSaveUnavailable'),
            }))
          } finally {
            scope.dispose()
            controllersRef.current.delete(controller)
          }
        }, [activePath, dirty, edit.phase, edit.version, editable, sessionId, t])

        /**
         * Re-read the open file from disk (the conflict card's "reload").
         *
         * "Reload" is an explicit discard: the dirty mark is cleared first,
         * otherwise the refresh guard that protects unsaved edits would keep the
         * local buffer instead of adopting the disk text.
         */
        const reloadFile = useCallback(() => {
          setEdit((prev) => ({ ...prev, dirty: false, phase: 'idle', detail: '' }))
          setRestored(null)
          if (activePath !== '') dropDraft(sessionId, activePath)
          setDraftEpoch((value) => value + 1)
          setFileReloadToken((token) => token + 1)
        }, [activePath, sessionId])

        /**
         * Open a tree entry, asking first when it would discard unsaved work.
         *
         * `options.restore` carries a parked draft the opening must adopt. The
         * draft restore goes through exactly this function, so restoring can
         * never bypass the dirty confirmation (B3).
         * @param path - absolute path to open.
         * @param kind - entry type from the listing, when known.
         * @param options - `{ restore }`.
         */
        const requestOpen = useCallback((path, kind, options) => {
          const restore = options?.restore ?? null
          const adopt = () => {
            setRestored(restore)
            if (path === activePath) {
              // Same file: no switch, so re-read it to re-run the baseline
              // effect - this time with the restored text.
              if (restore !== null) setFileReloadToken((token) => token + 1)
              return
            }
            openFile(path, kind)
          }
          if (path === activePath && restore === null) {
            openFile(path, kind)
            return
          }
          if (dirty) {
            setPending({ kind: 'switch', path, entryType: kind, restore })
            return
          }
          adopt()
        }, [activePath, dirty, openFile])

        /** Dismiss the confirm card and keep everything as it is. */
        const dismissPending = useCallback(() => {
          setPending(null)
        }, [])

        /**
         * The conflict card's "cancel": leave the conflict state, keep both the
         * buffer and the CAS version, so the next save asks the host again
         * instead of leaving a dead card on screen (重要 1).
         */
        const dismissConflict = useCallback(() => {
          setEdit((prev) => (prev.phase === 'conflict' ? { ...prev, phase: 'idle', detail: '' } : prev))
        }, [])

        /** Honor the confirm card: drop the buffer and run the held action. */
        const confirmDiscard = useCallback(() => {
          const action = pending
          setPending(null)
          setEdit((prev) => ({ ...prev, dirty: false, phase: 'idle', detail: '' }))
          // A held draft restore survives the confirmation; anything else starts
          // from the disk text.
          setRestored(action?.restore ?? null)
          if (action === null) return
          if (action.kind === 'switch') {
            if (action.path === activePath) setFileReloadToken((token) => token + 1)
            else openFile(action.path, action.entryType)
            return
          }
          // `exit` is the only other kind: leaving IDE mode, with the preferences
          // of this session reset.
          if (action.kind === 'exit') {
            controller.exit(sessionId, { reset: true })
            return
          }
        }, [activePath, controller, openFile, pending, sessionId])

        /**
         * Restore the parked draft: through {@link requestOpen}, so an unsaved
         * buffer in the current file still gets its confirmation. The parked copy
         * is dropped only once the read has really been adopted (baseline
         * effect), never up front.
         */
        const restoreDraft = useCallback(() => {
          const parked = armedDraft
          if (parked === null) return
          requestOpen(parked.path, 'file', { restore: parked })
        }, [armedDraft, requestOpen])

        /** Forget the parked draft of the open file. */
        const discardDraft = useCallback(() => {
          if (activePath === '') return
          dropDraft(sessionId, activePath)
          setDraftEpoch((value) => value + 1)
        }, [activePath, sessionId])

        /**
         * The one way into {@link saveNow}, and the reason a save can no longer
         * be invisible.
         *
         * The failure this closes: "I pressed Ctrl+S and the file on disk did
         * not change" had *two* possible shapes on disk, and the log only
         * described one of them. A refusal leaves `save-failed` with a
         * `no-request:<stage>` code; an entry that was never reached left
         * nothing at all - which is exactly what the last report contained (the
         * panel, the editor, the file and the chunk were all fine, and there was
         * not one `save-*` line). So every entry beacons `save-intent` **before**
         * it reaches the save: the next log answers "was the key delivered, which
         * entry took it, what did the save then decide" in that order.
         *
         * The fields are the ones that cannot be reconstructed afterwards:
         * `source` names the entry, `focus` says where the user was, and
         * `hasDirty`/`hasVersion` are the two preconditions the save itself
         * checks - so a `no-request:not-dirty` and a `no-request:no-version` in
         * the same log are now separate, explained facts instead of surprises.
         * @param source - `'editor-keymap' | 'button' | 'document-keydown'`.
         * @param focus - `'editor' | 'chat' | 'tree' | 'other'`.
         */
        const enterSave = (source, focus) => {
          beacon('save-intent', {
            source,
            focus,
            hasDirty: dirty === true,
            hasVersion: typeof edit.version === 'string' && edit.version !== '',
          })
          void saveNow()
        }
        /**
         * The live entry, for the document listener below.
         *
         * The listener is registered once per mount - so that one
         * `removeEventListener` really removes it - while `enterSave` closes over
         * the buffer of *this* render. A ref is what lets both be true; it is
         * assigned during render for the same reason {@link activePathRef} is:
         * the value is only ever read from an event handler, never guessed
         * during a render pass.
         */
        const enterSaveRef = useRef(enterSave)
        enterSaveRef.current = enterSave

        /**
         * Ctrl/Cmd+S, from anywhere on the page, while this panel is mounted.
         *
         * What it replaces: with focus outside the editor (the file tree, the
         * conversation's own composer, the panel chrome) neither the editor's
         * `Mod-s` keymap nor a handler on the panel root ever saw the key, so the
         * save simply did not run - and a log with no `save-*` line cannot be
         * told apart from "the user never pressed it". A `document` **capture**
         * listener is the one place a keystroke cannot escape, and IDE mode is a
         * whole-surface mode: while it is mounted, Ctrl+S means "save the open
         * file", including while the caret sits in the chat composer - the
         * conversation is embedded *inside* this panel and the file being edited
         * is still this panel's file. That is the IDE-mode semantic, and it is
         * the one entry point the user cannot miss.
         *
         * `capture` + `preventDefault` + `stopPropagation` together are what make
         * this exactly one save: the browser's own "save page" dialog never
         * opens, and no handler downstream can turn the same keystroke into a
         * second write. A handler that ran *earlier* (another capture listener,
         * or the editor keymap where the platform delivers the key to it first)
         * leaves `defaultPrevented === true`, which is the signal to stand down -
         * so one physical key press can never become two writes.
         *
         * The disposer is a real `removeEventListener`, not a flag: a flag would
         * leave the listener on the document for the life of the page, saving
         * for a panel that no longer exists.
         */
        useEffect(() => {
          const host = typeof document !== 'undefined' ? document : undefined
          if (host === undefined || typeof host.addEventListener !== 'function' || typeof host.removeEventListener !== 'function') {
            return undefined
          }
          const onDocumentKeyDown = (event) => {
            try {
              if (event === null || typeof event !== 'object') return
              // Already handled upstream: saving again would be the second write
              // of one keystroke.
              if (event.defaultPrevented === true) return
              if (event.ctrlKey !== true && event.metaKey !== true) return
              if (event.altKey === true) return
              if (typeof event.key !== 'string' || event.key.toLowerCase() !== 's') return
              event.preventDefault()
              if (typeof event.stopPropagation === 'function') event.stopPropagation()
              enterSaveRef.current('document-keydown', focusKindOf(event.target))
            } catch {
              // A keyboard handler may never throw into the page.
            }
          }
          host.addEventListener('keydown', onDocumentKeyDown, true)
          return () => {
            try {
              host.removeEventListener('keydown', onDocumentKeyDown, true)
            } catch {
              // The document is gone already (page teardown): nothing to remove.
            }
          }
        }, [])

        const rowsResult = useMemo(
          () => safeFlattenRows(dirs, rootPath, expanded, maxTreeEntries, t, measured),
          [dirs, expanded, maxTreeEntries, measured, rootPath, t],
        )
        const rows = rowsResult.rows
        const rootNode = rootPath === '' ? undefined : dirs[rootPath]
        const rootLabel = rootPath === '' ? t('rootLabel') : rootPath
        /** The one way out of the panel: leave IDE mode and drop this session's preferences. */
        const exitIde = useCallback(() => {
          if (dirty) {
            setPending({ kind: 'exit' })
            return
          }
          controller.exit(sessionId, { reset: true })
        }, [dirty, sessionId])
        /**
         * Explicit refresh: reload the tree and re-read the open file's disk
         * *version*, but never its editing buffer. The baseline effect keeps a
         * dirty buffer, its CAS version and its dirty mark, so pressing refresh
         * can no longer silently drop unsaved edits (B2).
         */
        const refreshTree = useCallback(() => {
          setReloadToken((token) => token + 1)
          if (activePath !== '') setFileReloadToken((token) => token + 1)
        }, [activePath])

        const treeBody = (() => {
          if (sessionId === '') return renderState(t('noSession'))
          if (rootPath === '') return renderState(t('errorNoWorkspace'))
          if (!filesAvailable) return renderServiceState(t, refreshTree)
          // The flattening step itself failed: this column gets its own card and
          // the other two columns keep rendering.
          if (rowsResult.crash !== '') return renderTreeCrash(t, rowsResult.crash, refreshTree)
          if (rootNode === undefined) return renderState(t('loading'))
          if (rootNode.status === 'loading' && rootNode.entries.length === 0) return renderState(t('loading'))
          // A root that failed with nothing loaded has no tree to show; one that
          // kept its last listing gets the error row inside the tree instead.
          if (rootNode.status === 'error' && rootNode.entries.length === 0) {
            return renderFailure(t, rootNode.failure, refreshTree)
          }
          if (rows.length === 0) return renderState(t('emptyDir'))
          return h('div', { className: 'dsh-ide-tree', role: 'list', 'aria-label': t('filesTitle') },
            rows.map((row) => {
              if (row.kind === 'status') {
                const retry = row.retryPath === undefined ? null : h('button', {
                  type: 'button',
                  className: 'dsh-ide-btn',
                  onClick: () => retryDir(row.retryPath),
                }, t('retry'))
                return h('div', {
                  key: row.key,
                  role: 'listitem',
                  className: 'dsh-ide-note',
                  'data-error': row.error === true ? 'true' : undefined,
                  'data-retry': row.retryPath === undefined ? undefined : 'true',
                  style: { paddingLeft: `${8 + row.depth * 12}px` },
                }, h('span', { className: 'dsh-ide-note-text' }, row.text), retry)
              }
              const open = row.isDirectory && expanded[row.path] === true
              // `aria-expanded` belongs on the control, not on the list item:
              // a list item cannot be expanded, a button can.
              return h('div', {
                key: row.key,
                role: 'listitem',
                className: 'dsh-ide-li',
              }, h('button', {
                type: 'button',
                className: 'dsh-ide-row',
                'data-ide-entry': row.path,
                'data-ide-entry-type': row.type,
                'aria-current': row.path === activePath ? 'true' : undefined,
                'aria-expanded': row.isDirectory ? (open ? 'true' : 'false') : undefined,
                title: displayPath(row.path, rootPath),
                style: { paddingLeft: `${8 + row.depth * 12}px` },
                onClick: () => {
                  if (row.isDirectory) toggleDir(row.path)
                  else requestOpen(row.path, row.type)
                },
              },
              h('span', { className: 'dsh-ide-mark', 'data-open': open ? 'true' : undefined }, row.isDirectory ? h(IconChevron, null) : null),
              h('span', { className: 'dsh-ide-mark' }, h(IconKind, { dir: row.isDirectory })),
              h('span', { className: 'dsh-ide-row-name' }, row.name)))
            }),
            rowsResult.truncated
              ? h('div', { className: 'dsh-ide-note', role: 'listitem' }, t('budgetReached', { n: maxTreeEntries }))
              : null)
        })()

        const codeBody = (() => {
          if (sessionId === '') return renderState(t('noSession'))
          if (rootPath === '') return renderState(t('errorNoWorkspace'))
          if (!filesAvailable) return renderServiceState(t, refreshTree)
          if (file.status === 'idle') return renderState(t('noFile'))
          if (file.status === 'loading') return renderState(t('loadingFile'), displayPath(activePath, rootPath))
          if (file.status === 'error') return renderFailure(t, file.failure, refreshTree)
          if (file.status === 'binary') return h('div', { className: 'dsh-ide-notice' }, t('binary'))
          if (file.status === 'too-large') return h('div', { className: 'dsh-ide-notice' }, t('tooLarge'))
          if (file.status === 'unsupported') {
            return h('div', { className: 'dsh-ide-notice', 'data-ide-file': 'unsupported' }, t('unsupportedFile'))
          }
          // `text` alone cannot tell an empty file from an empty page: the Host
          // answers `text: ''` both for a page past the last line and for a page
          // holding one blank line, so `lines` is the discriminator.
          if (lineCount === 0) return renderState(t('emptyFile'))
          // A read-only preview of a file past the caps renders at most one page:
          // 20,000 rows of DOM would freeze the layout the way 20,000 lines would
          // freeze the editor.
          const rendered = editorAllowed ? lineCount : Math.min(lineCount, PREVIEW_LINES)
          const shown = pageLines.slice(0, rendered)
          const truncated = page.eof === false
            ? h('div', { className: 'dsh-ide-notice' }, t('renderTruncated', { n: rendered }))
            : null
          // The read-only rendering. It is the whole body for a file the editor
          // must not hold, and the *fallback* behind a failed editor chunk. Built
          // on demand: a 20,000-line editable file must not allocate 20,000
          // preview elements on every render just in case the chunk fails.
          const renderPreview = () => h('pre', { className: 'dsh-ide-pre' }, shown.map((line, index) => h('div', {
            key: index,
            className: 'dsh-ide-line',
            'data-ide-line': index + 1,
          }, h('span', { className: 'dsh-ide-ln' }, String(index + 1)), line)))
          if (!editorAllowed) {
            return h(Fragment, null,
              h('div', { className: 'dsh-ide-notice', 'data-ide-readonly': 'too-large' },
                t('fileTooLarge')),
              truncated,
              renderPreview())
          }
          return h(Fragment, null,
            truncated,
            // The two "decide" cards sit above the editor, never over it: the
            // user still sees the buffer they are deciding about. They share one
            // always-present container so that a card appearing or disappearing
            // cannot re-index the editor beside it (that would tear the view down
            // and rebuild it, losing the cursor and the undo history).
            h('div', { className: 'dsh-ide-cards' },
            edit.phase === 'conflict'
              ? h('div', { className: 'dsh-ide-card', 'data-ide-conflict': '1' },
                h('div', { className: 'dsh-ide-card-title' }, t('conflictTitle')),
                h('div', null, t('conflictHint')),
                h('div', { className: 'dsh-ide-actions' },
                  h('button', {
                    type: 'button',
                    className: 'dsh-ide-btn',
                    'data-ide-action': 'conflict-reload',
                    onClick: reloadFile,
                  }, t('conflictReload')),
                  h('button', {
                    type: 'button',
                    className: 'dsh-ide-btn',
                    'data-ide-action': 'conflict-overwrite',
                    onClick: () => {
                      void saveNow({ force: true })
                    },
                  }, t('conflictOverwrite')),
                  h('button', {
                    type: 'button',
                    className: 'dsh-ide-btn',
                    'data-ide-action': 'conflict-cancel',
                    onClick: dismissConflict,
                  }, t('confirmCancel'))))
              : null,
            armedDraft === null
              ? null
              : h('div', { className: 'dsh-ide-card', 'data-ide-draft': '1' },
                h('div', { className: 'dsh-ide-card-title' }, t('draftTitle')),
                h('div', null, t('draftHint', { name: displayPath(armedDraft.path, rootPath) || armedDraft.path })),
                h('div', { className: 'dsh-ide-actions' },
                  h('button', {
                    type: 'button',
                    className: 'dsh-ide-btn',
                    'data-ide-action': 'draft-restore',
                    onClick: restoreDraft,
                  }, t('draftRestore')),
                  h('button', {
                    type: 'button',
                    className: 'dsh-ide-btn',
                    'data-ide-action': 'draft-discard',
                    onClick: discardDraft,
                  }, t('draftDiscard'))))),
            h('div', {
              className: 'dsh-ide-editor-shell',
              'data-ide-editor-shell': '1',
              onContextMenu: openEditorMenu,
            }, h(CodeEditor, {
              t,
              doc: docText,
              docToken: docView.key,
              language: languageForPath(activePath),
              editable,
              onChange: onEditorChange,
              // The selection sink of this mount. CodeEditor keeps it in a ref and
              // hands it to the chunk's `onCursor` (its `EditorView.updateListener`),
              // so a selection never re-creates the view and never re-renders.
              onSelection: onEditorSelection,
              onSave: () => {
                // The editor's own `Mod-s` keymap (`createEditor`'s `onSave`),
                // kept as a named entry of its own even though the document-level
                // capture listener above normally takes the keystroke first and
                // stops it before the view sees it: this is the entry that still
                // works where that listener could not be registered, and it is
                // where a `stopPropagation` regression would surface as a second
                // write of one keystroke.
                enterSave('editor-keymap', 'editor')
              },
              fallback: renderPreview,
            })))
        })()

        const infoBar = (() => {
          const relative = displayPath(activePath, rootPath)
          const label = activePath === '' ? t('noFile') : relative === '' ? activePath : relative
          const saveState = edit.phase === 'saving'
            ? t('saving')
            : edit.phase === 'saved'
              ? t('saved')
              : edit.phase === 'error'
                ? t('saveFailed')
                : dirty ? t('unsaved') : ''
          // Only two states disable the save button: no editable buffer at all
          // (read-only preview, withdrawn file face, no file), and a save
          // already in flight. A *clean* buffer deliberately stays clickable:
          // the click then leaves `save-intent{source:'button'}` plus
          // `save-failed{code:'no-request:not-dirty'}` in the log, so "I clicked
          // save and nothing happened" can never again be a dead end with no
          // evidence - the click, the intent and the refusal are all on disk.
          const saveDisabled = !editable || edit.phase === 'saving'
          return h('div', { className: 'dsh-ide-head' },
            h('span', { className: 'dsh-ide-head-title' }, t('codeTitle')),
            dirty ? h('span', { className: 'dsh-ide-dot', 'data-ide-dirty': 'true', title: t('saveHint') }) : null,
            h('span', { className: 'dsh-ide-head-text', title: activePath === '' ? undefined : activePath }, label),
            // The reference feedback line: one short sentence that removes itself
            // after 1.5 s. It lives beside the file label, not in a toast, so it
            // cannot cover the editor and cannot take focus.
            refHint === ''
              ? null
              : h('span', { className: 'dsh-ide-ref-hint', 'data-ide-ref-hint': '1' }, refHint),
            // Read progress: pages are 2000 lines, so a large file is several
            // requests and "nothing happened for two seconds" needs a number.
            readProgress === null
              ? null
              : h('span', {
                className: 'dsh-ide-status',
                'data-ide-read-progress': `${readProgress.page}/${readProgress.total}`,
              }, t('readingPages', { i: readProgress.page, n: readProgress.total })),
            activePath === '' ? null : h('span', null, t('lines', { n: page.lines ?? 0 })),
            h('span', null, formatBytes(page.bytes)),
            saveState === ''
              ? null
              : h('span', { className: 'dsh-ide-status', 'data-ide-save-state': edit.phase }, saveState),
            // The concrete reason behind a failed save (timeout, refused code,
            // missing version) used to live only in state; showing it is what
            // makes the saved/refused distinction actionable.
            edit.phase === 'error' && edit.detail !== ''
              ? h('span', { className: 'dsh-ide-head-text', 'data-ide-save-detail': '1' }, edit.detail)
              : null,
            h('button', {
              type: 'button',
              className: 'dsh-ide-btn',
              'data-ide-action': 'save',
              title: t('saveHint'),
              disabled: saveDisabled,
              onClick: () => {
                // Focus is read from the DOM: a click says nothing about it, and
                // the button can be clicked while the caret sits anywhere.
                enterSave('button', focusKindOf(typeof document === 'undefined' ? undefined : document.activeElement))
              },
            }, t('save')),
            h('span', { className: 'dsh-ide-head-title' }, editable ? t('editable') : t('readOnly')))
        })()

        // First frame: the panel has not been measured yet, so drawing columns
        // would paint a wrong width for one frame. The root element is still the
        // measured one, so the skeleton is exactly what the observer watches.
        //
        // Nothing else happens on this frame: no `flattenRows` (the memo returns
        // `EMPTY_ROWS`), no `<ChatColumn>`, hence no `renderFactorySlot` call
        // while the panel has no box yet - the earliest possible moment in the
        // render tree is also the least populated context, and the host factory
        // is the one call here that reaches into another plugin's surfaces.
        if (containerWidth === 0) {
          return h('div', {
            className: 'dsh-ide-root',
            'data-ide-root': '1',
            'data-ide-skeleton': '1',
            ref: rootRef,
          })
        }

        /**
         * The context menu itself: two actions plus a cancel row, positioned at
         * the pointer.
         *
         * `role="menu"` + `role="menuitem"` is what makes the arrow keys
         * meaningful to assistive tech; the roving `tabIndex` below is what makes
         * them work. The quote rows are disabled - not hidden - without a
         * selection: a menu that changes shape is harder to use than one that
         * says "select some code first".
         */
        const refMenuNode = refMenu === null ? null : (() => {
          const canQuote = refMenu.canQuote === true
          const rows = [
            {
              index: 0,
              action: 'insert',
              label: t('refMenuInsert'),
              disabled: canQuote !== true,
              nodeRef: refMenuInsertRef,
            },
            {
              index: 1,
              action: 'copy',
              label: t('refMenuCopy'),
              disabled: canQuote !== true,
              nodeRef: refMenuCopyRef,
            },
          ]
          // Which rows the arrow keys may land on: both quote rows need a
          // selection, cancel never does.
          const enabled = canQuote === true ? [0, 1, 2] : [2]
          const onKeyDown = (event) => {
            if (event === null || typeof event !== 'object') return
            if (event.key === 'Escape') {
              if (typeof event.preventDefault === 'function') event.preventDefault()
              if (typeof event.stopPropagation === 'function') event.stopPropagation()
              closeRefMenu()
              return
            }
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              if (typeof event.preventDefault === 'function') event.preventDefault()
              const at = enabled.indexOf(refMenuIndex)
              const step = event.key === 'ArrowDown' ? 1 : -1
              const next = enabled[(at < 0 ? 0 : at + step + enabled.length) % enabled.length]
              setRefMenuIndex(next)
              return
            }
            if (event.key === 'Enter' || event.key === ' ') {
              // `preventDefault` is what keeps the browser from also firing the
              // focused button's own click: one Enter, one action.
              if (typeof event.preventDefault === 'function') event.preventDefault()
              activateRefMenuRow(refMenuIndex)
            }
          }
          const item = (row, extra) => h('button', {
            key: row.action,
            type: 'button',
            role: 'menuitem',
            className: 'dsh-ide-ref-menu-item',
            'data-ide-ref-action': row.action,
            'data-ide-ref-focus': row.index === refMenuIndex ? 'true' : undefined,
            'aria-disabled': row.disabled === true ? 'true' : undefined,
            disabled: row.disabled === true,
            tabIndex: row.index === refMenuIndex ? 0 : -1,
            title: row.disabled === true ? t('refMenuDisabled') : undefined,
            ref: row.nodeRef,
            onClick: () => activateRefMenuRow(row.index),
            ...extra,
          }, row.label)
          return h('div', {
            className: 'dsh-ide-ref-menu',
            role: 'menu',
            'data-ide-ref-menu': '1',
            ref: refMenuRef,
            style: { left: `${refMenu.x}px`, top: `${refMenu.y}px` },
            onKeyDown,
            // A right click on the menu itself must not reopen it underneath.
            onContextMenu: (event) => {
              if (event !== null && typeof event === 'object' && typeof event.preventDefault === 'function') {
                event.preventDefault()
              }
            },
          },
          rows.map((row) => item(row)),
          h('div', { key: 'sep', className: 'dsh-ide-ref-menu-sep', role: 'separator' }),
          h('button', {
            key: 'cancel',
            type: 'button',
            role: 'menuitem',
            className: 'dsh-ide-ref-menu-item',
            'data-ide-ref-action': 'cancel',
            'data-ide-ref-focus': refMenuIndex === 2 ? 'true' : undefined,
            tabIndex: refMenuIndex === 2 ? 0 : -1,
            ref: refMenuCancelRef,
            onClick: () => activateRefMenuRow(2),
          }, t('refMenuCancel')))
        })()

        return h('div', {
          className: 'dsh-ide-root',
          'data-ide-root': '1',
          'data-ide-active': panelActive ? 'true' : 'false',
          'data-dragging': dragging ? 'true' : undefined,
          'data-ide-chat-surface': chatSurface,
          ref: rootRef,
          // No `onKeyDown` here on purpose: a handler scoped to this element only
          // fires while focus is somewhere inside the panel, which is precisely
          // the gap that made Ctrl+S do nothing. The shortcut lives on the
          // document (capture) for the lifetime of this mount instead - see the
          // listener registered right after `enterSave`.
        },
        h('div', { className: 'dsh-ide-top', 'data-ide-topbar': '1' },
          h('span', { className: 'dsh-ide-title', title: sessionTitle }, sessionTitle),
          // The bar holds one action only: entering and leaving IDE mode is the
          // whole of it. Quoting a selection lives in the editor's context menu,
          // because it acts on the editor (see "引用选区" in the README) and
          // because a permanent switch made a selection an action by itself.
          h('div', { className: 'dsh-ide-actions' },
            h('button', { type: 'button', className: 'dsh-ide-btn', 'data-ide-action': 'exit', onClick: exitIde }, t('exitIde')))),
        h('div', { className: 'dsh-ide-cols' },
          h('aside', {
            className: 'dsh-ide-col dsh-ide-col-tree',
            'data-ide-col': 'tree',
            'data-ide-width': layout.tree,
            style: { flex: `0 0 ${layout.tree}px`, width: `${layout.tree}px` },
          },
          h('div', { className: 'dsh-ide-head' },
            h('span', { className: 'dsh-ide-head-title' }, t('filesTitle')),
            h('span', { className: 'dsh-ide-head-text' }, rootLabel),
            h('button', {
              type: 'button',
              className: 'dsh-ide-icon-btn',
              title: t('refresh'),
              'aria-label': t('refresh'),
              onClick: refreshTree,
            }, h(IconRefresh, null))),
          treeBody),
          h(SplitHandle, {
            side: 'start',
            value: layout.tree,
            min: layout.treeMin,
            max: layout.treeMax,
            resetValue: TREE_DEFAULT,
            label: t('resizeTree'),
            hint: t('resizeHint'),
            onStart: () => setDragWidth((prev) => ({ ...prev, tree: layout.tree })),
            onChange: (next) => setDragWidth((prev) => ({ ...prev, tree: next })),
            onCommit: commitTree,
          }),
          h('section', { className: 'dsh-ide-col dsh-ide-col-code', 'data-ide-col': 'code' },
            infoBar,
            h('div', { className: 'dsh-ide-body' }, codeBody)),
          h(SplitHandle, {
            side: 'end',
            value: layout.chat,
            min: layout.chatMin,
            max: layout.chatMax,
            resetValue: CHAT_DEFAULT,
            label: t('resizeChat'),
            hint: t('resizeHint'),
            onStart: () => setDragWidth((prev) => ({ ...prev, chat: layout.chat })),
            onChange: (next) => setDragWidth((prev) => ({ ...prev, chat: next })),
            onCommit: commitChat,
          }),
          h('aside', {
            className: 'dsh-ide-col dsh-ide-col-chat',
            'data-ide-col': 'chat',
            'data-ide-width': layout.chat,
            style: { flex: `0 0 ${layout.chat}px`, width: `${layout.chat}px` },
          },
          h('div', { className: 'dsh-ide-head' }, h('span', { className: 'dsh-ide-head-title' }, t('chatTitle'))),
          h('div', { className: 'dsh-ide-chat-body' },
            h(ChatColumn, {
              t,
              sessionId,
              // The chat column's own fallback card ("go back to the chat") is a
              // degradation exit, not a second top-bar action: it leaves IDE mode
              // exactly like the one remaining button does.
              onBack: exitIde,
              renderFactorySlot,
              blank: currentSessionBlank === true,
            })))),
        // The "unsaved changes" confirm. A card inside this panel's own root, not
        // a modal framework: the panel is one slot entry inside the shell, and a
        // centered overlay would have to steal focus and escape handling from a
        // layer this plugin does not own.
        pending === null
          ? null
          : h('div', {
            className: 'dsh-ide-confirm',
            'data-ide-confirm': pending.kind,
            role: 'alertdialog',
            'aria-modal': 'false',
            'aria-label': t('confirmTitle'),
          },
          h('div', { className: 'dsh-ide-card' },
            h('div', { className: 'dsh-ide-card-title' }, t('confirmTitle')),
            h('div', null, pending.kind === 'switch'
              ? pending.restore === null || pending.restore === undefined
                ? t('confirmSwitch', { name: displayPath(pending.path, rootPath) || pending.path })
                : t('confirmRestore')
              : t('confirmLeave')),
            h('div', { className: 'dsh-ide-actions' },
              h('button', {
                type: 'button',
                className: 'dsh-ide-btn',
                'data-ide-action': 'confirm-discard',
                onClick: confirmDiscard,
              }, t('confirmDiscard')),
              h('button', {
                type: 'button',
                className: 'dsh-ide-btn',
                'data-ide-action': 'confirm-cancel',
                onClick: dismissPending,
              }, t('confirmCancel'))))),
        refMenuNode)
      }

      /**
       * Track one element's width.
       *
       * Starts at 0 ("not measured yet"), so the panel paints its skeleton for
       * the first frame instead of a viewport-guessed layout that jumps as soon
       * as the real width lands. The viewport is only the last resort, for an
       * element the platform cannot measure at all.
       * @param ref - ref holding the element.
       * @returns the current width in CSS pixels, 0 before the first measurement.
       */
      function useElementWidth(ref) {
        const [width, setWidth] = useState(0)
        useEffect(() => {
          const element = ref.current
          let frame = null
          const measure = () => {
            if (frame !== null) return
            frame = scheduleFrame(() => {
              frame = null
              let next = 0
              try {
                const rect = typeof element?.getBoundingClientRect === 'function' ? element.getBoundingClientRect() : undefined
                if (rect !== undefined && Number.isFinite(rect.width) && rect.width > 0) next = rect.width
              } catch {
                next = 0
              }
              if (next === 0) next = readViewportWidth()
              setWidth((prev) => (Math.abs(prev - next) < 1 ? prev : next))
            })
          }
          measure()
          let observer = null
          if (typeof ResizeObserver === 'function' && element !== null && element !== undefined) {
            observer = new ResizeObserver(measure)
            observer.observe(element)
          }
          window.addEventListener('resize', measure)
          return () => {
            if (frame !== null) cancelFrame(frame)
            if (observer !== null) observer.disconnect()
            window.removeEventListener('resize', measure)
          }
        }, [ref])
        return width
      }

      // -- the panel boundary (top-level net + circuit breaker) -------------

      /**
       * The active locale id, read live rather than through a hook.
       *
       * A class boundary cannot call hooks, and its card must still be localized;
       * this is the same snapshot `useT` reads, just not subscribed. Missing
       * service, blocked getter or an unexpected shape all read as `''`, which
       * `translateWith` maps to Chinese - the authored language of this panel.
       * @returns the active locale id, or ''.
       */
      const currentLocaleId = () => {
        try {
          const snapshot = localeFace?.getSnapshot?.()
          return typeof snapshot?.active === 'string' ? snapshot.active : ''
        } catch {
          return ''
        }
      }

      /**
       * Leave the panel from a crash card: exactly `ctx.get('layout').selectPanel(null)`,
       * resolved live (the face may have re-mounted since activation) and never
       * allowed to throw out of a click handler.
       */
      const selectConversationPanel = () => {
        const failure = trySelectPanel(resolveLayout(), null)
        if (failure !== undefined) {
          console.warn(`[${PLUGIN}] selectPanel(null) from the crash card failed:`, failure)
        }
      }

      /**
       * The component actually registered into `main` / key `ide`.
       *
       * React 18 unmounts the whole root for an uncaught render error, and the
       * shell's own slots are inside that root: one throw anywhere in this
       * panel's subtree (file tree, a width computation, a host factory, a store
       * hook that rejects its input) is a blank page, not a broken column. So the
       * panel is only ever rendered as this boundary's child, and the boundary:
       *
       * 1. catches with `getDerivedStateFromError` and **never rethrows** - the
       *    state it sets is what `render` paints, so React never unmounts;
       * 2. keeps the crash card: localized title, one sentence, the raw
       *    `name: message` on one copyable line, "retry" and "back to chat";
       * 3. is the circuit breaker: `componentDidCatch` writes a *versioned*
       *    record to {@link CRASH_KEY} (`{ version, message, ts, rev? }`), and a
       *    mount that finds a record whose `version` is this build's renders the
       *    card *without* mounting the child, so a reload cannot loop through the
       *    same crash into another blank page. A record written by any other
       *    build - or the bare `name: message` string older releases wrote - is
       *    discarded on read ({@link readCrashMark}), so an upgrade never needs a
       *    manual retry first. Only "retry" clears the mark and bumps `mount`,
       *    which remounts the child from scratch.
       */
      class IdePanelBoundary extends React.Component {
        constructor(props) {
          super(props)
          const mark = readCrashMark()
          this.state = {
            error: null,
            /** Crash detail found on entry: non-null means "do not mount the child". */
            haltedDetail: mark === null ? null : mark.message,
            /** Remount token; bumping it gives the child a new `key`. */
            mount: 0,
          }
          this.retry = this.retry.bind(this)
          this.backToChat = this.backToChat.bind(this)
        }

        static getDerivedStateFromError(error) {
          return { error: error ?? new Error('unknown error') }
        }

        componentDidMount() {
          // One line a user can copy out of the console when a report says
          // "it went white": what this renderer actually handed us.
          console.log(`[${PLUGIN}] panel mounted`, {
            version: PLUGIN_VERSION,
            hasUseSessions: typeof this.props?.useSessions === 'function',
            hasUsePanelInfo: typeof this.props?.usePanelInfo === 'function',
            hasRenderFactorySlot: typeof this.props?.renderFactorySlot === 'function',
            haltedByPreviousCrash: this.state.haltedDetail !== null,
          })
        }

        componentDidCatch(error) {
          const detail = describeCrash(error)
          console.error(`[${PLUGIN}] panel crashed`, error)
          writeCrashMark(detail)
          // The one event that explains a white panel: the boundary swallowed a
          // render throw, so nothing else on screen reports it.
          beacon('panel-crashed', {
            name: typeof error?.name === 'string' && error.name !== '' ? error.name : 'Error',
            message: truncateText(typeof error?.message === 'string' ? error.message : detail, 300),
          })
        }

        /** Clear the mark and remount the child (the only path back to the panel). */
        retry() {
          clearCrashMark()
          this.setState((prev) => ({ error: null, haltedDetail: null, mount: prev.mount + 1 }))
        }

        backToChat() {
          selectConversationPanel()
        }

        render() {
          const t = (key, vars) => translateWith(currentLocaleId(), key, vars)
          if (this.state.error !== null) {
            return renderCrashCard(t, {
              kind: 'crash',
              title: t('crashTitle'),
              hint: t('crashHint'),
              detail: describeCrash(this.state.error),
              onRetry: this.retry,
              onBack: this.backToChat,
            })
          }
          if (this.state.haltedDetail !== null) {
            return renderCrashCard(t, {
              kind: 'halted',
              title: t('crashHaltedTitle'),
              hint: t('crashHaltedHint'),
              detail: this.state.haltedDetail,
              onRetry: this.retry,
              onBack: this.backToChat,
            })
          }
          return h(IdePanel, { ...this.props, key: this.state.mount })
        }
      }

      // -- registrations ---------------------------------------------------
      ctx.effect(() => {
        const style = document.createElement('style')
        style.dataset.plugin = PLUGIN
        style.textContent = CSS
        document.head.appendChild(style)
        return () => {
          style.remove()
        }
      }, `${PLUGIN}: stylesheet`)

      ctx.effect(() => {
        const disposers = []
        try {
          disposers.push(ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
            name: 'conversation.session.header.utilities',
            id: `${PLUGIN}:toggle`,
            order: -20,
            registrant: PLUGIN,
          }, ToggleButton)))
          disposers.push(ctx.slots.inject('main', () => ctx.slots.register({
            name: 'main',
            key: PANEL_KEY,
            registrant: PLUGIN,
          }, IdePanelBoundary)))
        } catch (error) {
          console.error(`[${PLUGIN}] slot registration failed:`, error)
        }
        return () => {
          for (const dispose of disposers.reverse()) {
            try {
              dispose()
            } catch {
              // Teardown is best-effort.
            }
          }
          disposers.length = 0
        }
      }, `${PLUGIN}: slot registrations`)

      // Leaving the panel through the host's own UI must consume the record, so
      // the plugin never believes it is still in IDE mode. The store is resolved
      // here rather than pinned at apply; when it is absent the watcher is
      // skipped and `exit()` stays the path that consumes the record.
      ctx.effect(() => {
        const store = resolvePanelInfo()
        if (store === undefined) return () => {}
        let wasActive = isIdeActive()
        const off = store.subscribe(() => {
          const active = isIdeActive()
          if (wasActive && !active) {
            const sessions = [...restoreRecords.keys()]
            restoreRecords.clear()
            for (const id of sessions) patchSessionPrefs(id, { mode: 'conversation' })
          }
          wasActive = active
        })
        return () => {
          try {
            if (typeof off === 'function') off()
          } catch {
            // The layout face may already be gone.
          }
        }
      }, `${PLUGIN}: panel watcher`)

      // Unloading mid-mode restores the conversation and drops every pending write.
      ctx.effect(() => () => {
        for (const id of [...restoreRecords.keys()]) patchSessionPrefs(id, { mode: 'conversation' })
        restoreRecords.clear()
        // Last: writes the final blob and clears the coalescing timer, so no
        // timer survives this activation.
        flushPrefs()
        // Resolved now: the face may have mounted (or re-mounted) since apply.
        // A throw here is dropped - the layout service may already be unloaded,
        // and an unload has nowhere to report to.
        if (isIdeActive()) trySelectPanel(resolveLayout(), null)
      }, `${PLUGIN}: restore on unload`)

      // One copyable line at the *end* of activation, after the registrations
      // above: which half of the enter gate exists right now. When a report says
      // "the button does nothing", this line says whether it was the layout
      // service or the `main` registration - and it is expected to read
      // `layoutNow: false` on a host where `ui-layout` mounts later, because
      // every use re-resolves instead of trusting this snapshot.
      console.log(`[${PLUGIN}] gate at activation`, {
        version: PLUGIN_VERSION,
        layoutNow: typeof resolveLayout()?.selectPanel === 'function',
        panelNow: mainPanelRegistered(PANEL_KEY),
        canEnterNow: canEnter(),
      })

      // The same snapshot, for the disk log: a report that starts with "the
      // button did nothing" is answered here (which half of the enter gate
      // existed, whether the file face had been injected, which locale was
      // active) before the user is asked for anything else.
      beacon('activation', {
        version: PLUGIN_VERSION,
        layoutNow: typeof resolveLayout()?.selectPanel === 'function',
        panelNow: mainPanelRegistered(PANEL_KEY),
        canEnterNow: canEnter(),
        hasFilesFace: getFiles() !== undefined,
        locale: currentLocaleId(),
      })
    }

    /**
     * Read an optional client service without ever throwing.
     * @param ctx - client context.
     * @param name - service name.
     * @returns the service, or undefined.
     */
    function safeGet(ctx, name) {
      try {
        return ctx.get(name) ?? undefined
      } catch {
        return undefined
      }
    }

    /**
     * Absent sessions hook used when the entry received no `useSessions` prop.
     * Still a hook (one `useSyncExternalStore`), so the hook count is identical
     * on every render no matter which branch produced this render.
     * @returns undefined.
     */
    function useAbsentSessions() {
      useSyncExternalStore(ABSENT_SOURCE.subscribe, ABSENT_SOURCE.getSnapshot, ABSENT_SOURCE.getSnapshot)
      return undefined
    }

    /**
     * Absent panel-info hook used when the entry received no `usePanelInfo`
     * prop. Same contract as {@link useAbsentSessions}: exactly one
     * `useSyncExternalStore` whether or not the renderer supplied the prop.
     * @returns undefined.
     */
    function useAbsentPanelInfo() {
      useSyncExternalStore(ABSENT_SOURCE.subscribe, ABSENT_SOURCE.getSnapshot, ABSENT_SOURCE.getSnapshot)
      return undefined
    }

    /**
     * Select whether this plugin's panel is the active one.
     *
     * Returns a primitive, never an object: a selector that answers with a fresh
     * object would make `useSyncExternalStore` believe the snapshot changed on
     * every call. Shape misses (no argument, a different snapshot shape here)
     * read as `false`, and nothing is decided by the result.
     * @param snapshot - panel-info snapshot.
     * @returns whether `ide` is the active panel.
     */
    function selectIdePanelActive(snapshot) {
      try {
        const activePanelId = snapshot !== null && typeof snapshot === 'object' ? snapshot.activePanelId : undefined
        return (activePanelId ?? null) === PANEL_KEY
      } catch {
        return false
      }
    }

    return {
      // Only the slot service is a hard dependency: injecting `sessions`,
      // `locale` or `remote` would leave this fiber pending forever on a
      // composition that lacks a provider.
      inject: ['slots'],
      apply,
    }
  },
})
