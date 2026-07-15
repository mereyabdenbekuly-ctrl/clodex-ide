# Reviewed dependency license texts

These public files support the exact-version engineering registry in
[`../DEPENDENCY_LICENSE_OVERRIDES.json`](../DEPENDENCY_LICENSE_OVERRIDES.json).
They exist because some exact npm tarballs declare a license but omit the
corresponding root text, or because a dependency uses combined/custom terms.

Rules:

- no file is selected by package name alone;
- every applied record is exact `package@version` and npm-integrity bound;
- repository files are pinned to public commit hashes or release tags;
- SPDX templates are pinned to `spdx/license-list-data` commit
  `98f5c2939d624d338d9fbc159d97f0994c7cfaf3` and are used only when an exact
  package manifest already declares that SPDX license;
- package-file repairs verify the SHA-256 of the text shipped in the exact npm
  tarball;
- combined files retain the component texts/notices from which they were built;
- any registry or text hash drift blocks release.

These records are attribution engineering evidence, not a legal opinion or a
relicensing action. Custom terms (notably GSAP), LGPL obligations, source-offer
requirements, and commercial use require release-owner and specialist counsel
review.
