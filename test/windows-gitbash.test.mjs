import assert from 'node:assert/strict'
import test, { after, before } from 'node:test'
import { existsSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  GIT_BASH_DEFAULT_TIMEOUT_MS,
  GIT_BASH_MAX_OUTPUT_BYTES,
  GIT_BASH_PATH_ENV,
  GIT_BASH_TOOL_DESCRIPTION,
  buildGitBashEnv,
  createGitBashToolDefinition,
  dropPwshTool,
  findGitBash,
  gitBashCandidates,
  gitBashToolDescription,
  hideBashTool,
  parseGitBashExitStatus,
  renderGitBashProcessRead,
  renderGitBashResult,
  renderGitBashStream,
  resolveGitBashWorkdir,
  runGitBashCommand,
  startGitBashProcess,
  withoutToolNamed,
} from '../lib/windows-gitbash.js'
import { apply } from '../lib/index.js'

const originalPlatform = process.platform
const originalGitBashEnv = process.env[GIT_BASH_PATH_ENV]
const realBash = existsSync('/bin/bash') ? '/bin/bash' : undefined

before(() => {
  // `process.platform` is normally read-only; the descriptor is configurable,
  // so tests can pin the win32 branch and restore it afterwards.
  Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
})

after(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
  if (originalGitBashEnv === undefined) delete process.env[GIT_BASH_PATH_ENV]
  else process.env[GIT_BASH_PATH_ENV] = originalGitBashEnv
})

// Minimal fake of ctx.jobs: enough for the producer contract (spec.run() →
// { cancel, done, readOutput }) exercised by the background path.
function makeJobs() {
  const started = []
  return {
    started,
    start(spec) {
      const record = { id: `bash-${started.length + 1}`, spec, hooks: spec.run() }
      started.push(record)
      return record.id
    },
  }
}

test('gitBashCandidates probes standard install roots and PATH entries', () => {
  const candidates = gitBashCandidates({
    ProgramFiles: 'C:\\Program Files',
    'ProgramFiles(x86)': 'C:\\Program Files (x86)',
    LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local',
    PATH: 'C:\\Git\\bin;C:\\tools',
  })
  assert.ok(candidates.includes('C:\\Program Files\\Git\\bin\\bash.exe'))
  assert.ok(candidates.includes('C:\\Program Files\\Git\\usr\\bin\\bash.exe'))
  assert.ok(candidates.includes('C:\\Program Files (x86)\\Git\\bin\\bash.exe'))
  assert.ok(candidates.includes('C:\\Users\\u\\AppData\\Local\\Programs\\Git\\bin\\bash.exe'))
  assert.ok(candidates.includes('C:\\Git\\bin\\bash.exe'))
  assert.ok(candidates.includes('C:\\tools\\Git\\bin\\bash.exe'))
  // Deduplicated and PATH order preserved.
  assert.equal(new Set(candidates).size, candidates.length)
})

test('findGitBash honors the override, requires win32, and returns undefined when absent', () => {
  const exists = (path) => path === 'C:\\Git\\bash.exe'
  assert.equal(findGitBash({ env: { [GIT_BASH_PATH_ENV]: 'C:\\Git\\bash.exe' }, platform: 'win32', exists }), 'C:\\Git\\bash.exe')
  assert.equal(findGitBash({ env: { [GIT_BASH_PATH_ENV]: 'C:\\Git\\missing.exe' }, platform: 'win32', exists }), undefined)
  assert.equal(findGitBash({ env: {}, platform: 'linux', exists }), undefined)
  assert.equal(findGitBash({ env: {}, platform: 'win32', exists: () => false }), undefined)
})

