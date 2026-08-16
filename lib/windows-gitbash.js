/**
 * Windows Git Bash adaptation helpers for the extrapro-anchor experiment.
 *
 * On Windows the harness's default shell stack is PowerShell (`pwsh`). The
 * anchor trajectory is sampled from a bash surface, and in practice the model
 * drifts back to `let me` when the catalog contains `pwsh` but no `bash`.
 * When Git Bash is installed AND injection is enabled, the host plugin:
 *
 *   1. registers a `bash` tool backed by the detected `bash.exe`, and
 *   2. removes `pwsh` from the model-facing tool schemas for anchored
 *      sessions, leaving `bash` in its place.
 *
 * The call flow mirrors `@deepseek-ai/dsh-tool-bash`:
 *
 *   - `startGitBashProcess()` returns a live process handle (readOutput /
 *     cancel / done), shared by both execution modes;
 *   - foreground execution (`runGitBashCommand`) adds timeout and tool-call
 *     abort handling on top of that handle;
 *   - background execution registers the handle with the generic `ctx.jobs`
 *     runtime, so `job_output` / `job_kill` control it and completion notices
 *     are delivered by `@deepseek-ai/dsh-tool-jobs`.
 *
 * The model-facing schema advertises ONLY what this backend actually
 * implements:
 *
 *   - fresh-shell execution with an explicit/relative `workdir`,
 *   - a validated foreground timeout that kills the command on expiry
 *     (process-tree kill on Windows),
 *   - managed `$DSH_*` environment facts when the harness `shellEnv` service
 *     is available (ambient `DSH_*` values are discarded, exactly like the
 *     native bash executor),
 *   - per-stream tail truncation with a full-output spill file,
 *   - `run_in_background` when `enableRunInBackground` is enabled.
 *
 * It deliberately does NOT advertise file-sandbox escalation
 * (`sandbox_permissions` / `justification`) because this backend never runs
 * through the harness sandbox. Unsupported calls are still rejected
 * explicitly so a stale or adversarial argument fails loudly.
 *
 * This module has no Cordis imports and is unit-testable; the optional
 * `jobs` service is passed in as an accessor from `lib/index.js`.
 */
import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve, win32 } from 'node:path'

/** Env override for tests and unusual Git Bash install locations. */
export const GIT_BASH_PATH_ENV = 'DSH_EXTRAPRO_ANCHOR_GIT_BASH_PATH'

/** Default foreground timeout, in milliseconds. */
export const GIT_BASH_DEFAULT_TIMEOUT_MS = 60000

/**
 * Per-stream in-memory tail cap and per-stream full-output spill cap. These
 * mirror the native shell executor's configured defaults (64000 bytes /
 * 64 MiB) so oversized Windows Git Bash output behaves like the Linux bash
 * tool the anchor trajectory was sampled from.
 */
export const GIT_BASH_MAX_OUTPUT_BYTES = 64000
export const GIT_BASH_MAX_SPILL_BYTES = 64 * 1024 * 1024

let gitBashSpillDir
let streamSpillCounter = 0

/** Lazily create the private, per-process directory that holds spill files. */
function gitBashSpillDirectory() {
  if (gitBashSpillDir === undefined) {
    gitBashSpillDir = mkdtempSync(join(tmpdir(), 'dsh-extrapro-anchor-bash-'))
  }
  return gitBashSpillDir
}

/**
 * Model-facing description for the compatibility bash tool. It is built from
 * the capabilities the backend really has: managed `$DSH_*` facts are only
 * claimed when `ctx.shellEnv` can supply them, and `run_in_background` is
 * only claimed while background execution is enabled.
 */
export function gitBashToolDescription({ managedDshEnv = false, backgroundEnabled = true } = {}) {
  const dshEnv = managedDshEnv
    ? 'Current harness environment facts are exposed through managed `$DSH_*` variables; inspect them when needed. '
    : ''
  const background = backgroundEnabled
    ? 'Set `run_in_background: true` for long-running commands: the call returns a job id immediately; read its output with `job_output` and stop it with `job_kill`. '
    : 'Background execution is not available; long-running commands must finish within the timeout, which kills the command on expiry. '
  return 'Execute a bash command (`bash -c`) in Git Bash and return its stdout/stderr. ' +
    'Each call runs in a fresh shell: no state (cwd, variables, functions) persists between calls — pass `workdir` instead of using `cd`. ' +
    'Non-zero exits are reported as `[exit code: N]`. ' +
    dshEnv +
    'Long output is truncated to its tail; the full output is saved to a file whose path is reported when available. ' +
    'This Windows compatibility tool does not sandbox file operations, so there is no `sandbox_permissions` escalation. ' +
    background
}

