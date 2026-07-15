# Bundled-component license evidence

These files are exact upstream license bytes referenced by
[`../BUNDLED_COMPONENTS.json`](../BUNDLED_COMPONENTS.json). They cover shipped
components that are not discovered through the installed npm dependency graph.

Rules:

- every record binds an exact component/version to an immutable source archive
  and SHA-256;
- every local evidence file is SHA-256-pinned relative to the registry;
- every dependency embedded in a generated webpack bundle is bound to the
  exact archived production lock, npm integrity, tarball SHA-256, package-root
  license path, and license-text SHA-256;
- final artifact validation verifies generated manifests or fixed binary hashes
  before emitting the CycloneDX SBOM;
- hash drift, missing evidence, a mutable Git download URL, an unreviewed record,
  or a platform/architecture mismatch blocks release; and
- the records are engineering attribution evidence, not a legal conclusion or
  a substitute for release-owner and specialist-counsel review.

The `VCRuntime.CefSharp.140` record intentionally retains
`CONDITIONAL_UPSTREAM_TERMS`: the NuGet package declares MIT for the package,
but this repository does not infer from that declaration alone that Microsoft
runtime DLL redistribution is authorized.