test('tool name filters drop exactly the requested shell', () => {
  const tools = [{ name: 'pwsh' }, { name: 'bash' }, { name: 'read' }]
  assert.deepEqual(dropPwshTool(tools).map((tool) => tool.name), ['bash', 'read'])
  assert.deepEqual(hideBashTool(tools).map((tool) => tool.name), ['pwsh', 'read'])
  assert.deepEqual(withoutToolNamed(tools, 'read').map((tool) => tool.name), ['pwsh', 'bash'])
  assert.equal(dropPwshTool(undefined), undefined)
})

test('gitBashToolDescription advertises background honestly and still no sandbox escalation', () => {
  assert.match(GIT_BASH_TOOL_DESCRIPTION, /in Git Bash/)
  assert.match(GIT_BASH_TOOL_DESCRIPTION, /run_in_background/)
  assert.match(GIT_BASH_TOOL_DESCRIPTION, /job_output/ && /job_kill/)
  assert.match(GIT_BASH_TOOL_DESCRIPTION, /does not sandbox file operations/)
  assert.match(GIT_BASH_TOOL_DESCRIPTION, /no `sandbox_permissions` escalation/)
  assert.doesNotMatch(GIT_BASH_TOOL_DESCRIPTION, /escalate immediately|wider mode would let it succeed|approval prompt/)
  assert.doesNotMatch(GIT_BASH_TOOL_DESCRIPTION, /\$DSH_\*/)
  assert.match(gitBashToolDescription({ managedDshEnv: true }), /\$DSH_\*/)
  assert.match(gitBashToolDescription({ backgroundEnabled: false }), /Background execution is not available/)
  assert.doesNotMatch(gitBashToolDescription({ backgroundEnabled: false }), /run_in_background/)
})

test('buildGitBashEnv keeps ambient env alone and replaces ambient DSH_* with the managed snapshot', () => {
  assert.equal(buildGitBashEnv(undefined), process.env)
  process.env.DSH_EXTRAPRO_TEST = 'ambient'
  try {
    const env = buildGitBashEnv({ DSH_EXTRAPRO_TEST: 'managed' })
    assert.notEqual(env, process.env)
    assert.equal(env.DSH_EXTRAPRO_TEST, 'managed')
    assert.equal(env.PATH, process.env.PATH)
  } finally {
    delete process.env.DSH_EXTRAPRO_TEST
  }
  assert.throws(() => buildGitBashEnv({ NOT_DSH: 'x' }), /must map DSH_\* keys to strings/)
  assert.throws(() => buildGitBashEnv({ DSH_BAD: 1 }), /must map DSH_\* keys to strings/)
})

test('renderGitBashResult renders stdout, stderr, and exit markers', () => {
  assert.equal(renderGitBashResult({ stdout: 'ok\n', stderr: '', exitCode: 0, signal: null, timedOut: false }), 'ok\n')
  assert.equal(renderGitBashResult({ stdout: '', stderr: '', exitCode: 0, signal: null, timedOut: false }), '(no output)')
  assert.equal(
    renderGitBashResult({ stdout: 'out', stderr: 'err', exitCode: 1, signal: null, timedOut: false }),
    'out\n[stderr]\nerr\n[exit code: 1]',
  )
  assert.match(
    renderGitBashResult({ stdout: '', stderr: '', exitCode: null, signal: 'SIGTERM', timedOut: true, timeoutMs: 1234 }),
    /timed out after 1234ms/,
  )
})

test('renderGitBashStream reports truncation and the spill path', () => {
  assert.equal(renderGitBashStream('plain'), 'plain')
  assert.equal(renderGitBashStream({ text: 'tail', truncated: false }), 'tail')
  assert.equal(renderGitBashStream({ text: 'tail', truncated: true }), 'tail\n[output truncated]')
  assert.equal(
    renderGitBashStream({ text: 'tail', truncated: true, spillPath: 'C:\\tmp\\out.log' }),
    'tail\n[output truncated; full output: C:\\tmp\\out.log]',
  )
})

