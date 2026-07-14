# `@clodex/icons`

This private workspace package is an AGPL compatibility layer over
`lucide-react`. It preserves existing local component export names while the UI
is migrated toward direct Lucide names.

The package contains no Nucleo package dependency, downloaded vendor bundle,
license key, or copied Nucleo SVG asset. The former local `nucleo-*`
compatibility packages were removed. The GitHub mark and every other active icon
now render a Lucide component.

The compatibility names do not make this package an independently publishable
component. It remains part of the public AGPL desktop source, and its migration
status is recorded in `docs/provenance/components.yml`.
