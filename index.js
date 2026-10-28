/**
 * dsh-ide-mode — Host half.
 *
 * Two exact routes and nothing else:
 *
 * - `POST /dsh-ide-mode/write` - the one *workspace* write channel. The Client
 *   half still reads files through the harness's own authorized Remote
 *   namespace (`remote.workspaceFiles`); that namespace exposes no mutation, so
 *   saving an edited buffer needs exactly one Host-side write channel, and this
 *   is it.
 * - `POST /dsh-ide-mode/diag` - a **read-only diagnostic beacon**: the Client
 *   half POSTs one scalar-only event and the Host appends one JSONL line to
 *   `<os.tmpdir()>/dsh-ide-mode/diag.jsonl`. It never touches a workspace, never
 *   accepts a path, and never writes anywhere else; it exists because "the panel
 *   rendered up to step X" has to be readable from the host filesystem when
 *   nobody can open DevTools.
 *
 * Security has one home, here, and it is fail-closed at every step:
 *
 * 1. **Trust fence first.** `ctx.get('connection')` must exist, must expose
 *    `requestRejection`, and must answer `undefined` for this request. A missing
 *    service, a missing method, or a throw is a 503 — never an implicit allow.
 *    The fence is what defeats DNS rebinding, cross-site POSTs and unauthenticated
 *    callers before a single byte of the body is read.
 * 2. **Wire shape next.** `POST` only (else 405), `application/json` only (else
 *    415), a declared or streamed body over {@link MAX_BODY_BYTES} is 413, and a
 *    body that is not a JSON object with string `sessionId`/`path`/`content` is
 *    400.
 * 3. **Path containment.** The workspace base comes from the *session*, never
 *    from the request: `ctx.sessions.get(sessionId)` (an unknown id is 404, with
 *    no fallback directory) then `session.header.cwd` — the exact field the
 *    host's own file tree and every `workspaceFiles` call read, so a session
 *    whose working directory was changed writes into the tree the panel is
 *    showing. `ctx.workingDirectory.get()` is deliberately *not* used: it
 *    projects `stateOf(...) ?? process.cwd()`, which answers the deployment
 *    default for a session that has no cwd and would make the refusal below
 *    unreachable. A missing or non-absolute `cwd` is 409 `no-workspace`. The
 *    target is resolved through `ctx.fs.resolve(path, { cwd: root })` and
 *    accepted only when `ctx.fs.contains(rootTarget, target)` — the backend's
 *    canonical containment, so `..`, symlinks and absolute escapes are all
 *    refused with 403 by the same check.
 * 4. **Compare-and-swap.** The Client sends the `version` it read; the write
 *    carries `{ kind: 'replaceIfVersion', version }` as its `FsWriteIntent`, so a
 *    file that changed since that read fails with `FS_STALE_VERSION` (409) instead
 *    of clobbering the other writer. Only an explicit `force: true` (the user's
 *    "overwrite anyway" choice after a conflict) drops the guard, and even then
 *    the target must already exist (`ctx.fs.stat`): without an intent
 *    `writeText` would *create* a missing file, and this endpoint never creates
 *    files — a missing forced target is 404.
 * 5. **Sandbox on top.** The write carries
 *    `ctx.sandboxPolicy.resolve({ session })`, so a sandboxing filesystem backend
 *    fences it again by mode and workspace root — a second, independent gate
 *    behind the containment check, not a replacement for it.
 *
 * No service is a hard `inject` on the plugin itself: a profile without one of
 * them must still activate (the panel keeps working, read-only), so the routes
 * are mounted through `ctx.inject(['webServer'], …)` and every other face is
 * read live per request and reported as a 503 naming what is missing.
 *
 * The module imports only `node:` builtins (`node:os`, `node:path`,
 * `node:fs/promises`) for the beacon sink. This file is loaded by the Host's
 * plugin loader without a bundler, so a bare `@deepseek-ai/*` import here would
 * be a packaging accident rather than a dependency - and this is the Host half,
 * so node builtins are the supported surface (the Client half has none).
 *
 * @module dsh-ide-mode
 */

import os from 'node:os'
import nodePath from 'node:path'
import { appendFile, mkdir } from 'node:fs/promises'

/** Exact pathname of the one route this plugin registers. */
const WRITE_PATH = '/dsh-ide-mode/write'

/** Exact pathname of the read-only diagnostic beacon route. */
const DIAG_PATH = '/dsh-ide-mode/diag'

/** Hard ceiling on one request body (2 MiB): a text editor never needs more. */
const MAX_BODY_BYTES = 2 * 1024 * 1024

