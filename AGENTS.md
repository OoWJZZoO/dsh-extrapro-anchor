# AGENTS.md — dsh-extrapro-anchor contributor guide

This file helps AI agents (and humans) work on this repository without
breaking its contract with DeepSeek Harness.

## What this repository is

A Cordis host plugin for DeepSeek Harness that seeds every fresh top-level
session with one virtual minimal-style read turn before the first model
request, so the session starts inside the minimal trajectory without any real
tool call. See `README.md` / `docs/README.zh.md` for the mechanism.

## Layout

- `lib/runtime.js` — pure, harness-free logic (event construction, guide
  content, bash-stdout result rendering, durable anchor-state inspection).
  No Cordis imports; fully unit-tested. Keep it that way.
- `lib/index.js` — the Cordis host plugin: config parsing, fail-safe guard
  wiring, the `system-prompt/assemble` hook, settings-file gating, file
  writing, event injection.
- `lib/settings.js` — disk-backed panel settings store (defaults, validation,
  atomic writes). No Cordis imports.
- `lib/health.js` — thinking-chain health classifier derived from the
  reference repos (modeltest trigger probe + dsh-anchored-standard tables).
- `lib/config-remote.js` — `extraproAnchorConfig` Typert Remote bridge builder;
  receives the protocol namespace as a parameter so the module itself has no
  external imports.
- `lib/guards.js` — environment self-check (dsh-read-image pattern): a failed
  check must leave the plugin inert, never take the harness boot down.
- `panel/` — companion client row: empty host half (`index.js`), nested
  `package.json` carrying the `dsh.client` manifest, and the hand-built
  `__ModuleLoader__` browser bundle `client.js` (floating overlay, switch,
  health, text editor).
- `test/` — `node --test`; run `npm test` (87 tests incl. the reference
  dsh-anchored-standard tree under this checkout). `lib/runtime.js`,
  `lib/settings.js`, and `lib/health.js` must stay testable with zero harness
  dependencies.

## Invariants (do not break)

1. **Never throw out of a hook.** Every failure path in `apply()` and in the
   `system-prompt/assemble` listener logs a warning and lets the session run
   without the anchor. A plugin whose `apply()` throws takes the whole harness
   down.
2. **Never re-seed.** `isFreshTopLevelAgent` (no prior `user/message`, top
   level only) plus the per-process WeakSet guarantee one seed per session.
   Whether a session is already anchored is decided from the DURABLE log
   (`form: 'extrapro-anchor'` marker / `inspectAnchorTurn`), so resume/reload keeps
   the minimal system replacement. A partial seed is completed, never restarted.
3. **The transcript must be internally consistent.** The virtual turn runs
   on the minimal preset's REAL surface: `bash` (there is no `read` tool in
   minimal), the command defaults to `pwd && cat {path}`, and the `tool/result`
   is the exact raw stdout that command produces (`<cwd>\n<content>`).
   `lib/index.js` writes the shared guide file `.dsh/agent-dev-guide.md` with
   identical content BEFORE appending the events, so the virtual result and
   the file agree at seed time. The read result is durable in the log; the
   shared file is overwritten by later fresh seeds. If you override
   `virtualCommandTemplate`, keep the fabricated result consistent with that
   command's real output.
4. **Surface metadata is load-bearing.** `user/message`,
   `assistant/message`, and `tool/result` are surface-eligible events:
   `Session.append` REQUIRES `surfaceOp: 'append'`, and `tool/result` also
   requires `sourceEventSeqs: [<tool/call seq>]`. These shapes mirror the
   agent loop (dsh-agent-loop `turn()`/`step()`/`appendToolResult`); if an
   upstream harness changes them, the guard log and the "session continues
   without the anchor" warning are the safe failure mode — do not guess new
   shapes.
5. **No `turn/start`/`step/start`/`turn/end` for the virtual turn.** The loop
   derives its turn number from `turn/start` at agent construction; synthetic
   boundary events could collide with the real turn numbering. Message events
   are all the surface needs. The virtual messages DO carry `turn: 1,
   step: 0`: the trajectory UI keys the assistant-step lifecycle on
   `${turn}:${step}`, so stamping the virtual turn `1:1` made its
   `assistant/message` arrive as an "update" before the real `step/start`
   ("received an update before its start Match") and broke the trajectory
   render; step 0 avoids that key. Turn 1 (not 0) keeps the Initial System
   Prompt (`firstVisibleTurn`) ahead of the virtual prelude. The virtual
   user message uses `source.kind: 'user'` so the UI renders it as a real
   user message (opens a turn), plus `source.form: 'extrapro-anchor'` so the
   durable log can distinguish it from real human input and recover the
   session title from the real first message.