test('renderGitBashProcessRead marks lossy background reads with the spill path', () => {
  assert.equal(renderGitBashProcessRead({ delta: 'next', lossy: false }), 'next')
  assert.equal(
    renderGitBashProcessRead({ delta: 'tail', lossy: true, stdoutSpillPath: 'C:\\tmp\\stdout.log' }),
    'tail\n[some output was dropped from memory; full output: C:\\tmp\\stdout.log]',
  )
  assert.equal(
    renderGitBashProcessRead({ delta: '', lossy: true }),
    '[some output was dropped from memory; full output: (unavailable)]',
  )
})

test('parseGitBashExitStatus splits the rendered body from exit markers', () => {
  assert.deepEqual(parseGitBashExitStatus('out\n[stderr]\nerr\n[exit code: 1]'), {
    body: 'out\n[stderr]\nerr',
    exitCode: 1,
  })
  assert.deepEqual(parseGitBashExitStatus('x\n[timed out after 100ms]\n[killed by signal: SIGTERM]'), {
    body: 'x',
    signal: 'SIGTERM',
    timedOut: true,
  })
  assert.deepEqual(parseGitBashExitStatus('clean output'), { body: 'clean output' })
})

test('resolveGitBashWorkdir defaults to the session cwd and resolves relative paths against it', () => {
  const exec = { agent: { session: { header: { cwd: '/work/proj' } } } }
  assert.equal(resolveGitBashWorkdir(undefined, exec), '/work/proj')
  assert.equal(resolveGitBashWorkdir('sub/dir', exec), join('/work/proj', 'sub/dir'))
  assert.equal(resolveGitBashWorkdir('/abs/dir', exec), '/abs/dir')
  assert.equal(resolveGitBashWorkdir(undefined, undefined), process.cwd())
})

test('createGitBashToolDefinition advertises dual-mode schema and rejects unsupported calls', async () => {
  const definition = createGitBashToolDefinition({ bashPath: 'C:\\Git\\bin\\bash.exe' })
  assert.equal(definition.name, 'bash')
  assert.equal(typeof definition.execute, 'function')
  assert.equal(definition.parameters.additionalProperties, false)
  assert.deepEqual(Object.keys(definition.parameters.properties), ['command', 'description', 'timeoutMs', 'workdir', 'run_in_background'])
  assert.equal(definition.parameters.properties.run_in_background.type, 'boolean')
  assert.equal(definition.parameters.properties.timeoutMs.description.includes(String(GIT_BASH_DEFAULT_TIMEOUT_MS)), true)
  assert.equal(definition.parameters.properties.sandbox_permissions, undefined)
  assert.equal(definition.parameters.properties.justification, undefined)

  const branches = definition.output.schema.oneOf
  assert.equal(branches.length, 2)
  assert.equal(branches[0].properties.kind.const, 'background')
  assert.equal(branches[1].properties.kind.const, 'foreground')
  assert.ok(branches[1].required.includes('aborted'))
  assert.equal(branches[1].properties.sandbox, undefined)
  assert.deepEqual(
    definition.output.render({}, { kind: 'background', jobId: 'bash-1' }),
    [{ type: 'text', text: 'started background job bash-1' }],
  )

  await assert.rejects(() => definition.execute({ command: '  ', description: 'x' }), /invalid command/)
  await assert.rejects(() => definition.execute({ command: 'echo hi', description: '  ' }), /invalid description/)
  await assert.rejects(() => definition.execute({ command: 'echo hi', description: 'x', timeoutMs: 0 }), /invalid timeoutMs/)
  await assert.rejects(
    () => definition.execute({ command: 'echo hi', description: 'x', run_in_background: true }),
    /background jobs unavailable/,
  )
  await assert.rejects(
    () => definition.execute({ command: 'echo hi', description: 'x', sandbox_permissions: 'workspace-write' }),
    /does not sandbox commands/,
  )
  await assert.rejects(
    () => definition.execute({ command: 'echo hi', description: 'x', justification: 'need it' }),
    /does not sandbox commands/,
  )

  const disabled = createGitBashToolDefinition({ bashPath: 'C:\\Git\\bin\\bash.exe', backgroundEnabled: false })
  assert.deepEqual(Object.keys(disabled.parameters.properties), ['command', 'description', 'timeoutMs', 'workdir'])
  await assert.rejects(
    () => disabled.execute({ command: 'echo hi', description: 'x', run_in_background: true }),
    /background execution is disabled/,
  )
})