/** Hard ceiling on one diag request body (64 KiB): an event is a few hundred bytes. */
const DIAG_MAX_BODY_BYTES = 64 * 1024

/** Hard ceiling on the decoded content, so the body cap cannot be side-stepped. */
const MAX_CONTENT_BYTES = 2 * 1024 * 1024

/** Log prefix, identical to the Client half's. */
const PLUGIN = 'dsh-ide-mode'

// -- the diagnostic beacon: vocabulary and limits --------------------------

/**
 * The complete event vocabulary. Anything else is a 400: a diagnostic channel
 * with a free-form event name is a logging API, and this is not one.
 */
const DIAG_EVENTS = Object.freeze([
  'activation',
  'toggle-click',
  'enter-ok',
  'enter-failed',
  'panel-mounted',
  'panel-crashed',
  'chunk-load-ok',
  'chunk-load-failed',
  // Written by the Client *before* it reaches `saveNow`, so "the file did not
  // change and the log has no `save-*` line" can no longer be the whole story:
  // `source` names the entry (editor keymap, save button, document-level
  // shortcut), `focus` says where the caret was, and `hasDirty`/`hasVersion` are
  // the two preconditions the save itself checks.
  'save-intent',
  'save-ok',
  'save-failed',
  'conflict-shown',
  'file-open',
  'chat-fallback',
])

/** Membership test for {@link DIAG_EVENTS}. */
const DIAG_EVENT_SET = new Set(DIAG_EVENTS)

/** Longest accepted `data` key, in characters. */
const DIAG_MAX_KEY_CHARS = 64

/** Longest accepted `data` value, in characters (longer strings are truncated). */
const DIAG_MAX_VALUE_CHARS = 512

/** Budget for one serialized `data` object; past it, fields are dropped, not refused. */
const DIAG_MAX_DATA_CHARS = 8 * 1024

/** Sink directory name, directly under `os.tmpdir()`. */
const DIAG_DIR_NAME = 'dsh-ide-mode'

/** Sink file name inside that directory. */
const DIAG_FILE_NAME = 'diag.jsonl'

/** Consecutive sink failures after which the beacon is rate-limited. */
const DIAG_FAILURE_BURST = 3

/** How long one bucket of "at most one attempt" lasts once rate-limited. */
const DIAG_RETRY_AFTER_MS = 60 * 1000

/**
 * The node faces the beacon writes through.
 *
 * Exported for one reason: a test asserts the exact path shape and the failure
 * path without writing into the real temp directory (or without needing it to
 * be unwritable). Nothing in this module reads these lazily for any other
 * purpose, and no request can influence them - the client has no path input.
 * @type {{ tmpdir: () => string, join: (...parts: string[]) => string, mkdir: Function, appendFile: Function, now: () => number }}
 */
export const diagDeps = {
  tmpdir: () => os.tmpdir(),
  join: (...parts) => nodePath.join(...parts),
  mkdir: (dir, options) => mkdir(dir, options),
  appendFile: (file, text, options) => appendFile(file, text, options),
  now: () => Date.now(),
}

/** Consecutive sink failures, reset by the first success. */
let diagFailures = 0
/** Wall-clock instant before which the sink is not attempted again. */
let diagPausedUntil = 0
/** Serialized append chain: one line is never interleaved with the next. */
let diagQueue = Promise.resolve()

/**
 * The one file this plugin may ever write to.
 *
 * The Host decides it, always: `path.join(os.tmpdir(), 'dsh-ide-mode',
 * 'diag.jsonl')`. There is no path field on the wire and no fallback directory,
 * so no client can steer a write - not into a workspace, not into `.dsh`.
 * @returns {string} the absolute sink path.
 */
export function diagPath() {
  return diagDeps.join(diagDeps.tmpdir(), DIAG_DIR_NAME, DIAG_FILE_NAME)
}

/**
 * Append one already-serialized JSONL line, creating the directory first.
 *
 * `appendFile` is used deliberately: it is one `open(..., 'a')` + `write`, so a
 * concurrent reader tailing the file never sees a half-written line, and a
 * crashed process cannot truncate what earlier activations wrote.
 * @param {string} line - one JSON object, no newline.
 * @returns {Promise<void>} rejects when the sink is unusable.
 */
async function appendDiagLine(line) {
  const dir = diagDeps.join(diagDeps.tmpdir(), DIAG_DIR_NAME)
  await diagDeps.mkdir(dir, { recursive: true })
  await diagDeps.appendFile(diagPath(), `${line}\n`, { encoding: 'utf8' })
}

