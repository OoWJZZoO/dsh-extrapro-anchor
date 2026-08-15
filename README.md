# dsh-extrapro-anchor

[简体中文](docs/README.zh.md)

> Deterministic trajectory anchoring for DeepSeek Harness: before the first
> model request, seed every top-level session with one pre-sampled minimal-style
> virtual read turn whose tool result elevates the session to the preset's real
> prompt — no real tool call required, works across projects and presets.

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin
that generalizes the `anchored-standard` idea (see
[`xiaobright/dsh-anchored-standard`](https://github.com/xiaobright/dsh-anchored-standard)
and its evidence in
[`xiaobright/modeltest`](https://github.com/xiaobright/modeltest)):

- `anchored-standard` anchors the trajectory by exposing only two tools on the
  first request and **waiting for a real `tool/call`** before promoting to the
  full catalog. The anchor depends on what the model actually does.
- `extrapro-anchor` makes the anchor **deterministic**: it appends a virtual turn
  to the session log before the first request. The model never has to call
  anything; the first real request already carries the full tool catalog and a
  history that reads like a minimal-mode session that just finished an
  onboarding read.
- A **floating Web panel** (collapsed and OFF by default, right side of the
  page) toggles injection, shows the live thinking-chain health (any `let me`
  in recent reasoning turns the readout amber/red), and edits the injected
  texts with a reset-to-built-in-defaults button. Edits are cached in the
  browser and written to disk when the panel is folded or when the next
  injection happens.

This is a community project. It is not an official DeepSeek preset and is not
affiliated with or endorsed by DeepSeek.

## What the model sees (first request)

```
system         minimal persona sentence + a two-tool statement
               ("You have access to the following tools: bash,
                str_replace_editor …") — whatever ordinary preset was mounted,
               its full prompt is replaced here
[user]         "Please read the entire
               <project>/.dsh/agent-dev-guide.md in the project
               root directory for detailed information, and work entirely
               according to the instructions it contains."
[assistant]    minimal-style reasoning + one `bash` tool call
[tool result]  the guide's full content, rendered exactly like that bash
               command's real stdout:
                 When the user asks you to read this document and work
                 according to it, it means that your Agent's operation has
                 changed to some extent; please work according to the
                 following more detailed prompt:
                 <the preset's REAL prompt>
[user]         the user's actual first message
[user]         AGENTS.md / CLAUDE.md (system-reminder framing — injected by the
               harness's OWN dsh-agent-instructions, AFTER the real message)
tools          the FULL catalog — the request's TOOL SCHEMAS are never filtered
```

That exact sequence — minimal persona, virtual read request, virtual
assistant reply + tool call, guide content (the only place the real preset
expands), the user's real first message,
then AGENTS.md (harness convention) — is the whole transcript before the
model's first reply. The plugin never injects workspace instructions itself:
the harness's built-in `dsh-agent-instructions` (a dsh-base dependency) places
AGENTS.md/CLAUDE.md after the real user message, matching the standard
convention. Nothing else is injected, so the preset prompt cannot leak into
any other channel and mislead the model.

The system replacement is **global and idempotent**: every
`system-prompt/assemble` re-applies the minimal sections, so the persisted
`request/header` stays on the minimal system across steps and turns (request
cache friendly), while the tool schemas remain the full catalog the whole
time. The catalog is not duplicated into the guide file: every tool name and
description comes from the schemas themselves. The system/tool-schema split is
deliberate — the virtual turn has already "called a tool once", so the full
schemas are what the model can actually invoke; the two-tool statement only
shapes the first request's strategy. Whitelisted dynamic sections (default
`plan:policy`) are appended AFTER those two minimal sections when active, so
plan-mode guidance still reaches the system without touching runtime context
and its cache prefix.

> **Self-contained preset note.** `preset/agent.cordis.yml` keeps the
> persona `complete: true`. The harness then enforces that complete section
> after the waterfall, so in THAT preset the final system prompt is the
> minimal persona sentence alone (the two-tool statement is not visible).
> This is intentional: the tools the model actually uses are the full request
> schemas, and the old minimal tool names are not part of the real callable
> surface. When bundled onto an ordinary preset WITHOUT a complete section,
> the two-tool statement does appear.

The guide file is **really written to disk** — one shared
`.dsh/agent-dev-guide.md`, overwritten on every fresh seed — with exactly the
content the virtual result shows. The read result is durable in the session
log, so once seeded the transcript no longer depends on the file.

## Why

DeepSeek V4 Pro conditions strongly on the API-visible tool catalog and the
first request's structure (modeltest trigger experiments, 2026-08-14):

- minimal system + two tools → `We need` trajectory (99/96 on Project2);
- standard 25 tools from request #1 → `Let me` trajectory (91);
- **anchor turn 1 with two tools, then promote to all 25 → the trajectory
  holds (98/99)** — the first request's strategy choice is what matters, and
  full tools remain usable afterward.

`anchored-standard` reproduced that by promoting after a real tool call.
`extrapro-anchor` replaces the real first turn with a pre-sampled virtual one, so:

- the anchor is deterministic — it does not depend on the model's first action;
- request #1 already has the full catalog — no bootstrap, no promotion logic;
- the elevation text is the preset's own prompt, so the same plugin composes
  onto any preset on any project;
- subagents are never seeded (top-level sessions only).

**Scope of the claim:** the mechanism matches the published evidence, but
`extrapro-anchor` itself is new — validate the trajectory fingerprint on your
setup before relying on it (see Verify).

## Modeltest validation (2026-08-15)

One run per configuration on the frozen Project2 V4.1b evaluation: WSL2, DeepSeek
V4 Pro (official API), reasoning `max`, no MCP, no dsh-read-image, DSH 0.1.0-rc.6.

| Configuration | Ability | hidden | ESP static | real build |
|---|---:|---:|---:|---|
| minimal native (no anchor) | **97** | 43/45 | 9/9 | passed (model-driven) |
| standard + extrapro-anchor | **96** | 44/45 | 9/9 | failed (compile) |
| code (PTC) + extrapro-anchor | **88** | 42/45 | 8/9 | failed (configure) |

Versus the author's no-anchor baselines (same model, `max`, WSL, official API):

| Config | no anchor (author) | + extrapro-anchor (this run) | Δ |
|---|---:|---:|---:|
| minimal | 99/96 (2-tool wire) | 97 (25-tool wire, harness diff) | n/a\* |
| standard | 91 | **96** | **+5** |
| PTC (code) | 92 | 88 | **−4** |

\* This harness's base layer registers the global tool catalog, so the native
minimal request carries 25 tool schemas instead of the two the author's harness
sent — the 97 here is the current-harness native baseline, not the 2-tool RL
surface; the author's 99/96 is on the older harness and is not directly comparable.

Findings:

- **extrapro-anchor works on standard.** The virtual turn pulls the first request into
  the minimal trajectory ("We need" opening, zero "Let me"), and the hidden run
  reproduces the exact anchored-standard fingerprint — 44/45, missing only the
  same F12-04 semantic string both anchored-standard runs missed. 96 vs the
  author's no-anchor standard 91; with a passing firmware build the frozen scorer
  would give 99 (the 96↔97 gap to native minimal is purely the F9 build evidence:
  run 2's firmware had a real compile error — a stale `MQTT_EVENT` base from the
  pre-v6.0 esp-mqtt API — honestly recorded in its PR).
- **PTC is not a good fit for anchor.** 88 is below the author's no-anchor PTC
  baseline (92). The virtual turn is a bash/read-style transcript while the PTC
  wire surface exposes only `run_code`, so the model must reconcile history it
  cannot reproduce with its single entry point, and the code-writing overhead
  diverts reasoning budget from the task (ambient session policy and the ESP
  mqtt dependency were missed).
- n=1 each — provisional. F9: the frozen build runner is Windows-PowerShell-only;
  run 1's F9=6/6 uses the model's own real in-session build evidence (stdpro.bin
  archived with hash), runs 2/3 keep the frozen 3/6 partial.

## Installation

Requires DeepSeek Harness (`dsh`) `0.1.0-rc.6` or later (the harness is in
developer preview; a newer release candidate may need a compatibility pass).

### As a self-contained preset (recommended, like anchored-standard)

Clone this repository and copy the `preset` directory into the user preset root
under the id `extrapro-anchor`:

```sh
dsh_home="${DSH_HOME:-$HOME/.dsh}"
mkdir -p "$dsh_home/.agent-presets"
test ! -e "$dsh_home/.agent-presets/extrapro-anchor"
cp -R preset "$dsh_home/.agent-presets/extrapro-anchor"
```

Fully restart DeepSeek Harness, create a blank session, and select
**ExtraPro Anchor (experimental)**. Do not switch an active session from a
different preset.

The example composition keeps the Minimal system prompt (complete) and mounts
the full Standard tool set — exactly the anchored-standard surface, minus the
bootstrap, plus the seed. The self-contained preset ships **no floating
panel**, so its `extrapro-anchor` row sets `enabled: true`; injection stays on by
default in this install path.

### As a bundle plugin on your own preset

The package ships a `cordis.patch.yml` via its `dsh.bundle` manifest, so the
profile bundle mechanism composes the plugin row automatically. Recommended
one-liner:

```sh
dsh plugin --profile <profile> add github:OoWJZZoO/dsh-extrapro-anchor
```

Then restart `dsh web` (or let the profile patch watcher hot-add the row) and
refresh the existing URL: the collapsed panel appears on the right side of the
page. In bundle installs injection defaults to **OFF** — flip the panel switch
once to enable it.

Manual install: add the dependency, insert the two rows, and restart.

```json
// ~/.dsh/profiles/<profile>/package.json → dependencies
"@deepseek-ai/dsh-extrapro-anchor": "github:OoWJZZoO/dsh-extrapro-anchor#v0.2.0"
```

```sh
cd ~/.dsh/profiles/<profile> && pnpm install
```

```yaml
- id: extrapro-anchor
  name: '@deepseek-ai/dsh-extrapro-anchor'
  config:
    elevationPrompt: ''   # '' → auto-capture non-persona prompt sections
- id: extrapro-anchor-panel
  name: '@deepseek-ai/dsh-extrapro-anchor/panel'
  config: {}
```

> **Do not combine the two paths**: `dsh plugin add` already composes both rows,
> so adding the dependency manually *and* inserting the rows would register the
> plugin twice.

Requirements for the anchoring to work as designed:

- **no minimal-persona precondition anymore** — the plugin replaces the system
  prompt itself with the minimal persona + two-tool statement on every
  assembly, whatever the composition mounts. The preset's full prompt is
  captured into the guide file (elevation) and revealed by the virtual turn;
- **workspace instructions (AGENTS.md/CLAUDE.md) come from the harness**, not
  the plugin: the harness bundles `dsh-agent-instructions` as a dsh-base
  dependency, which composes them AFTER the user's real first message
  (standard convention). extrapro-anchor does not inject instructions itself and
  needs no dedupe. `injectProjectInstructions` / `maxInstructionsBytes` config
  keys are accepted for backward compatibility but inert.

## Floating panel (Web)

The companion row `@deepseek-ai/dsh-extrapro-anchor/panel` registers a floating,
draggable, collapsible panel in the shell overlay. Out of the box it sits at
the right side, collapsed, with injection **off**:

- **Collapsed** shows exactly two things: the injection switch and the
  thinking-chain health readout.
- **Expanded** edits the four injected texts (elevation notice, virtual user
  template, virtual reasoning template, virtual command template) and offers a
  one-click **reset to the plugin's built-in defaults**. `{path}` stays the
  project-root-relative guide path placeholder; templates without it are
  flagged red and not saved.
- The injection switch saves immediately. Text edits are cached in the browser
  and **written to disk when the panel is folded or when the next injection
  happens** (the panel observes a new session id and flushes first), so the
  next seed always uses the last persisted values.
- Panel position is remembered per browser (`localStorage`); the default is
  the right edge.

The health number follows the repository's reference evidence: the lexical
classifier published in
[`modeltest/evaluator/trigger_probe/src/classifier.mjs`](modeltest/evaluator/trigger_probe/src/classifier.mjs)
(`We need` / `we` style scores up, `Let me` scores down) and the trajectory
tables in `dsh-anchored-standard` / `modeltest/docs/v4.1` (anchored runs have
`let me = 0/1`, standard runs `let me = 208`). Any `let me` in the latest
reasoning blocks therefore turns the readout amber/red so the user is alerted
immediately; a stable `we`-style chain reads green with a 0–100 score.

Settings persist to `$DSH_HOME/storages/extrapro-anchor/settings.json` (override
with `DSH_EXTRAPRO_ANCHOR_SETTINGS_PATH`). The host plugin re-reads the file on
mtime change before every fresh seed — disk is the source of truth.

## Configuration (composition row `config`)

| Key | Default | Description |
| --- | --- | --- |
| `enabled` | `false` (panel posture; the self-contained preset sets `true`) | Injection switch fallback when no panel settings file exists. The panel's durable setting overrides this at seed time. |
| `settingsPath` | `$DSH_HOME/storages/extrapro-anchor/settings.json` | Override path for the panel settings file (tests / unusual deployments). |
| `elevationPrompt` | `''` | The preset's real prompt placed after the elevation notice in the guide file. |
| `elevationSource` | `auto` | `auto`: capture non-persona prompt sections of the assembly (fallback to `elevationPrompt`); `config`: use `elevationPrompt` only; `none`: notice only. |
| `elevationNotice` | `When the user asks you to read this document and work according to it, it means that your Agent's operation has changed to some extent; please work according to the following more detailed prompt:` | The fixed framing sentence. |
| `personaSection` | `deployment:persona` | Section name excluded from auto-capture (matches the harness's own persona registration in dsh-system-prompt). |
| `virtualUserTemplate` | pre-sampled (see `lib/runtime.js`) | Virtual user message template; `{path}` is replaced with the project-root-relative guide path (`.dsh/agent-dev-guide.md`). Default is verbatim text from the best modeltest-fingerprint round. |
| `virtualReasoningTemplate` | pre-sampled (see `lib/runtime.js`) | Virtual assistant reasoning text; default is the verbatim minimal "We need" first block from the same round. |
| `virtualToolName` | `bash` | Tool the virtual assistant calls (the minimal preset's real surface is `bash` + `str_replace_editor` — there is no `read` tool). |
| `virtualCommandTemplate` | `pwd && cat {path}` | Bash command whose fabricated stdout becomes the tool result. |
| `dynamicSections` | `['plan:policy']` | Whitelist of dynamic system-prompt sections preserved by the minimal replacement. A section is appended AFTER the minimal persona/tools sections when its rendered text is non-empty (e.g. plan-mode guidance while plan mode is active). |
| `injectProjectInstructions` | `true` | **Inert (backward compat).** Workspace instructions come from the harness's `dsh-agent-instructions` after the user's real first message. |
| `maxInstructionsBytes` | `65536` | **Inert (backward compat).** See `injectProjectInstructions`. |
| `guard.enabled` | `true` | Environment self-check switch; `false` force-loads the plugin. |

## Safety

This plugin rides on harness internals that can change shape between releases.
On startup it runs an environment self-check over every harness contract it
touches (`lib/guards.js`, the `dsh-read-image` fail-safe pattern). If any check
fails, the plugin **fails safe**: it loads nothing and the harness boots
normally — the full diagnostics are written to
`~/.dsh/logs/dsh-extrapro-anchor-guard.log` and one short bilingual notice is
logged. To force-load anyway (at your own risk): set `guard.enabled: false` in
the composition-row `config`. The companion panel runs the same client-side
check and installs nothing when a browser service is missing, so a failed panel
never takes the web boot down.

## Verify

Panel (bundle installs): after the page refresh, the collapsed pill shows on
the right; the client bundle is served under your web origin at
`<web-origin>/plugins/@deepseek-ai/dsh-extrapro-anchor/panel/client.js`, and
`$DSH_HOME/storages/extrapro-anchor/settings.json` appears after the first switch
toggle or fold with edits.

Export the session JSONL and inspect the events of the first turn:

- a `user/message` whose source is `{ kind: 'user', form: 'extrapro-anchor' }`, an
  `assistant/message` with a `reasoning` block plus one `tool-call`, a
  `tool/call`, and a `tool/result` whose content is the guide file;
- the `tool/result` carries `surfaceOp: append` and
  `sourceEventSeqs: [<tool/call seq>]`;
- the real file `.dsh/agent-dev-guide.md` exists with the same content as the
  virtual result body;
- the first `request/header` already contains the FULL tool catalog.

Run the zero-dependency tests:

```sh
npm test
```

## Important behavior

- **Bundle installs default to OFF.** Fresh sessions are not seeded and keep
  their ordinary system prompt until the panel switch (or a persisted
  `settings.json` / row config) enables injection. Sessions that already carry
  a durable anchor keep the minimal replacement when the switch is turned off
  mid-flight; a partial seed is completed, never left half-written. The
  self-contained preset sets `enabled: true` because it ships no panel.
- The seed is appended inside the first `system-prompt/assemble` waterfall,
  before `buildRequest` derives the request messages — the first real request
  always includes the virtual turn.
- Top-level fresh sessions only: subagents (`delegationDepth > 0` or
  `origin: 'subagent'`) are never seeded; sessions that already produced a
  real `user/message` are never re-seeded. Seeded state is detected from the
  DURABLE log, so resume/reload keeps the minimal system replacement, and a
  partially written seed is completed on the next assembly instead of
  re-seeding.
- The virtual `tool/result` is the raw stdout of `pwd && cat <guide>`
  (`<cwd>\n<content>` — bash, not a read-tool envelope). The shared guide file
  is overwritten on each fresh seed; the virtual read result is durable in the
  session log.
- The session-title service would title the session from the virtual user
  message (the built-in first-prompt provider always picks the first user
  message). Once a title event citing the virtual message is observed after
  the real first message, the plugin corrects it: when a title provider is
  reachable it generates a provider title from the real message; otherwise —
  and as the deterministic fallback — it appends a corrected fallback title
  derived from the real message.
- Every failure path degrades: a guard failure, an unwritable guide path, a
  missing model route, or a session that rejects an event logs one warning
  and leaves the session running WITHOUT the anchor. A plugin hook never
  throws into the harness.
- The plugin performs no external network requests and adds no telemetry (the
  panel talks only to the local host's own Typert Remote bridge).
- The plugin has the same trust level as shell access — it writes the shared
  guide file `.dsh/agent-dev-guide.md` into each seeded project and the panel
  settings file under `$DSH_HOME/storages/extrapro-anchor/`. Add `.dsh/` to your
  project's `.gitignore`.

## Known limitations

- The default virtual dialogue texts are the verbatim first-turn sample of ONE
  best modeltest-fingerprint round (picked by
  `scripts/find-best-sampling-round.mjs`). Pre-sampled, but n=1: swap in your
  own preferred sample via `virtualUserTemplate`/`virtualReasoningTemplate` if
  a different round suits your setup better.
- The virtual tool result is the fabricated stdout of `pwd && cat <guide>`
  (`<cwd>\n<content>`). If you override `virtualCommandTemplate`, keep the
  result format consistent with what that command would actually print.
- The elevation lives in the first tool result; long sessions with compaction
  may summarize or prune it (the same constraint anchored-standard had for its
  one-time promotion). The request's tool schemas stay constant, so the
  request-prefix cache changes once (between the pre-seed and post-seed
  prefixes of the first request).
- n=1 empirical validation on your model/setup is required; the published
  98/99 evidence is for DeepSeek V4 Pro on one frozen task.

## Development

`lib/runtime.js` is pure and harness-free (fully unit-tested); `lib/index.js`
is the Cordis host plugin; `lib/guards.js` is the fail-safe environment
self-check (dsh-read-image pattern); `lib/settings.js` is the disk-backed
panel settings store; `lib/health.js` is the modeltest-derived chain-health
classifier; `lib/config-remote.js` builds the `extraproAnchorConfig` Typert Remote
bridge. `panel/` is the companion client row (empty host half + the
`__ModuleLoader__` browser bundle in `panel/client.js`). `preset/lib/` is a
build snapshot — run `scripts/build-preset.sh` after changing `lib/`.

The panel bundle duplicates the defaults (`lib/settings.js`) and the health
classifier (`lib/health.js`) because a served client bundle cannot import the
host half — keep the three sides in sync.

Sampling helper: `scripts/find-best-sampling-round.mjs` batch-scans
`$DSH_HOME/sessions/<cwd-slug>/` and ranks every session against the modeltest
minimal fingerprint (verbatim `classifyReasoning` from
`modeltest/evaluator/trigger_probe`), then prints the best round's first
reasoning block, user message, and tool call as ready-to-paste
`virtualUserTemplate`/`virtualReasoningTemplate` material. Requires the
`unzstd` CLI.

## References / Acknowledgements

- [`xiaobright/dsh-anchored-standard`](https://github.com/xiaobright/dsh-anchored-standard) —
  the original two-tool → full-catalog anchor mechanism this plugin makes
  deterministic, and the source of the trajectory evidence it builds on.
- [`xiaobright/modeltest`](https://github.com/xiaobright/modeltest) —
  trigger-probe experiments, the `We need` / `Let me` fingerprint classifier
  (used verbatim by `lib/health.js`), and the V4.1 trajectory tables.
- [`OoWJZZoO/dsh-read-image`](https://github.com/OoWJZZoO/dsh-read-image) —
  the fail-safe environment self-check pattern (`lib/guards.js`), the optional
  Typert Remote config-bridge pattern, and the client-side guard pattern.
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) and its
  Standard/Minimal agent presets — the host platform and the preset surface the
  plugin composes onto.

## License

MIT. `preset/agent.cordis.yml` is derived from the DeepSeek Harness Standard
preset and from `xiaobright/dsh-anchored-standard`; the original DeepSeek
copyright and MIT notice are retained in
[`NOTICE`](./NOTICE).