test('createGitBashToolDefinition exposes official-style presenters', () => {
  const definition = createGitBashToolDefinition({ bashPath: 'C:\\Git\\bin\\bash.exe' })
  assert.deepEqual(
    definition.presentCall({ command: 'ls', description: 'List files', workdir: '/tmp' }),
    { card: 'terminal', title: 'ls', description: 'List files', cwd: '/tmp' },
  )
  assert.equal(
    definition.presentCall({ command: 'long task', description: 'run it', run_in_background: true }).card,
    'generic',
  )
  assert.deepEqual(
    definition.presentResult({ run_in_background: false }, { content: [{ type: 'text', text: 'ok\n[exit code: 1]' }] }),
    { card: 'terminal', output: 'ok', exitCode: 1 },
  )
  const backgroundResult = definition.presentResult(
    { run_in_background: true },
    { content: [{ type: 'text', text: 'started background job bash-1' }] },
  )
  assert.equal(backgroundResult.card, 'generic')
})

test('createGitBashToolDefinition runs a real foreground bash when available', async () => {
  if (!realBash) return
  const real = createGitBashToolDefinition({ bashPath: realBash })
  const result = await real.execute({ command: 'echo hi', description: 'say hi', timeoutMs: 5000 })
  assert.equal(result.kind, 'foreground')
  assert.equal(result.stdout.text.trim(), 'hi')
  assert.equal(result.stdout.truncated, false)
  assert.equal(result.stderr.text, '')
  assert.equal(result.exitCode, 0)
  assert.equal(result.aborted, false)
})

test('runGitBashCommand surfaces infrastructure failures', async () => {
  const result = await runGitBashCommand('C:\\definitely\\missing\\bash.exe', { command: 'echo hi', description: 'x' })
  assert.equal(typeof result.infrastructureError, 'string')
  assert.ok(result.infrastructureError.length > 0)
})

test('runGitBashCommand injects the managed DSH_* snapshot and discards ambient values', async () => {
  if (!realBash) return
  process.env.DSH_EXTRAPRO_TEST = 'ambient'
  try {
    const result = await runGitBashCommand(
      realBash,
      { command: 'printf %s "$DSH_EXTRAPRO_TEST"', description: 'print managed env' },
      undefined,
      { dshEnv: { DSH_EXTRAPRO_TEST: 'managed' }, defaultTimeoutMs: 5000 },
    )
    assert.equal(result.kind, 'foreground')
    assert.equal(result.stdout.text, 'managed')
    assert.equal(result.exitCode, 0)
  } finally {
    delete process.env.DSH_EXTRAPRO_TEST
  }
})

test('runGitBashCommand truncates oversized output to the tail and spills the full stream', async () => {
  if (!realBash) return
  const result = await runGitBashCommand(
    realBash,
    { command: "printf '%200000s' '' | tr ' ' A", description: 'print oversized output' },
    undefined,
    { defaultTimeoutMs: 5000 },
  )
  assert.equal(result.kind, 'foreground')
  assert.equal(result.exitCode, 0)
  assert.equal(result.stdout.truncated, true)
  assert.ok(result.stdout.text.length <= GIT_BASH_MAX_OUTPUT_BYTES)
  assert.ok(result.stdout.text.endsWith('A'.repeat(100)))
  assert.equal(typeof result.stdout.spillPath, 'string')
  assert.ok(existsSync(result.stdout.spillPath))
  try {
    assert.match(renderGitBashResult(result), /\[output truncated; full output: .*stdout\.log\]/)
  } finally {
    unlinkSync(result.stdout.spillPath)
  }
})