/** The default honest description (background on, no managed `$DSH_*` claim). */
export const GIT_BASH_TOOL_DESCRIPTION = gitBashToolDescription()

/**
 * Candidate `bash.exe` locations on Windows: standard Git install roots plus
 * every `bash.exe` reachable through PATH entries.
 */
export function gitBashCandidates(env = process.env) {
  const candidates = []
  const seen = new Set()
  const push = (candidate) => {
    if (typeof candidate !== 'string' || candidate.length === 0) return
    if (seen.has(candidate)) return
    seen.add(candidate)
    candidates.push(candidate)
  }
  const pushRoot = (root) => {
    if (typeof root !== 'string' || root.trim().length === 0) return
    push(win32.join(root.trim(), 'Git', 'bin', 'bash.exe'))
    push(win32.join(root.trim(), 'Git', 'usr', 'bin', 'bash.exe'))
  }
  pushRoot(env.ProgramFiles)
  pushRoot(env['ProgramFiles(x86)'])
  pushRoot(env.ProgramW6432)
  if (typeof env.LOCALAPPDATA === 'string' && env.LOCALAPPDATA.trim().length > 0) {
    pushRoot(win32.join(env.LOCALAPPDATA.trim(), 'Programs'))
  }
  for (const entry of (env.PATH ?? env.Path ?? '').split(';')) {
    const trimmed = entry.trim()
    if (trimmed.length === 0) continue
    // PATH may point at the exact bin directory or at an install root.
    push(win32.join(trimmed, 'bash.exe'))
    pushRoot(trimmed)
  }
  return candidates
}

/**
 * Locate a usable Git Bash executable. The override env var wins when it
 * points at an existing file; otherwise the standard install locations and
 * PATH are probed. Returns `undefined` on non-Windows platforms or when Git
 * Bash is not installed.
 */
export function findGitBash({ env = process.env, platform = process.platform, exists = existsSync } = {}) {
  const override = env[GIT_BASH_PATH_ENV]
  if (typeof override === 'string' && override.trim().length > 0) {
    const candidate = override.trim()
    return exists(candidate) ? candidate : undefined
  }
  if (platform !== 'win32') return undefined
  for (const candidate of gitBashCandidates(env)) {
    if (exists(candidate)) return candidate
  }
  return undefined
}

/** Remove every tool whose name matches `name`. */
export function withoutToolNamed(tools, name) {
  if (!Array.isArray(tools)) return tools
  return tools.filter((tool) => tool?.name !== name)
}

/** Keep every tool except the host `pwsh` shell. */
export function dropPwshTool(tools) {
  return withoutToolNamed(tools, 'pwsh')
}

/** Hide the experimental `bash` tool when injection is OFF. */
export function hideBashTool(tools) {
  return withoutToolNamed(tools, 'bash')
}

/** Shared per-stream output schema for the registered tool. */
export const GIT_BASH_STREAM_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    text: { type: 'string' },
    truncated: { type: 'boolean' },
    spillPath: { type: 'string' },
  },
  required: ['text', 'truncated'],
})

/** Render one collected stdout/stderr stream, including its truncation marker. */
export function renderGitBashStream(stream) {
  // String input is accepted for callers that already decoded a stream.
  if (typeof stream === 'string') return stream
  if (stream === undefined || stream === null) return ''
  const text = String(stream.text ?? '')
  if (stream.truncated !== true) return text
  const marker = typeof stream.spillPath === 'string' && stream.spillPath.length > 0
    ? `[output truncated; full output: ${stream.spillPath}]`
    : '[output truncated]'
  return text.length === 0 ? marker : `${text}\n${marker}`
}

