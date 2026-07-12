# Release Notes

Place custom release notes in this directory.

- `clodex.md` - Custom notes for the next browser release
- `karton.md` - Custom notes for the next karton release
- `clodex-technical-preview.json` - Immutable plan consumed by the explicit
  Technical Preview Release workflow; it is not deleted by `Prepare Release`

The package-specific Markdown files are merged into the changelog and then
deleted. The technical-preview JSON manifest remains committed as release
evidence.
