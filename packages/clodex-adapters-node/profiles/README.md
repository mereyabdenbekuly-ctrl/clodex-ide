# Container security profiles

These files are deployment inputs, not self-activating policy.

- `clodex-container-seccomp-v1.json` denies namespace/mount/kernel-control,
  cross-process inspection, io_uring, keyring, BPF, and non-`AF_UNIX` socket
  creation while retaining the syscall breadth needed by fixed developer test
  plans. `--network=none` and AppArmor independently deny network use.
- `clodex-container-v1.apparmor` is an installation template. A production
  release must install, load, inspect, and exercise the exact named profile on
  its target distribution before recording its digest/evidence.

The source-tree files are ordinary local files and are **not** independently
protected. Production construction pins an immutable installed seccomp file by
descriptor/digest and a loaded AppArmor profile by signed name/config evidence.
