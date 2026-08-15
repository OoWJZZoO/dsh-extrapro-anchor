/**
 * anchor-seed — deterministic trajectory anchoring for DeepSeek Harness.
 *
 * Goal: in ANY ordinary preset, make the first model request run inside the
 * minimal trajectory (superior reasoning chain) while keeping the full tool
 * catalog usable afterwards (multi-tool capability). The plugin does this in
 * three moves, none of which depends on the model calling a real tool:
 *
 *   0. REPLACE the system prompt (every `system-prompt/assemble`, global and
 *      idempotent): whatever the composition mounted, the returned sections
 *      become the minimal persona sentence (byte-identical to the harness
 *      minimal preset) plus a two-tool statement ("You have access to the
 *      following tools: bash, str_replace_editor …"). The request's TOOL
 *      SCHEMAS stay FULL — never filtered.
 *   1. SEED one virtual turn into the session log before the first request:
 *      [virtual] user asks the agent to fully read .dsh/<id>/agent-dev-guide.md
 *      [virtual] asst pre-sampled minimal-style reasoning + one `bash` tool
 *                call (`pwd && cat <guide>` — the minimal preset's real
 *                surface; there is no `read` tool there)
 *      [virtual] result the command's raw stdout: "<cwd>\n<guide content>",
 *                where the guide content is "When the user asks you to read
 *                this document and work according to it, it means that your
 *                Agent's operation has changed to some extent; please work
 *                according to the following more detailed prompt:" + the
 *                preset's REAL prompt (persona section excluded) + the full
 *                tool catalog rendered as text (every tool name + description).
 *   2. [real] user      the user's actual first message.
 *   3. [injected] user  AGENTS.md / CLAUDE.md — composed by the harness's OWN
 *                       dsh-agent-instructions (a dsh-base dependency) AFTER
 *                       the real user message, matching the standard
 *                       convention. anchor-seed does NOT inject them itself.
 *
 * Net effect: the model believes it has two tools (minimal system statement),
 * opens with "We need …", then the virtual turn's result reveals the full
 * catalog as text — it learns the real capability set and freely calls any
 * tool, while the request schemas were full the whole time (cache friendly).
 *
 * The guide file is REALLY written to disk first (content identical to the
 * virtual result), so a later real read of the file cannot contradict the
 * history the model saw. The turn/step trace events are intentionally omitted:
 * the loop derives the real turn number from `turn/start` events at agent
 * construction, so synthetic boundary events could collide with the real
 * turn's numbering; message events are all the surface needs. The virtual
 * messages carry `turn: 1, step: 0`: turn 1 keeps the Initial System
 * Prompt (firstVisibleTurn) ahead of the virtual prelude, step 0 stays off
 * the real `1:1` assistant-step lifecycle. The virtual user message is
 * stamped `source.kind: 'user'` so the trajectory renders it as a real
 * user message.
 *
 * Seeding happens inside the `system-prompt/assemble` waterfall of the first
 * step — after `next()` resolves, the full section list is available for the
 * elevation auto-capture and the tool-catalog text, and the appended events
 * are already in the log before `buildRequest` calls
 * `session.deriveMessages()`. The section replacement happens AFTER seeding so
 * the guide captures the composition's REAL prompt, not the minimal one.
 *
 * Fail-safe: every failure path logs a warning and leaves the session running
 * WITHOUT the anchor. A plugin hook must never throw into the harness.
 */
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  PLUGIN_NAME,
  DEFAULT_ELEVATION_NOTICE,
  DEFAULT_VIRTUAL_USER_TEMPLATE,
  DEFAULT_VIRTUAL_REASONING_TEMPLATE,
  DEFAULT_VIRTUAL_COMMAND_TEMPLATE,
  buildGuideContent,
  buildVirtualTurn,
  appendVirtualTurn,
  buildBashReadResult,
  buildMinimalSections,
  buildToolCatalogText,
  guideAbsolutePath,
  guideRelativePath,
  isFreshTopLevelAgent,
  interpolatePath,
  interpolateVariables,
} from './runtime.js'
import { checkHostEnvironment, writeGuardLog, guardFailNotice } from './guards.js'

export const name = PLUGIN_NAME

// No service injects: the plugin only needs `ctx.on`, the agent/session passed
// by the dispatch, and node:fs. Fewer injects = fewer upgrade break points.
export const inject = []

export const DEFAULT_MAX_INSTRUCTIONS_BYTES = 65536
/**
 * The system-prompt section name of the persona, excluded from auto-capture.
 *
 * Must match the harness's own persona registration: dsh-persona mounts the
 * section under `PERSONA_SECTION = 'deployment:persona'` (dsh-system-prompt
 * lib/index.js), NOT `'persona'` — the old default never matched, so the
 * persona text leaked into every guide file. Overridable per composition row.
 */
export const DEFAULT_PERSONA_SECTION = 'deployment:persona'