/**
 * Queue one append and report the outcome instead of throwing.
 *
 * Failure policy, in order: never throw (a diagnostic must not be able to fail
 * a request handler); answer `{ ok: false }` to the caller; and after
 * {@link DIAG_FAILURE_BURST} consecutive failures stop attempting for
 * {@link DIAG_RETRY_AFTER_MS} - a full disk or a locked temp directory must not
 * turn every beacon into an `EACCES` storm for the life of the process. The
 * first success resets both counters.
 * @param {string} line - one JSON object, no newline.
 * @returns {Promise<{ ok: true } | { ok: false, code: string, message: string }>} the outcome.
 */
function enqueueDiag(line) {
  const now = diagDeps.now()
  if (diagFailures >= DIAG_FAILURE_BURST && now < diagPausedUntil) {
    return Promise.resolve({
      ok: false,
      code: 'diag-throttled',
      message: `diag sink failed ${diagFailures} times; next attempt after the rate limit`,
    })
  }
  diagQueue = diagQueue.then(async () => {
    try {
      await appendDiagLine(line)
      diagFailures = 0
      diagPausedUntil = 0
      return { ok: true }
    } catch (error) {
      diagFailures += 1
      if (diagFailures >= DIAG_FAILURE_BURST) diagPausedUntil = diagDeps.now() + DIAG_RETRY_AFTER_MS
      return {
        ok: false,
        code: 'diag-write-failed',
        message: error instanceof Error ? error.message : String(error),
      }
    }
  })
  return diagQueue
}

/**
 * The `data` whitelist: scalar fields only, bounded, truncated rather than refused.
 *
 * Refusals (400) are shape violations a client bug produces: a nested object, an
 * array, a `null`, a key that is too long. Truncations are size problems: a long
 * string is cut at {@link DIAG_MAX_VALUE_CHARS}, and once the serialized form
 * would pass {@link DIAG_MAX_DATA_CHARS} the remaining fields are dropped and
 * counted in a `dropped` field, so a reader can tell "quiet" from "cut off".
 * @param {*} data - the request's `data` member, possibly absent.
 * @returns {{ ok: true, value: (object|undefined) } | { ok: false, message: string }} the verdict.
 */
function sanitizeDiagData(data) {
  if (data === undefined) return { ok: true, value: undefined }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, message: 'data must be a JSON object of scalar fields' }
  }
  const out = {}
  let dropped = 0
  let budget = DIAG_MAX_DATA_CHARS
  for (const [key, raw] of Object.entries(data)) {
    if (key.length > DIAG_MAX_KEY_CHARS) {
      return { ok: false, message: `data keys must be at most ${DIAG_MAX_KEY_CHARS} characters` }
    }
    let value
    if (typeof raw === 'string') {
      value = raw.length > DIAG_MAX_VALUE_CHARS ? raw.slice(0, DIAG_MAX_VALUE_CHARS) : raw
    } else if (typeof raw === 'number') {
      if (Number.isFinite(raw) !== true) return { ok: false, message: `data.${key} must be a finite number` }
      value = raw
    } else if (typeof raw === 'boolean') {
      value = raw
    } else {
      return { ok: false, message: `data.${key} must be a scalar (string, number or boolean)` }
    }
    const size = JSON.stringify({ [key]: value }).length
    if (size > budget) {
      dropped += 1
      continue
    }
    budget -= size
    out[key] = value
  }
  if (dropped > 0) out.dropped = dropped
  return { ok: true, value: out }
}

/**
 * Read one service without ever throwing.
 * @param {object} ctx - host context.
 * @param {string} name - service name.
 * @returns {*} the service, or undefined.
 */
function safeGet(ctx, name) {
  try {
    if (ctx === null || ctx === undefined || typeof ctx.get !== 'function') return undefined
    return ctx.get(name) ?? undefined
  } catch {
    return undefined
  }
}

/**
 * Send one JSON response. `no-store` because every answer describes live state.
 * @param {object} res - node response (or a test double).
 * @param {number} status - HTTP status.
 * @param {object} payload - JSON-serializable body.
 * @param {object} [options] - `close: true` asks the connection to be closed
 *   after this answer (used when a request body was deliberately not read).
 */
function sendJson(res, status, payload, options) {
  res.statusCode = status
  const close = options?.close === true
  if (typeof res.setHeader === 'function') {
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    if (close) res.setHeader('connection', 'close')
  }
  if (close && typeof res === 'object' && res !== null && 'shouldKeepAlive' in res) {
    try {
      res.shouldKeepAlive = false
    } catch {
      // A frozen response object: the header above is enough.
    }
  }
  res.end(JSON.stringify(payload))
}

