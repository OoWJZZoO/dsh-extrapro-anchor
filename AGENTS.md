# AGENTS.md — dsh-anchor-seed contributor guide

This file helps AI agents (and humans) work on this repository without
breaking its contract with DeepSeek Harness.

## What this repository is

A Cordis host plugin for DeepSeek Harness that seeds every fresh top-level
session with one virtual minimal-style read turn before the first model
request, so the session starts inside the minimal trajectory without any real
tool call. See `README.md` / `docs/README.zh.md` for the mechanism.

## Layout

- `lib/runtime.js` — pure, harness-free logic (event construction, guide
  content, bash-stdout result rendering, instructions text). No Cordis imports;
  fully unit-tested. Keep it that way.
- `lib/index.js` — the Cordis host plugin: config parsing, fail-safe guard
  wiring, the `system-prompt/assemble` hook, file writing, event injection.
- `lib/guards.js` — environment self-check (dsh-read-image pattern): a failed
  check must leave the plugin inert, never take the harness boot down.
- `preset/` — self-contained example preset (minimal persona + Standard tools
  + the anchor-seed row). `preset/lib/` is a BUILD SNAPSHOT: after changing
  `lib/`, run `./scripts/build-preset.sh`.
- `test/` — `node --test`; run `npm test` (58 tests). `lib/runtime.js` must
  stay testable with zero harness dependencies.

## Invariants (do not break)

1. **Never throw out of a hook.** Every failure path in `apply()` and in the
   `system-prompt/assemble` listener logs a warning and lets the session run
   without the anchor. A plugin whose `apply()` throws takes the whole harness
   down.
2. **Never re-seed.** `isFreshTopLevelAgent` (no prior `user/message`, top
   level only) plus the per-process WeakSet guarantee one seed per session.
   Resume/reload stays idempotent because seeded events are durable.
3. **The transcript must be internally consistent.** The virtual turn runs
   on the minimal preset's REAL surface: `bash` (there is no `read` tool in
   minimal), the command defaults to `pwd && cat {path}`, and the `tool/result`
   is the exact raw stdout that command produces (`<cwd>\n<content>`).
   `lib/index.js` writes the guide file with identical content BEFORE appending
   the events, so a real later read/cat cannot contradict the transcript. If
   you override `virtualCommandTemplate`, keep the fabricated result consistent
   with that command's real output.
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
   are all the surface needs.
6. **Minimal persona is the anchoring premise.** The composition must keep the
   persona as the minimal native prompt with `complete: true` and
   `includeRuntimeContext: false`; the preset's own guidance belongs in the
   elevation (guide file), not the system prompt.

## Working on the elevation / virtual dialogue

- `elevationSource: auto` captures the non-persona sections seen inside the
  `system-prompt/assemble` waterfall (before the complete-section wipe).
  Excluded section name is `personaSection` (default `persona`).
- The default `virtualUserTemplate`/`virtualReasoningTemplate` are verbatim
  text from the best modeltest-fingerprint round (`session-1018c36f`, minimal
  preset), selected by `scripts/find-best-sampling-round.mjs`; the path is
  generalized to the `{path}` placeholder (project-root-relative). It is an
  n=1 sample — when you swap in your own sample, document its source round.
- `injectProjectInstructions` (default on) injects AGENTS.md/CLAUDE.md from the
  session cwd right after the elevation. Do NOT also mount
  `dsh-agent-instructions` while it is on (double injection).

## Verification workflow

```sh
npm run check     # syntax check lib/* + full test run
./scripts/build-preset.sh   # refresh preset/lib snapshot after lib/ changes
```

Before shipping: confirm the exported JSONL of a fresh session shows exactly
the seeded event sequence (user/message → assistant/message → tool/call →
tool/result [+ instructions user/message]) with correct surface metadata, the
guide file on disk matches the virtual result, and the first `request/header`
carries the full catalog.
