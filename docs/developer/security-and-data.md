# Security and data

## 1. Trust model

Clodex assumes that model output, website content, MCP responses, plugin
metadata, generated apps, remote runners, and task attachments can all be
untrusted.

Security boundaries must not depend on prompt instructions alone.

## 2. Capability authorization

Every sensitive operation should identify:

- principal;
- task or agent;
- capability;
- resource scope;
- canonical action identity;
- expiry;
- one-time or reusable semantics;
- user authorization;
- audit outcome.

Approvals are narrow and operation-bound. A successful approval for one command
or destination must not authorize another.

## 3. Network egress

The Egress Control Gateway provides:

- deny-by-default destination decisions;
- exact protocol, hostname, and port grants;
- private, loopback, and link-local protection;
- DNS validation and pinned sockets;
- an authenticated local proxy;
- controlled Chromium routing;
- MCP fetch routing;
- grant revocation;
- content-free audit export.

The proxy must fail closed when policy or DNS validation is unavailable.

## 4. Shell security

Shell capabilities bind authorization to:

- agent;
- tool call;
- canonical command hash;
- workspace scope;
- short expiry;
- one-time consumption.

The system records status and bounded reason codes, not raw command content.

## 5. Protected storage

Protected files use authenticated encryption and context binding.

Protected categories include:

- attachments;
- shell logs;
- memory artifacts;
- selected caches;
- content-addressed diff blobs.

Contexts are authenticated and path traversal is rejected. When protected-file
storage is enabled, unexpected plaintext is treated as an error rather than
silently accepted.

## 6. Credentials

- Credentials are owned by the browser host.
- Renderer and generated apps receive only bounded procedures.
- Provider keys are not placed in prompts or telemetry.
- Remote jobs receive short-lived scoped credentials when required.
- Signing private keys are external release authority and must not be stored in
  the repository.
- Secret scans run against candidate manifests, new commits, and release
  branches.

## 7. Artifact and package trust

Generated-app and plugin packages are checked for:

- manifest schema;
- path containment;
- publisher or package identity;
- signature and public-key fingerprint;
- revocation;
- capability declarations;
- import limits;
- duplicate or replayed package identifiers.

Package trust failure blocks execution.

## 8. Remote execution

Runner jobs are bound to:

- source commit;
- workspace snapshot;
- lease and epoch;
- provider profile;
- command class;
- resource policy;
- signed receipt.

Docker jobs are expected to use digest-pinned images, bounded CPU, memory, PID,
file descriptors, execution time, and a network policy. SSH jobs verify the
remote workspace state and artifact hashes.

## 9. Telemetry and audit

Allowed telemetry:

- event name;
- bounded enum values;
- counts and rates;
- latency;
- feature-gate state;
- source/build identity;
- sanitized error category.

Forbidden telemetry:

- prompts and completions;
- source or file contents;
- raw commands;
- URLs with paths, query strings, or credentials;
- cookies or authorization headers;
- MCP arguments or results;
- audio or transcripts;
- private keys or access tokens.

The `community-observed` desktop distribution adds a stricter contract. It
does not construct a PostHog client until the user completes a required,
versioned first-run choice and explicitly allows anonymous statistics. Its
renderer is a compile-time telemetry no-op, PostHog person profiles and GeoIP
enrichment are disabled, lifecycle events do not inspect the running-process
list, and Settings can revoke consent without requiring an account. A central
event/field allowlist drops unknown events and all free-form content fields.

## 10. Security review checklist

Before merging a sensitive capability:

1. Identify the principal and authority.
2. Define fail-closed behavior.
3. Bind approval to an exact action.
4. Add timeout, cancellation, and replay semantics.
5. Validate all external input.
6. Add content-free audit.
7. Add negative and malformed-input tests.
8. Run secret scanning.
9. Keep the release feature gate default-off.
10. Define promotion evidence and rollback.
