# Community capability boundary

`apps/browser/community-capability-boundary.json` is the normative data-only inventory
for public IDE feature gates and managed-service connectors. CI must
reject a missing, extra, duplicated, or reclassified `featureGateId` rather
than infer commercial status from UI code.

## Classification rules

- `community-local` is the historical label for capabilities whose
  value-bearing implementation is Community-available in the public AGPL
  client. They cannot be converted into a paid tier with a local switch. This
  is a Community-available/public-client boundary, not an offline-only
  classification, and it does not prohibit user-controlled remote services.
- `managed-connector` means the public repository contains only the reviewed
  client connector and fail-closed local boundary. It requires the
  `__APP_MANAGED_SERVICES_ENABLED__` build gate, bearer authorization, and a
  server-authoritative entitlement decision before the separately operated
  service provides value.

All connectors reference the versioned generic public contract in
`apps/browser/public-managed-service-entitlement-contract.v1.json`. The server
decision is authoritative, a local entitlement grant is forbidden, HTTP 401
and 403 are denials, and a client paywall is forbidden. The contract describes
the public client boundary; it contains no paid-service implementation.

Only `cloud-tasks` and `session-continuity` are managed feature gates. The
connector inventory is exactly `cloud-task-control-plane`, `session-sharing`,
and `clodex-hosted-mcp`. Hosted MCP intentionally has no feature gate: it is
unavailable unless the managed build gate and explicit endpoint configuration
are present, and Community builds replace it with a fail-closed stub.

Every connector endpoint environment key must remain in
`COMMUNITY_FORBIDDEN_BACKEND_ENVIRONMENT_KEYS`, so Community artifacts discard
managed configuration. Non-endpoint managed configuration is inventoried
separately: `CLODEX_CLOUD_TASKS_RESIDENCY` is a managed configuration key, not
an endpoint. `implementationPaths` identify public client-side connector,
startup, build-policy, alias, and fail-closed stub surfaces only. This manifest
does not authorize or implement a paid service, Gateway, billing system, cloud
control plane, or enterprise backend.

## CI enforcement

The boundary checker binds every canonical public endpoint key and managed
endpoint key to an exact source-path inventory across backend, renderer,
shared, and preload runtime sources. Node and Vite environment access, dot
access, bracket access, static template keys, and template interpolation are
all scanned after comments are removed. An endpoint key in a new runtime file
is rejected even when that key is already known. Unknown hardcoded
`*.clodex.xyz` service hosts are also rejected; the canonical public host
remains `clodex.xyz`.

Managed bearer authorization is checked at the named operation that performs
the request, not only by a file-wide string count. The Cloud Task client
inventory contains 19 bearer-authorized operations and one explicit presigned
upload exception whose supplied headers are sanitized. Session sharing has two
account-bearer operations, and hosted MCP has one bearer-bound transport. A new
Cloud Task transport method, removal of any reviewed authorization binding, or
adding control-plane authorization to the presigned upload exception fails the
boundary check and requires explicit review. Cloud Task transport references
are inventoried whether accessed directly, with brackets or optional chaining,
or first assigned to a local alias.
