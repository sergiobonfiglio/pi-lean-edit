# pi-lean-edit

Safer, cheaper edits by verifying prior reads in the harness instead of the prompt.

`pi-lean-edit` lets the harness verify the model already read the latest text it wants to edit, reducing stale-edit failures without resending old text in edit requests and without the per-read overhead of hash-decorated output.
## Install or test

Install permanently:

```bash
pi install npm:pi-lean-edit
```

Test without installing permanently:

```bash
pi --no-extensions -e npm:pi-lean-edit
```

To load it alongside your normal setup:

```bash
pi -e npm:pi-lean-edit
```

## Tools

### `read`

```ts
{ path: string; offset?: number; limit?: number; columnOffset?: number; columnLimit?: number }
```

Only `path` is required. For normal reads, use `path` alone or `offset`/`limit` for a line range. Use `columnOffset` with `columnLimit` only for a huge single-line window; omit `limit` or set `limit=1`. Shows numbered text lines and stores shown ranges as in-memory snapshots for that file. Adjacent line reads merge into wider covered ranges. Adjacent/overlapping huge-line column windows compose into wider column coverage.

### `edit`

```ts
type EditRange = {
  startLine: number;
  endLine?: number;
  startColumn?: number;
  endColumn?: number;
  newText: string;
};

{ path: string; edits: EditRange[] }
```

Use one `edits` item for a single edit or multiple items for a batch. A line range uses `startLine` with optional `endLine` and omits columns. A column range uses `startLine`, `startColumn`, and `endColumn` and omits `endLine`. Direct single-range inputs from older sessions are normalized to `edits` before validation.

`edit` applies one or more non-overlapping inclusive ranges only when the requested text matches text previously shown by `read` or a failed edit. Column ranges must stay within one source line, but their replacement text may contain newlines. Cross-field constraints are checked at runtime so the provider-facing schema remains compatible with APIs that reject JSON Schema unions. If a range was not read or its text changed, the edit is not applied; for line-range edits, the error returns and snapshots the current target with up to five surrounding lines on each side so the same or a nearby corrected edit can be retried. Text beyond the configured automatic output limits still requires `read`. Normal-line column reads show the whole line; huge-line column reads can cover matching column ranges. After a successful edit, edited text must be read again before reuse. Line-count-preserving edits keep unaffected later reads valid; line-count-changing edits invalidate them.

#### Schema compatibility

Keep the provider-facing `edit` schema as a plain object and do not model its alternative forms with `Type.Union` or top-level `anyOf`, `oneOf`, or `allOf`. Amazon Bedrock Converse rejects such schemas before inference with `input_schema does not support oneOf, allOf, or anyOf at the top level`; other providers and strict-tool implementations also support different JSON Schema subsets.

The canonical `path + edits[]` shape therefore favors transport compatibility over expressing every cross-field rule in JSON Schema. `normalizeEdits()` remains the source of truth for paired columns, mutually exclusive line/column fields, non-overlapping ranges, and other runtime invariants. `prepareArguments` preserves direct single-range calls from older sessions. The schema tests recursively reject composition keywords so this constraint is not accidentally reintroduced.

## Concurrency

Cooperating `pi-lean-edit` processes in one checkout serialize `edit` and `write` mutations per canonical file; different files can still proceed concurrently. Snapshots remain per process, so every subagent must perform its own `read` before `edit`. For substantial parallel work, isolated worktrees or disjoint files are still preferable. Shell commands and other tools that do not use this cooperative lock can still race with these operations.

## Metrics

Successful edits record saved characters versus exact-text edit payloads. Failed edits increment failure rate. Global metrics persist at `~/.pi/agent/pi-lean-edit/metrics.json` by default, or `PI_LEAN_EDIT_METRICS_PATH` if set.

Show stats:

```text
/lean-edit-stats
```

## Test

```bash
npm test
```

## Configuration

Run `/lean-edit-settings` to configure both collapsed and expanded rendering for `read`, `edit`, and `write`. `ctrl+o` switches between those two configured views. Each setting accepts:

- `minimal`: compact rendering
- `medium`: detailed rendering capped at 20 rendered lines
- `full`: fully detailed rendering

Collapsed defaults are all `minimal`. Expanded defaults are `read=minimal`, `edit=full`, and `write=medium`. Settings persist globally in `~/.pi/agent/pi-lean-edit/settings.json`.

`read` output is capped by line and byte limits. Defaults: `PI_LEAN_EDIT_MAX_READ_LINES=2000`, `PI_LEAN_EDIT_MAX_READ_BYTES=50000`.
