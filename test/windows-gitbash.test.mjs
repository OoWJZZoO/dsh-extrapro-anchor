import assert from 'node:assert/strict'
import test, { after, before } from 'node:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  GIT_BASH_PATH_ENV,
  createGitBashToolDefinition,
  dropPwshTool,
  findGitBash,
  gitBashCandidates,
  hideBashTool,
  renderGitBashResult,
  runGitBashCommand,
  withoutToolNamed,
} from '../lib/windows-gitbash.js'
import { apply } from '../lib/index.js'

const originalPlatform = process.platform
const originalGitBashEnv = process.env[GIT_BASH_PATH_ENV]

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

test('createGitBashToolDefinition validates args and runs a real bash when available', async () => {
  const definition = createGitBashToolDefinition({ bashPath: 'C:\\Git\\bin\\bash.exe' })
  assert.equal(definition.name, 'bash')
  assert.equal(typeof definition.execute, 'function')
  await assert.rejects(() => definition.execute({ command: '  ', description: 'x' }), /invalid command/)
  await assert.rejects(() => definition.execute({ command: 'echo hi', description: '  ' }), /invalid description/)

  if (!existsSync('/bin/bash')) return
  const real = createGitBashToolDefinition({ bashPath: '/bin/bash' })
  const result = await real.execute({ command: 'echo hi', description: 'say hi', timeoutMs: 5000 })
  assert.equal(result.stdout.trim(), 'hi')
  assert.equal(result.exitCode, 0)
})

test('runGitBashCommand surfaces infrastructure failures', async () => {
  const result = await runGitBashCommand('C:\\definitely\\missing\\bash.exe', { command: 'echo hi', description: 'x' })
  assert.equal(typeof result.infrastructureError, 'string')
  assert.ok(result.infrastructureError.length > 0)
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