/**
 * One failure in the documented wire shape.
 * @param {object} res - node response.
 * @param {number} status - HTTP status.
 * @param {string} code - stable machine code.
 * @param {string} message - one-line human explanation.
 * @param {object} [options] - forwarded to {@link sendJson} (`close`).
 */
function sendFailure(res, status, code, message, options) {
  sendJson(res, status, { ok: false, error: { code, message } }, options)
}

/**
 * The trust fence, fail-closed.
 *
 * Returns `{ ok: true }` only when the connection service is present, exposes
 * `requestRejection`, does not throw, and answers `undefined`. Everything else is
 * a refusal with the status to answer, so no call site can accidentally read a
 * missing service as "trusted".
 * @param {object} ctx - host context.
 * @param {object} req - node request.
 * @returns {{ ok: boolean, status?: number, message?: string }} the verdict.
 */
function trustCheck(ctx, req) {
  const connection = safeGet(ctx, 'connection')
  if (connection === null || connection === undefined) {
    return { ok: false, status: 503, message: 'connection service is unavailable' }
  }
  if (typeof connection.requestRejection !== 'function') {
    return { ok: false, status: 503, message: 'connection.requestRejection is unavailable' }
  }
  let rejection
  try {
    rejection = connection.requestRejection(req)
  } catch {
    return { ok: false, status: 503, message: 'connection.requestRejection threw' }
  }
  if (rejection !== undefined) {
    const status = typeof rejection === 'number' && rejection >= 400 && rejection <= 599 ? rejection : 403
    return { ok: false, status, message: 'request refused by the connection trust fence' }
  }
  return { ok: true }
}

/**
 * Read one request header as a trimmed lowercase string.
 * @param {object} req - node request.
 * @param {string} name - lowercase header name.
 * @returns {string} the header, or ''.
 */
function headerValue(req, name) {
  try {
    const headers = req?.headers
    if (headers === null || headers === undefined) return ''
    const raw = typeof headers[name] === 'string' ? headers[name] : headers[name]?.[0]
    return typeof raw === 'string' ? raw.trim() : ''
  } catch {
    return ''
  }
}

/**
 * Read a bounded UTF-8 body.
 *
 * The declared `content-length` is refused before a byte is buffered, and that
 * answer closes the connection: a lying header may announce gigabytes, so the
 * body cannot be drained here and a kept-alive socket would otherwise carry an
 * unread body into the next request.
 *
 * A streamed body that crosses the ceiling is a different case: an early
 * `return` out of `for await` **destroys** the request (node's async iterator
 * contract), so `req.resume()` afterwards is a no-op on a dead socket. The loop
 * therefore keeps consuming to the natural end of the stream, only stops
 * buffering, and answers 413 with the stream already drained.
 * @param {object} req - node request.
 * @param {number} [maxBytes] - ceiling for this route; defaults to the write route's.
 * @returns {Promise<{ ok: true, text: string } | { ok: false, status: number, close?: boolean }>} the body or a refusal.
 */
async function readBoundedBody(req, maxBytes = MAX_BODY_BYTES) {
  const ceiling = Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : MAX_BODY_BYTES
  const declared = Number.parseInt(headerValue(req, 'content-length'), 10)
  if (Number.isFinite(declared) && declared > ceiling) {
    try {
      req.resume?.()
    } catch {
      // Nothing to drain.
    }
    return { ok: false, status: 413, close: true }
  }
  const chunks = []
  let size = 0
  let overflow = false
  try {
    for await (const chunk of req) {
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
      size += buffer.byteLength
      if (size > ceiling) overflow = true
      // Keep looping past the ceiling (never `break`): the stream has to reach
      // its own end so this response can be written on a sane socket.
      else chunks.push(buffer)
    }
  } catch {
    return { ok: false, status: 400 }
  }
  if (overflow) return { ok: false, status: 413 }
  return { ok: true, text: Buffer.concat(chunks, size).toString('utf8') }
}

/**
 * Whether one path is absolute, in either Windows or POSIX spelling.
 *
 * The endpoint only ever *compares* this: the authoritative containment check
 * is still `ctx.fs.contains`, which canonicalizes through the backend. This gate
 * exists so a relative or blank `cwd` is a clean 409 instead of silently being
 * resolved against `process.cwd()`.
 * @param {string} value - candidate absolute path.
 * @returns {boolean} whether it is absolute.
 */
function isAbsolutePath(value) {
  return /^[A-Za-z]:[\\/]/u.test(value) || value.startsWith('/') || value.startsWith('\\\\')
}

