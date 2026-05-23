# pi-smart-edit

Pi extension that replaces built-in `read`/`edit` with snapshot-verified range editing.

## Tools

### `read`

```ts
{ path: string; offset?: number; limit?: number }
```

Shows numbered text lines and stores shown ranges as in-memory snapshots for that file. Adjacent reads merge into wider covered ranges.

### `edit`

```ts
{ path: string; startLine: number; endLine?: number; newText: string }
// or
{ path: string; edits: Array<{ startLine: number; endLine?: number; newText: string }> }
```

`edit` applies one or more non-overlapping inclusive ranges after `read` has shown those ranges for the same canonical file. If the file changed, it fails with `file stale, read again`.

## Metrics

Successful edits record saved characters versus exact-text edit payloads. Failed edits increment failure rate. Global metrics persist at `~/.pi/agent/pi-smart-edit/metrics.json` by default, or `PI_SMART_EDIT_METRICS_PATH` if set.

Show stats:

```text
/smart-edit-stats
```

## Install

Install from a local checkout by linking the repo into Pi's extensions directory:

```text
~/.pi/agent/extensions/pi-smart-edit -> /path/to/pi-smart-edit
```

Then reload Pi:

```text
/reload
```

## Test

```bash
npm test
```

## Notes

`read` output is capped by line and byte limits. Defaults: `PI_SMART_EDIT_MAX_READ_LINES=2000`, `PI_SMART_EDIT_MAX_READ_BYTES=50000`.
