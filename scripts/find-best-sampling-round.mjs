#!/usr/bin/env node
/**
 * find-best-sampling-round — batch-scan DeepSeek Harness session logs and pick
 * the round that best matches the modeltest minimal trajectory fingerprint,
 * i.e. the best candidate to pre-sample the anchor-seed virtual turn from.
 *
 * Metrics and the lexical classifier mirror `xiaobright/modeltest`:
 * - `evaluator/trigger_probe/src/classifier.mjs` (classifyReasoning, verbatim)
 * - `evaluator/trajectory_evidence/analyze_trajectory_exports.py` (word
 *   counts are case-insensitive boundary matches; `I` includes `I'm`, `I'll`)
 * - `docs/v4.1/DEEPSEEK_V4_TRAJECTORY_ANALYSIS_20260814.md` (the minimal
 *   fingerprint: `let me = 0`, high `we`, exactly 1 visible reply)
 *
 * Requirements: the `unzstd` CLI on PATH (sessions are stored as zstd JSONL).
 *
 * Usage:
 *   node scripts/find-best-sampling-round.mjs [--sessions-dir DIR] [--cwd PATH] [--top N]
 *
 * Defaults: sessions dir derived from --cwd (or process.cwd()) under
 * $DSH_HOME/sessions/<slug>, where slug = '--' + path components joined by '-'.
 * Set DSH_HOME to override ~/.dsh.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/* ── modeltest verbatim classifier ─────────────────────────────────────── */
function count(text, regex) {
  return [...text.matchAll(regex)].length
}

/** Exact copy of modeltest trigger_probe classifyReasoning. */
export function classifyReasoning(reasoning, visibleBeforeTool = false) {
  const text = reasoning.trim()
  const firstLine = text.split(/\r?\n/, 1)[0] ?? ''
  const metrics = {
    firstLine,
    chars: text.length,
    we: count(text, /\bwe\b/gi),
    letMe: count(text, /\blet me\b/gi),
    i: count(text, /\bi\b/gi),
    markerFirstLine: /^(good|great|excellent)\.?$/i.test(firstLine.trim()),
    visibleBeforeTool,
  }
  let score = 0
  if (/^we need\b/i.test(firstLine)) score += 3
  if (/^let me\b/i.test(firstLine)) score -= 3
  if (metrics.we > 0 && metrics.letMe === 0) score += 2
  if (metrics.letMe > 0) score -= 2
  if (metrics.markerFirstLine) score += 1
  if (visibleBeforeTool) score -= 1
  return {
    label: score >= 4 ? 'minimal-like' : score <= -4 ? 'standard-like' : 'ambiguous',
    score,
    metrics,
  }
}

/* ── session log scanning ──────────────────────────────────────────────── */
function parseArgs(argv) {
  const args = { cwd: process.cwd(), sessionsDir: undefined, top: 3 }
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i]
    const value = argv[i + 1]
    if (key === '--sessions-dir' && value) { args.sessionsDir = value; i += 1 }
    else if (key === '--cwd' && value) { args.cwd = value; i += 1 }
    else if (key === '--top' && value) { args.top = Number.parseInt(value, 10) || 3; i += 1 }
    else if (key === '--help') {
      console.log('usage: node scripts/find-best-sampling-round.mjs [--sessions-dir DIR] [--cwd PATH] [--top N]')
      process.exit(0)
    }
  }
  return args
}

/** Derive the sessions store dir for a cwd: '--' + path components joined by '-'. */
export function sessionsDirForCwd(cwd, dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')) {
  const slug = '--' + cwd.split('/').filter(Boolean).join('-') + '--'
  return join(dshHome, 'sessions', slug)
}

function decompress(path) {
  const probe = spawnSync('unzstd', ['--version'], { encoding: 'utf8' })
  if (probe.status !== 0) throw new Error('unzstd CLI not found on PATH (needed to read session.jsonl.zstd)')
  const result = spawnSync('unzstd', ['-q', '-c', path], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 })
  if (result.status !== 0) throw new Error(`unzstd failed: ${(result.stderr || '').slice(0, 200)}`)
  return result.stdout
}

