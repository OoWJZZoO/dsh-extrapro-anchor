import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, name, parseConfig } from '../lib/index.js'
import { checkHostEnvironment } from '../lib/guards.js'

function makeCtx({ cwd }) {
  const state = { listeners: new Map() }
  const warns = []
  const errors = []
  const ctx = {
    on(event, callback, options) {
      const list = state.listeners.get(event) ?? []
      list.push({ callback, options })
      state.listeners.set(event, list)
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
      { name: 'guide', text: 'Work in a calm, direct style. Model is {{model}} in {{cwd}}.' },
    ],
    contexts: [],
    tools: [],
    variables: { model: 'deepseek-v4-pro', cwd: '/work' },
  }
}

async function runSeed({ ctx, state, agent, assembly = makeAssembly() }) {
  const listener = state.listeners.get('system-prompt/assemble')?.at(-1)?.callback
  return listener(assembly, { agent }, async () => assembly)
}

/** Run the registered agent/pre-step listeners as a waterfall (registration order). */
async function runPreStep({ ctx, state, payload, initial }) {
  const listeners = (state.listeners.get('agent/pre-step') ?? []).map((entry) => entry.callback)
  let decision = initial
  for (const callback of listeners) {
    decision = await callback(payload, async () => decision)
  }
  return decision
}

test('exports a diagnostic plugin name', () => {
  assert.equal(name, 'anchor-seed')
})

