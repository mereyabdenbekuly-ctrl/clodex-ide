# Canary observation v1 conformance vectors

These files are synthetic, content-free positive vectors for the public
distribution-summary and health-summary contracts. They contain no real
installation identifiers, telemetry, prompts, traces, credentials, production
topology, or customer data.

Each JSON file is encoded as canonical UTF-8 JSON with exactly one trailing
newline. `canary-observation-summaries.test.mjs` verifies the exact bytes,
schema, counter partition, and deterministic receipt assembly against the
synthetic verification clock `2026-07-15T01:00:00.000Z`.
