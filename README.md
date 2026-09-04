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

Reads normal UTF-8 text with numbered full lines and stores shown ranges as in-memory snapshots. Invalid UTF-8 is rejected rather than decoded lossily. A UTF-8 BOM is hidden from the model and preserved on write, matching Pi's built-in edit behavior. It also supports jpg, png, gif, and webp images. If a line exceeds the byte limit, `read` stops before it and directs the model to `read_huge_line`.

### `edit`

```ts
type EditRange = { startLine: number; endLine?: number; newText: string };
{ path: string; edits: EditRange[] }
```

Applies one or more non-overlapping inclusive full-line ranges only when they match text previously shown by `read` or a failed edit and the file fingerprint still matches that read. A failed edit returns and snapshots bounded current context so it can be retried if appropriate. Successful replacement lines can be edited again immediately; deletions add no replacement rows. Same-line-count edits preserve unaffected snapshots, while line-count changes conservatively invalidate old suffix coverage. Like Pi's built-in edit, a BOM is preserved and bare CR or mixed line endings are normalized to the style of the first LF/CRLF line ending.

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

Cooperating `pi-lean-edit` processes in one checkout serialize `edit`, `edit_huge_line`, and `write` mutations per canonical file; different files can still proceed concurrently. Snapshots remain isolated per extension session/process. Each process records a file fingerprint with its snapshots, so an intervening mutation by another process or by `write` makes the old snapshot stale even when identical text appears at the old coordinates. Snapshots reset after session-tree navigation or compaction, and every agent must perform its own matching read before editing. For substantial parallel work, isolated worktrees or disjoint files are still preferable. Shell commands and other tools that do not use the cooperative lock can still race with these operations.

### Mutation writes

Edits deliberately overwrite files in place with `fs.writeFile`, matching Pi's built-in edit and write tools. Atomic temporary-file replacement would add metadata, ownership, symlink, and platform-specific rename semantics that are not justified here. A rare write failure or process termination during the overwrite can therefore leave a partial file; version control remains the recovery mechanism.

## Metrics

Global metrics are an intentional product feature. They persist under the configured Pi agent directory (`getAgentDir()/pi-lean-edit/metrics.json`) by default, or at `PI_LEAN_EDIT_METRICS_PATH` if set. Metrics are best-effort: persistence errors are warnings and never change a successful edit into a failure.

Show stats:

```text
/lean-edit-stats
```

## Test

```bash
npm test
```

## Rendering expansion

Configurable rendering is an intentional product feature. `pi-lean-edit` provides three rendering levels for each tool row, configured with `/lean-edit-settings`:

- `minimal`: use the tool's compact/collapsed renderer
- `medium`: use detailed/expanded rendering, capped at 20 rendered lines
- `full`: use detailed/expanded rendering without the extension's line cap

Collapsed and expanded tool rows are configured independently. This allows, for example, an expanded `edit` row to show its full diff while an expanded `read` row remains compact. Huge-line tools share the corresponding `read` or `edit` setting; `write` has its own.

Collapsed defaults are all `minimal`. Expanded defaults are `read=minimal`, `edit=full`, and `write=medium`. Settings persist under the configured Pi agent directory in `pi-lean-edit/settings.json`.

## Configuration

Read content is capped by line, byte, and huge-line column limits. Defaults: `PI_LEAN_EDIT_MAX_READ_LINES=2000`, `PI_LEAN_EDIT_MAX_READ_BYTES=50000`, and `PI_LEAN_EDIT_MAX_READ_COLUMNS=400`. Override values must be positive integers.

These limits apply to the displayed file-content payload (numbered lines or a huge-line column window). Summary text and continuation guidance are added outside that budget, so the complete tool result can be slightly larger. Reads and edits currently load the target file into memory; huge-line edit diffs are separately bounded to a small window around the change.
