# dsh-extrapro-anchor

[简体中文](docs/README.zh.md)

> Deterministic trajectory anchoring for DeepSeek Harness: before the first
> model request, every fresh top-level session is seeded with one pre-sampled
> minimal-style virtual read turn that elevates the session to the preset's
> real prompt — no real tool call required, works on any preset and any project.

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin
that generalizes the
[`xiaobright/dsh-anchored-standard`](https://github.com/xiaobright/dsh-anchored-standard)
idea: instead of waiting for the model to call a tool before promoting the
catalog, the anchor is seeded deterministically before the first request.

This is a community project. It is not an official DeepSeek preset and is not
affiliated with or endorsed by DeepSeek.

## What it does

- On every fresh top-level session, the plugin appends one virtual turn:
  a user request to read `.dsh/agent-dev-guide.md`, a minimal-style assistant
  reply with a `bash` call, and a tool result that reveals the preset's real
  prompt.
- The system prompt is replaced with the minimal persona + two-tool statement
  for anchored sessions. Tool schemas are never filtered, so the full tool
  catalog stays usable.
- Subagents are never seeded, and sessions are never seeded twice.

## Installation

Requires DeepSeek Harness (`dsh`) `0.1.0-rc.6` or later.

```sh
dsh plugin --profile <profile> add github:OoWJZZoO/dsh-extrapro-anchor
```

Then restart `dsh web` (or let the profile patch watcher hot-add the rows) and
refresh the page. The package ships a `cordis.patch.yml`, so the plugin rows
are composed automatically.

Manual install: add the dependency and insert the two rows, then restart.

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
  config: {}
- id: extrapro-anchor-panel
  name: '@deepseek-ai/dsh-extrapro-anchor/panel'
  config: {}
```

> Do not combine the two paths: `dsh plugin add` already composes both rows.

## Floating panel

After installation, a collapsed pill appears on the right side of the Web page.
The panel is the main way to use the plugin; injection is **OFF by default**
until you turn it on.

- **Collapsed**: shows exactly the injection switch and the thinking-chain
  health readout.
  - Switch **on** → new fresh sessions are anchored. Switch **off** → new
    sessions run normally. Sessions that are already anchored keep their
    minimal system replacement.
  - The health dot reports the live model chain: green = stable minimal-style
    chain, amber/red = `let me` drift detected.
- **Expanded**: edit the four injected texts (elevation notice, virtual user
  request, virtual reasoning, virtual command). Templates missing `{path}` are
  marked red and not saved; the reset button restores the built-in defaults.
- Text edits are cached in the browser and saved to disk when the panel is
  folded or when the next injection happens. The switch saves immediately.
- Panel position is remembered per browser (`localStorage`).

Settings persist to `$DSH_HOME/storages/extrapro-anchor/settings.json`. The
host re-reads them on every fresh seed, so the panel is the single switch for
enabling and tuning the anchor.

## Configuration

The composition row accepts optional overrides:

| Key | Default | Description |
| --- | --- | --- |
| `enabled` | `false` | Fallback injection switch when no panel settings file exists. The panel's persisted value overrides it at seed time. |
| `elevationSource` | `auto` | `auto`: capture the preset's non-persona prompt sections; `config`: use `elevationPrompt` only; `none`: elevation notice only. |
| `elevationPrompt` | `''` | Explicit prompt text for `elevationSource: config`. |
| `elevationNotice` | built-in sentence | Framing sentence at the top of the guide file. |
| `virtualUserTemplate` / `virtualReasoningTemplate` / `virtualCommandTemplate` | pre-sampled defaults | Injected virtual turn texts; `{path}` is replaced with `.dsh/agent-dev-guide.md`. |
| `dynamicSections` | `['plan:policy']` | Dynamic system sections preserved after the minimal replacement. |
| `guard.enabled` | `true` | Environment self-check switch; `false` force-loads the plugin. |

## Safety

On startup the plugin runs an environment self-check over every harness
contract it touches. If a check fails, it **fails safe**: nothing is loaded and
the harness boots normally. Full diagnostics are written to
`~/.dsh/logs/dsh-extrapro-anchor-guard.log`, and one short bilingual notice is
logged. The panel runs the same client-side check and installs nothing when a
browser service is missing.

## Verify

After installation, refresh the page and turn the panel switch on. Create a
new session and export the JSONL: the first turn should contain a
`user/message` with `source = { kind: 'user', form: 'extrapro-anchor' }`,
an `assistant/message`, a `tool/call`, and a `tool/result`, followed by your
real message and the harness-injected AGENTS.md. The shared guide file
`.dsh/agent-dev-guide.md` is written with the same content the virtual result
shows.

Run the zero-dependency tests:

```sh
npm test
```

## Known limitations

- The default virtual dialogue is a pre-sampled n=1 round. You can replace it
  from the panel or the row config.
- Long sessions with compaction may summarize or prune the elevation in the
  first tool result.
- Validate the trajectory fingerprint on your own model/setup before relying
  on it.

## Development

`lib/` is pure, harness-free plugin logic (unit-tested); `panel/` is the
companion client row. Run the full check with:

```sh
npm run check
```

## References / Acknowledgements

- [`xiaobright/dsh-anchored-standard`](https://github.com/xiaobright/dsh-anchored-standard) —
  the original two-tool → full-catalog anchor mechanism this plugin makes deterministic.
- [`xiaobright/modeltest`](https://github.com/xiaobright/modeltest) —
  trigger-probe experiments and the `We need` / `Let me` fingerprint classifier.
- [`OoWJZZoO/dsh-read-image`](https://github.com/OoWJZZoO/dsh-read-image) —
  the fail-safe environment self-check pattern and the Typert Remote panel bridge pattern.
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) —
  the host platform this plugin composes onto.

## License

MIT