test('apply registers a system-prompt/assemble listener', () => {
  const { ctx, state } = makeCtx({ cwd: '/' })
  apply(ctx, {})
  assert.equal(typeof state.listeners.get('system-prompt/assemble')?.at(-1)?.callback, 'function')
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
    assert.doesNotMatch(resultText, /\{\{model\}\}/) // {{variables}} are interpolated in the elevation
    assert.match(resultText, /Model is deepseek-v4-pro in \/work\./)
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

test('virtual turn events carry turn 0 step 0 (no collision with the real first step)', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'anchor-seed-'))
  try {
    const { ctx, state } = makeCtx({ cwd })
    apply(ctx, {})
    const session = makeSession({ cwd })
    await runSeed({ ctx, state, agent: makeAgent({ session }) })
    const assistant = session.events.find((e) => e.type === 'assistant/message')
    const call = session.events.find((e) => e.type === 'tool/call')
    const result = session.events.find((e) => e.type === 'tool/result')
    // Regression: the trajectory UI keys the assistant-step lifecycle on
    // `${turn}:${step}`; stamping the virtual turn 1:1 made its
    // assistant/message arrive as an "update" before the real step/start
    // ("received an update before its start Match"), breaking the render.
    assert.deepEqual({ turn: assistant.data.turn, step: assistant.data.step }, { turn: 0, step: 0 })
    assert.deepEqual({ turn: call.data.turn, step: call.data.step }, { turn: 0, step: 0 })
    assert.deepEqual({ turn: result.data.turn, step: result.data.step }, { turn: 0, step: 0 })
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('agent/pre-step drops the harness agent-instructions copy after the seed injected instructions', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'anchor-seed-'))
  try {
    writeFileSync(join(cwd, 'AGENTS.md'), 'project rules')
    const { ctx, state } = makeCtx({ cwd })
    apply(ctx, {})
    const session = makeSession({ cwd })
    const agent = makeAgent({ session })
    await runSeed({ ctx, state, agent })

    // A realistic pre-step decision: claimed real user message plus the
    // harness's composed agent-instructions baseline (source.kind
    // 'agent-instructions', the dsh-base dependency's shape).
    const claimed = [
      { role: 'user', content: [{ type: 'text', text: 'real first message' }], source: { kind: 'user' } },
    ]
    const harnessCopy = {
      role: 'user',
      content: [{ type: 'text', text: '<system-reminder>AGENTS.md</system-reminder>' }],
      source: { kind: 'agent-instructions', baseline: true, baselineIdentity: 'x' },
    }
    const runtimeCtx = {
      role: 'user',
      content: [{ type: 'text', text: 'runtime context' }],
      source: { kind: 'plugin', plugin: 'runtime-context' },
    }
    const decision = await runPreStep({
      ctx, state,
      payload: { agent, messages: claimed, turn: 1, step: 1, signal: new AbortController().signal },
      initial: { kind: 'enter', messages: [...claimed, harnessCopy, runtimeCtx] },
    })
    const kinds = decision.messages.map((m) => m.source.kind)
    assert.ok(!kinds.includes('agent-instructions'), `harness copy must be dropped, got ${kinds.join(', ')}`)
    assert.ok(kinds.includes('user'), 'real user message preserved')
    assert.ok(kinds.includes('plugin'), 'unrelated runtime context preserved')
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('agent/pre-step keeps the harness decision when nothing was injected', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'anchor-seed-'))
  try {
    const { ctx, state } = makeCtx({ cwd })
    apply(ctx, {}) // no AGENTS.md/CLAUDE.md in cwd → nothing injected
    const session = makeSession({ cwd })
    const agent = makeAgent({ session })
    await runSeed({ ctx, state, agent })

    const harnessCopy = {
      role: 'user',
      content: [{ type: 'text', text: '<system-reminder>AGENTS.md</system-reminder>' }],
      source: { kind: 'agent-instructions', baseline: true, baselineIdentity: 'x' },
    }
    const decision = await runPreStep({
      ctx, state,
      payload: { agent, messages: [], turn: 1, step: 1, signal: new AbortController().signal },
      initial: { kind: 'enter', messages: [harnessCopy] },
    })
    assert.deepEqual(decision.messages, [harnessCopy], 'harness instructions survive when the seed did not inject its own')
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('agent/pre-step failure degrades with a warning, no throw', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'anchor-seed-'))
  try {
    writeFileSync(join(cwd, 'AGENTS.md'), 'project rules')
    const { ctx, state, warns } = makeCtx({ cwd })
    apply(ctx, {})
    const session = makeSession({ cwd })
    const agent = makeAgent({ session })
    await runSeed({ ctx, state, agent })

    // A decision whose messages are a non-array (or null) must not throw.
    const decision = await runPreStep({
      ctx, state,
      payload: { agent, messages: [], turn: 1, step: 1, signal: new AbortController().signal },
      initial: { kind: 'enter', messages: null },
    })
    assert.deepEqual(decision, { kind: 'enter', messages: null }, 'non-array messages pass through untouched')
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
  const listener = state.listeners.get('system-prompt/assemble')?.at(-1)?.callback
  const result = await listener(makeAssembly(), { agent }, async () => makeAssembly())
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
    const listener = state.listeners.get('system-prompt/assemble')?.at(-1)?.callback
    const result = await listener(makeAssembly(), { agent }, async () => makeAssembly())
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
    assert.equal(state.listeners.get('system-prompt/assemble'), undefined)
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
    assert.equal(typeof state.listeners.get('system-prompt/assemble')?.at(-1)?.callback, 'function')
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
    assert.match(
      user.data.content[0].text,
      /^Session setup: please read the entire \.dsh\/s1\/agent-dev-guide\.md in the project root directory for detailed information, and work entirely according to the instructions it contains\. Do not reply yet — the actual task follows in the next message\.$/,
    )
    const reasoning = session.events[1].data.message.content[0]
    assert.equal(reasoning.type, 'reasoning')
    assert.match(reasoning.text, /^We need respond to user asking to read entire \.dsh\/s1\/agent-dev-guide\.md/)
    assert.doesNotMatch(reasoning.text, /\{path\}/) // interpolated, no placeholder left
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('system sections are replaced with minimal persona + two-tool statement', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'anchor-seed-'))
  try {
    const { ctx, state } = makeCtx({ cwd })
    apply(ctx, {})
    const session = makeSession({ cwd })
    const agent = makeAgent({ session })
    const assembly = makeAssembly()
    assembly.tools = [
      { name: 'bash', description: 'Run commands', parameters: { type: 'object' } },
      { name: 'read', description: 'Read a file', parameters: { type: 'object' } },
      { name: 'edit', description: 'Edit a file', parameters: { type: 'object' } },
    ]
    const result = await runSeed({ ctx, state, agent, assembly })
    // Global replacement: the returned assembly's sections are the minimal ones
    assert.equal(result.sections.length, 2)
    assert.equal(result.sections[0].name, 'persona')
    assert.equal(result.sections[0].text, 'You are a helpful software engineer assistant.')
    assert.equal(result.sections[1].name, 'tools')
    assert.match(result.sections[1].text, /bash, str_replace_editor/)
    assert.doesNotMatch(result.sections[1].text, /\bread\b|\bedit\b/) // two-tool statement only
    // Tools schemas are NOT filtered — full catalog stays
    assert.equal(result.tools.length, 3)
    // Idempotent: a second assembly applies the same replacement
    const result2 = await runSeed({ ctx, state, agent, assembly })
    assert.deepEqual(result2.sections.map((s) => s.text), result.sections.map((s) => s.text))
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('guide content includes the full tool catalog text', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'anchor-seed-'))
  try {
    const { ctx, state } = makeCtx({ cwd })
    apply(ctx, {})
    const session = makeSession({ cwd })
    const agent = makeAgent({ session })
    const assembly = makeAssembly()
    assembly.tools = [
      { name: 'bash', description: 'Run commands in a shell' },
      { name: 'web_search', description: 'Search the web' },
      { name: 'subagent', description: 'Delegate work' },
    ]
    await runSeed({ ctx, state, agent, assembly })
    const resultText = session.events.find((e) => e.type === 'tool/result').data.message.content[0].content[0].text
    assert.match(resultText, /The full tool catalog available in this session:/)
    assert.match(resultText, /- bash: Run commands in a shell/)
    assert.match(resultText, /- web_search: Search the web/)
    assert.match(resultText, /- subagent: Delegate work/)
    // The elevation (non-persona sections) is still captured BEFORE the catalog
    assert.match(resultText, /Work in a calm, direct style\./)
    assert.match(resultText, /Model is deepseek-v4-pro in \/work\./)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})
