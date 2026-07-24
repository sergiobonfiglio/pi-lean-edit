# pi-lean-edit

Safer, cheaper edits by verifying prior reads in the harness instead of the prompt.

> Formerly `pi-smart-edit`.

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

Shows numbered text lines and stores shown ranges as in-memory snapshots for that file. Adjacent line reads merge into wider covered ranges. Huge single-line reads can continue with `columnOffset`/`columnLimit`; `columnOffset` is single-line only, so omit `limit` or set `limit=1`. Adjacent/overlapping huge-line column windows compose into wider column coverage.

### `edit`

```ts
{ path: string; startLine: number; endLine?: number; startColumn?: number; endColumn?: number; newText: string }
// or
{ path: string; edits: Array<{ startLine: number; endLine?: number; startColumn?: number; endColumn?: number; newText: string }> }
```

`edit` applies one or more non-overlapping inclusive ranges after `read` has shown those ranges for the same canonical file. If the file changed, it fails with `file stale, read again`. Normal-line column edits require a whole-line snapshot; huge-line column edits can use matching column snapshots. After a successful edit, edited ranges are invalidated. Same-line-count edits preserve unaffected later snapshots; line-count-changing edits invalidate later snapshots.

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
