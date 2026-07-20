# Private dependency firewall reference

Status: public reference semantics only. Gateway implementation remains
unauthorized.

The public checker in scripts/ci/check-private-dependency-firewall.mjs is a
test oracle for the B3 and PV0-G09 policy. It demonstrates fail-closed checks
against synthetic directories. It is not a private repository baseline and
must not be copied or vendored into private code as a licensing shortcut.

The reference policy rejects:

- workspace, file, link, portal, patch, URL, and Git dependency sources;
- Stagewise packages and all CLODEx implementation packages;
- package aliases that hide a forbidden dependency;
- source imports of forbidden packages;
- exact hashes recorded as copied public implementation bytes;
- private-data-room, attachment, investor, customer-data, and production
  topology markers;
- obvious private key and provider-token forms;
- generated files without an exact reviewed hash and provenance record; and
- any attempt to allow a Protocol or SDK package before its publication gates
  are approved.

Run the synthetic reference tests with:

    node --test scripts/ci/check-private-dependency-firewall.test.mjs

A future private repository closes B3 or PV0-G09 only after it has an
independently reviewed implementation of equivalent controls, operating CI,
retained evidence, branch protection, secret scanning, SAST, SBOM generation,
and an explicit list of GREEN published dependencies. Passing the public
reference tests alone closes no Gateway gate.