/**
 * Validate the composition-row config. Invalid values throw at apply time
 * (preset mount), where they are visible and fixable — the same policy
 * dsh-anchored-standard's tool-bootstrap uses.
 */
export function parseConfig(config) {
  const cfg = config ?? {}
  const elevationPrompt = typeof cfg.elevationPrompt === 'string' ? cfg.elevationPrompt : ''
  const elevationNotice =
    typeof cfg.elevationNotice === 'string' && cfg.elevationNotice.trim().length > 0
      ? cfg.elevationNotice
      : DEFAULT_ELEVATION_NOTICE
  const elevationSource = cfg.elevationSource === 'config' || cfg.elevationSource === 'none' ? cfg.elevationSource : 'auto'
  const personaSection =
    typeof cfg.personaSection === 'string' && cfg.personaSection.length > 0 ? cfg.personaSection : DEFAULT_PERSONA_SECTION
  const virtualUserTemplate =
    typeof cfg.virtualUserTemplate === 'string' && cfg.virtualUserTemplate.includes('{path}')
      ? cfg.virtualUserTemplate
      : DEFAULT_VIRTUAL_USER_TEMPLATE
  const virtualReasoningTemplate =
    typeof cfg.virtualReasoningTemplate === 'string' && cfg.virtualReasoningTemplate.includes('{path}')
      ? cfg.virtualReasoningTemplate
      : DEFAULT_VIRTUAL_REASONING_TEMPLATE
  const virtualToolName =
    typeof cfg.virtualToolName === 'string' && cfg.virtualToolName.length > 0 ? cfg.virtualToolName : 'bash'
  const virtualCommandTemplate =
    typeof cfg.virtualCommandTemplate === 'string' && cfg.virtualCommandTemplate.includes('{path}')
      ? cfg.virtualCommandTemplate
      : DEFAULT_VIRTUAL_COMMAND_TEMPLATE
  // Accepted for backward compatibility: workspace instructions (AGENTS.md/
  // CLAUDE.md) are now injected by the harness's OWN dsh-agent-instructions
  // after the user's real first message (standard convention). These knobs are
  // inert — set injectProjectInstructions: false only as documentation; the
  // actual behavior is controlled by whether dsh-agent-instructions is mounted.
  const injectProjectInstructions = cfg.injectProjectInstructions !== false
  const maxInstructionsBytes =
    Number.isSafeInteger(cfg.maxInstructionsBytes) && cfg.maxInstructionsBytes > 0
      ? cfg.maxInstructionsBytes
      : DEFAULT_MAX_INSTRUCTIONS_BYTES
  const guardEnabled = cfg.guard?.enabled !== false
  return {
    elevationPrompt,
    elevationNotice,
    elevationSource,
    personaSection,
    virtualUserTemplate,
    virtualReasoningTemplate,
    virtualToolName,
    virtualCommandTemplate,
    injectProjectInstructions,
    maxInstructionsBytes,
    guardEnabled,
  }
}

/** The preset's real prompt for the guide file, per `elevationSource`. */
function captureElevation(assembled, cfg) {
  if (cfg.elevationSource === 'config') return cfg.elevationPrompt
  if (cfg.elevationSource === 'none') return ''
  // auto: join every non-persona rendered prompt section (the pre-complete-wipe
  // list the waterfall sees), falling back to the explicit config when the
  // preset registers no other sections. Sections are INTERPOLATED with the
  // assembly's variables first: the raw text carries literal {{model}}/{{cwd}}
  // placeholders, which would otherwise leak into the guide file and read as a
  // broken template (observed in the dev test).
  const sections = assembled?.sections ?? []
  const text = sections
    .filter((section) => section.name !== cfg.personaSection && typeof section.text === 'string' && section.text.trim().length > 0)
    .map((section) => interpolateVariables(section.text, assembled?.variables))
    .join('\n\n')
    .trim()
  return text.length > 0 ? text : cfg.elevationPrompt
}