/** Render the collected stdout/stderr of a foreground Git Bash run. */
export function renderGitBashResult(result) {
  const out = renderGitBashStream(result.stdout)
  const err = renderGitBashStream(result.stderr)
  let body = out
  if (err.length > 0) {
    if (body.length > 0 && !body.endsWith('\n')) body += '\n'
    body += `[stderr]\n${err}`
  }
  if (body.length === 0) body = '(no output)'
  const markers = []
  if (result.timedOut) markers.push(`[timed out after ${result.timeoutMs ?? GIT_BASH_DEFAULT_TIMEOUT_MS}ms]`)
  if (result.signal) markers.push(`[killed by signal: ${result.signal}]`)
  else if (result.exitCode !== 0) markers.push(`[exit code: ${result.exitCode}]`)
  if (markers.length === 0) return body
  if (!body.endsWith('\n')) body += '\n'
  return body + markers.join('\n')
}

/**
 * Shape one background-process read into the `job_output` delta the model
 * sees: the incremental stdout/stderr text plus a lossy-read notice when the
 * in-memory tail window already slid past the caller's read position.
 */
export function renderGitBashProcessRead(read) {
  if (read === undefined || read === null) return ''
  const text = String(read.delta ?? '')
  if (read.lossy !== true) return text
  const paths = [read.stdoutSpillPath, read.stderrSpillPath].filter((path) => typeof path === 'string' && path.length > 0)
  const notice = `[some output was dropped from memory; full output: ${paths.length > 0 ? paths.join(', ') : '(unavailable)'}]`
  return `${text}${text.length > 0 && !text.endsWith('\n') ? '\n' : ''}${notice}`
}

/**
 * Split a rendered foreground result back into the terminal body and the exit
 * marker (`[exit code: N]` / `[killed by signal: X]` / `[timed out ...]`).
 * This is the tiny local twin of the harness's shared `parseExitStatus`, used
 * only by `presentResult` so this module can stay harness-free.
 */
export function parseGitBashExitStatus(raw) {
  let body = String(raw ?? '')
  let exitCode
  let signal
  let timedOut
  const strip = (pattern, apply) => {
    const match = body.match(pattern)
    if (!match) return false
    apply(match)
    body = body.slice(0, match.index).replace(/\n+$/, '')
    return true
  }
  strip(/\[exit code: (-?\d+)\]$/u, (match) => {
    exitCode = Number(match[1])
  })
  strip(/\[killed by signal: ([^\]]+)\]$/u, (match) => {
    signal = match[1]
  })
  strip(/\[timed out after (\d+)ms\]$/u, () => {
    timedOut = true
  })
  return {
    body,
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(signal !== undefined ? { signal } : {}),
    ...(timedOut !== undefined ? { timedOut } : {}),
  }
}

/**
 * Resolve the working directory like the harness bash tool does: an explicit
 * relative `workdir` is session-workspace-relative, and a missing `workdir`
 * defaults to the session cwd (`agent.session.header.cwd`) — never to the DSH
 * process cwd, which on Windows is the user's home directory and would make
 * the first real bash call contradict the virtual turn's `pwd`.
 */
export function resolveGitBashWorkdir(workdir, exec) {
  const sessionCwd = exec?.agent?.session?.header?.cwd
  const modelWorkdir = typeof workdir === 'string' && workdir.trim().length > 0 ? workdir.trim() : undefined
  if (modelWorkdir === undefined) {
    return typeof sessionCwd === 'string' && sessionCwd.length > 0 ? sessionCwd : process.cwd()
  }
  if (typeof sessionCwd === 'string' && sessionCwd.length > 0 && !isAbsolute(modelWorkdir)) {
    return resolve(sessionCwd, modelWorkdir)
  }
  return modelWorkdir
}

/**
 * Build the environment for one Git Bash spawn. When the harness provides a
 * managed `DSH_*` snapshot, ambient `DSH_*` values are discarded first so only
 * the trusted snapshot reaches the command — the same contract the native bash
 * executor applies. Without a snapshot, the parent environment is passed
 * through untouched (and the schema does not advertise `$DSH_*`).
 */
