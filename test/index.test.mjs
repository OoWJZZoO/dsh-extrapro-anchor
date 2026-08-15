import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, name, parseConfig } from '../lib/index.js'
import { checkHostEnvironment } from '../lib/guards.js'

function makeCtx({ cwd }) {
  const state = { listener: undefined }
  const warns = []
  const errors = []
  const ctx = {
    on(event, callback) {
      assert.equal(event, 'system-prompt/assemble')
      state.listener = callback
    },
    logger: {
      warn(message) { warns.push(message) },
      error(message) { errors.push(message) },
    },
  }
  return { ctx, state, warns, errors }
}

function makeSession({ id = 's1', depth = 0, events = [], cwd }) {
  const log = [...events]
  const session = {
    id,
    header: { cwd, delegationDepth: depth },
    events: log,
    append(type, data, opts) {
      const logged = { type, seq: log.length, time: Date.now(), data, opts }
      log.push(logged)
      return logged
    },
  }
  return session
}

function makeAgent({ session, provider = 'p', model = 'm' }) {
  return { session, options: { provider, model } }
}

/** A representative pre-wipe assembly: persona + one extra section. */
function makeAssembly(personaText = 'You are a helpful software engineer assistant.') {
  return {
    sections: [
      { name: 'persona', text: personaText },
      { name: 'guide', text: 'Work in a calm, direct style.' },
    ],
    contexts: [],
    tools: [],
    variables: {},
  }
}

async function runSeed({ ctx, state, agent, assembly = makeAssembly() }) {
  return state.listener(assembly, { agent }, async () => assembly)
}

test('exports a diagnostic plugin name', () => {
  assert.equal(name, 'anchor-seed')
})

test('apply registers a system-prompt/assemble listener', () => {
  const { ctx, state } = makeCtx({ cwd: '/' })
  apply(ctx, {})
  assert.equal(typeof state.listener, 'function')
})

