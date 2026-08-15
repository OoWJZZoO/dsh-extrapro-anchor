# dsh-anchor-seed

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
- `anchor-seed` makes the anchor **deterministic**: it appends a virtual turn
  to the session log before the first request. The model never has to call
  anything; the first real request already carries the full tool catalog and a
  history that reads like a minimal-mode session that just finished an
  onboarding read.

This is a community project. It is not an official DeepSeek preset and is not
affiliated with or endorsed by DeepSeek.

## What the model sees (first request)

```
system         minimal persona sentence + a two-tool statement
               ("You have access to the following tools: bash,
                str_replace_editor …") — whatever ordinary preset was mounted,
               its full prompt is replaced here
[user]         "Please read the entire
               <project>/.dsh/<session id>/agent-dev-guide.md in the project
               root directory for detailed information, and work entirely
               according to the instructions it contains."
[assistant]    minimal-style reasoning + one `bash` tool call
[tool result]  the guide's full content, rendered exactly like that bash
               command's real stdout:
                 Your access in this project has been elevated; you may now act
                 according to the following prompt:
                 <the preset's REAL prompt>
                 The full tool catalog available in this session:
                 - bash: … - read: … - edit: … (every tool with description)
[user]         the user's actual first message
[user]         AGENTS.md / CLAUDE.md (system-reminder framing — injected by the
               harness's OWN dsh-agent-instructions, AFTER the real message)
tools          the FULL catalog — the request's TOOL SCHEMAS are never filtered
```

That exact sequence — minimal persona, virtual read request, virtual
assistant reply + tool call, guide content (the only place the real preset
expands, plus the full tool catalog as text), the user's real first message,
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
time — the model only *thinks* it has two tools until the virtual turn's
result reveals the full list.

The guide file is **really written to disk** with exactly that content before
the events are appended, so a later genuine `read` of the file cannot
contradict what the model already saw.

## Why

DeepSeek V4 Pro conditions strongly on the API-visible tool catalog and the
first request's structure (modeltest trigger experiments, 2026-08-14):

- minimal system + two tools → `We need` trajectory (99/96 on Project2);
- standard 25 tools from request #1 → `Let me` trajectory (91);
- **anchor turn 1 with two tools, then promote to all 25 → the trajectory
  holds (98/99)** — the first request's strategy choice is what matters, and
  full tools remain usable afterward.

`anchored-standard` reproduced that by promoting after a real tool call.
`anchor-seed` replaces the real first turn with a pre-sampled virtual one, so:

- the anchor is deterministic — it does not depend on the model's first action;
- request #1 already has the full catalog — no bootstrap, no promotion logic;
- the elevation text is the preset's own prompt, so the same plugin composes
  onto any preset on any project;
- subagents are never seeded (top-level sessions only).

**Scope of the claim:** the mechanism matches the published evidence, but
`anchor-seed` itself is new — validate the trajectory fingerprint on your
setup before relying on it (see Verify).

## Installation

### As a self-contained preset (recommended, like anchored-standard)

Clone this repository and copy the `preset` directory into the user preset root
under the id `anchor-seed`:

```sh
dsh_home="${DSH_HOME:-$HOME/.dsh}"
mkdir -p "$dsh_home/.agent-presets"
test ! -e "$dsh_home/.agent-presets/anchor-seed"
cp -R preset "$dsh_home/.agent-presets/anchor-seed"
```

Fully restart DeepSeek Harness, create a blank session, and select
**Anchor Seed (experimental)**. Do not switch an active session from a
different preset.

The example composition keeps the Minimal system prompt (complete) and mounts
the full Standard tool set — exactly the anchored-standard surface, minus the
bootstrap, plus the seed.

### As a bundle plugin on your own preset

Add the package and insert one row into your preset's `agent.cordis.yml`:

```yaml
- id: anchor-seed
  name: '@deepseek-ai/dsh-anchor-seed'
  config:
    elevationPrompt: ''   # '' → auto-capture non-persona prompt sections
```

Requirements for the anchoring to work as designed:

- **no minimal-persona precondition anymore** — the plugin replaces the system
  prompt itself with the minimal persona + two-tool statement on every
  assembly, whatever the composition mounts. The preset's full prompt is
  captured into the guide file (elevation) and revealed by the virtual turn;
- **workspace instructions (AGENTS.md/CLAUDE.md) come from the harness**, not
  the plugin: the harness bundles `dsh-agent-instructions` as a dsh-base
  dependency, which composes them AFTER the user's real first message
  (standard convention). anchor-seed does not inject instructions itself and
  needs no dedupe. `injectProjectInstructions` / `maxInstructionsBytes` config
  keys are accepted for backward compatibility but inert.

## Configuration (composition row `config`)