export function buildGitBashEnv(dshEnv) {
  if (dshEnv === undefined || dshEnv === null) return process.env
  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    if (key.startsWith('DSH_')) delete env[key]
  }
  for (const [key, value] of Object.entries(dshEnv)) {
    if (!key.startsWith('DSH_') || typeof value !== 'string') {
      throw new Error(`windows-gitbash: managed shell env must map DSH_* keys to strings, got ${JSON.stringify(key)}`)
    }
    env[key] = value
  }
  return env
}

/**
 * One bounded output stream: keeps the in-memory TAIL up to `maxBytes` and,
 * once that cap is crossed, appends the complete stream to a private spill
 * file (up to `maxSpillBytes`). A stream that outgrows the spill cap discards
 * the now-incomplete spill and keeps only the marked truncated tail.
 * `readFrom(offset)` supports incremental background reads; `finalize()` seals
 * the spill file for the foreground result and is idempotent.
 */
function createStreamCollector(label, {
  maxBytes = GIT_BASH_MAX_OUTPUT_BYTES,
  maxSpillBytes = GIT_BASH_MAX_SPILL_BYTES,
} = {}) {
  let chunks = []
  let bytes = 0
  let total = 0
  let dropped = false
  let spillFd
  let spillFile
  let spillDisabled = false
  let finalized = false
  let finalStream

  const discardSpill = () => {
    const fd = spillFd
    const file = spillFile
    spillFd = undefined
    spillFile = undefined
    spillDisabled = true
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        // The file is no longer advertised; an unclosable fd is not fatal.
      }
    }
    if (file !== undefined) {
      try {
        unlinkSync(file)
      } catch {
        // Best effort only — never fail command execution over cleanup.
      }
    }
  }

  const spillAll = (chunk) => {
    if (total > maxSpillBytes) {
      discardSpill()
      return
    }
    try {
      if (spillFd === undefined) {
        spillFile = join(
          gitBashSpillDirectory(),
          `dsh-extrapro-anchor-bash-${process.pid}-${++streamSpillCounter}-${randomBytes(6).toString('hex')}-${label}.log`,
        )
        spillFd = openSync(spillFile, 'wx', 0o600)
        for (const prior of chunks) writeSync(spillFd, prior)
      }
      writeSync(spillFd, chunk)
    } catch {
      discardSpill()
    }
  }

  return {
    push(chunk) {
      if (finalized) return
      total += chunk.length
      const overflows = bytes + chunk.length > maxBytes
      if (!spillDisabled && (overflows || spillFd !== undefined)) spillAll(chunk)
      chunks.push(chunk)
      bytes += chunk.length
      while (bytes > maxBytes) {
        const head = chunks[0]
        const excess = bytes - maxBytes
        if (head.length <= excess) {
          chunks.shift()
          bytes -= head.length
        } else {
          chunks[0] = head.subarray(excess)
          bytes -= excess
        }
        dropped = true
      }
    },
    readFrom(fromByte) {
      const windowStart = total - bytes
      const buffer = Buffer.concat(chunks)
      const lossy = fromByte < windowStart
      return {
        text: (lossy ? buffer : buffer.subarray(Math.max(0, fromByte - windowStart))).toString('utf8'),
        nextOffset: total,
        lossy,
        ...(spillFile !== undefined ? { spillPath: spillFile } : {}),
      }
    },
    finalize() {
      if (finalized) return finalStream
      if (spillFd !== undefined) {
        try {
          closeSync(spillFd)
        } catch {
          // A failed close means the file may miss its tail: stop advertising it.
          spillFile = undefined
        }
        spillFd = undefined
      }
      finalStream = {
        text: Buffer.concat(chunks).toString('utf8'),
        truncated: dropped,
        ...(spillFile !== undefined ? { spillPath: spillFile } : {}),
      }
      finalized = true
      return finalStream
    },
  }
}

/**
 * Terminate the spawned Git Bash process. On Windows this force-kills the
 * whole process tree (`taskkill /T /F`) because killing `bash.exe` alone can
 * leave grandchildren running; on POSIX it falls back to a direct SIGTERM.
 */
function terminateGitBashProcess(child, { platform = process.platform } = {}) {
  if (child.exitCode !== null || child.signalCode !== null) return
  if (platform === 'win32') {
    try {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      })
    } catch {
      // taskkill is best effort; the direct kill below remains the fallback.
    }
  }
  try {
    child.kill('SIGTERM')
  } catch {
    // The process may have exited between the check and the signal.
  }
}

