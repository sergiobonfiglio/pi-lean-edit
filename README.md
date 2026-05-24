# pi-smart-edit

Safer, cheaper edits by verifying prior reads in the harness instead of the prompt.

`pi-smart-edit` lets the harness verify the model already read the latest text it wants to edit, reducing stale-edit failures without resending old text in edit requests and without the per-read overhead of hash-decorated output.

## Install or test locally

Install from npm:

```bash
pi install npm:pi-smart-edit
```

Test from a local checkout without installing:

```bash
pi --no-extensions -e ~/repositories/pi-extensions/pi-smart-edit
```

To test it alongside your normal setup, omit `--no-extensions`:

```bash
pi -e ~/repositories/pi-extensions/pi-smart-edit
```

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

## Test

```bash
npm test
```

## Test

```bash
npm test
```

## Notes

`read` output is capped by line and byte limits. Defaults: `PI_SMART_EDIT_MAX_READ_LINES=2000`, `PI_SMART_EDIT_MAX_READ_BYTES=50000`.
