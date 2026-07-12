# Clodex developer handbook

Primary documents:

- [Short product document](short_doc.md)
- [Full project document](full_doc.md)

The canonical developer documentation lives in
[`docs/developer/README.md`](docs/developer/README.md).

Start here:

1. [Local development](docs/developer/local-development.md)
2. [Architecture](docs/developer/architecture.md)
3. [Repository map](docs/developer/repository-map.md)
4. [Product capabilities](docs/developer/capabilities.md)
5. [Agent platform](docs/developer/agent-platform.md)
6. [Security and data](docs/developer/security-and-data.md)
7. [Testing and release](docs/developer/testing-and-release.md)

Minimum supported toolchain:

- Node.js `22.23.1` for deterministic packaging;
- pnpm `10.30.3`;
- macOS, Linux, or Windows for development;
- macOS for DMG packaging and notarization.

Quick start:

```bash
pnpm install --frozen-lockfile
pnpm build:packages
pnpm --dir apps/browser start:fast
```

Before opening a pull request:

```bash
pnpm check
pnpm typecheck
pnpm test
```