/**
 * Start one Git Bash command and return a live process handle shared by the
 * foreground and background execution modes. No timeout is applied here:
 * foreground callers layer one on top, background jobs are untimed.
 *
 * The handle mirrors the `ShellProcess` contract consumed by `ctx.jobs`:
 * `readOutput()` returns one consuming delta (stdout first, then stderr under
 * a `[stderr]` marker), `kill()` is idempotent, and `done` always resolves
 * with `{ status: 'completed' | 'killed' | 'failed', detail }`.
 */
export function startGitBashProcess(bashPath, {
  command,
  workdir,
  env,
  platform = process.platform,
} = {}) {
  if (typeof command !== 'string' || command.trim().length === 0) {
    throw new Error('invalid command: expected a non-empty string')
  }
  const stdoutCollector = createStreamCollector('stdout')
  const stderrCollector = createStreamCollector('stderr')
  const child = spawn(bashPath, ['-c', command.trim()], {
    cwd: workdir,
    env,
    windowsHide: true,
  })

  const handle = {
    status: 'running',
    exitCode: null,
    signal: null,
    stdoutOffset: 0,
    stderrOffset: 0,
    spawnFailureNote: undefined,
    done: null,
  }
  let settleDone
  let settled = false
  handle.done = new Promise((resolveDone) => {
    settleDone = resolveDone
  })

  const finalizeCollectors = () => {
    handle.stdoutFinal = stdoutCollector.finalize()
    handle.stderrFinal = stderrCollector.finalize()
  }

  const settle = (outcome) => {
    if (settled) return
    settled = true
    finalizeCollectors()
    settleDone(outcome)
  }

  handle.readOutput = () => {
    const out = stdoutCollector.readFrom(handle.stdoutOffset)
    const err = stderrCollector.readFrom(handle.stderrOffset)
    handle.stdoutOffset = out.nextOffset
    handle.stderrOffset = err.nextOffset
    let errText = err.text
    if (errText.length === 0 && handle.spawnFailureNote !== undefined) {
      errText = handle.spawnFailureNote
      handle.spawnFailureNote = undefined
    }
    const separator = out.text.length > 0 && !out.text.endsWith('\n') ? '\n' : ''
    return {
      delta: out.text + (errText.length > 0 ? `${separator}[stderr]\n${errText}` : ''),
      lossy: out.lossy || err.lossy,
      ...(out.spillPath !== undefined ? { stdoutSpillPath: out.spillPath } : {}),
      ...(err.spillPath !== undefined ? { stderrSpillPath: err.spillPath } : {}),
    }
  }

  handle.kill = () => {
    if (handle.status !== 'running') return false
    handle.status = 'killed'
    terminateGitBashProcess(child, { platform })
    return true
  }

  handle.result = () => ({
    stdout: handle.stdoutFinal,
    stderr: handle.stderrFinal,
    exitCode: handle.exitCode,
    signal: handle.signal,
  })

  child.stdout?.on('data', (chunk) => {
    stdoutCollector.push(chunk)
  })
  child.stderr?.on('data', (chunk) => {
    stderrCollector.push(chunk)
  })
  child.on('error', (error) => {
    if (settled) return
    handle.status = 'failed'
    const note = `spawn failed: ${String((error && error.message) || error)}`
    handle.spawnFailureNote = note
    settle({ status: 'failed', detail: note })
  })
  child.on('close', (code, signal) => {
    if (settled) return
    handle.exitCode = code
    handle.signal = signal
    if (handle.status === 'running') handle.status = signal !== null ? 'killed' : 'completed'
    const detail = handle.status === 'killed'
      ? (signal !== null ? `signal: ${signal}` : 'killed before exit')
      : `exit code: ${code ?? 0}`
    settle({ status: handle.status, detail })
  })

  return handle
}

/**
 * Run one foreground command with the detected Git Bash. This builds on
 * `startGitBashProcess` and adds the foreground-only concerns: `timeoutMs`,
 * the tool-call abort signal, and the final foreground result DTO. It has no
 * sandbox and no background jobs — see the tool definition for those paths.
 */
