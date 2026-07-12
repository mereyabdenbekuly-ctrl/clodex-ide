---
name: Release Readiness
description: Review a change against release gates, rollback safety, validation evidence, and operational risk.
version: 1.0.0
---

# Release Readiness

Use this skill when preparing a feature, migration, or policy change for
release.

## Review sequence

1. Identify the feature gate, default state, kill switch, and rollback path.
2. Confirm that persisted data remains readable after downgrade.
3. List unit, integration, type, format, and platform smoke evidence.
4. Separate automated evidence from manual validation.
5. Verify that telemetry contains no prompt, credential, file, command, or URL
   content unless explicitly required and approved.
6. Treat irreversible operations as requiring explicit human confirmation.
7. Record unresolved blockers and do not label the release ready while a
   required gate is incomplete.
