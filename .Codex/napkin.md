# Napkin Runbook

## Curation Rules
- Re-prioritize on every read.
- Keep recurring, high-value notes only.
- Max 10 items per category.
- Each item includes date + "Do instead".

## Execution & Validation (Highest Priority)
1. **[2026-08-09] Bun's typed `test.each` expects a mutable case array**
   Do instead: spread readonly fixture collections at the call site (`test.each([...cases])`) so callback values retain their declared type.

## Shell & Command Reliability
1. **[2026-08-09] Bun may defer missing-directory errors from `opendir`**
   Do instead: wrap both `opendir(path)` and the first `Dir.read()` in the same error boundary; the awaited open alone may appear successful.


## Domain Behavior Guardrails
1. **[2026-08-09] Revalidate the artifact named by the conflict reason**
   Do instead: inspect the occupied canonical for `canonical-occupied`, and quarantine only for displaced-content conflicts; never validate unrelated old bytes.
2. **[2026-08-09] Never import external revision lineage**
   Do instead: mint revalidated external bytes as an alternate under the candidate's parent; schema-valid external parent IDs may be missing or cyclic.
3. **[2026-08-09] An occupied no-replace destination starts opaque**
   Do instead: classify `EEXIST` winners as opaque until their bytes independently pass schema and privacy validation; a previously safe expected revision does not validate the new occupant.
4. **[2026-08-09] Recovery trusts immutable bytes, never staging names**
   Do instead: compare any surviving staging file byte-for-byte with the validated candidate revision before hard-link promotion; conflict on a mismatch.
5. **[2026-08-09] Publish setup activation with no-replace promotion**
   Do instead: fsync a private same-directory temporary, hard-link it to an absent final config, then unlink the temporary; direct exclusive writes can strand a truncated activation file.
6. **[2026-08-09] Freeze migrations before copying targets**
   Do instead: atomically publish validated canonical snapshots, bind their IDs and digests in the pending marker, and preflight every existing target before any retry write.
7. **[2026-08-09] Bound imports on one open file handle**
   Do instead: inspect and read through the same descriptor, cap the read at the limit plus one byte, and reject inode, size, or timestamp changes before deriving state.

## User Directives
1. **[2026-08-09] Keep the product name lowercase**
   Do instead: write `clasi` in product copy, package names, commands, and identifiers; reserve uppercase for environment-variable conventions.