test('startGitBashProcess supports incremental reads and an idempotent kill', async () => {
  if (!realBash) return
  const marker = join(tmpdir(), `extrapro-anchor-wait-${process.pid}-${Date.now()}`)
  const command = `printf 'one\\n'; while [ ! -f '${marker}' ]; do sleep 0.05; done; printf 'two\\n'`
  const handle = startGitBashProcess(realBash, { command, workdir: process.cwd(), env: process.env })
  let seen = ''
  const deadline = Date.now() + 3000
  while (!seen.includes('one') && Date.now() < deadline) {
    seen += handle.readOutput().delta
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  assert.ok(seen.includes('one'))
  assert.equal(handle.kill(), true)
  assert.equal(handle.kill(), false)
  const outcome = await handle.done
  assert.equal(outcome.status, 'killed')
})

test('background execution registers the process handle with ctx.jobs', async () => {
  if (!realBash) return
  const jobs = makeJobs()
  const definition = createGitBashToolDefinition({ bashPath: realBash, getJobs: () => jobs })
  const agent = { id: 'agent-1' }
  const result = await definition.execute({ command: "printf 'bg-ok'", description: 'background ok', run_in_background: true }, { agent })

  assert.deepEqual(result, { kind: 'background', jobId: 'bash-1' })
  const { spec, hooks } = jobs.started[0]
  assert.equal(spec.kind, 'bash')
  assert.equal(spec.label, "printf 'bg-ok'")
  assert.equal(spec.owner, agent)
  assert.equal(typeof hooks.cancel, 'function')
  assert.equal(typeof hooks.readOutput, 'function')
  assert.equal(typeof hooks.done.then, 'function')

  const outcome = await hooks.done
  assert.deepEqual(outcome, { status: 'completed', detail: 'exit code: 0' })
  // The background hook already returns the model-facing delta text (the
  // same value job_output would consume).
  assert.match(hooks.readOutput(), /bg-ok/)
})

test('background nonzero exit stays completed with the exit code in the detail', async () => {
  if (!realBash) return
  const jobs = makeJobs()
  const definition = createGitBashToolDefinition({ bashPath: realBash, getJobs: () => jobs })
  await definition.execute({ command: 'exit 7', description: 'nonzero', run_in_background: true }, { agent: { id: 'agent-1' } })
  const outcome = await jobs.started[0].hooks.done
  assert.deepEqual(outcome, { status: 'completed', detail: 'exit code: 7' })
})

test('background cancel settles the job as killed', async () => {
  if (!realBash) return
  const jobs = makeJobs()
  const definition = createGitBashToolDefinition({ bashPath: realBash, getJobs: () => jobs })
  await definition.execute({ command: 'sleep 30', description: 'long sleep', run_in_background: true }, { agent: { id: 'agent-1' } })
  const { hooks } = jobs.started[0]
  hooks.cancel()
  const outcome = await hooks.done
  assert.equal(outcome.status, 'killed')
  assert.match(outcome.detail, /signal: SIGTERM|killed before exit/)
})

test('background spawn failure settles the job as failed and reports it once', async () => {
  const jobs = makeJobs()
  const definition = createGitBashToolDefinition({
    bashPath: 'C:\\definitely\\missing\\bash.exe',
    getJobs: () => jobs,
  })
  const result = await definition.execute({ command: 'echo hi', description: 'x', run_in_background: true }, { agent: { id: 'agent-1' } })
  assert.equal(result.kind, 'background')
  const { hooks } = jobs.started[0]
  const outcome = await hooks.done
  assert.equal(outcome.status, 'failed')
  assert.match(outcome.detail, /spawn failed/)
  assert.match(hooks.readOutput(), /spawn failed/)
  assert.equal(hooks.readOutput(), '')
})

test('background start with an already-aborted signal throws without creating a job', async () => {
  const jobs = makeJobs()
  const definition = createGitBashToolDefinition({ bashPath: 'C:\\Git\\bin\\bash.exe', getJobs: () => jobs })
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    () => definition.execute({ command: 'echo hi', description: 'x', run_in_background: true }, { signal: controller.signal }),
    (error) => error.name === 'AbortError' && /tool call aborted/.test(error.message),
  )
  assert.equal(jobs.started.length, 0)
})

