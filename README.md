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
{ path: string; offset?: number; limit?: number }
```

Reads normal text with numbered full lines and stores shown ranges as in-memory snapshots. It also supports jpg, png, gif, and webp images. If a line exceeds the byte limit, `read` stops before it and directs the model to `read_huge_line`.

### `edit`

```ts
type EditRange = { startLine: number; endLine?: number; newText: string };
{ path: string; edits: EditRange[] }
```

Applies one or more non-overlapping inclusive full-line ranges only when they match text previously shown by `read` or a failed edit. A failed edit returns and snapshots bounded current context so it can be retried if appropriate. Successful replacement lines can be edited again immediately; deletions add no replacement rows. Same-line-count edits preserve unaffected snapshots, while line-count changes conservatively invalidate old suffix coverage. Uniform LF and CRLF files retain their style; mixed line endings are rejected.

### `read_huge_line`

```ts
{ path: string; line: number; columnOffset?: number; columnLimit?: number }
```

Reads one bounded window from a line too large for `read`, using 1-based Unicode code-point columns. Adjacent or overlapping windows combine into wider snapshot coverage. Normal-sized lines are rejected with guidance to use `read`.

### `edit_huge_line`

```ts
{ path: string; line: number; startColumn: number; endColumn: number; newText: string }
```

Applies one inclusive range covered by `read_huge_line`. It supports one range per call and forbids newlines in `newText`; use normal `read`/`edit` when full-line or multiline replacement is needed. Empty text deletes the range.

#### Snapshot visibility limitation

Snapshot verification reflects this extension's own read output. It assumes other extensions do not subsequently alter or remove that output before it reaches the model; Pi currently does not expose authoritative final model-visible tool content to extensions.

#### Schema compatibility

The provider-facing schemas remain plain objects without top-level `anyOf`, `oneOf`, or `allOf`, because Amazon Bedrock Converse and some strict-tool providers reject those forms. Cross-field and non-overlap rules are enforced at runtime. Direct single-line-range calls from older sessions are normalized to canonical `edit.edits[]`; column ranges belong only to `edit_huge_line`.

## Concurrency

Cooperating `pi-lean-edit` processes in one checkout serialize `edit`, `edit_huge_line`, and `write` mutations per canonical file; different files can still proceed concurrently. Snapshots are isolated per extension session and reset after session-tree navigation or compaction, so every agent must perform its own matching read before editing. For substantial parallel work, isolated worktrees or disjoint files are still preferable. Shell commands and other tools that do not use this cooperative lock can still race with these operations.

## Metrics

Global metrics persist under the configured Pi agent directory (`getAgentDir()/pi-lean-edit/metrics.json`) by default, or at `PI_LEAN_EDIT_METRICS_PATH` if set. Metrics are best-effort: persistence errors are warnings and never change a successful edit into a failure.

Show stats:

```text
/lean-edit-stats
```

## Test

```bash
npm test
```

## Configuration

Run `/lean-edit-settings` to configure collapsed and expanded rendering. Huge-line tools share the corresponding `read` or `edit` rendering setting; `write` has its own.

- `minimal`: compact rendering
- `medium`: detailed rendering capped at 20 rendered lines
- `full`: fully detailed rendering

Collapsed defaults are all `minimal`. Expanded defaults are `read=minimal`, `edit=full`, and `write=medium`. Settings persist under the configured Pi agent directory in `pi-lean-edit/settings.json`.

Read output is capped by line, byte, and huge-line column limits. Defaults: `PI_LEAN_EDIT_MAX_READ_LINES=2000`, `PI_LEAN_EDIT_MAX_READ_BYTES=50000`, and `PI_LEAN_EDIT_MAX_READ_COLUMNS=400`.