/**
 * The workspace base of one session: `session.header.cwd`.
 *
 * This is the field the host's own file tree and every `workspaceFiles` call
 * read (`session.cwd` in the Client snapshot), so a session whose working
 * directory was changed resolves to the tree the panel actually shows.
 * `ctx.workingDirectory.get()` is deliberately not consulted: it projects
 * `stateOf(...) ?? process.cwd()`, i.e. it invents a directory for a session
 * without one, which would make {@link handleWrite}'s 409 unreachable and write
 * into the deployment directory instead.
 * @param {object} session - one live session record.
 * @returns {string} the absolute cwd, or '' when there is none.
 */
function sessionWorkspaceRoot(session) {
  let cwd
  try {
    cwd = session?.header?.cwd
  } catch {
    return ''
  }
  if (typeof cwd !== 'string') return ''
  const trimmed = cwd.trim()
  if (trimmed === '') return ''
  return isAbsolutePath(trimmed) ? trimmed : ''
}

/**
 * The services one write needs, read live.
 *
 * Listed by name so a refusal can say exactly which one is missing instead of
 * failing with a `TypeError` nobody can act on. `workingDirectory` is not in the
 * list: the workspace base comes from `session.header.cwd`, so a profile without
 * that projection can still save.
 * @param {object} ctx - host context.
 * @returns {{ missing: string[], fs: *, sessions: *, sandboxPolicy: * }} the faces.
 */
function writeServices(ctx) {
  const fs = safeGet(ctx, 'fs')
  const sessions = safeGet(ctx, 'sessions')
  const sandboxPolicy = safeGet(ctx, 'sandboxPolicy')
  const missing = []
  if (fs === undefined || typeof fs.resolve !== 'function' || typeof fs.contains !== 'function' || typeof fs.writeText !== 'function') {
    missing.push('fs')
  }
  if (sessions === undefined || typeof sessions.get !== 'function') missing.push('sessions')
  if (sandboxPolicy === undefined || typeof sandboxPolicy.resolve !== 'function') missing.push('sandboxPolicy')
  return { missing, fs, sessions, sandboxPolicy }
}

/**
 * HTTP status for one filesystem error code.
 *
 * `FS_NOT_REGULAR_FILE` maps to 400 on purpose: the request named something that
 * is not writable *text*, which is a bad request target rather than a permission
 * answer, and the Client's notice ("this file type cannot be saved") keys off the
 * 4xx class. The host's own `workspace-files` surface answers 403 for the same
 * code; that difference is deliberate and documented in the README's error-code
 * table, so do not "align" it here.
 * @param {string} code - `FsError.code`.
 * @returns {number} the status to answer.
 */
function statusForFsCode(code) {
  switch (code) {
    case 'FS_STALE_VERSION': return 409
    case 'FS_NOT_FOUND': return 404
    case 'FS_SANDBOX_DENIED': return 403
    case 'FS_PERMISSION_DENIED': return 403
    case 'FS_TOO_LARGE': return 413
    case 'FS_NOT_TEXT': return 415
    case 'FS_NOT_REGULAR_FILE': return 400
    case 'FS_IS_DIRECTORY': return 400
    case 'FS_NOT_DIRECTORY': return 400
    case 'FS_ABORTED': return 499
    default: return 500
  }
}

/**
 * Handle one write request.
 *
 * Never throws: the webserver answers an escaped handler error with a bare 400,
 * which a client cannot tell from a validation failure, so every path here ends
 * in an explicit JSON answer.
 * @param {object} ctx - host context (the route's owning context).
 * @param {object} req - node request.
 * @param {object} res - node response.
 * @returns {Promise<void>} after the response ended.
 */
async function handleWrite(ctx, req, res) {
  try {
    await runWrite(ctx, req, res)
  } catch (error) {
    try {
      if (res.headersSent === true) {
        res.destroy?.()
        return
      }
      sendFailure(res, 500, 'internal', error instanceof Error ? error.message : String(error))
    } catch {
      // The socket is already gone; nothing left to answer.
    }
  }
}

/**
 * The write handler proper; {@link handleWrite} owns the throw barrier.
 * @param {object} ctx - host context.
 * @param {object} req - node request.
 * @param {object} res - node response.
 * @returns {Promise<void>} after the response ended.
 */
