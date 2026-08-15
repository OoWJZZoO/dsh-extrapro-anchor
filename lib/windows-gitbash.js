/**
 * Windows Git Bash adaptation helpers for the extrapro-anchor experiment.
 *
 * On Windows the harness's default shell stack is PowerShell (`pwsh`). The
 * anchor trajectory is sampled from a bash surface, and in practice the model
 * drifts back to `let me` when the catalog contains `pwsh` but no `bash`.
 * When Git Bash is installed AND injection is enabled, the host plugin:
 *
 *   1. registers a small foreground `bash` tool backed by the detected
 *      `bash.exe`, and
 *   2. removes `pwsh` from the model-facing tool schemas for anchored
 *      sessions, leaving `bash` in its place.
 *
 * This module has no Cordis imports and is unit-testable.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { isAbsolute, resolve, win32 } from 'node:path'

/** Env override for tests and unusual Git Bash install locations. */
export const GIT_BASH_PATH_ENV = 'DSH_EXTRAPRO_ANCHOR_GIT_BASH_PATH'

/** Short, neutral description for the experimental bash tool. */
export const GIT_BASH_TOOL_DESCRIPTION =
  'Execute a bash command in Git Bash and return its stdout/stderr. ' +
  'Each call runs in a fresh shell; state does not persist between calls. ' +
  'Non-zero exits are reported as [exit code: N].'

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

/** Render the collected stdout/stderr of a foreground bash run. */
export function renderGitBashResult(result) {
  const out = String(result.stdout ?? '')
  const err = String(result.stderr ?? '')
  let body = out
  if (err.length > 0) {
    if (body.length > 0 && !body.endsWith('\n')) body += '\n'
    body += `[stderr]\n${err}`
  }
  if (body.length === 0) body = '(no output)'
  const markers = []
  if (result.timedOut) markers.push(`[timed out after ${result.timeoutMs ?? 60000}ms]`)
  if (result.signal) markers.push(`[killed by signal: ${result.signal}]`)
  else if (result.exitCode !== 0) markers.push(`[exit code: ${result.exitCode}]`)
  if (markers.length === 0) return body
  if (!body.endsWith('\n')) body += '\n'
  return body + markers.join('\n')
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
 * Run one command with the detected Git Bash. This is deliberately small: it
 * is the experimental Windows bridge, not a replacement for the harness's
 * managed bash executor (no sandbox, no background jobs, no spill files).
 */
export function runGitBashCommand(bashPath, args, exec) {
  return new Promise((resolve) => {
    const command = typeof args.command === 'string' ? args.command.trim() : ''
    const workdir = resolveGitBashWorkdir(args.workdir, exec)
    const timeoutMs = Number.isFinite(args.timeoutMs) && args.timeoutMs > 0
      ? args.timeoutMs
      : 60000
    let settled = false
    const settle = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    let child
    try {
      child = spawn(bashPath, ['-c', command], { cwd: workdir, env: process.env, windowsHide: true })
    } catch (error) {
      settle({ infrastructureError: String((error && error.message) || error) })
      return
    }
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
    }, timeoutMs)
    const onAbort = () => {
      if (!child.killed) child.kill('SIGTERM')
    }
    if (exec?.signal) {
      if (exec.signal.aborted) onAbort()
      else exec.signal.addEventListener('abort', onAbort, { once: true })
    }
    child.stdout?.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr?.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      exec?.signal?.removeEventListener('abort', onAbort)
      settle({ infrastructureError: String((error && error.message) || error) })
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      exec?.signal?.removeEventListener('abort', onAbort)
      settle({ stdout, stderr, exitCode: code, signal, timedOut, timeoutMs })
    })
  })
}

/**
 * Build a registry-ready `bash` tool definition (the shape `ctx.tools.register`
 * accepts) backed by the detected Git Bash executable.
 */
export function createGitBashToolDefinition({ bashPath, timeoutMs = 60000 } = {}) {
  if (typeof bashPath !== 'string' || bashPath.length === 0) {
    throw new Error('windows-gitbash: bashPath must be a non-empty string')
  }
  return {
    name: 'bash',
    description: GIT_BASH_TOOL_DESCRIPTION,
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
          description: 'Clear, concise description of what this command does in active voice, 5-10 words (shown in the UI).',
        },
        timeoutMs: {
          type: 'number',
          description: `Timeout in milliseconds. Defaults to ${timeoutMs}.`,
        },
        workdir: {
          type: 'string',
          description: 'Working directory for this command. Defaults to the session workspace.',
        },
      },
      required: ['command', 'description'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          stdout: { type: 'string' },
          stderr: { type: 'string' },
          exitCode: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
          signal: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          timedOut: { type: 'boolean' },
          timeoutMs: { type: 'number' },
        },
        required: ['stdout', 'stderr', 'exitCode', 'signal', 'timedOut', 'timeoutMs'],
      },
      render(_args, value) {
        return [{ type: 'text', text: renderGitBashResult(value) }]
      },
    },
    async execute(args, exec) {
      if (typeof args.command !== 'string' || args.command.trim().length === 0) {
        throw new Error('invalid command: expected a non-empty string')
      }
      if (typeof args.description !== 'string' || args.description.trim().length === 0) {
        throw new Error('invalid description: expected a non-empty string')
      }
      const result = await runGitBashCommand(bashPath, args, exec)
      if (result.infrastructureError) throw new Error(`bash spawn failed: ${result.infrastructureError}`)
      return result
    },
  }
}