function wordCounts(text) {
  return {
    we: count(text, /\bwe\b/gi),
    letMe: count(text, /\blet me\b/gi),
    lets: count(text, /\blet's\b/gi),
    i: count(text, /\bi\b/gi),
  }
}

/** Parse one session log into modeltest-style metrics. */
export function analyzeSessionLog(raw) {
  const events = raw.split('\n').filter(Boolean).map((line) => JSON.parse(line))

  const sessionRecord = events.find((e) => e.type === 'session') ?? {}
  const selectedEvent = events.find((e) => e.type === 'agent-preset/selected')
  const firstHeader = events.find((e) => e.type === 'request/header' && e.data?.reason === 'initial')

  const userMessages = []
  const assistantMessages = [] // { blocks, reasoning, text, toolCalls }
  let toolCalls = 0
  for (const event of events) {
    switch (event.type) {
      case 'user/message': {
        const text = (event.data?.content ?? [])
          .filter((b) => b.type === 'text')
          .map((b) => b.text)
          .join('')
        userMessages.push({ time: event.time, text })
        break
      }
      case 'assistant/message': {
        const blocks = event.data?.message?.content ?? []
        const reasoning = blocks.filter((b) => b.type === 'reasoning').map((b) => b.text).join('')
        const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('')
        const toolCallBlocks = blocks.filter((b) => b.type === 'tool-call')
        assistantMessages.push({ time: event.time, reasoning, text, toolCallBlocks })
        break
      }
      case 'tool/call':
        toolCalls += 1
        break
      default:
        break
    }
  }

  const allReasoning = assistantMessages.map((m) => m.reasoning).filter((t) => t.length > 0)
  const allReasoningText = allReasoning.join('\n')
  const firstWithReasoning = assistantMessages.find((m) => m.reasoning.length > 0)
  const firstAssistant = assistantMessages[0]

  const visibleReplies = assistantMessages.filter((m) => m.text.trim().length > 0).length
  const visibleBeforeTool = Boolean(
    firstAssistant && firstAssistant.text.trim().length > 0 && firstAssistant.toolCallBlocks.length > 0,
  )

  const tools = firstHeader?.data?.header?.tools ?? []
  const toolNames = tools.map((t) => t.name)
  const selectedPreset = selectedEvent?.data?.agentPreset ?? sessionRecord.agentPreset

  const firstClass = firstWithReasoning
    ? classifyReasoning(firstWithReasoning.reasoning, visibleBeforeTool)
    : undefined
  const allCounts = wordCounts(allReasoningText)
  const firstCounts = firstWithReasoning ? wordCounts(firstWithReasoning.reasoning) : undefined

  const blockChars = allReasoning.map((t) => t.length).sort((a, b) => a - b)
  const p50Chars = blockChars.length > 0 ? blockChars[Math.floor(blockChars.length / 2)] : 0

  return {
    id: sessionRecord.id ?? '?',
    createdAt: sessionRecord.createdAt,
    selectedPreset,
    toolCount: toolNames.length,
    toolNames,
    userMessages,
    assistantMessages,
    firstReasoning: firstWithReasoning?.reasoning ?? '',
    firstClass,
    metrics: {
      blocks: allReasoning.length,
      p50Chars,
      we: allCounts.we,
      letMe: allCounts.letMe,
      lets: allCounts.lets,
      i: allCounts.i,
      visibleReplies,
      toolCalls,
    },
    firstBlockCounts: firstCounts,
  }
}

/** Rank sessions for "best pre-sampled anchor round" (documented heuristic). */
export function rankScore(s) {
  let score = 0
  // The first reasoning block IS the anchor text — weight the classifier highest.
  if (s.firstClass) {
    score += s.firstClass.score * 2
    if (s.firstClass.label === 'minimal-like') score += 8
    if (s.firstClass.label === 'standard-like') score -= 12
  }
  if (s.selectedPreset === 'minimal') score += 4
  if (s.toolCount === 2) score += 2 // pure modeltest minimal surface
  if (s.metrics.letMe === 0) score += 3
  if (s.metrics.visibleReplies === 1) score += 2
  if (s.metrics.we >= 50) score += 1

  // First-block detail: the anchor text should be we-dense, I-sparse, and the
  // first tool call should read the guide in ONE shot (not multi-step hunting).
  if (s.firstBlockCounts) {
    score += Math.min(3, s.firstBlockCounts.we) // +0..3 for we density
    score -= Math.min(4, s.firstBlockCounts.i) // -0..4 for first-person
    score -= s.firstBlockCounts.letMe * 3
  }
  const firstTool = s.assistantMessages.find((m) => m.toolCallBlocks.length > 0)?.toolCallBlocks[0]
  if (firstTool) {
    const args = firstTool.arguments
    const readsGuide = /agent-dev-guide\.md/.test(args) && /cat|read/.test(args)
    const hunts = /find|ls -la \/|sudo/.test(args)
    if (readsGuide && !hunts) score += 2
    else if (hunts) score -= 2
  }
  // Clean sessions preferred: fewer blocks/tool calls = less trajectory noise.
  if (s.metrics.blocks >= 5) score -= 2
  if (s.metrics.toolCalls >= 4) score -= 2
  if (s.metrics.toolCalls === 0 && s.metrics.blocks === 0) return -100 // empty/aborted session
  return score
}

/* ── output ────────────────────────────────────────────────────────────── */
function pad(str, width) {
  const s = String(str)
  return s.length >= width ? s : s + ' '.repeat(width - s.length)
}

function printTable(rows) {
  const header = [
    ['#', 3], ['session id', 20], ['preset', 9], ['tools', 5], ['首块', 16],
    ['class', 12], ['score', 6], ['we', 5], ['let me', 7], ['let\'s', 6],
    ['blocks', 7], ['可见回复', 7], ['tool calls', 11],
  ].map(([title, w]) => pad(title, w)).join(' ')
  console.log(header)
  console.log('-'.repeat(header.length))
  rows.forEach((r, i) => {
    const first = (r.firstClass?.metrics.firstLine || '—').slice(0, 15)
    console.log(
      pad(i + 1, 3) + pad(r.id, 20) + pad(r.selectedPreset ?? '?', 9) + pad(r.toolCount, 5)
      + pad(first, 16) + pad(r.firstClass?.label ?? '—', 12) + pad(r.firstClass?.score ?? '—', 6)
      + pad(r.metrics.we, 5) + pad(r.metrics.letMe, 7) + pad(r.metrics.lets, 6)
      + pad(r.metrics.blocks, 7) + pad(r.metrics.visibleReplies, 7) + pad(r.metrics.toolCalls, 11),
    )
  })
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const dir = args.sessionsDir ?? sessionsDirForCwd(args.cwd)
  if (!existsSync(dir)) {
    console.error(`sessions dir not found: ${dir}`)
    process.exit(1)
  }

  const sessionDirs = readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.startsWith('session-'))
    .map((d) => d.name)
    .sort()

  const analyzed = []
  const skipped = []
  for (const name of sessionDirs) {
    const zstd = join(dir, name, 'session.jsonl.zstd')
    const plain = join(dir, name, 'session.jsonl')
    let raw
    try {
      raw = existsSync(zstd) ? decompress(zstd) : existsSync(plain) ? readFileSync(plain, 'utf8') : null
      if (raw === null) { skipped.push(`${name}: no log file`); continue }
      analyzed.push(analyzeSessionLog(raw))
    } catch (error) {
      skipped.push(`${name}: ${error.message}`)
    }
  }

  const ranked = analyzed
    .map((s) => ({ ...s, rank: rankScore(s) }))
    .sort((a, b) => b.rank - a.rank || (a.createdAt ?? 0) - (b.createdAt ?? 0))

  console.log(`sessions scanned: ${sessionDirs.length} (analyzed ${analyzed.length}, skipped ${skipped.length})`)
  if (skipped.length > 0) console.log('skipped:\n  ' + skipped.join('\n  '))
  console.log()
  printTable(ranked)
  console.log()

  const winner = ranked[0]
  if (!winner || winner.rank < 0) {
    console.log('没有可用会话(全部为空/中断)。')
    return
  }
  console.log('════════ 最优采样轮 ════════')
  console.log(`session: ${winner.id}  (preset=${winner.selectedPreset}, tools=${winner.toolCount}, rank=${winner.rank})`)
  console.log(`首块分类: ${winner.firstClass?.label} (score ${winner.firstClass?.score})`)
  console.log(`全轮指纹: we=${winner.metrics.we} let me=${winner.metrics.letMe} let's=${winner.metrics.lets} `
    + `blocks=${winner.metrics.blocks} 可见回复=${winner.metrics.visibleReplies} tool calls=${winner.metrics.toolCalls}`)
  console.log()
  console.log('── 用户消息(可作 virtualUserTemplate 参照) ──')
  for (const m of winner.userMessages.slice(0, 3)) {
    if (m.text.includes('agent-dev-guide')) console.log(m.text.trim())
  }
  console.log()
  console.log('── 首个 reasoning 块全文(可作 virtualReasoningTemplate) ──')
  console.log(winner.firstReasoning.trim())
  console.log()
  const firstTools = winner.assistantMessages.find((m) => m.toolCallBlocks.length > 0)?.toolCallBlocks
  if (firstTools) {
    console.log('── 首个工具调用(可作虚拟 read 调用的参数参照) ──')
    for (const b of firstTools) console.log(`${b.name} ${b.arguments}`)
  }
}

main()
