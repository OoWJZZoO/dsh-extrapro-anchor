/**
 * extrapro-anchor — deterministic trajectory anchoring for DeepSeek Harness.
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
 *      [virtual] user asks the agent to fully read .dsh/agent-dev-guide.md
 *      [virtual] asst pre-sampled minimal-style reasoning + one `bash` tool
 *                call (`pwd && cat <guide>` — the minimal preset's real
 *                surface; there is no `read` tool there)
 *      [virtual] result the command's raw stdout: "<cwd>\n<guide content>",
 *                where the guide content is "When the user asks you to read
 *                this document and work according to it, it means that your
 *                Agent's operation has changed to some extent; please work
 *                according to the following more detailed prompt:" + the
 *                preset's REAL prompt (persona section excluded).
 *   2. [real] user      the user's actual first message.
 *   3. [injected] user  AGENTS.md / CLAUDE.md — composed by the harness's OWN
 *                       dsh-agent-instructions (a dsh-base dependency) AFTER
 *                       the real user message, matching the standard
 *                       convention. extrapro-anchor does NOT inject them itself.
 *
 * Net effect: the model believes it has two tools (minimal system statement),
 * opens with "We need …", then the virtual turn's result reveals the preset's
 * real prompt. The request schemas stay full the whole time, so every tool
 * name + description comes from the schemas themselves — not duplicated into
 * the guide file (cache friendly).
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
 * elevation auto-capture, and the appended events
 * are already in the log before `buildRequest` calls
 * `session.deriveMessages()`. The section replacement happens AFTER seeding so
 * the guide captures the composition's REAL prompt, not the minimal one.
 *
 * Fail-safe: every failure path logs a warning and leaves the session running
 * WITHOUT the anchor. A plugin hook must never throw into the harness.
 */
import { createRequire } from 'node:module'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  PLUGIN_NAME,
  ANCHOR_USER_SOURCE_FORM,
  DEFAULT_ELEVATION_NOTICE,
  DEFAULT_VIRTUAL_USER_TEMPLATE,
  DEFAULT_VIRTUAL_REASONING_TEMPLATE,
  DEFAULT_VIRTUAL_COMMAND_TEMPLATE,
  assertVirtualTurnAppendable,
  buildGuideContent,
  buildVirtualTurn,
  appendVirtualTurn,
  buildBashReadResult,
  buildMinimalSections,
  guideAbsolutePath,
  guideRelativePath,
  hasPartialAnchorTurn,
  isAnchorSeeded,
  isFreshTopLevelAgent,
  isTopLevelAgent,
  interpolatePath,
  interpolateVariables,
} from './runtime.js'
import { checkHostEnvironment, writeGuardLog, guardFailNotice } from './guards.js'
import { DEFAULT_SETTINGS, createSettingsStore } from './settings.js'
import { createExtraproAnchorConfigBridge } from './config-remote.js'
import {
  createGitBashToolDefinition,
  dropPwshTool,
  findGitBash,
  hideBashTool,
} from './windows-gitbash.js'

export const name = PLUGIN_NAME

// The Windows Git Bash adaptation registers an experimental `bash` tool, so
// this branch needs the tools service in addition to the event hooks. The
// `shellEnv` service is read OPTIONALLY via ctx.get (not injected): the tool
// advertises managed `$DSH_*` facts only when it can actually supply them.
// `jobs` is likewise resolved lazily at tool-execution time (official
// dsh-tool-bash pattern), so boot never depends on row ordering.
export const inject = ['tools']

/** Kept for backward-compatible imports; instructions are owned by the harness now. */
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
 * Dynamic system-prompt sections preserved by the global minimal replacement.
 * `plan:policy` is dsh-plan-mode's guidance section: when plan mode is active
 * its dynamic text is non-empty, and the section is appended AFTER the minimal
 * persona/tools sections so the plan rules still reach the model without
 * touching runtime CONTEXT (whose cache prefix stays stable).
 */
export const DEFAULT_DYNAMIC_SECTIONS = ['plan:policy']

/**
 * Normalize the composition-row config. Invalid values fall back to the safe
 * default and are reported through `warnings` (logged once by `apply`), so a
 * typo degrades the anchor text instead of taking the harness boot down.
 */
