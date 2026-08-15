import test from 'node:test'
import assert from 'node:assert/strict'

import {
  classifyReasoning,
  computeChainHealth,
  healthOfConversation,
  reasoningBlocksOf,
} from '../lib/health.js'

// These three cases are the published reference-probe fixtures:
// modeltest/evaluator/trigger_probe/test/classifier.test.mjs.
test('classifyReasoning reproduces the reference probe labels', () => {
  assert.equal(classifyReasoning('We need inspect the repository.').label, 'minimal-like')
  assert.equal(classifyReasoning('Let me inspect the repository.').label, 'standard-like')
  assert.equal(classifyReasoning('Need inspect the next file.').label, 'ambiguous')
})

test('classifyReasoning reproduces the reference scoring rules', () => {
  const strong = classifyReasoning('We need to read it. We will verify every file we touch.')
  assert.equal(strong.metrics.we, 3)
  assert.equal(strong.metrics.letMe, 0)
  assert.equal(strong.score, 5) // +3 first line, +2 we-without-let-me

  const standard = classifyReasoning('Let me start by listing files. I will check the output.')
  assert.equal(standard.score, -5) // −3 first line, −2 let-me
  assert.equal(standard.label, 'standard-like')

  const praise = classifyReasoning('Good.\nWe need read the file next.')
  assert.equal(praise.metrics.markerFirstLine, true)
  assert.equal(praise.score, 3) // +2 we-without-let-me, +1 lone praise
  assert.equal(praise.label, 'ambiguous')
})

test('computeChainHealth: any "let me" raises the warning the user asked for', () => {
  const healthy = computeChainHealth(['We need inspect the repository. We have tools.'])
  assert.equal(healthy.status, 'healthy')
  assert.equal(healthy.letMe, 0)
  assert.equal(healthy.score, 80) // 60 + (3 + 2) * 4

  const watched = computeChainHealth(['We need inspect the repository.', 'Let me double-check the plan.'])
  assert.equal(watched.letMe, 1)
  assert.equal(watched.status, 'watch')

  const drifted = computeChainHealth(['Let me inspect the repository.', 'Let me open the file.', 'Let me run it.'])
  assert.equal(drifted.status, 'drift')
  assert.ok(drifted.score <= 40)
})

test('computeChainHealth: empty input is idle, window caps the sample', () => {
  assert.equal(computeChainHealth([]).status, 'idle')
  assert.equal(computeChainHealth([]).score, null)
  const blocks = Array.from({ length: 20 }, () => 'We need inspect something.')
  const capped = computeChainHealth(blocks, { window: 8 })
  assert.equal(capped.blocks, 8)
})

test('reasoningBlocksOf: extracts assistant reasoning and skips the virtual prelude', () => {
  const nodes = [
    { kind: 'assistant', turn: 1, step: 0, blocks: [{ kind: 'reasoning', text: 'VIRTUAL' }] },
    { kind: 'assistant', turn: 1, step: 1, blocks: [{ kind: 'reasoning', text: 'REAL one' }, { kind: 'text', text: 'hi' }] },
    { kind: 'user', blocks: [] },
  ]
  const blocks = reasoningBlocksOf({ nodes, partial: { turn: 2, step: 1, blocks: [{ kind: 'reasoning', text: 'LIVE' }] } })
  assert.deepEqual(blocks, ['REAL one', 'LIVE'])
})

test('healthOfConversation: one call from a snapshot slice', () => {
  const health = healthOfConversation({
    nodes: [{ kind: 'assistant', turn: 1, step: 1, blocks: [{ kind: 'reasoning', text: 'We need inspect the repository.' }] }],
  })
  assert.equal(health.status, 'healthy')
  assert.equal(health.score, 80)
})