| Key | Default | Description |
| --- | --- | --- |
| `elevationPrompt` | `''` | The preset's real prompt placed after the elevation notice in the guide file. |
| `elevationSource` | `auto` | `auto`: capture non-persona prompt sections of the assembly (fallback to `elevationPrompt`); `config`: use `elevationPrompt` only; `none`: notice only. |
| `elevationNotice` | `Your access in this project has been elevated; you may now act according to the following prompt:` | The fixed framing sentence. |
| `personaSection` | `persona` | Section name excluded from auto-capture. |
| `virtualUserTemplate` | pre-sampled (see `lib/runtime.js`) | Virtual user message template; `{path}` is replaced with the project-root-relative guide path (`.dsh/<id>/agent-dev-guide.md`). Default is verbatim text from the best modeltest-fingerprint round. |
| `virtualReasoningTemplate` | pre-sampled (see `lib/runtime.js`) | Virtual assistant reasoning text; default is the verbatim minimal "We need" first block from the same round. |
| `virtualToolName` | `bash` | Tool the virtual assistant calls (the minimal preset's real surface is `bash` + `str_replace_editor` — there is no `read` tool). |
| `virtualCommandTemplate` | `pwd && cat {path}` | Bash command whose fabricated stdout becomes the tool result. |
| `injectProjectInstructions` | `true` | **Inert (backward compat).** Workspace instructions come from the harness's `dsh-agent-instructions` after the user's real first message. |
| `maxInstructionsBytes` | `65536` | **Inert (backward compat).** See `injectProjectInstructions`. |
| `guard.enabled` | `true` | Environment self-check switch; `false` force-loads the plugin. |

## Verify

Export the session JSONL and inspect the events of the first turn:

- a `user/message` (the read request, source `plugin`), an
  `assistant/message` with a `reasoning` block plus one `tool-call`, a
  `tool/call`, and a `tool/result` whose content is the guide file;
- the `tool/result` carries `surfaceOp: append` and
  `sourceEventSeqs: [<tool/call seq>]`;
- the real file `.dsh/<session id>/agent-dev-guide.md` exists with the same
  content as the virtual result;
- the first `request/header` already contains the FULL tool catalog.

Run the zero-dependency tests:

```sh
npm test
```

## Important behavior

- The seed is appended inside the first `system-prompt/assemble` waterfall,
  before `buildRequest` derives the request messages — the first real request
  always includes the virtual turn.
- Top-level fresh sessions only: subagents (`delegationDepth > 0`) are never
  seeded; sessions that already produced a `user/message` are never re-seeded
  (this also makes resume/reload idempotent, because the seeded events are
  durable).
- The virtual `tool/result` is rendered byte-for-byte like `dsh-tool-fs`
  `read` output (`<path>` envelope, line numbers, `(End of file - total N
  lines)`), and the guide file on disk is identical, so the transcript cannot
  be contradicted by a real read.
- Every failure path degrades: a guard failure, an unwritable guide path, or a
  session that rejects an event logs one warning and leaves the session
  running WITHOUT the anchor. A plugin hook never throws into the harness.
- The plugin performs no network requests and adds no telemetry.
- The plugin has the same trust level as shell access — it writes one file
  into the project (`.dsh/<session id>/agent-dev-guide.md`). Add `.dsh/` to
  your project's `.gitignore`.

## Known limitations

- The default virtual dialogue texts are the verbatim first-turn sample of ONE
  round (`session-1018c36f`, minimal preset, picked by
  `scripts/find-best-sampling-round.mjs` as the best modeltest-fingerprint
  match). Pre-sampled, but n=1: swap in your own preferred sample via
  `virtualUserTemplate`/`virtualReasoningTemplate` if a different round suits
  your setup better.
- The virtual tool result is the fabricated stdout of `pwd && cat <guide>`
  (`<cwd>\n<content>`). If you override `virtualCommandTemplate`, keep the
  result format consistent with what that command would actually print.
- The elevation lives in the first tool result; long sessions with compaction
  may summarize or prune it (the same constraint anchored-standard had for its
  one-time promotion). The tool catalog stays constant, so the request-prefix
  cache changes once (between the pre-seed and post-seed prefixes of the first
  request).
- n=1 empirical validation on your model/setup is required; the published
  98/99 evidence is for DeepSeek V4 Pro on one frozen task.

## Development

`lib/runtime.js` is pure and harness-free (fully unit-tested); `lib/index.js`
is the Cordis host plugin; `lib/guards.js` is the fail-safe environment
self-check (dsh-read-image pattern). `preset/lib/` is a build snapshot — run
`scripts/build-preset.sh` after changing `lib/`.

Sampling helper: `scripts/find-best-sampling-round.mjs` batch-scans
`$DSH_HOME/sessions/<cwd-slug>/` and ranks every session against the modeltest
minimal fingerprint (verbatim `classifyReasoning` from
`modeltest/evaluator/trigger_probe`), then prints the best round's first
reasoning block, user message, and tool call as ready-to-paste
`virtualUserTemplate`/`virtualReasoningTemplate` material. Requires the
`unzstd` CLI.

## License

MIT. `preset/agent.cordis.yml` is derived from the DeepSeek Harness Standard
preset and from `xiaobright/dsh-anchored-standard`; the original DeepSeek
copyright and MIT notice are retained in
[`NOTICE`](./NOTICE).
