# `@clodex/control-plane-node`

POSIX-local durable snapshot adapter for `@clodex/control-plane`.

## Local durability sequence

For each successful CAS the adapter:

1. establishes and inode-pins a trusted absolute base directory (`0700`);
2. acquires a fixed-name atomic lock directory and never breaks it as stale;
3. reloads and validates the complete canonical snapshot;
4. rechecks revision and all global replay-identity reservations;
5. invokes the optional synchronous authority fence while holding the lock;
6. writes a fixed-name staging file with mode `0600`;
7. `fsync`s the staging file;
8. renames it over the fixed-name snapshot in the same directory;
9. `fsync`s the base directory before returning `APPLIED`; and
10. removes the lock and `fsync`s the directory again.

If an exception is observed after rename, the adapter re-`fsync`s and reads
back the exact expected canonical snapshot before deciding whether `APPLIED`
may escape. A surviving staging entry is never promoted or removed
automatically. A surviving lock is never guessed to be stale. Both conditions
block later mutation for operator investigation. Reads are bounded and reject
noncanonical UTF-8/JSON, invalid state/revision shapes, incomplete identity
reservations, cross-record identity collisions, wrong modes, hard links, and
base-directory replacement.

Deterministic fault points cover lock acquisition/cleanup, staging open/write,
file `fsync`, atomic rename, and directory `fsync`.

## Deliberate non-claims

The declaration applies only to a trusted local POSIX filesystem that actually
implements same-directory atomic rename and working file/directory `fsync`.
It does not provide encryption at rest, a protected monotonic head,
anti-rollback, network-filesystem durability, descriptor-relative `openat2`
confinement, or resistance to a same-privilege adversary racing trusted paths.

Most importantly, the adapter commits **local control-plane state only**. The
external effect is not part of its filesystem transaction. Recovery therefore
never replays effects and classifies any nonterminal post-permit record as
`UNCERTAIN`.

An independently stored authority registry is also outside the POSIX snapshot
transaction. The synchronous fence narrows that race but does not create an
atomic cross-store revocation/consumption guarantee.