export async function runGitBashCommand(
  bashPath,
  args,
  exec,
  {
    dshEnv,
    defaultTimeoutMs = GIT_BASH_DEFAULT_TIMEOUT_MS,
    platform = process.platform,
  } = {},
) {
  const command = typeof args.command === 'string' ? args.command.trim() : ''
  const workdir = resolveGitBashWorkdir(args.workdir, exec)
  const configuredDefault =
    Number.isFinite(defaultTimeoutMs) && defaultTimeoutMs > 0
      ? defaultTimeoutMs
      : GIT_BASH_DEFAULT_TIMEOUT_MS
  const timeoutMs =
    Number.isFinite(args.timeoutMs) && args.timeoutMs > 0 ? args.timeoutMs : configuredDefault
  let env
  try {
    env = buildGitBashEnv(dshEnv)
  } catch (error) {
    return { infrastructureError: String((error && error.message) || error) }
  }
  let handle
  try {
    handle = startGitBashProcess(bashPath, { command, workdir, env, platform })
  } catch (error) {
    return { infrastructureError: String((error && error.message) || error) }
  }

  let timedOut = false
  let aborted = false
  const timer = setTimeout(() => {
    timedOut = true
    handle.kill()
  }, timeoutMs)
  const onAbort = () => {
    aborted = true
    handle.kill()
  }
  if (exec?.signal) {
    if (exec.signal.aborted) onAbort()
    else exec.signal.addEventListener('abort', onAbort, { once: true })
  }

  const outcome = await handle.done
  clearTimeout(timer)
  exec?.signal?.removeEventListener('abort', onAbort)
  if (outcome.status === 'failed') return { infrastructureError: outcome.detail }
  return {
    kind: 'foreground',
    ...handle.result(),
    timedOut,
    aborted,
    timeoutMs,
  }
}

/** The plain fallback for "tool call aborted" when harness constants are absent. */
function defaultAbortedError() {
  const error = new Error('tool call aborted')
  error.name = 'AbortError'
  return error
}

/**
 * Build a registry-ready `bash` tool definition (the shape `ctx.tools.register`
 * accepts) backed by the detected Git Bash executable. The advertised schema
 * is the honest foreground + background surface described at the top of this
 * module; background execution goes through the caller-provided `getJobs`
 * accessor, evaluated at execution time exactly like `dsh-tool-bash` does.
 */
