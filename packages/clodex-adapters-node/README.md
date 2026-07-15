# `@clodex/adapters-node`

Linux production-side capabilities for the fixed operations defined by
`@clodex/adapters`:

- descriptor-relative `filesystem.create` and `filesystem.replace` through a
  pinned native `openat2(2)` helper;
- descriptor-relative `filesystem.mkdir` inspection, with execution explicitly
  disabled until a private same-filesystem staging boundary is provisioned;
- fixed Git status/diff observation in a digest-pinned, read-only,
  networkless container;
- registry-selected tests in a digest-pinned, read-only, networkless
  container with disposable tmpfs scratch.

This package exposes no generic host filesystem, shell, argv, environment,
mount, image-tag, network, device, or privileged-container API.

## Native helper provisioning

The helper is source-controlled under `native/`. A release pipeline must:

1. build it on the exact supported Linux toolchain;
2. run the platform/adversarial suite listed in
   `docs/developer/P0_TESTING_HANDOFF.md`;
3. install the resulting ELF on an immutable/root-owned path;
4. remove write bits for the executing principal (normally mode `0555`);
5. record its SHA-256 digest and, where provisioned, device/inode in the signed
   adapter registry.

The Node launcher opens and hashes the helper, rechecks its file identity, and
executes that same descriptor via `/proc/self/fd/3`. The workspace root is
opened `O_DIRECTORY|O_NOFOLLOW`, checked against its provisioned device/inode,
held for the entire operation, and transferred as fd 4. The helper refuses to
run without Linux `openat2`, `RENAME_EXCHANGE`, `RESOLVE_BENEATH`,
`RESOLVE_NO_SYMLINKS`, `RESOLVE_NO_MAGICLINKS`, and `RESOLVE_NO_XDEV`.

Create uses an absent-state commitment and exclusive creation. Linux
`mkdirat(2)` returns no descriptor, so a first lookup can adopt a decoy inode in
an attacker-writable parent. Protocol v1 therefore rejects `execute-mkdir`
pre-effect; it must not be enabled until a distinct Guardian principal supplies
a pinned, private same-filesystem staging directory and retained-fd install
validation. Replace uses a same-directory durable staging file and atomic
`RENAME_EXCHANGE`, then
validates the captured old inode/content and stable pre-exchange semantics
before deleting it. File and parent-directory `fsync` complete before success.
Any failure after the first host mutation (including creation of a hidden
staging file) is classified as potentially effected/`UNCERTAIN`; callers must
burn the one-shot ticket and must not retry. Linux does not provide a single
kernel compare-and-swap primitive for replacement by expected inode; namespace
races therefore fail/post-validate as `UNCERTAIN` rather than being claimed as
strict atomic inode CAS.

## Container provisioning

Production construction requires all of the following signed inputs:

- an ELF Docker client descriptor pinned by digest (and optionally
  device/inode);
- a fixed Unix daemon socket;
- a pinned, non-writable seccomp profile;
- an installed named AppArmor profile;
- exact `repository@sha256:<digest>` Git/test images;
- exact resource and output limits;
- a workspace root object pinned by device/inode;
- exact test profile, plan, runner, and image membership.

Every run uses `--pull=never`, `--network=none`, a read-only image root, all
Linux capabilities dropped, `no-new-privileges`, the pinned seccomp/AppArmor
profiles, a non-root user, PID/CPU/memory/fd/output/time limits, no host
credentials, and a read-only bind of the held workspace descriptor. Only
`/tmp` and `/scratch` are disposable tmpfs; the test runner must copy any build
tree it needs into `/scratch`.

Git is invoked directly (never through a shell) with fixed status/diff
arguments, no pager, no external diff, no textconv, no optional locks, no
credential prompt, and disabled file/ext protocols. Repository-local config
remains untrusted input: every observation first runs a fixed fail-closed audit
that rejects `alias.*`, `include.*`, and `includeIf.*`, while fixed command-line
as well as local filter/diff/pager/credential command surfaces, while fixed
command-line overrides disable the remaining command-bearing Git facilities
used by these operations. Only bounded digests/counts leave the
credential-free, networkless, read-only capability.

## Honest guarantee boundary

The source implements the confinement boundary but does **not** by itself
prove a production deployment. Promotion still requires:

- compiled-helper tests on the claimed Linux kernel/filesystem;
- a trusted/rootless container daemon configuration;
- independent provisioning evidence for the Docker socket endpoint (the
  current client API holds only its absolute path, not a kernel-pinned socket
  descriptor);
- verified installation and enforcement of the named AppArmor profile;
- exact seccomp, client, helper, image, registry, build, config, and policy
  digests;
- durable universal ticket/WAL/control-plane closure;
- independently protected trust/anti-rollback heads;
- packaged production integration evidence.

No feature-gate default is changed by this package. Until those external
conditions are verified, production write/package/plugin authority must remain
off.
