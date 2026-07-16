# Bundled-component metadata evidence

This directory retains exact non-license metadata bytes extracted from pinned
upstream archives. The SHA-256 values and public source references are recorded
in [`../BUNDLED_COMPONENTS.json`](../BUNDLED_COMPONENTS.json).

`VCRuntime.CefSharp.140-1.0.5.nuspec.txt` contains the exact nuspec bytes from
the pinned NuGet archive. The packaging-safe `.txt` suffix prevents
NuGet/Squirrel from dropping nested `.nuspec` evidence. The file records the
package identity, version, author/owner metadata, license expression,
copyright notice, project URL, and description. Retaining it does not create
or expand redistribution rights.

`vscode-eslint-3.0.10-server-package-lock.json` is the exact production lock
from immutable vscode-eslint revision
`790646388696511b2665a4d119bf0fb713dd990d`. It is used to require exact
coverage of all nine production-lock packages. Source-map inspection proves
that seven are emitted into the generated server bundle; `lru-cache` and
`yallist` remain reviewed lock-only evidence and are not represented as shipped
components. Dev/build-only packages are also not represented as shipped.