test('a fresh top-level session is seeded: events + real guide file', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'anchor-seed-'))
  try {
    const { ctx, state, warns } = makeCtx({ cwd })
    apply(ctx, {})
    const session = makeSession({ cwd })
    const agent = makeAgent({ session })
    await runSeed({ ctx, state, agent })

    // Events: user, assistant, tool/call, tool/result
    const types = session.events.map((e) => e.type)
    assert.deepEqual(types, ['user/message', 'assistant/message', 'tool/call', 'tool/result'])

    // The tool result cites the tool/call seq and carries raw bash stdout:
    // "<cwd>\n<guide content>" — no read-tool envelope.
    const callSeq = session.events.find((e) => e.type === 'tool/call').seq
    const result = session.events.find((e) => e.type === 'tool/result')
    assert.deepEqual(result.opts, { surfaceOp: 'append', sourceEventSeqs: [callSeq] })
    const resultText = result.data.message.content[0].content[0].text
    assert.match(resultText, new RegExp(`^${cwd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n`))
    assert.match(resultText, /elevated; you may now act according to the following prompt/)
    assert.match(resultText, /Work in a calm, direct style\./) // auto-captured non-persona section
    assert.doesNotMatch(resultText, /\(End of file - total/) // bash cat, not read

    // The virtual call is bash with the interpolated relative path
    const call = session.events.find((e) => e.type === 'tool/call')
    assert.equal(call.data.name, 'bash')
    assert.deepEqual(JSON.parse(call.data.arguments), { command: 'pwd && cat .dsh/s1/agent-dev-guide.md' })

    // The real file exists with content identical to the virtual result
    const guidePath = join(cwd, '.dsh', 's1', 'agent-dev-guide.md')
    assert.equal(existsSync(guidePath), true)
    const fileContent = readFileSync(guidePath, 'utf8')
    assert.match(fileContent, /Work in a calm, direct style\./)
    assert.equal(warns.length, 0)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('elevationSource config forces the explicit prompt', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'anchor-seed-'))
  try {
    const { ctx, state } = makeCtx({ cwd })
    apply(ctx, { elevationSource: 'config', elevationPrompt: 'Only the config prompt.' })
    const session = makeSession({ cwd })
    await runSeed({ ctx, state, agent: makeAgent({ session }) })
    const resultText = session.events.find((e) => e.type === 'tool/result').data.message.content[0].content[0].text
    assert.match(resultText, /Only the config prompt\./)
    assert.doesNotMatch(resultText, /Work in a calm, direct style\./)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('elevationSource none emits the notice only', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'anchor-seed-'))
  try {
    const { ctx, state } = makeCtx({ cwd })
    apply(ctx, { elevationSource: 'none' })
    const session = makeSession({ cwd })
    await runSeed({ ctx, state, agent: makeAgent({ session }) })
    const resultText = session.events.find((e) => e.type === 'tool/result').data.message.content[0].content[0].text
    assert.doesNotMatch(resultText, /Work in a calm, direct style\./)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('AGENTS.md/CLAUDE.md are injected right after the virtual turn', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'anchor-seed-'))
  try {
    writeFileSync(join(cwd, 'AGENTS.md'), 'project rules')
    writeFileSync(join(cwd, 'CLAUDE.md'), 'claude rules')
    const { ctx, state } = makeCtx({ cwd })
    apply(ctx, {})
    const session = makeSession({ cwd })
    await runSeed({ ctx, state, agent: makeAgent({ session }) })
    const types = session.events.map((e) => e.type)
    assert.deepEqual(types, ['user/message', 'assistant/message', 'tool/call', 'tool/result', 'user/message'])
    const injected = session.events.at(-1)
    assert.equal(injected.data.source.plugin, 'anchor-seed')
    assert.match(injected.data.content[0].text, /project rules/)
    assert.match(injected.data.content[0].text, /claude rules/)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('injectProjectInstructions false skips AGENTS.md injection', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'anchor-seed-'))
  try {
    writeFileSync(join(cwd, 'AGENTS.md'), 'project rules')
    const { ctx, state } = makeCtx({ cwd })
    apply(ctx, { injectProjectInstructions: false })
    const session = makeSession({ cwd })
    await runSeed({ ctx, state, agent: makeAgent({ session }) })
    assert.deepEqual(session.events.map((e) => e.type), ['user/message', 'assistant/message', 'tool/call', 'tool/result'])
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('a session is seeded exactly once across repeated assemblies', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'anchor-seed-'))
  try {
    const { ctx, state } = makeCtx({ cwd })
    apply(ctx, {})
    const session = makeSession({ cwd })
    const agent = makeAgent({ session })
    await runSeed({ ctx, state, agent })
    const countAfterFirst = session.events.length
    await runSeed({ ctx, state, agent })
    await runSeed({ ctx, state, agent })
    assert.equal(session.events.length, countAfterFirst)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('subagents are never seeded', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'anchor-seed-'))
  try {
    const { ctx, state } = makeCtx({ cwd })
    apply(ctx, {})
    const session = makeSession({ cwd, depth: 1 })
    await runSeed({ ctx, state, agent: makeAgent({ session }) })
    assert.equal(session.events.length, 0)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('sessions that already produced a user message are not seeded (resume safety)', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'anchor-seed-'))
  try {
    const { ctx, state } = makeCtx({ cwd })
    apply(ctx, {})
    const session = makeSession({ cwd, events: [{ type: 'user/message', seq: 0, data: { role: 'user', content: [] } }] })
    await runSeed({ ctx, state, agent: makeAgent({ session }) })
    assert.equal(session.events.length, 1)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('a session without session.append degrades with a warning, no throw', async () => {
  const { ctx, state, warns } = makeCtx({ cwd: '/' })
  apply(ctx, {})
  const agent = { session: { id: 'x', header: { cwd: '/' }, events: [], append: undefined }, options: {} }
  const result = await state.listener(makeAssembly(), { agent }, async () => makeAssembly())
  assert.equal(result.sections.length, 2) // assembly passes through untouched
  assert.ok(warns.length >= 1)
  assert.match(warns[0], /session continues without the anchor/)
})

test('a file write failure degrades with a warning, no throw', async () => {
  const { ctx, state, warns } = makeCtx({ cwd: '/' })
  apply(ctx, {})
  // cwd "/" exists; force failure by making the .dsh path unwritable is hard
  // cross-platform — instead point cwd at a path whose parent is a FILE.
  const cwd = mkdtempSync(join(tmpdir(), 'anchor-seed-'))
  const blocker = join(cwd, 'block')
  writeFileSync(blocker, 'x')
  try {
    const agent = { session: { id: 's1', header: { cwd: blocker }, events: [], append: () => { throw new Error('unreachable') } }, options: {} }
    const result = await state.listener(makeAssembly(), { agent }, async () => makeAssembly())
    assert.equal(result.sections.length, 2)
    assert.ok(warns.length >= 1)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('the guard failure path loads nothing (fail-safe)', async () => {
  const { ctx, state, errors } = makeCtx({ cwd: '/' })
  process.env.DSH_ANCHOR_SEED_FORCE_GUARD_FAIL = '1'
  try {
    apply(ctx, {})
    assert.equal(state.listener, undefined)
    assert.ok(errors.length >= 1)
    assert.match(errors[0], /self-check FAILED/)
  } finally {
    delete process.env.DSH_ANCHOR_SEED_FORCE_GUARD_FAIL
  }
})

test('guard.enabled false bypasses the self-check', () => {
  const { ctx, state, errors } = makeCtx({ cwd: '/' })
  process.env.DSH_ANCHOR_SEED_FORCE_GUARD_FAIL = '1'
  try {
    apply(ctx, { guard: { enabled: false } })
    assert.equal(typeof state.listener, 'function')
    assert.equal(errors.length, 0)
  } finally {
    delete process.env.DSH_ANCHOR_SEED_FORCE_GUARD_FAIL
  }
})

test('guard accepts the cordis callable-logger shape (function with methods)', () => {
  // Regression: cordis v4 exposes ctx.logger as a CALLABLE function
  // (ctx.logger() creates a named logger; ctx.logger.warn/error also exist).
  // typeof is 'function', not 'object' — a naive probe made the plugin inert
  // on a real boot (observed on the dev profile, 2026-08-15).
  const ctx = {
    on: () => {},
    logger: Object.assign(function logger() {}, { warn: () => {}, error: () => {} }),
  }
  const result = checkHostEnvironment(ctx)
  assert.equal(result.ok, true)
  assert.deepEqual(result.problems, [])
})

test('parseConfig validates and defaults', () => {
  const defaults = parseConfig(undefined)
  assert.equal(defaults.elevationSource, 'auto')
  assert.equal(defaults.virtualToolName, 'bash')
  assert.match(defaults.virtualCommandTemplate, /\{path\}/)
  assert.equal(defaults.injectProjectInstructions, true)
  assert.equal(defaults.guardEnabled, true)
  const custom = parseConfig({
    elevationSource: 'config',
    elevationPrompt: 'X',
    virtualToolName: 'cat',
    virtualCommandTemplate: 'cat {path}',
    injectProjectInstructions: false,
    guard: { enabled: false },
    maxInstructionsBytes: 1234,
  })
  assert.equal(custom.elevationSource, 'config')
  assert.equal(custom.virtualToolName, 'cat')
  assert.equal(custom.virtualCommandTemplate, 'cat {path}')
  assert.equal(custom.injectProjectInstructions, false)
  assert.equal(custom.guardEnabled, false)
  assert.equal(custom.maxInstructionsBytes, 1234)
  // unknown elevationSource values fall back to 'auto'
  assert.equal(parseConfig({ elevationSource: 'bogus' }).elevationSource, 'auto')
})

test('virtual templates default to the pre-sampled minimal texts', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'anchor-seed-'))
  try {
    const { ctx, state } = makeCtx({ cwd })
    apply(ctx, {})
    const session = makeSession({ cwd })
    await runSeed({ ctx, state, agent: makeAgent({ session }) })
    const user = session.events[0]
    assert.match(user.data.content[0].text, /^Please read the entire \.dsh\/s1\/agent-dev-guide\.md in the project root directory for detailed information\.$/)
    const reasoning = session.events[1].data.message.content[0]
    assert.equal(reasoning.type, 'reasoning')
    assert.match(reasoning.text, /^We need respond to user asking to read entire \.dsh\/s1\/agent-dev-guide\.md/)
    assert.doesNotMatch(reasoning.text, /\{path\}/) // interpolated, no placeholder left
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})