export function createGitBashToolDefinition({
  bashPath,
  timeoutMs = GIT_BASH_DEFAULT_TIMEOUT_MS,
  shellEnv,
  getJobs,
  makeAbortedError = defaultAbortedError,
  backgroundEnabled = true,
} = {}) {
  if (typeof bashPath !== 'string' || bashPath.length === 0) {
    throw new Error('windows-gitbash: bashPath must be a non-empty string')
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('windows-gitbash: timeoutMs must be a positive finite number')
  }
  const collectDshEnv =
    shellEnv && typeof shellEnv.collect === 'function'
      ? (exec) => shellEnv.collect(exec)
      : undefined
  const runInBackgroundEnabled = backgroundEnabled !== false
  const resolveJobs = typeof getJobs === 'function' ? getJobs : () => undefined
  const abortError = typeof makeAbortedError === 'function' ? makeAbortedError : defaultAbortedError

  return {
    name: 'bash',
    description: gitBashToolDescription({
      managedDshEnv: collectDshEnv !== undefined,
      backgroundEnabled: runInBackgroundEnabled,
    }),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        command: {
          type: 'string',
          description: 'The bash command to execute.',
        },
        description: {
          type: 'string',
          description: 'Clear, concise description of what this command does in active voice, 5-10 words (shown in the UI). Examples: "ls" → "List files in current directory"; "git status" → "Show working tree status"; "npm install" → "Install package dependencies".',
        },
        timeoutMs: {
          type: 'number',
          description: `Timeout in milliseconds. Defaults to ${timeoutMs}; the command is killed on expiry.`,
        },
        workdir: {
          type: 'string',
          description: 'Working directory for this command. Defaults to the session workspace; a relative path is resolved against it.',
        },
        ...(runInBackgroundEnabled
          ? {
              run_in_background: {
                type: 'boolean',
                description: 'Run in the background and return a job id immediately (collect with job_output, stop with job_kill). No timeout applies.',
              },
            }
          : {}),
      },
      required: ['command', 'description'],
    },
    output: {
      schema: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', const: 'background' },
              jobId: { type: 'string' },
            },
            required: ['kind', 'jobId'],
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', const: 'foreground' },
              stdout: GIT_BASH_STREAM_SCHEMA,
              stderr: GIT_BASH_STREAM_SCHEMA,
              exitCode: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
              signal: { oneOf: [{ type: 'string' }, { type: 'null' }] },
              timedOut: { type: 'boolean' },
              aborted: { type: 'boolean' },
              timeoutMs: { type: 'number' },
            },
            required: ['kind', 'stdout', 'stderr', 'exitCode', 'signal', 'timedOut', 'aborted', 'timeoutMs'],
          },
        ],
      },
      render(_args, value) {
        if (value?.kind === 'background') {
          return [{ type: 'text', text: `started background job ${value.jobId}` }]
        }
        return [{ type: 'text', text: renderGitBashResult(value) }]
      },
    },
    presentCall(args) {
      if (args.run_in_background === true) {
        return {
          card: 'generic',
          title: args.command,
          kind: 'execute',
          rawInput: args.command,
          content: [{ type: 'text', text: args.description }],
        }
      }
      return {
        card: 'terminal',
        title: args.command,
        description: args.description,
        ...(args.workdir !== undefined ? { cwd: args.workdir } : {}),
      }
    },
    presentResult(args, result) {
      const block = Array.isArray(result?.content) ? result.content[0] : undefined
      if (block === undefined || block.type !== 'text') return undefined
      const raw = block.text
      if (args?.run_in_background === true || result?.isError === true) {
        return {
          card: 'generic',
          content: [{ type: 'text', text: `\`\`\`console\n${raw.replace(/\n+$/, '')}\n\`\`\`` }],
        }
      }
      const { body, ...exit } = parseGitBashExitStatus(raw)
      return {
        card: 'terminal',
        output: body,
        ...exit,
      }
    },
    async execute(args, exec) {
      if (typeof args.command !== 'string' || args.command.trim().length === 0) {
        throw new Error('invalid command: expected a non-empty string')
      }
      if (typeof args.description !== 'string' || args.description.trim().length === 0) {
        throw new Error('invalid description: expected a non-empty string')
      }
      if (args.timeoutMs !== undefined && (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0)) {
        throw new Error(`invalid timeoutMs: expected a positive number, got ${JSON.stringify(args.timeoutMs)}`)
      }
      if (args.sandbox_permissions !== undefined || args.justification !== undefined) {
        throw new Error('sandbox_permissions is not available for the Windows Git Bash compatibility tool; this backend does not sandbox commands')
      }
      const dshEnv = collectDshEnv ? collectDshEnv(exec) : undefined
      if (args.run_in_background === true) {
        if (!runInBackgroundEnabled) throw new Error('background execution is disabled for this bash tool')
        if (exec?.signal?.aborted) throw abortError()
        const jobs = resolveJobs()
        if (jobs === undefined || jobs === null) {
          throw new Error('background jobs unavailable: load @deepseek-ai/dsh-jobs and @deepseek-ai/dsh-tool-jobs')
        }
        const command = args.command.trim()
        const workdir = resolveGitBashWorkdir(args.workdir, exec)
        let env
        try {
          env = buildGitBashEnv(dshEnv)
        } catch (error) {
          throw new Error(`bash environment failed: ${String((error && error.message) || error)}`)
        }
        return {
          kind: 'background',
          jobId: jobs.start({
            kind: 'bash',
            label: command,
            ...(exec?.agent ? { owner: exec.agent } : {}),
            run: () => {
              const handle = startGitBashProcess(bashPath, { command, workdir, env })
              return {
                cancel: () => {
                  handle.kill()
                },
                done: handle.done,
                readOutput: () => renderGitBashProcessRead(handle.readOutput()),
              }
            },
          }),
        }
      }
      const result = await runGitBashCommand(bashPath, args, exec, {
        dshEnv,
        defaultTimeoutMs: timeoutMs,
      })
      if (result.infrastructureError) throw new Error(`bash spawn failed: ${result.infrastructureError}`)
      if (result.aborted) throw abortError()
      return result
    },
  }
}
