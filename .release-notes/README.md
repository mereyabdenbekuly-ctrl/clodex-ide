# Release Notes

Place custom release notes in this directory.

- `clodex.md` - Custom notes for the next browser release
- `karton.md` - Custom notes for the next karton release
- `clodex-technical-preview.json` - Active schema-v2 preview plan consumed by
  the explicit Technical Preview Release workflow; it is not deleted by
  `Prepare Release`
- `clodex-stable.json` - Created only after real, committed preview.3 canary
  evidence exists. Its absence deliberately blocks stable promotion.

The package-specific Markdown files are merged into the changelog and then
deleted. The technical-preview JSON manifest remains committed as release
evidence.

Do not commit speculative preview.3 or stable manifests with placeholder
digests, release IDs, source SHAs, or acceptance paths. Promotion manifests
must reference a terminal acceptance report already committed under
`.release-evidence/`.