6. **The plugin replaces the system prompt itself — no preset precondition.**
   On every `system-prompt/assemble` of a top-level session, the returned
   `assembly.sections` are replaced with the minimal persona sentence (byte-
   identical to the harness minimal preset) plus a two-tool statement listing
   only `bash` and `str_replace_editor`. The tool SCHEMAS are never filtered —
   the request always carries the full catalog (every tool name +
   description), so the guide file must NOT duplicate the catalog as text; the
   schemas themselves are the single source of truth for the capability set.
   The replacement is idempotent and global: re-applied on every assemble so
   the persisted request/header stays minimal (request-cache friendly).
   Elevation capture must read the sections BEFORE the replacement (seed runs
   first). Whitelisted dynamic sections (`dynamicSections`, default
   `plan:policy`) are appended AFTER the two minimal sections when their
   rendered text is non-empty; never touch runtime CONTEXT (its cache prefix
   must stay stable). When the composition's persona is `complete: true`, the
   harness re-imposes that complete section after the waterfall, so the final
   system is the persona sentence alone — this is deliberate; the tools the
   model actually uses are the full schemas.
7. **Workspace instructions are the harness's job — the plugin does not
   inject AGENTS.md/CLAUDE.md.** The harness bundles
   `@deepseek-ai/dsh-agent-instructions` (a dsh-base dependency) which
   composes AGENTS.md/CLAUDE.md into `agent/pre-step` decisions AFTER the
   claimed real user messages. That matches the standard convention the user
   asked for (2026-08-15): virtual turn → user's real first message →
   AGENTS.md. extrapro-anchor never appends an instructions message itself and
   registers no `agent/pre-step` listener. `injectProjectInstructions` /
   `maxInstructionsBytes` are accepted for backward compatibility but inert.

## Working on the elevation / virtual dialogue

- `elevationSource: auto` captures the non-persona sections seen inside the
  `system-prompt/assemble` waterfall (before the complete-section wipe).
  Excluded section name is `personaSection` (default `deployment:persona`,
  the harness's own `PERSONA_SECTION`).
- The default `virtualUserTemplate`/`virtualReasoningTemplate` are verbatim
  text from the best modeltest-fingerprint round (`session-1018c36f`, minimal
  preset), selected by `scripts/find-best-sampling-round.mjs`; the path is
  generalized to the `{path}` placeholder (project-root-relative). It is an
  n=1 sample — when you swap in your own sample, document its source round.
- The virtual user text is "Please read the entire {path} …" (no "Session
  setup:" prefix, no "Do not reply yet" trailer — 2026-08-15 user request) and
  carries `source.kind: 'user'` so the trajectory renders it as a real user
  message.

## Working on the floating panel

- **One row id, five matching spellings.** The panel is a companion row named
  `@deepseek-ai/dsh-extrapro-anchor/panel`. These must stay byte-identical: the
  row name in `cordis.patch.yml`, the root package `exports["./panel"]`,
  `exports["./panel/package.json"]` / `"./panel/*"`, the nested
  `panel/package.json` `exports["./client"]`, and the
  `window.__ModuleLoader__.load({ id })` string in `panel/client.js`.
- **Disk is the truth.** The switch saves immediately through
  `extraproAnchorConfig.set`; text drafts are cached in the browser and flushed on
  fold or when the panel observes a NEW session id ("cache lands at the next
  injection"). The host re-reads `settings.json` on mtime change before every
  fresh seed. Invalid templates (missing `{path}`) are refused by BOTH the
  client (`validDraft`) and the host (`normalizeSettingsUpdate`).
- **Defaults are OFF.** `DEFAULT_SETTINGS.enabled` is `false`; the panel switch
  is what turns injection on for the user. Do not "helpfully" flip the default.
- **The Remote bridge must stay optional.** `lib/index.js` resolves
  typert-protocol with `createRequire` inside try/catch — never a top-level
  import — so the plugin still boots when the package is not resolvable. A
  missing bridge only disables panel saving; injection itself keeps working.
- **The Remote parameter name is wire-load-bearing.** The gateway derives the
  endpoint descriptor from the host method's REAL parameter names
  (`set(settings)`), so the client contribution's json parameter must declare
  `{ name: "settings", wire: "settings" }`. A mismatch fails every write with
  `arguments-invalid` — rename both sides together.
- **Do not put `dsh.client` on the root package.** The host row is already
  loaded in running profiles, so its package metadata is cached and a new
  client manifest would not be re-scanned until restart; the companion row is
  a NEW entry id and can be hot-added.
- **The panel bundle duplicates two host modules** (defaults from
  `lib/settings.js`, health classifier from `lib/health.js`) because a served
  client bundle cannot import the host half. Update all three sides together,
  and keep the panel's client-side guard pattern: any missing client service
  logs and installs nothing — a failed client plugin takes the whole web boot
  down.
- **Health reads the model, not the seed.** The panel excludes the virtual
  prelude (`turn: 1, step: 0`) and includes the live partial; any `let me` in
  the recent window must show the amber/red warning state.

## Verification workflow

```sh
npm run check     # syntax check lib/* + panel/* + full test run
```

Before shipping: confirm the exported JSONL of a fresh session shows exactly
the seeded event sequence (user/message with
`source = { kind: 'user', form: 'extrapro-anchor' }` → assistant/message →
tool/call → tool/result, then the real user message and harness-injected
AGENTS.md) with correct surface metadata, the shared guide file
`.dsh/agent-dev-guide.md` matches the virtual result body, and the first
`request/header` carries the full catalog.