test('foreground abort during a run throws the AbortError', async () => {
  if (!realBash) return
  const definition = createGitBashToolDefinition({ bashPath: realBash })
  const controller = new AbortController()
  const promise = definition.execute({ command: 'sleep 30', description: 'long sleep', timeoutMs: 5000 }, { signal: controller.signal })
  setTimeout(() => controller.abort(), 50)
  await assert.rejects(promise, (error) => error.name === 'AbortError' && /tool call aborted/.test(error.message))
})

test('foreground timeout kills the command and reports timedOut', async () => {
  if (!realBash) return
  const definition = createGitBashToolDefinition({ bashPath: realBash })
  const result = await definition.execute({ command: 'sleep 30', description: 'timed out sleep', timeoutMs: 100 })
  assert.equal(result.kind, 'foreground')
  assert.equal(result.timedOut, true)
  assert.equal(result.exitCode, null)
})

test('background oversized output reports a lossy read with the spill path', async () => {
  if (!realBash) return
  const jobs = makeJobs()
  const definition = createGitBashToolDefinition({ bashPath: realBash, getJobs: () => jobs })
  await definition.execute(
    { command: "printf '%200000s' '' | tr ' ' A", description: 'oversized background output', run_in_background: true },
    { agent: { id: 'agent-1' } },
  )
  const { hooks } = jobs.started[0]
  await hooks.done
  const text = hooks.readOutput()
  const match = text.match(/\[some output was dropped from memory; full output: (.+)\]$/)
  assert.ok(match)
  try {
    assert.ok(existsSync(match[1]))
  } finally {
    unlinkSync(match[1])
  }
})

// ── index integration ─────────────────────────────────────────────────────

function makeCtx() {
  const state = { listeners: new Map(), registered: [] }
  const ctx = {
    on(event, callback) {
      const list = state.listeners.get(event) ?? []
      list.push({ callback })
      state.listeners.set(event, list)
    },
    get() {
      throw new Error('no services in windows-gitbash test context')
    },
    logger: {
      warn() {},
      error() {},
    },
    tools: {
      register(definition) {
        state.registered.push(definition)
        return () => {}
      },
      get() {
        return undefined
      },
    },
  }
  return { ctx, state }
}

function makeSession({ id = 's1', depth = 0, origin, cwd }) {
  const log = []
  return {
    id,
    header: { cwd, delegationDepth: depth, ...(origin === undefined ? {} : { origin }) },
    events: log,
    append(type, data, opts) {
      const logged = { type, seq: log.length, time: Date.now(), data, opts }
      log.push(logged)
      return logged
    },
  }
}

function makeAgent({ session }) {
  return { session, options: { provider: 'p', model: 'm' } }
}

function makeAssembly(tools) {
  return {
    sections: [
      { name: 'deployment:persona', text: 'You are a helpful software engineer assistant.' },
      { name: 'guide', text: 'Work in a calm, direct style.' },
    ],
    tools,
    contexts: [],
    variables: {},
  }
}

async function runSeed({ ctx, state, agent, assembly }) {
  const listener = state.listeners.get('system-prompt/assemble')?.at(-1)?.callback
  assert.equal(typeof listener, 'function')
  return listener(assembly, { agent }, async () => assembly)
}

function setPlatform(platform) {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
}