export function parseConfig(config) {
  const cfg = config ?? {}
  const warnings = []
  const warn = (key, fallback) => warnings.push(
    `${PLUGIN_NAME}: invalid config "${key}", falling back to the default (${fallback})`,
  )
  const elevationPrompt = typeof cfg.elevationPrompt === 'string' ? cfg.elevationPrompt : ''
  const elevationNotice =
    typeof cfg.elevationNotice === 'string' && cfg.elevationNotice.trim().length > 0
      ? cfg.elevationNotice
      : DEFAULT_ELEVATION_NOTICE

  // Injection on/off. The panel's durable setting overrides this row value at
  // seed time; this is the fallback when no settings file exists. Defaults to
  // OFF (the panel's requested out-of-the-box posture).
  let enabled = cfg.enabled
  if (enabled === undefined) enabled = DEFAULT_SETTINGS.enabled
  if (typeof enabled !== 'boolean') {
    warn('enabled', String(DEFAULT_SETTINGS.enabled))
    enabled = DEFAULT_SETTINGS.enabled
  }

  // Windows Git Bash background execution. Mirrors dsh-tool-bash's
  // `enableRunInBackground` knob: true keeps `run_in_background` in the
  // experimental bash schema, false removes it and rejects forced background
  // calls. Defaults to ON because the shipped compositions always load the
  // generic jobs runtime and job_output/job_kill tools.
  let enableRunInBackground = cfg.enableRunInBackground
  if (enableRunInBackground === undefined) enableRunInBackground = true
  if (typeof enableRunInBackground !== 'boolean') {
    warn('enableRunInBackground', 'true')
    enableRunInBackground = true
  }

  // Where the panel settings file lives. Exposed for tests and unusual
  // deployments; normal installs use the DSH_HOME/storages default.
  const settingsPath = typeof cfg.settingsPath === 'string' && cfg.settingsPath.trim().length > 0
    ? cfg.settingsPath.trim()
    : undefined

  let elevationSource = cfg.elevationSource
  if (elevationSource === undefined) elevationSource = 'auto'
  if (elevationSource !== 'auto' && elevationSource !== 'config' && elevationSource !== 'none') {
    warn('elevationSource', 'auto')
    elevationSource = 'auto'
  }

  const personaSection =
    typeof cfg.personaSection === 'string' && cfg.personaSection.length > 0 ? cfg.personaSection : DEFAULT_PERSONA_SECTION

  const template = (key, fallback) => {
    const value = cfg[key]
    if (value === undefined) return fallback
    if (typeof value === 'string' && value.includes('{path}')) return value
    warn(key, fallback)
    return fallback
  }
  const virtualUserTemplate = template('virtualUserTemplate', DEFAULT_VIRTUAL_USER_TEMPLATE)
  const virtualReasoningTemplate = template('virtualReasoningTemplate', DEFAULT_VIRTUAL_REASONING_TEMPLATE)
  const virtualCommandTemplate = template('virtualCommandTemplate', DEFAULT_VIRTUAL_COMMAND_TEMPLATE)

  let virtualToolName = cfg.virtualToolName
  if (virtualToolName === undefined) virtualToolName = 'bash'
  if (typeof virtualToolName !== 'string' || virtualToolName.length === 0) {
    warn('virtualToolName', 'bash')
    virtualToolName = 'bash'
  }

  let dynamicSections = cfg.dynamicSections
  if (dynamicSections === undefined) dynamicSections = [...DEFAULT_DYNAMIC_SECTIONS]
  if (!Array.isArray(dynamicSections) || dynamicSections.some((name) => typeof name !== 'string' || name.length === 0)) {
    warn('dynamicSections', DEFAULT_DYNAMIC_SECTIONS.join(', '))
    dynamicSections = [...DEFAULT_DYNAMIC_SECTIONS]
  } else {
    dynamicSections = [...new Set(dynamicSections)]
  }

  const guardEnabled = cfg.guard?.enabled !== false

  // Accepted for backward compatibility but inert: workspace instructions are
  // injected by the harness's OWN dsh-agent-instructions after the real first
  // user message. Surface a one-time warning when they are configured so the
  // knobs no longer look effective.
  if (cfg.injectProjectInstructions !== undefined || cfg.maxInstructionsBytes !== undefined) {
    warnings.push(
      `${PLUGIN_NAME}: injectProjectInstructions and maxInstructionsBytes are inert — ` +
      'workspace instructions are owned by the harness dsh-agent-instructions plugin',
    )
  }

  return {
    elevationPrompt,
    elevationNotice,
    elevationSource,
    personaSection,
    virtualUserTemplate,
    virtualReasoningTemplate,
    virtualToolName,
    virtualCommandTemplate,
    dynamicSections,
    guardEnabled,
    enabled,
    enableRunInBackground,
    settingsPath,
    warnings,
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

/** Concatenate the text blocks of a message-shaped object. */
function messageTextOf(message) {
  return (message?.content ?? [])
    .filter((block) => block?.type === 'text')
    .map((block) => block.text)
    .join('\n')
}

/**
 * Resolve the Typert protocol namespace WITHOUT a top-level import.
 *
 * `@deepseek-ai/dsh-typert-protocol` is optional — a top-level import would
 * take the whole plugin boot down in profiles where it is not installed.
 * `createRequire` lets us try synchronously (Node 22 require-ESM) and degrade
 * to "panel config bridge unavailable" (injection itself still works) instead
 * of failing to load.
 */
function loadTypertProtocol() {
  try {
    return createRequire(import.meta.url)('@deepseek-ai/dsh-typert-protocol')
  } catch {
    return null
  }
}

/**
 * Build the "tool call aborted" error factory for the Windows Git Bash tool.
 * Preferred shape is the harness's own `HarnessError(TOOL_ABORTED)`, resolved
 * lazily like the Typert bridge so a missing optional package cannot break
 * boot; otherwise fall back to a plain Error named `AbortError`, which the
 * agent loop also recognizes.
 */
function loadAbortedErrorFactory() {
  try {
    const dshTools = createRequire(import.meta.url)('@deepseek-ai/dsh-tools')
    const dshLlm = createRequire(import.meta.url)('@deepseek-ai/dsh-llm')
    if (dshTools?.TOOL_ABORTED !== undefined && typeof dshLlm?.HarnessError === 'function') {
      return () => {
        const error = new dshLlm.HarnessError('tool call aborted', dshTools.TOOL_ABORTED)
        error.name = 'AbortError'
        return error
      }
    }
  } catch {
    // Fall through to the plain AbortError below.
  }
  return () => {
    const error = new Error('tool call aborted')
    error.name = 'AbortError'
    return error
  }
}

export function apply(ctx, config) {
  const cfg = parseConfig(config)

  // ── environment self-check (fail-safe, dsh-read-image pattern) ──
  const forced = process.env.DSH_EXTRAPRO_ANCHOR_FORCE_GUARD_FAIL === '1'
    ? [{ name: 'forced', detail: 'DSH_EXTRAPRO_ANCHOR_FORCE_GUARD_FAIL=1 强制模拟环境不满足（仅测试用）' }]
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

  for (const warning of cfg.warnings) {
    try {
      ctx.logger.warn(warning)
    } catch {
      // Logger unavailable — configuration warnings are non-fatal anyway.
    }
  }

  // ── floating-panel settings (disk is the truth at every seed) ──────────
  // The browser panel flushes its cached edits on fold / next injection and
  // then calls extraproAnchorConfig.set; this store re-reads the file on mtime
  // change, so the next fresh seed always uses the latest persisted values.
  const settingsStore = createSettingsStore({
    ...(cfg.settingsPath === undefined ? {} : { path: cfg.settingsPath }),
    fallback: cfg,
  })
  for (const warning of settingsStore.warnings()) {
    try {
      ctx.logger.warn(warning)
    } catch {
      // Logger unavailable — the settings store already fell back safely.
    }
  }

  // ── Windows Git Bash adaptation (experimental branch) ───────────────────
  // On Windows the default shell tool is pwsh. When Git Bash is installed, the
  // plugin registers a `bash` tool backed by the detected bash.exe; anchored
  // sessions then drop pwsh from the model-facing catalog. The tool mirrors
  // dsh-tool-bash's dual-mode flow: foreground calls run with timeout/abort,
  // `run_in_background` registers the process handle with ctx.jobs (resolved
  // lazily at execution time). The schema still never advertises sandbox
  // escalation — this backend does not sandbox (see lib/windows-gitbash.js).
  // The registration is global, so the assemble listener below hides it again
  // whenever injection is OFF or the session is not anchored.
  const gitBashPath = findGitBash()
  if (gitBashPath) {
    let shellEnv
    try {
      shellEnv = typeof ctx.get === 'function' ? ctx.get('shellEnv') : undefined
    } catch {
      // Optional service: without it the tool simply omits the `$DSH_*` claim.
    }
    const getJobs = typeof ctx.get === 'function'
      ? () => {
          try {
            return ctx.get('jobs')
          } catch {
            return undefined
          }
        }
      : () => undefined
    const makeAbortedError = loadAbortedErrorFactory()
    const tools = typeof ctx.tools === 'object' && ctx.tools !== null ? ctx.tools : undefined
    if (tools && typeof tools.register === 'function') {
      try {
        const existing = typeof tools.get === 'function' ? tools.get('bash') : undefined
        if (existing === undefined) {
          tools.register(createGitBashToolDefinition({
            bashPath: gitBashPath,
            shellEnv,
            getJobs,
            makeAbortedError,
            backgroundEnabled: cfg.enableRunInBackground,
          }))
          try {
            ctx.logger.warn(`${name}: Windows Git Bash detected at ${gitBashPath}; registered a foreground/background bash tool`)
          } catch {
            // Logger unavailable — the registration itself is what matters.
          }
        }
      } catch (error) {
        try {
          ctx.logger.warn(`${name}: Windows Git Bash tool registration failed: ${String((error && error.message) || error)}`)
        } catch {
          // Logger unavailable — keep the plugin alive.
        }
      }
    } else {
      try {
        ctx.logger.warn(`${name}: Windows Git Bash detected at ${gitBashPath}, but ctx.tools is unavailable; the model-facing bash swap has no executor behind it`)
      } catch {
        // Logger unavailable — the plugin still runs.
      }
    }
  }

  // Mount the Typert Remote bridge the panel uses. Optional by design: without
  // typert-protocol or without ctx.plugin (unusual host), the panel cannot
  // edit settings, but injection still works from row config.
  const typertProtocol = loadTypertProtocol()
  if (typertProtocol !== null && typeof ctx.plugin === 'function') {
    try {
      ctx.plugin(createExtraproAnchorConfigBridge(typertProtocol, settingsStore))
    } catch (error) {
      try {
        ctx.logger.warn(`${name}: 悬浮面板配置桥挂载失败（面板将无法保存配置）: ${String((error && error.message) || error)}`)
      } catch {
        // Logger unavailable — the bridge is optional anyway.
      }
    }
  } else if (typertProtocol !== null) {
    try {
      ctx.logger.warn(`${name}: ctx.plugin 缺失，悬浮面板配置桥未挂载（面板将无法保存配置）`)
    } catch {
      // Logger unavailable — the bridge is optional anyway.
    }
  }

  // Sessions anchored in this process. The durable-log scan (isAnchorSeeded /
  // hasPartialAnchorTurn) covers resume/reload; the WeakSet is the in-process
  // fast path and belt-and-braces against repeated assemblies.
  const anchored = new WeakSet()
  const warnedSessions = new WeakSet()
  const warnSession = (session, message) => {
    if (session && warnedSessions.has(session)) return
    if (session) warnedSessions.add(session)
    try {
      ctx.logger.warn(message)
    } catch {
      // Logger unavailable — the guard exists only to avoid spamming.
    }
  }

  /**
   * Seed one session: write the single shared guide file and append the
   * virtual turn. Any failure throws to the listener, which logs one warning
   * and leaves the session running without the anchor — never into the
   * harness boot path.
   */
  const seed = async (agent, assembled, settings) => {
    const session = agent.session
    if (!session || typeof session.append !== 'function') {
      throw new Error(`${name}: session.append unavailable — anchor not seeded`)
    }
    // A virtual assistant/message with empty provider/model would be rejected
    // by Session.fromRestore later, making the whole session unloadable.
    // Refuse to write that event shape; the harness's own request pipeline
    // will report a missing route if it is genuinely missing.
    const provider = agent.options?.provider
    const model = agent.options?.model
    if (typeof provider !== 'string' || provider.length === 0 || typeof model !== 'string' || model.length === 0) {
      throw new Error(`${name}: agent has no provider/model route — refusing to write an unrestorable virtual assistant message`)
    }
    const cwd = session.header?.cwd ?? process.cwd()
    const guidePath = guideAbsolutePath(cwd)
    // The transcript references the PROJECT-ROOT-RELATIVE path; the file is
    // written at the absolute path. One shared file, overwritten per fresh
    // seed: the virtual read result is durable in the session log.
    const displayPath = guideRelativePath()
    // The guide carries the composition's REAL prompt (captured before the
    // system sections are replaced below). The full tool catalog is NOT
    // duplicated into the guide: the request's tool schemas already carry
    // every tool name + description.
    const fullGuideContent = buildGuideContent({
      notice: settings.elevationNotice,
      prompt: captureElevation(assembled, cfg),
    })
    const command = interpolatePath(settings.virtualCommandTemplate, displayPath)
    const events = buildVirtualTurn({
      command,
      resultText: buildBashReadResult(cwd, fullGuideContent),
      userText: interpolatePath(settings.virtualUserTemplate, displayPath),
      reasoningText: interpolatePath(settings.virtualReasoningTemplate, displayPath),
      toolName: cfg.virtualToolName,
      provider,
      model,
    })

    // Validate the whole turn against the current event contract BEFORE the
    // first append, so an upstream shape change degrades cleanly instead of
    // leaving a partial transcript.
    assertVirtualTurnAppendable(events)

    // 1) The REAL file must exist before the virtual turn references it, so a
    //    later genuine read returns the identical content. `.dsh` is created
    //    non-recursively: recursive mkdir can hang on pseudo-filesystems.
    const guideDir = dirname(guidePath)
    try {
      await mkdir(guideDir)
    } catch (error) {
      if (!error || error.code !== 'EEXIST') throw error
    }
    await writeFile(guidePath, fullGuideContent, 'utf8')

    // 2) The virtual anchor turn itself: sampled minimal-style reasoning plus
    //    one bash call whose fabricated result is the exact stdout of the
    //    command (`pwd && cat {path}` → `<cwd>\n<content>`). The append is
    //    idempotent: a partial turn from an interrupted seed is completed.
    //    AGENTS.md/CLAUDE.md are NOT injected here: the harness's own
    //    dsh-agent-instructions (a dsh-base dependency) composes them AFTER
    //    the claimed real user messages, matching the standard convention
    //    (virtual turn → REAL user first message → AGENTS.md). Disable that
    //    harness plugin if you want no workspace instructions at all.
    appendVirtualTurn(session, events, displayPath)
    anchored.add(agent)
  }

  /** One seed attempt per session; concurrent assemblies await the same promise. */
  const seeding = new Map()
  const seedOnce = (agent, assembled, settings) => {
    const key = agent.session?.id
    if (key !== undefined && seeding.has(key)) return seeding.get(key)
    const promise = seed(agent, assembled, settings)
    if (key !== undefined) {
      seeding.set(key, promise)
      promise.finally(() => {
        if (seeding.get(key) === promise) seeding.delete(key)
      }).catch(() => {
        // The listener already handles the rejection; this arm only prevents
        // an unhandled rejection from the cleanup chain.
      })
    }
    return promise
  }

  // ── session title recovery ─────────────────────────────────────────────
  //
  // The virtual user message is `source.kind: 'user'` so the trajectory opens
  // a real user turn. The harness session-title service keys on the same field
  // and therefore titles the session from the VIRTUAL request (the built-in
  // first-prompt provider always picks messages[0]). Once a title event citing
  // the virtual message is observed after the real first message, replace it:
  // with a mounted title provider we generate a fresh title from the REAL
  // message and append it as a provider title; otherwise we append a corrected
  // deterministic fallback ourselves.
  const titleFixed = new WeakSet()
  const realTitleText = (session) => {
    const events = Array.isArray(session?.events) ? session.events : []
    const anchorSeq = events.findIndex((event) =>
      event.type === 'user/message' && event.data?.source?.form === ANCHOR_USER_SOURCE_FORM,
    )
    if (anchorSeq < 0) return { anchorSeq, realSeq: -1, text: '' }
    const realSeq = events.findIndex((event, index) =>
      index > anchorSeq && event.type === 'user/message' &&
      event.data?.source?.kind === 'user' && event.data?.source?.form !== ANCHOR_USER_SOURCE_FORM,
    )
    if (realSeq < 0) return { anchorSeq, realSeq, text: '' }
    return { anchorSeq, realSeq, text: messageTextOf(events[realSeq]?.data) }
  }
  const titleCitesVirtual = (session, anchorSeq) => {
    const title = session?.events?.findLast((event) => event.type === 'session/title')
    return title?.data?.messageSeqs?.includes(anchorSeq) === true
  }
  const appendTitle = async (session, titleText, realSeq, source) => {
    if (typeof titleText !== 'string' || titleText.trim().length === 0) return false
    await Promise.resolve()
    try {
      session.append('session/title', {
        title: titleText.trim(),
        messageSeqs: [realSeq],
        source,
      })
      return true
    } catch (error) {
      warnSession(session, `${name}: session title correction append failed (cosmetic): ${String((error && error.message) || error)}`)
      return false
    }
  }
  const fallbackTitle = (text, config) => {
    const maxWords = Number.isSafeInteger(config?.fallbackMaxWords) ? config.fallbackMaxWords : 8
    const maxBytes = Number.isSafeInteger(config?.fallbackMaxBytes) ? config.fallbackMaxBytes : 64
    const words = String(text).replace(/\s+/gu, ' ').trim().split(' ').filter(Boolean)
    const joined = words.slice(0, maxWords).join(' ')
    const bytes = Buffer.from(joined, 'utf8')
    return (bytes.length <= maxBytes ? joined : bytes.subarray(0, maxBytes).toString('utf8')).trim()
  }
  const fixSessionTitle = async (session) => {
    if (!session || titleFixed.has(session)) return
    const { anchorSeq, realSeq, text } = realTitleText(session)
    if (anchorSeq < 0 || realSeq < 0 || text.length === 0) return
    if (!titleCitesVirtual(session, anchorSeq)) {
      titleFixed.add(session)
      return
    }
    let titleService
    try {
      titleService = typeof ctx.get === 'function' ? ctx.get('sessionTitle') : undefined
    } catch {
      titleService = undefined
    }
    const registration = titleService?.registration
    if (registration && !registration.closing && typeof registration.provider?.generate === 'function') {
      titleFixed.add(session)
      const provider = registration.provider
      const route = session.requestHeader?.()?.config
      let generated
      try {
        generated = await provider.generate({
          session,
          messages: [{ seq: session.events[realSeq].seq, text }],
          ...(route === undefined ? {} : { route }),
          signal: new AbortController().signal,
        })
      } catch (error) {
        warnSession(session, `${name}: real-message title generation failed, using fallback: ${String((error && error.message) || error)}`)
      }
      const generatedTitle = typeof generated?.title === 'string' ? generated.title.trim() : ''
      if (generatedTitle.length > 0) {
        const source = {
          kind: 'provider',
          provider: typeof provider.id === 'string' && provider.id.length > 0 ? provider.id : name,
          ...(generated?.model !== undefined ? { model: generated.model } : {}),
        }
        await appendTitle(session, generatedTitle, session.events[realSeq].seq, source)
        return
      }
    } else {
      titleFixed.add(session)
    }
    // No provider or provider generation failed: append a deterministic fallback.
    const fallback = fallbackTitle(text, titleService?.config)
    if (fallback.length > 0) await appendTitle(session, fallback, session.events[realSeq].seq, { kind: 'fallback' })
  }
  ctx.on('session/event', (session, event) => {
    if (!session) return
    if (event?.type === 'session/title') {
      void fixSessionTitle(session)
      return
    }
    // With no mounted title provider, the fallback title is written from the
    // VIRTUAL message before the real one exists; correct it as soon as the
    // real first message lands. With a provider, wait for its title event so
    // our correction cannot race the provider's own pending generation.
    if (event?.type === 'user/message' && event.data?.source?.kind === 'user' && event.data?.source?.form !== ANCHOR_USER_SOURCE_FORM) {
      let titleService
      try {
        titleService = typeof ctx.get === 'function' ? ctx.get('sessionTitle') : undefined
      } catch {
        titleService = undefined
      }
      if (!(titleService?.registration && !titleService.registration.closing)) void fixSessionTitle(session)
    }
  })

  // ── replace the system prompt with the minimal persona + two-tool statement,
  //    and seed the virtual turn on the first assembly of a fresh top-level session
  //
  // The anchor's core move: whatever ordinary preset the composition mounts, the
  // model's FIRST request must see the minimal system-prompt condition (persona
  // sentence + a tool-catalog statement listing only bash/str_replace_editor),
  // so it opens inside the minimal trajectory ("We need …"), while the request's
  // TOOL SCHEMAS stay FULL (28 tools — never filtered). The guide file written
  // here carries the composition's REAL prompt; the virtual turn's bash result
  // reveals it, and the model then freely calls the full catalog — whose names
  // and descriptions come from the schemas, not from guide text. The section
  // replacement is GLOBAL and idempotent:
  // every assemble() (every step/turn) re-applies it, so the persisted
  // request/header stays on the minimal system for request-cache stability.
  ctx.on('system-prompt/assemble', async (assembly, context, next) => {
    // Downstream errors propagate untouched; only this plugin's logic is guarded.
    const assembled = await next()
    const agent = context?.agent
    try {
      // The panel settings file is the truth for the NEXT injection: re-read it
      // whenever its mtime moved (panel flush, another tab, a hand edit).
      const settings = settingsStore.snapshot()
      // On Windows + Git Bash, the experimental bash tool is hidden outside
      // anchored sessions so the host's pwsh surface stays the default.
      const hideGitBashTool = (tools) => gitBashPath ? hideBashTool(tools) : tools
      if (!isTopLevelAgent(agent)) {
        assembled.tools = hideGitBashTool(assembled.tools)
        return assembled
      }
      const fresh = isFreshTopLevelAgent(agent)
      const partial = hasPartialAnchorTurn(agent)
      const durable = isAnchorSeeded(agent)
      const alreadyAnchored = anchored.has(agent)
      if (!fresh && !partial && !durable && !alreadyAnchored) {
        assembled.tools = hideGitBashTool(assembled.tools)
        return assembled
      }
      if (!alreadyAnchored) {
        if (partial) {
          // A partial seed from before the switch was turned off is completed,
          // never left half-written in the transcript.
          await seedOnce(agent, assembled, settings)
        } else if (settings.enabled) {
          // First assembly of a fresh top-level session, with injection ON:
          // capture the REAL prompt (still full at this point) into the guide
          // and append the virtual turn.
          await seedOnce(agent, assembled, settings)
        } else {
          // Injection OFF: the fresh session runs on its ordinary system prompt.
          assembled.tools = hideGitBashTool(assembled.tools)
          return assembled
        }
      }
      // Only replace the system for sessions that actually carry the anchor.
      // A seed that failed (e.g. missing route) leaves the assembly untouched.
      if (!anchored.has(agent) && !isAnchorSeeded(agent)) {
        assembled.tools = hideGitBashTool(assembled.tools)
        return assembled
      }
      // Global replacement: minimal persona + two-tool statement. Tools schemas
      // are left intact — every tool name + description comes from the schemas,
      // not from the guide text.
      const minimalSections = buildMinimalSections()
      // Whitelisted dynamic sections (plan mode guidance) are appended AFTER
      // the minimal sections when their rendered text is non-empty. Their text
      // is the harness's own dynamic evaluation: an inactive plan mode renders
      // empty and is dropped. Dynamic CONTEXT is deliberately not touched.
      const dynamicSections = assembled.sections.filter(
        (section) => cfg.dynamicSections.includes(section.name) &&
          typeof section.text === 'string' && section.text.trim().length > 0,
      )
      assembled.sections = [...minimalSections, ...dynamicSections]
      // Windows Git Bash adaptation: with injection ON, pwsh is dropped from the
      // model-facing catalog and the registered bash tool remains; with injection
      // OFF, the experimental bash tool is hidden and pwsh remains.
      if (gitBashPath) {
        assembled.tools = settings.enabled ? dropPwshTool(assembled.tools) : hideBashTool(assembled.tools)
      }
      return assembled
    } catch (error) {
      warnSession(
        agent?.session,
        `${name}: anchor seeding failed for session "${agent?.session?.id ?? '?'}", ` +
        `session continues without the anchor: ${String((error && error.message) || error)}`,
      )
      return assembled
    }
  })
}