async function runWrite(ctx, req, res) {
  // 1. trust fence, before anything is read
  const trust = trustCheck(ctx, req)
  if (trust.ok !== true) {
    sendFailure(res, trust.status ?? 503, 'untrusted', trust.message ?? 'request refused')
    return
  }

  // 2. method
  if (req.method !== 'POST') {
    if (typeof res.setHeader === 'function') res.setHeader('allow', 'POST')
    sendFailure(res, 405, 'method-not-allowed', 'this endpoint accepts POST only')
    return
  }

  // 3. media type
  const contentType = headerValue(req, 'content-type').split(';', 1)[0]?.trim().toLowerCase() ?? ''
  if (contentType !== 'application/json') {
    sendFailure(res, 415, 'unsupported-media-type', 'content-type must be application/json')
    return
  }

  // 4. body, bounded
  const body = await readBoundedBody(req)
  if (body.ok !== true) {
    if (body.status === 413) {
      sendFailure(res, 413, 'payload-too-large', 'request body exceeds 2 MiB', { close: body.close === true })
    } else {
      sendFailure(res, 400, 'bad-request', 'request body is unreadable')
    }
    return
  }

  // 5. JSON shape
  let payload
  try {
    payload = JSON.parse(body.text)
  } catch {
    sendFailure(res, 400, 'bad-request', 'request body is not valid JSON')
    return
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    sendFailure(res, 400, 'bad-request', 'request body must be a JSON object')
    return
  }
  const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : ''
  const filePath = typeof payload.path === 'string' ? payload.path : ''
  const content = typeof payload.content === 'string' ? payload.content : undefined
  const version = typeof payload.version === 'string' ? payload.version : ''
  const force = payload.force === true
  if (sessionId === '' || filePath === '') {
    sendFailure(res, 400, 'bad-request', 'sessionId and path must be non-empty strings')
    return
  }
  if (content === undefined) {
    sendFailure(res, 400, 'bad-request', 'content must be a string')
    return
  }
  if (Buffer.byteLength(content, 'utf8') > MAX_CONTENT_BYTES) {
    sendFailure(res, 413, 'payload-too-large', 'content exceeds 2 MiB')
    return
  }
  if (force !== true && version === '') {
    sendFailure(res, 400, 'bad-request', 'version is required for a guarded write')
    return
  }

  // 6. every service the write needs, named when absent
  const services = writeServices(ctx)
  if (services.missing.length > 0) {
    sendFailure(res, 503, 'service-unavailable', `missing host service: ${services.missing.join(', ')}`)
    return
  }

  // 7. the session decides the workspace base; an unknown id is a 404, never a default
  let session
  try {
    session = services.sessions.get(sessionId)
  } catch {
    session = undefined
  }
  if (session === null || session === undefined) {
    sendFailure(res, 404, 'session-not-found', `no live session with id ${sessionId}`)
    return
  }
  // `session.header.cwd` — the same base the panel's tree and every
  // `workspaceFiles` call are addressed with. No `workingDirectory` projection
  // and no deployment default: a session without an absolute cwd cannot be
  // written to at all.
  const root = sessionWorkspaceRoot(session)
  if (root === '') {
    sendFailure(
      res,
      409,
      'no-workspace',
      'this session has no absolute session.header.cwd, so there is no workspace to write into',
    )
    return
  }

  // 8. path containment: resolve through the backend, then ask the backend
  let rootTarget
  let target
  try {
    rootTarget = await services.fs.resolve(root, { cwd: root })
    target = await services.fs.resolve(filePath, { cwd: root })
  } catch (error) {
    const code = typeof error?.code === 'string' ? error.code : ''
    sendFailure(res, statusForFsCode(code), code === '' ? 'resolve-failed' : code, error?.message ?? 'path could not be resolved')
    return
  }
  if (rootTarget === undefined || target === undefined) {
    sendFailure(res, 400, 'resolve-failed', 'path could not be resolved')
    return
  }
  let contained = false
  try {
    contained = services.fs.contains(rootTarget, target) === true
  } catch {
    contained = false
  }
  if (!contained) {
    sendFailure(res, 403, 'outside-workspace', 'path is outside this session\'s workspace')
    return
  }

  // 9. the per-call sandbox policy, resolved from the session (never the wire)
  let policy
  try {
    policy = services.sandboxPolicy.resolve({ session })
  } catch {
    sendFailure(res, 503, 'sandbox-unavailable', 'sandbox policy could not be resolved for this session')
    return
  }

  // 10. a forced write must still target a file that exists.
  //
  // `writeText` without an `FsWriteIntent` *creates* a missing target. The
  // panel only ever saves a file it has read, and this endpoint must not become
  // a "create any file inside the workspace" primitive, so `force` proves
  // existence first through the same backend (`ctx.fs.stat`, i.e. the host's own
  // resolve-then-stat surface).
  const controller = typeof AbortController === 'function' ? new AbortController() : undefined
  if (force === true) {
    if (typeof services.fs.stat !== 'function') {
      sendFailure(
        res,
        503,
        'service-unavailable',
        'missing host service: fs.stat (required to confirm that a forced target exists)',
      )
      return
    }
    let info
    try {
      info = await services.fs.stat(target, controller?.signal)
    } catch (error) {
      const code = typeof error?.code === 'string' ? error.code : ''
      sendFailure(res, statusForFsCode(code), code === '' ? 'stat-failed' : code, error?.message ?? 'target could not be inspected')
      return
    }
    if (info === undefined || info === null) {
      sendFailure(res, 404, 'not-found', 'the forced target does not exist; this endpoint never creates files')
      return
    }
  }

  // 11. compare-and-swap write
  const expected = force === true ? undefined : { kind: 'replaceIfVersion', version }
  let outcome
  try {
    outcome = await services.fs.writeText(target, content, expected, controller?.signal, policy)
  } catch (error) {
    const code = typeof error?.code === 'string' ? error.code : ''
    const status = statusForFsCode(code)
    sendFailure(res, status, code === '' ? 'write-failed' : code, error?.message ?? 'write failed')
    return
  }

  const after = typeof outcome?.after === 'string' ? outcome.after : content
  sendJson(res, 200, {
    ok: true,
    value: {
      version: typeof outcome?.version === 'string' ? outcome.version : '',
      bytes: Buffer.byteLength(after, 'utf8'),
      operation: typeof outcome?.operation === 'string' ? outcome.operation : 'update',
    },
  })
}

