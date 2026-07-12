# P1 Protected files — threat model

## Security objective

Sensitive local artifacts must not remain readable as plaintext in application
files, SQLite payload columns, WAL files, agent sandboxes, shell working
directories, or direct runtime-node mounts.

P1 protects:

- attachment blobs;
- Chronicle screenshots, OCR, and summaries;
- shell logs;
- memory archives and indexes;
- diff-history content-addressed blobs;
- file-read, processed-image, and asset URL cache payloads;
- agent titles.

Queryable non-content metadata remains plaintext where required: identifiers,
content hashes, timestamps, sizes, LRU fields, MIME types, relationships,
message roles, model IDs, and approval modes.

## Adversaries in scope

- offline inspection of the application data directory or copied backups;
- accidental plaintext leakage through SQLite free pages or WAL files;
- an agent attempting to read ciphertext through sandbox, shell, native
  read/glob/grep, path hashing, file preview, or attachment protocol paths;
- corruption, truncation, record reordering, trailing-byte injection, context
  substitution, or use of a wrong data-protection key;
- interrupted migration or interrupted protected-file write.

## Out of scope

- a process already running as the same OS user with permission to inspect
  Clodex process memory or call OS accessibility/debug APIs;
- a compromised Electron main process after the data key is unlocked;
- filenames, directory names, file counts, timestamps, and file sizes;
- content deliberately exported by the user or sent to a model/provider;
- forensic recovery from storage below the guarantees provided by the OS and
  filesystem after `fsync`, WAL truncation, and `VACUUM`.

## Key hierarchy

1. Browser startup loads one random 256-bit application data key.
2. Electron `safeStorage` wraps the key through the OS keychain.
3. Small SQLite values use versioned AES-256-GCM
   `clodex-protected:v1` envelopes with a fresh nonce and context-bound AAD.
4. Every protected file receives a random 256-bit DEK.
5. The application data key wraps each DEK with context containing the file
   identity and context hash.

No plaintext persistence or in-memory persistence fallback is used by the
desktop host when keychain/data protection is unavailable. Startup fails
closed. Test-only explicit constructors may omit protection to create legacy
fixtures for migration tests.

## Protected-file format

`CLODEXPF` version 1 is a streaming binary format:

- random 128-bit file ID;
- random 64-bit nonce prefix plus uint32 record sequence;
- AES-256-GCM data records;
- AAD binds the header hash, context hash, file ID, record type, sequence, and
  plaintext length;
- an authenticated final record commits total plaintext bytes and chunk count;
- readers reject wrong context, unknown versions, tampering, truncation,
  reordering, duplicate sequence numbers, and trailing data.

Writes use:

`sibling staging file → file fsync → atomic rename → parent directory fsync`.

Plaintext is streamed from the old file directly into encrypted staging during
migration; no plaintext staging copy is created.

Shell logs use immutable encrypted segments plus an atomically replaced
encrypted manifest. Graceful teardown kills PTYs synchronously and awaits all
queued segment/manifest writes before completing.

## Context binding

Canonical contexts bind ciphertext to its logical owner:

- `attachments/<agent>/<attachment>`;
- `chronicle/<relative path>`;
- `shell-logs/<agent>/<file>` plus manifest/segment suffixes;
- `memory/<relative path>`;
- shared diff-history blob-store context plus independent plaintext SHA-256
  OID verification on every read;
- `cache/<cache name>/<key>`;
- `agentInstances/<agent>/title`.

Copying ciphertext to another field, agent, path context, or cache key fails
authentication.

## Trusted read boundary

Ciphertext is never mounted into the isolated agent sandbox. Protected
`att/`, `shells/`, and `memory/` paths are served only by trusted host code:

- native read/glob/grep decrypts per file;
- shell cwd resolution excludes all protected prefixes;
- environment prompts expose `host-protected://...`, not physical ciphertext
  paths;
- attachment protocol and file preview read through `AttachmentsService`;
- model-context blob reading and path hashing use protected mount helpers;
- asset upload reads attachment plaintext through `AttachmentsService`;
- runtime-node instances for protected directories do not exist.

Directory globbing may reveal filenames and structure, which are explicitly
outside the P1 confidentiality scope. Internal shell `.segments` directories
are filtered.

## Startup migration order

The order is immutable and enforced by `P1ProtectedMigrationOrder`:

1. attachments;
2. Chronicle;
3. shell logs;
4. memory;
5. diff-history blobs;
6. caches;
7. titles/search.

Cache payload migration authenticates existing envelopes, encrypts plaintext
rows, enables `secure_delete` where applicable, truncates WAL, and runs
`VACUUM`. Title search no longer uses SQL `LIKE`; titles are decrypted and
filtered in trusted host memory before pagination. No blind index is stored.

## Failure policy

- unavailable/corrupt key: startup fails;
- wrong key or context: startup/read fails;
- plaintext found after protected migration: trusted read fails closed;
- corrupt protected file or OID mismatch: read/startup migration fails;
- cache/title migration failure: startup fails rather than enabling plaintext
  persistence;
- shutdown log-drain failure: shell/toolbox teardown rejects and is reported by
  the main shutdown coordinator.

## Verification

Focused checks:

```bash
pnpm --filter @clodex/agent-core typecheck
pnpm --filter @clodex/agent-core test
pnpm --filter @clodex/agent-shell typecheck
pnpm --filter @clodex/agent-shell test
pnpm --filter clodex exec vitest run \
  src/backend/services/protected-files \
  src/backend/services/agent-os/chronicle.test.ts
pnpm --filter clodex typecheck
pnpm --filter clodex test
```

Tests cover randomized ciphertext, multi-chunk streaming, wrong context/key,
tampering, truncation, trailing data, one-way migrations, SQLite compaction,
protected read/glob/grep, OID verification, title search, and awaited shell-log
drain.
