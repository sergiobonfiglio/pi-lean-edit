# pi-lean-edit

Safer, cheaper edits by verifying prior reads in the harness instead of the prompt.

`pi-lean-edit` lets the harness verify the model already read the text it wants to edit, reducing stale-edit failures without resending old text in edit requests and without hash-decorated output. See [DESIGN.md](DESIGN.md) for the deliberate validity and concurrency model.

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

Applies one or more non-overlapping inclusive full-line ranges only when they exactly match text previously shown by `read`, a complete built-in `grep` result, or a failed edit. Changes elsewhere in the file do not invalidate the snapshot. A failed edit returns and snapshots bounded current context so it can be retried if appropriate. Successful replacement lines can be edited again immediately; deletions add no replacement rows. Same-line-count edits preserve unaffected snapshots, while line-count changes conservatively invalidate old suffix coverage. Like Pi's built-in edit, a BOM is preserved and bare CR or mixed line endings are normalized to the style of the first LF/CRLF line ending.

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

#### Other tool-result bookkeeping

Complete, untruncated built-in `grep` results can establish full-line snapshots. The observer resolves each reported path against the grep target, rereads the UTF-8 file, and verifies that every displayed line still matches exactly before storing coverage. This is best-effort compatibility with the built-in grep output format; malformed output, missing files, binary/invalid UTF-8 files, image blocks, byte-truncated output, and individually truncated lines establish no snapshots. Match-limit notices do not invalidate the complete rows that were shown.

`find` and `ls` return paths rather than file contents, so they do not establish snapshots. Arbitrary `bash` output is not interpreted, including shell `grep`/`find` commands. Successful `edit` or `write` results from tools other than this extension's owned mutation call clear snapshots for their target path; failed results do not.

#### Snapshot visibility limitation

Snapshot verification assumes other extensions do not alter or remove observed `read` or `grep` output after this extension's event handler runs. Pi currently does not expose authoritative final model-visible tool content to extensions.

#### Schema compatibility

The provider-facing schemas remain plain objects without top-level `anyOf`, `oneOf`, or `allOf`, because Amazon Bedrock Converse and some strict-tool providers reject those forms. Cross-field and non-overlap rules are enforced at runtime. Direct single-line-range calls from older sessions are normalized to canonical `edit.edits[]`; column ranges belong only to `edit_huge_line`.

## Concurrency

Edit validity depends only on exact content at the requested coordinates. Whole-file fingerprints are intentionally not used, so unrelated mutations and identical target text do not make an edit stale. Same-process lean edits use Pi's `withFileMutationQueue`, which serializes sibling read-modify-write calls without rejecting disjoint valid edits.

Cross-process mutation serialization is intentionally unsupported, matching Pi's built-in tools. Snapshots and observer ordering are process-local. Concurrent agents should use isolated worktrees or disjoint files rather than editing the same file from multiple processes. Snapshots reset after session-tree navigation or compaction.

### Mutation writes

Edits deliberately overwrite files in place with `fs.writeFile`, matching Pi's built-in edit and write tools. Atomic temporary-file replacement would add metadata, ownership, symlink, and platform-specific rename semantics that are not justified here. A rare write failure or process termination during the overwrite can therefore leave a partial file; version control remains the recovery mechanism.

## Metrics

Global metrics are an intentional product feature. They persist under the configured Pi agent directory (`getAgentDir()/pi-lean-edit/metrics.json`) by default, or at `PI_LEAN_EDIT_METRICS_PATH` if set. Metrics are best-effort: same-process updates are queued, concurrent Pi processes may lose an increment, and persistence errors never change edit correctness.

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