/**
 * Handle one diagnostic beacon.
 *
 * Same throw barrier as {@link handleWrite}: the webserver answers an escaped
 * handler error with a bare 400, which a client cannot tell from a validation
 * failure, so every path ends in an explicit JSON answer.
 * @param {object} ctx - host context (the route's owning context).
 * @param {object} req - node request.
 * @param {object} res - node response.
 * @param {string} rev - the activation token written on every line.
 * @returns {Promise<void>} after the response ended.
 */
async function handleDiag(ctx, req, res, rev) {
  try {
    await runDiag(ctx, req, res, rev)
  } catch (error) {
    try {
      if (res.headersSent === true) {
        res.destroy?.()
        return
      }
      sendFailure(res, 500, 'internal', error instanceof Error ? error.message : String(error))
    } catch {
      // The socket is already gone; nothing left to answer.
    }
  }
}

/**
 * The beacon handler proper; {@link handleDiag} owns the throw barrier.
 *
 * The front half is deliberately the *same* sequence as {@link runWrite} -
 * trust fence, POST, `application/json`, bounded body, JSON shape - because the
 * beacon is a route on the same listener and must not be the softer door. Only
 * the body ceiling (64 KiB), the payload shape (a whitelisted event plus scalar
 * `data`) and the sink differ. Two consequences worth stating:
 *
 * - **No path, no session, no workspace.** The sink path comes from
 *   {@link diagPath} alone; `sessionId`/`path` are not read even if present, and
 *   this endpoint never consults `fs`/`sessions`/`sandboxPolicy`, so it cannot
 *   be turned into a write primitive for a workspace or for `.dsh`.
 * - **A failing sink is answered, not thrown.** `{ ok: false }` with 200: the
 *   request was well-formed and accepted; the sink is the only thing that
 *   failed, and the client ignores the body anyway (it is fire-and-forget).
 * @param {object} ctx - host context.
 * @param {object} req - node request.
 * @param {object} res - node response.
 * @param {string} rev - the activation token written on every line.
 * @returns {Promise<void>} after the response ended.
 */
