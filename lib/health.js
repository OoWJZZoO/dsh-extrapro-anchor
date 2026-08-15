/**
 * Thinking-chain health for the floating panel — pure, harness-free logic.
 *
 * Quantification is derived from the two reference repositories in this
 * checkout, kept deliberately close to their published classifier:
 *
 *   - `modeltest/evaluator/trigger_probe/src/classifier.mjs`
 *     (first line "We need" +3; first line "Let me" −3; "we" without
 *     "let me" +2; any "let me" −2; lone praise marker +1; label threshold
 *     ±4). This is the conservative lexical classifier the 2026-08-14
 *     trigger experiments shipped.
 *   - `dsh-anchored-standard/README.md` trajectory table: the anchored
 *     minimal runs are "we"-style with `let me = 0/1`, while the standard
 *     baseline is "Let me"-heavy (`let me=208`). The panel therefore treats
 *     ANY `let me` in the recent chain as the user-facing warning condition.
 *
 * The host plugin does not consume this module — it is the single source of
 * truth the browser bundle (`panel/client.js`) duplicates. Update both sides
 * together (see the duplicate block in panel/client.js).
 */

/** Case-insensitive whole-word count, matching the reference classifier. */
function countPhrase(text, regex) {
  return [...text.matchAll(regex)].length
}

/**
 * Classify ONE reasoning block with the reference probe's verbatim rules
 * (`visibleBeforeTool` is always false here: the panel only sees finalized or
 * streaming blocks, not a tool-visibility flag).
 */
export function classifyReasoning(reasoning) {
  const text = String(reasoning ?? '').trim()
  const firstLine = text.split(/\r?\n/, 1)[0] ?? ''
  const metrics = {
    firstLine,
    chars: text.length,
    we: countPhrase(text, /\bwe\b/gi),
    letMe: countPhrase(text, /\blet me\b/gi),
    i: countPhrase(text, /\bi\b/gi),
    markerFirstLine: /^(good|great|excellent)\.?$/i.test(firstLine.trim()),
  }
  if (text.length === 0) {
    return { label: 'empty', score: 0, metrics }
  }
  let score = 0
  if (/^we need\b/i.test(firstLine)) score += 3
  if (/^let me\b/i.test(firstLine)) score -= 3
  if (metrics.we > 0 && metrics.letMe === 0) score += 2
  if (metrics.letMe > 0) score -= 2
  if (metrics.markerFirstLine) score += 1
  const label = score >= 4 ? 'minimal-like' : score <= -4 ? 'standard-like' : 'ambiguous'
  return { label, score, metrics }
}

/**
 * Aggregate the health of a chain from its most recent reasoning blocks.
 *
 * Any `let me` is already `watch`; when the standard-like blocks outnumber the
 * minimal-like ones (or the summed score drops to the reference's standard
 * threshold) it escalates to `drift`. The 0–100 number is the classifier score
 * scaled around 60 so a single strong "We need…" block reads as a healthy 80
 * and a single strong "Let me…" block reads as a worrying 40 — numbers the
 * compact pill can show without extra copy.
 */
export function computeChainHealth(blocks, { window = 8 } = {}) {
  const texts = Array.isArray(blocks) ? blocks.map((block) => String(block ?? '')) : []
  const recent = texts.slice(-Math.max(1, window))
  let we = 0
  let letMe = 0
  let i = 0
  let minimal = 0
  let standard = 0
  let ambiguous = 0
  let scoreSum = 0
  for (const text of recent) {
    const { label, score, metrics } = classifyReasoning(text)
    if (label === 'empty') continue
    we += metrics.we
    letMe += metrics.letMe
    i += metrics.i
    if (label === 'minimal-like') minimal += 1
    else if (label === 'standard-like') standard += 1
    else ambiguous += 1
    scoreSum += score
  }
  const seen = minimal + standard + ambiguous
  if (seen === 0) {
    return { status: 'idle', score: null, scoreSum: 0, we: 0, letMe: 0, i: 0, blocks: 0 }
  }
  const score = Math.max(0, Math.min(100, 60 + scoreSum * 4))
  let status = 'healthy'
  if (letMe > 0) {
    status = standard > minimal || scoreSum <= -4 ? 'drift' : 'watch'
  } else if (standard > minimal && scoreSum <= -4) {
    status = 'drift'
  }
  return {
    status,
    score,
    scoreSum,
    we,
    letMe,
    i,
    blocks: seen,
    minimal,
    standard,
    ambiguous,
  }
}

/**
 * Collect reasoning texts from a UI conversation snapshot's legacy node slice
 * plus the live partial. The virtual anchor prelude (turn 1, step 0) is
 * deliberately excluded: the panel must report the MODEL's chain, not the
 * pre-sampled seed text it already knows about.
 */
export function reasoningBlocksOf({ nodes, partial } = {}) {
  const blocks = []
  const visit = (item, isPartial) => {
    if (!item || !Array.isArray(item.blocks)) return
    if (item.turn === 1 && item.step === 0 && !isPartial) return
    for (const block of item.blocks) {
      if (block?.kind === 'reasoning' && typeof block.text === 'string' && block.text.trim().length > 0) {
        blocks.push(block.text)
      }
    }
  }
  for (const node of Array.isArray(nodes) ? nodes : []) {
    if (node?.kind === 'assistant') visit(node, false)
  }
  if (partial && Array.isArray(partial.blocks)) {
    if (!(partial.turn === 1 && partial.step === 0)) {
      for (const block of partial.blocks) {
        if (block?.kind === 'reasoning' && typeof block.text === 'string' && block.text.trim().length > 0) {
          blocks.push(block.text)
        }
      }
    }
  }
  return blocks
}

/** One-call health read used by the browser bundle duplicate. */
export function healthOfConversation({ nodes, partial } = {}, options) {
  return computeChainHealth(reasoningBlocksOf({ nodes, partial }), options)
}
