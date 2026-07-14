# `@clodex/adapters`

Capability-confined **reference** adapters for the Safe Coding slice:

- `filesystem.create`, `filesystem.replace`, and `filesystem.mkdir`;
- fixed `git.status` and `git.diff` observations;
- registered, digest-pinned `test.run` sandbox profiles.

The package has no filesystem, Git CLI, shell, process, network, credential, or
host-workspace API. Every external operation is an injected, operation-specific
port. Runtime preparation is side-effect free and returns a closed one-shot
effect that the reference runtime may invoke only after `COMMIT_PERMIT`.

Every adapter is constructed with one immutable capability scope containing
`workspaceId`, `taskId`, and `rootObjectId`. Runtime PREPARE rejects a ticket
whose audience does not match the fixed workspace/task before any content,
inspection, profile, or execution port is called. The exact scope is forwarded
to every such port call, and one registry cannot combine adapters from different
scopes. **Registry contract:** `binding.adapterRegistryDigest` must commit the
canonical capability scope together with the registered adapter bindings; this
reference package validates equality of supplied digests but does not mint the
externally signed registry manifest. It therefore **does not claim to prove**
that an arbitrary supplied digest contains `rootObjectId`; production wiring
must verify a signed/canonical registry manifest that includes the full scope.

This is a protocol/capability reference layer. It is **not** an `openat2`
no-follow implementation, hardened Git subprocess implementation, Docker/VM/OS
sandbox, durable transaction coordinator, or host-write adapter. The exported
memory ports are test fakes only and provide no durability or OS isolation.