test('index: with Git Bash + anchor ON, anchored sessions get bash instead of pwsh', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'extrapro-anchor-win-on-'))
  const fakeBash = join(cwd, 'bash.exe')
  writeFileSync(fakeBash, '')
  try {
    setPlatform('win32')
    process.env[GIT_BASH_PATH_ENV] = fakeBash
    const { ctx, state } = makeCtx()
    apply(ctx, { enabled: true, settingsPath: join(cwd, 'settings.json') })
    assert.equal(state.registered.length, 1)
    assert.equal(state.registered[0].name, 'bash')
    assert.equal(state.registered[0].parameters.properties.run_in_background.type, 'boolean')

    const session = makeSession({ cwd })
    const result = await runSeed({
      ctx,
      state,
      agent: makeAgent({ session }),
      assembly: makeAssembly([{ name: 'bash' }, { name: 'pwsh' }, { name: 'read' }, { name: 'str_replace_editor' }]),
    })
    assert.deepEqual(result.tools.map((tool) => tool.name).sort(), ['bash', 'read', 'str_replace_editor'])
  } finally {
    setPlatform(originalPlatform)
    delete process.env[GIT_BASH_PATH_ENV]
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('index: enableRunInBackground false removes the background parameter from the registered tool', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'extrapro-anchor-win-nobg-'))
  const fakeBash = join(cwd, 'bash.exe')
  writeFileSync(fakeBash, '')
  try {
    setPlatform('win32')
    process.env[GIT_BASH_PATH_ENV] = fakeBash
    const { ctx, state } = makeCtx()
    apply(ctx, { enabled: true, enableRunInBackground: false, settingsPath: join(cwd, 'settings.json') })
    const definition = state.registered[0]
    assert.equal(definition.parameters.properties.run_in_background, undefined)
    await assert.rejects(
      () => definition.execute({ command: 'echo hi', description: 'x', run_in_background: true }),
      /background execution is disabled/,
    )
  } finally {
    setPlatform(originalPlatform)
    delete process.env[GIT_BASH_PATH_ENV]
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('index: with Git Bash + anchor OFF, the experimental bash tool stays hidden', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'extrapro-anchor-win-off-'))
  const fakeBash = join(cwd, 'bash.exe')
  writeFileSync(fakeBash, '')
  try {
    setPlatform('win32')
    process.env[GIT_BASH_PATH_ENV] = fakeBash
    const { ctx, state } = makeCtx()
    apply(ctx, { enabled: false, settingsPath: join(cwd, 'settings.json') })
    assert.equal(state.registered.length, 1)

    const session = makeSession({ cwd })
    const result = await runSeed({
      ctx,
      state,
      agent: makeAgent({ session }),
      assembly: makeAssembly([{ name: 'bash' }, { name: 'pwsh' }, { name: 'read' }]),
    })
    assert.deepEqual(result.tools.map((tool) => tool.name).sort(), ['pwsh', 'read'])
  } finally {
    setPlatform(originalPlatform)
    delete process.env[GIT_BASH_PATH_ENV]
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('index: subagents keep pwsh and never see the experimental bash tool', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'extrapro-anchor-win-sub-'))
  const fakeBash = join(cwd, 'bash.exe')
  writeFileSync(fakeBash, '')
  try {
    setPlatform('win32')
    process.env[GIT_BASH_PATH_ENV] = fakeBash
    const { ctx, state } = makeCtx()
    apply(ctx, { enabled: true, settingsPath: join(cwd, 'settings.json') })

    const session = makeSession({ cwd, depth: 1 })
    const result = await runSeed({
      ctx,
      state,
      agent: makeAgent({ session }),
      assembly: makeAssembly([{ name: 'bash' }, { name: 'pwsh' }, { name: 'read' }]),
    })
    assert.deepEqual(result.tools.map((tool) => tool.name).sort(), ['pwsh', 'read'])
  } finally {
    setPlatform(originalPlatform)
    delete process.env[GIT_BASH_PATH_ENV]
    rmSync(cwd, { recursive: true, force: true })
  }
})
