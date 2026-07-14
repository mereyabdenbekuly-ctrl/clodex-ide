# OCB-006 release-license blocker snapshot

**Observed:** 2026-07-15 on macOS arm64 after `pnpm install --frozen-lockfile --ignore-scripts`  
**Gate status:** RED  
**Inventory:** 952 unique dependency versions; 58 blockers

This is a reproducible engineering snapshot, not a legal conclusion. Resolve each item with package-specific provenance and distributable license text; do not silence or fabricate entries. Platform-specific inventories may add further packages.

Reproduce with:

```bash
pnpm install --frozen-lockfile
pnpm --dir apps/browser release:attribution:check -- --channel=release
```

## PACKAGE_LICENSE_TEXT_MISSING (54)

- @ai-sdk/provider-utils@4.0.27 has no distributable license text.
- @aws-sdk/credential-provider-http@3.972.36 has no distributable license text.
- @aws-sdk/credential-provider-login@3.972.38 has no distributable license text.
- @aws-sdk/nested-clients@3.997.6 has no distributable license text.
- @better-auth/utils@0.4.0 has no distributable license text.
- @better-fetch/fetch@1.1.21 has no distributable license text.
- @bokuweb/zstd-wasm@0.0.27 has no distributable license text.
- @cfworker/json-schema@4.1.1 has no distributable license text.
- @clodex/agent-core@0.0.0 has no distributable license text.
- @clodex/agent-runtime-node@0.2.0 has no distributable license text.
- @clodex/agent-shell@0.0.0 has no distributable license text.
- @clodex/api-client@0.1.0 has no distributable license text.
- @clodex/mcp-runtime@0.0.0 has no distributable license text.
- @clodex/stage-ui@0.0.1 has no distributable license text.
- @gsap/react@2.1.2 has no distributable license text.
- @img/sharp-libvips-darwin-arm64@1.2.4 has no distributable license text.
- @libsql/client@0.15.15 has no distributable license text.
- @libsql/client@0.17.3 has no distributable license text.
- @libsql/core@0.15.15 has no distributable license text.
- @libsql/core@0.17.3 has no distributable license text.
- @libsql/darwin-arm64@0.5.29 has no distributable license text.
- @libsql/isomorphic-fetch@0.3.1 has no distributable license text.
- @libsql/isomorphic-ws@0.1.5 has no distributable license text.
- @napi-rs/canvas-darwin-arm64@0.1.100 has no distributable license text.
- @nodable/entities@2.1.0 has no distributable license text.
- @posthog/core@1.28.4 has no distributable license text.
- @react-three/fiber@9.6.1 has no distributable license text.
- @xterm/addon-serialize@0.14.0 has no distributable license text.
- @xterm/headless@6.0.0 has no distributable license text.
- boolbase@1.0.0 has no distributable license text.
- data-uri-to-buffer@4.0.1 has no distributable license text.
- drizzle-orm@0.45.2 has no distributable license text.
- eastasianwidth@0.2.0 has no distributable license text.
- emoji-regex@10.6.0 has no distributable license text.
- emoji-regex@8.0.0 has no distributable license text.
- emoji-regex@9.2.2 has no distributable license text.
- gsap@3.15.0 has no distributable license text.
- ignore@6.0.2 has no distributable license text.
- ignore@7.0.5 has no distributable license text.
- input-otp@1.4.2 has no distributable license text.
- js-tiktoken@1.0.21 has no distributable license text.
- khroma@2.1.0 has no distributable license text.
- langsmith@0.6.0 has no distributable license text.
- ogl@1.0.11 has no distributable license text.
- overlayscrollbars-react@0.5.6 has no distributable license text.
- overlayscrollbars@2.16.0 has no distributable license text.
- promise-limit@2.7.0 has no distributable license text.
- punycode.js@2.3.1 has no distributable license text.
- rehype-katex@7.0.1 has no distributable license text.
- remark-math@6.0.0 has no distributable license text.
- seti-icons@0.0.4 has no distributable license text.
- stable@0.1.8 has no distributable license text.
- type-fest@2.19.0 has no distributable license text.
- victory-vendor@37.3.6 has no distributable license text.

## PACKAGE_LICENSE_UNKNOWN (4)

- @better-fetch/fetch@1.1.21 has a missing or Unknown license declaration.
- @clodex/api-client@0.1.0 has a missing or Unknown license declaration.
- @clodex/stage-ui@0.0.1 has a missing or Unknown license declaration.
- khroma@2.1.0 has a missing or Unknown license declaration.