async function runDiag(ctx, req, res, rev) {
  // 1. trust fence, before anything is read
  const trust = trustCheck(ctx, req)
  if (trust.ok !== true) {
    sendFailure(res, trust.status ?? 503, 'untrusted', trust.message ?? 'request refused')
    return
  }

  // 2. method
  if (req.method !== 'POST') {
    if (typeof res.setHeader === 'function') res.setHeader('allow', 'POST')
    sendFailure(res, 405, 'method-not-allowed', 'this endpoint accepts POST only')
    return
  }

  // 3. media type
  const contentType = headerValue(req, 'content-type').split(';', 1)[0]?.trim().toLowerCase() ?? ''
  if (contentType !== 'application/json') {
    sendFailure(res, 415, 'unsupported-media-type', 'content-type must be application/json')
    return
  }

  // 4. body, bounded to 64 KiB
  const body = await readBoundedBody(req, DIAG_MAX_BODY_BYTES)
  if (body.ok !== true) {
    if (body.status === 413) {
      sendFailure(res, 413, 'payload-too-large', 'request body exceeds 64 KiB', { close: body.close === true })
    } else {
      sendFailure(res, 400, 'bad-request', 'request body is unreadable')
    }
    return
  }

  // 5. JSON shape: `{ event, data? }` and nothing that matters
  let payload
  try {
    payload = JSON.parse(body.text)
  } catch {
    sendFailure(res, 400, 'bad-request', 'request body is not valid JSON')
    return
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    sendFailure(res, 400, 'bad-request', 'request body must be a JSON object')
    return
  }
  const event = typeof payload.event === 'string' ? payload.event : ''
  if (event === '') {
    sendFailure(res, 400, 'bad-request', 'event must be a non-empty string')
    return
  }
  if (DIAG_EVENT_SET.has(event) !== true) {
    sendFailure(res, 400, 'unknown-event', `unknown diagnostic event: ${event.slice(0, 64)}`)
    return
  }
  const data = sanitizeDiagData(payload.data)
  if (data.ok !== true) {
    sendFailure(res, 400, 'bad-request', data.message)
    return
  }

  // 6. one JSONL line: ts / pid / rev / event / data
  const record = {
    ts: new Date().toISOString(),
    pid: process.pid,
    rev,
    event,
  }
  if (data.value !== undefined) record.data = data.value
  const line = JSON.stringify(record)
  // The DevTools counterpart, kept on purpose: a user who *can* open the console
  // gets the same event, in the same order, to compare against the file.
  console.log(`[${PLUGIN}] diag`, event, data.value)

  // 7. the sink never throws and never affects anything but this answer
  const outcome = await enqueueDiag(line)
  if (outcome.ok === true) {
    sendJson(res, 200, { ok: true })
    return
  }
  sendJson(res, 200, { ok: false, error: { code: outcome.code, message: outcome.message } })
}

/**
 * Host activation.
 *
 * Both routes are mounted on a child fiber that waits for `webServer` only, so a
 * profile without it leaves this plugin loaded instead of pending. Every other
 * service is read per request by {@link runWrite} and answered with a 503 naming
 * it, which keeps the panel usable (read-only) on a partial composition. The
 * diagnostic route needs nothing but `webServer`.
 * @param {object} ctx - host context.
 * @returns {void}
 */
export function apply(ctx) {
  /**
   * Register the routes on whichever context currently owns `webServer`.
   * @param {object} host - context that carries the service.
   */
  const mount = (host) => {
    // One token per *activation*, so every line of one page session can be told
    // apart from the previous one in the same process (the Host process outlives
    // a page reload). Short and opaque on purpose: it is a correlation key.
    const rev = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    try {
      host.effect(() => {
        const server = safeGet(host, 'webServer')
        if (server === undefined || typeof server.register !== 'function') {
          console.warn(`[${PLUGIN}] endpoints not mounted: webServer.register is unavailable`)
          return () => {}
        }
        const disposers = []
        const register = (path, handler, label) => {
          try {
            const dispose = server.register({ kind: 'exact', path, handler })
            if (typeof dispose === 'function') disposers.push(dispose)
          } catch (error) {
            console.error(`[${PLUGIN}] ${label} endpoint registration failed:`, error)
          }
        }
        // Order matters for the smoke harness and for a reader of the log: the
        // workspace write channel is the primary route, the beacon is secondary.
        register(WRITE_PATH, (req, res) => handleWrite(host, req, res), 'write')
        register(DIAG_PATH, (req, res) => handleDiag(host, req, res, rev), 'diag')
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
      }, `${PLUGIN}: endpoints`)
    } catch (error) {
      console.error(`[${PLUGIN}] endpoint activation failed:`, error)
    }
  }

  try {
    if (typeof ctx.inject === 'function') {
      // A child fiber: a profile without `webServer` never blocks this plugin.
      ctx.inject(['webServer'], (sub) => mount(sub))
      return
    }
  } catch (error) {
    console.error(`[${PLUGIN}] webServer injection failed:`, error)
  }
  mount(ctx)
}

/** Route path, exported for tests and for documentation cross-checks. */
export const writePath = WRITE_PATH

/** Beacon route path, exported for tests and for documentation cross-checks. */
export const diagRoutePath = DIAG_PATH

/** The event vocabulary, exported so documentation and tests cannot drift. */
export const diagEvents = DIAG_EVENTS