export function apply(ctx, config) {
  const cfg = parseConfig(config)

  // ── environment self-check (fail-safe, dsh-read-image pattern) ──
  const forced = process.env.DSH_ANCHOR_SEED_FORCE_GUARD_FAIL === '1'
    ? [{ name: 'forced', detail: 'DSH_ANCHOR_SEED_FORCE_GUARD_FAIL=1 强制模拟环境不满足（仅测试用）' }]
    : []
  if (cfg.guardEnabled) {
    const result = checkHostEnvironment(ctx)
    const problems = [...result.problems, ...forced]
    if (problems.length > 0) {
      const logPath = writeGuardLog(problems)
      try {
        ctx.logger.error(guardFailNotice(logPath))
      } catch {
        // Even the failure path must never throw: the plugin stays inert and
        // the full diagnostics are already in the guard log file.
      }
      return
    }
  }

  // Sessions already seeded in this process. The durable-log freshness check in
  // isFreshTopLevelAgent covers resume/reload; the WeakSet is belt-and-braces
  // for repeated assemblies inside one process.
  const seeded = new WeakSet()
  let warned = false
  const warnOnce = (message) => {
    if (warned) return
    warned = true
    try {
      ctx.logger.warn(message)
    } catch {
      // Logger unavailable — the guard exists only to avoid spamming.
    }
  }

  /**
   * Seed one session: write the guide file, gather instructions, append the
   * virtual turn. Any failure logs a warning and leaves the session running
   * without the anchor — never throws to the harness.
   */
  const seed = async (agent, assembled) => {
    const session = agent.session
    if (typeof session.append !== 'function') {
      throw new Error(`${name}: session.append unavailable — anchor not seeded`)
    }
    const cwd = session.header?.cwd ?? process.cwd()
    const guidePath = guideAbsolutePath(cwd, session.id)
    // The transcript references the PROJECT-ROOT-RELATIVE path (matching the
    // sampled minimal round: "…entire .dsh/<id>/agent-dev-guide.md in the
    // project root directory…"); the file is written at the absolute path.
    const displayPath = guideRelativePath(session.id)
    // The guide carries the composition's REAL prompt (captured before the
    // system sections are replaced below) PLUS the full tool catalog rendered
    // as text: after the virtual read the model sees every tool it may
    // actually call, even though the first request's system prompt described
    // only the two minimal tools.
    const toolCatalog = buildToolCatalogText(assembled?.tools)
    const guideContent = buildGuideContent({
      notice: cfg.elevationNotice,
      prompt: captureElevation(assembled, cfg),
    })
    const fullGuideContent = toolCatalog.length > 0 ? `${guideContent}\n\n${toolCatalog}` : guideContent

    // 1) The REAL file must exist before the virtual turn references it, so a
    //    later genuine read returns the identical content.
    await mkdir(dirname(guidePath), { recursive: true })
    await writeFile(guidePath, fullGuideContent, 'utf8')

    // 2) The virtual anchor turn itself: sampled minimal-style reasoning plus
    //    one bash call whose fabricated result is the exact stdout of the
    //    command (`pwd && cat {path}` → `<cwd>\n<content>`).
    //    AGENTS.md/CLAUDE.md are NOT injected here: the harness's own
    //    dsh-agent-instructions (a dsh-base dependency) composes them AFTER
    //    the claimed real user messages, matching the standard convention
    //    (virtual turn → REAL user first message → AGENTS.md). Disable that
    //    harness plugin if you want no workspace instructions at all.
    const events = []
    const provider = agent.options?.provider ?? ''
    const model = agent.options?.model ?? ''
    const command = interpolatePath(cfg.virtualCommandTemplate, displayPath)
    events.unshift(...buildVirtualTurn({
      command,
      resultText: buildBashReadResult(cwd, fullGuideContent),
      userText: interpolatePath(cfg.virtualUserTemplate, displayPath),
      reasoningText: interpolatePath(cfg.virtualReasoningTemplate, displayPath),
      toolName: cfg.virtualToolName,
      provider,
      model,
    }))

    appendVirtualTurn(session, events)
    seeded.add(agent)
  }

  // ── replace the system prompt with the minimal persona + two-tool statement,
  //    and seed the virtual turn on the first assembly of a fresh top-level session
  //
  // The anchor's core move: whatever ordinary preset the composition mounts, the
  // model's FIRST request must see the minimal system-prompt condition (persona
  // sentence + a tool-catalog statement listing only bash/str_replace_editor),
  // so it opens inside the minimal trajectory ("We need …"), while the request's
  // TOOL SCHEMAS stay FULL (28 tools — never filtered). The guide file written
  // here carries the composition's REAL prompt plus the full tool catalog as
  // text; the virtual turn's bash result reveals it, and the model then freely
  // calls the full catalog. The section replacement is GLOBAL and idempotent:
  // every assemble() (every step/turn) re-applies it, so the persisted
  // request/header stays on the minimal system for request-cache stability.
  ctx.on('system-prompt/assemble', async (assembly, context, next) => {
    // Downstream errors propagate untouched; only this plugin's logic is guarded.
    const assembled = await next()
    const agent = context?.agent
    try {
      if (!agent) return assembled
      const fresh = isFreshTopLevelAgent(agent)
      const alreadySeeded = seeded.has(agent)
      if (!fresh && !alreadySeeded) return assembled // subagents / non-fresh: untouched
      if (fresh && !alreadySeeded) {
        // First assembly of a fresh top-level session: capture the REAL prompt
        // (still full at this point) into the guide and append the virtual turn.
        await seed(agent, assembled)
      }
      // Global replacement: minimal persona + two-tool statement. Tools schemas
      // are left intact — the full catalog is revealed by the guide text.
      assembled.sections = buildMinimalSections()
      return assembled
    } catch (error) {
      warnOnce(
        `${name}: anchor seeding failed for session "${agent?.session?.id ?? '?'}", ` +
        `session continues without the anchor: ${String((error && error.message) || error)}`,
      )
      return assembled
    }
  })
}
