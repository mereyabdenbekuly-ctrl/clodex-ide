# `@clodex/ledger-node`

POSIX-only, whole-store durable snapshot adapter for `@clodex/ledger`.

## Declared local durability boundary

For each successful CAS the adapter acquires a fixed-name atomic lock
directory, reloads and validates the complete current snapshot, rechecks the
expected revision and all identity reservations, then writes the complete next
state through this sequence:

1. create the fixed-name staging file with mode `0600`;
2. write strict canonical JSON/UTF-8 bytes;
3. `fsync` the staging file;
4. atomically rename it over the fixed-name main snapshot;
5. `fsync` the base directory;
6. if an exception is observed after rename, re-`fsync` and read back the exact
   canonical next snapshot before returning `APPLIED`;
7. remove the lock and `fsync` the base directory again.

The trusted parent and base directory are `fsync`ed during every initialization
pass, including recovery by a new instance after a creator failed between
`mkdir` and parent `fsync`. The base directory is mode `0700` and its device and
inode are pinned per store instance. Reads accept only a bounded, exact
canonical snapshot whose records, reachable revisions, mutation count, and
complete identity reservation set agree. The snapshot is capped at 512 records
and eight reservations per record so it stays below the shared canonical-JSON
node budget. A surviving staging entry is ignored by reads and blocks all later
mutations; it is never promoted. A surviving lock directory is waited on only
for a bounded interval and is never removed as "stale."

If the data snapshot is already durable but lock-directory cleanup reports an
error, the completed CAS still returns `APPLIED` so a caller cannot blindly
repeat the effect. That store instance then rejects later mutations. A new
instance revalidates the complete snapshot and filesystem state before use.

## Deliberate non-claims

This adapter declares durability only for a trusted **local POSIX filesystem**
that actually implements atomic same-directory rename and working file and
directory `fsync`. It does not claim network-filesystem durability, encryption
at rest, a separately protected ledger head, or anti-rollback protection. An
attacker able to replace the complete snapshot with an older complete valid
snapshot cannot be detected without an independent protected monotonic anchor.
Device/inode revalidation detects ordinary base-path replacement, but the Node
adapter has no descriptor-relative `openat2`/`openat` operation set and does not
claim resistance to a same-privilege adversary racing path replacement. The
base path and its parent therefore remain part of this adapter's deployment
TCB.
