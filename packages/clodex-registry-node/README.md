# `@clodex/registry-node`

Local POSIX snapshot adapter for `@clodex/registry` monotonic heads.

The adapter uses a fixed private directory, fixed filenames, an atomic lock
directory that is never stale-broken automatically, strict canonical JSON,
`0600` staging, file `fsync`, same-directory rename, directory `fsync`, and
post-rename exact reconciliation. Reads also take the mutation lock so the
synchronous current-head fence is serialized with local writers.

## Security boundary

This is **not** an independently protected anti-rollback head. A same-UID actor,
host administrator, backup restore, or filesystem rollback can replace the
whole valid snapshot. Parent-directory symlink/path replacement is outside the
adapter's trusted-base-path assumption. There is no encryption, HSM/TPM,
remote quorum, transparency log, network-filesystem durability claim, or
production key custody. Use it only as a local reference/durability adapter.

## Verification handoff

```sh
pnpm --dir packages/clodex-registry-node test
pnpm --dir packages/clodex-registry-node typecheck
pnpm exec biome check packages/clodex-registry-node
```

No feature gate or production authority is enabled.
