# Encryption at rest

## Implemented scope

The Electron host creates one random 256-bit data key on first launch. The key
record is stored in `data-protection-key.json` through the strict
`persisted-data` path:

- Electron `safeStorage` wraps the record with the OS keychain;
- writes are atomic (`temp -> fsync -> rename`);
- the file is owner-only (`0600`) where POSIX modes apply;
- unavailable keychain access, malformed envelopes, and invalid key material
  fail startup closed.

`@clodex/agent-core` receives the unlocked key only through the optional
`AgentHost.dataProtection` capability. agent-core does not import Electron.

The reusable codec in `packages/agent-core/src/host/data-protection.ts` uses:

- AES-256-GCM;
- a fresh 96-bit nonce per value;
- a versioned `clodex-protected:v1` envelope;
- a short SHA-256-derived key id for explicit key mismatch detection;
- authenticated context (AAD) containing the table, agent id, field, and,
  for messages, sequence number.

The following values in `agents/instances.sqlite` are encrypted:

- `agentInstances.instance_config`
- `agentInstances.history` (deprecated rollback column)
- `agentInstances.queued_messages`
- `agentInstances.input_state`
- `agentInstances.mounted_workspaces`
- `agentInstances.title`
- `agentMessages.parts`
- `agentMessages.metadata`

Legacy plaintext rows are encrypted during startup in one transaction.
Existing ciphertext is authenticated before startup continues. The first
migration also enables SQLite `secure_delete`, truncates the WAL, and runs
`VACUUM` before recording a compaction marker so legacy plaintext is not left
in free pages or journal files.

Agent title search decrypts and filters titles in the trusted host process
before pagination. SQL `LIKE` is not applied to randomized ciphertext and no
blind index is stored.

## Protected files and caches

Bulk files use the versioned streaming `CLODEXPF` format documented in
`docs/protected-files-threat-model.md`. The protected scope includes:

- attachments;
- Chronicle artifacts;
- shell logs;
- memory archives and indexes;
- diff-history content blobs;
- file-read and processed-image cache payloads;
- presigned asset-cache read URLs.

Small cache/title SQLite values use the existing data-protection envelope.
Legacy rows are authenticated or encrypted during startup, followed by WAL
checkpoint and `VACUUM` when plaintext was replaced.

Protected `att/`, `shells/`, and `memory/` directories are not mounted into the
sandbox or exposed as shell working directories. Native read/glob/grep,
attachment preview/protocol, model-context injection, path hashing, and asset
upload decrypt inside trusted host services.

## Intentionally queryable metadata

The first version leaves fields needed for ordering, filtering, and relational
integrity in plaintext:

- agent/message ids and parent ids;
- agent type and message role;
- timestamps and message sequence numbers;
- active model id;
- title-lock state;
- token counters and tool-approval mode.

Filenames, directory structure, identifiers, hashes, timestamps, sizes,
relationships, MIME types, roles, model IDs, and LRU metadata remain outside
the encrypted payload by design.
