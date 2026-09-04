# Design decisions

## Edit validity and concurrency

An edit is valid when every requested line or column range exactly matches text previously shown to the model. The requested coordinates and their observed content are the source of truth.

Unrelated file mutations therefore do not invalidate snapshots, and identical text at the requested coordinates remains editable. Whole-file fingerprints are intentionally not stored or compared.

`pi-lean-edit` also intentionally does not provide cross-process mutation serialization. This keeps its behavior and complexity aligned with Pi's built-in tools. Concurrent agents that may touch the same files should use isolated worktrees; agents sharing a checkout should work on disjoint files.

Within one Pi process, lean read-modify-write operations remain serialized by Pi's `withFileMutationQueue`. Snapshot revisions preserve local tool-result observer ordering, but do not provide a cross-process guarantee.

These choices are deliberate simplicity and built-in parity decisions. Fingerprints or cross-process locks should only be reconsidered if concrete failures demonstrate that their added complexity is necessary.

## Metrics

Global metrics are best-effort. Their read-modify-write updates use `withFileMutationQueue` within a process, but concurrent Pi processes may overwrite an increment. Metrics persistence failures must never affect edit correctness.
