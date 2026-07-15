# Bundled-component metadata evidence

This directory retains exact non-license metadata bytes extracted from pinned
upstream archives. The SHA-256 values and public source references are recorded
in [`../BUNDLED_COMPONENTS.json`](../BUNDLED_COMPONENTS.json).

`VCRuntime.CefSharp.140-1.0.5.nuspec` is the exact nuspec from the pinned NuGet
archive. It records the package identity, version, author/owner metadata,
license expression, copyright notice, project URL, and description. Retaining
it does not create or expand redistribution rights.

`vscode-eslint-3.0.10-server-package-lock.json` is the exact production lock
from immutable vscode-eslint revision
`790646388696511b2665a4d119bf0fb713dd990d`. It is used to require exact
coverage of every production package embedded into the generated server
bundle; dev/build-only packages are not represented as shipped components.
