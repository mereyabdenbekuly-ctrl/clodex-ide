# Cloud Tasks 9.5 — Release Readiness

Этап закрывает runtime-хвосты перед production rollout, но **не включает
release gate автоматически**. Для promotion нужны dogfood evidence,
cross-platform smoke и явный product/security/operations sign-off.

## Startup reconciliation

`FileSystemCloudTaskStreamResumeStore` теперь предоставляет bounded
`listPending()` и удаляет corrupt, oversized и expired checkpoints.
Checkpoint остаётся content-free:

- opaque `taskId` и `executionId`;
- monotonic replay cursor;
- expiry/update timestamps;
- без prompt, URL, credential, path, log, artifact metadata и hash.

`CloudTaskRecoveryCoordinator` запускается:

- при старте приложения;
- после Electron `powerMonitor.resume`.

Для каждого checkpoint coordinator получает новый short-lived credential со
scopes `task:status` и `task:cancel`, обращается только к fixed same-origin
endpoint и:

- очищает checkpoint для terminal execution;
- отменяет active orphan (`queued/preparing/running/suspended`) и очищает
  checkpoint после подтверждённой idempotent cancellation;
- сохраняет checkpoint при auth/network failure для следующей попытки;
- никогда не выполняет cloud-to-local replay.

## Artifact retention и global disk budget

`FileSystemCloudTaskArtifactStore` является единственным authority для
локальных cloud artifacts:

- default global budget: 2 GiB;
- default retention: 7 дней;
- oldest-first eviction до новой download reservation;
- `.part` активной загрузки не удаляется;
- stale inactive partial/checkpoint state очищается;
- metadata и final file связываются по execution/artifact id;
- regular-file, no-symlink и realpath-containment revalidation перед open,
  reveal или export;
- bounded scan: до 1 000 execution directories и 2 000 entries на directory.

Final metadata sidecar записывается atomically и содержит только необходимые
локальные display/integrity поля. Telemetry получает только aggregate
removed-count/bytes.

## Artifact UI и export boundary

Cloud artifact отображается отдельной карточкой в assistant message:

- `Open`;
- `Show in folder`;
- `Export`.

Renderer передаёт backend только `executionId` и `artifactId`. Raw
`localPath` больше не входит в UI stream и не является authorization input.
Backend повторно разрешает metadata-bound path внутри artifact root. Export
использует native save dialog и копирует файл только после backend
revalidation.

## Production backend conformance

Client conformance tests фиксируют обязательный protocol:

- scoped bearer на status/cancel;
- fixed same-origin status endpoint;
- idempotent cancellation (`409/410` допустимы);
- execution/task binding;
- monotonic NDJSON sequence и terminal event;
- same-origin artifact URL;
- identity encoding, Range offset/total и SHA-256 acknowledgement;
- запрет redirect/content transformation;
- account credential не передаётся signed upload target.

Production backend должен прогнать тот же набор до sign-off.

## Dogfood SLO

`evaluateCloudTaskReleaseReadiness()` использует fixed-shape content-free
evidence.

Sample gates:

- observation ≥72 часов;
- evidence age ≤48 часов;
- ≥2 builds;
- ≥25 installs;
- ≥200 finished executions.

Quality thresholds:

- execution failure rate ≤2%;
- network failure rate ≤3%;
- resume failure rate ≤1%;
- policy-limit rate ≤1%;
- reconciliation failure rate ≤1%;
- artifact action failure rate ≤2%;
- integrity failures = 0;
- start latency p95 ≤5 s;
- reconnect latency p95 ≤3 s.

Обязательны backend conformance, content-free telemetry audit и
network/suspend/resume smoke на macOS, Windows и Linux. После этого всё равно
требуется отдельный product/security/operations sign-off. Возможные состояния:
`collecting`, `needs-tuning`, `awaiting-signoff`, `candidate`.

## Cross-platform smoke evidence

Harness не создаёт passed artifact, пока оператор явно не подтвердил все
гейты:

```bash
pnpm --filter @clodex/browser smoke:cloud-tasks:suspend-resume -- \
  --network-reconnect=passed \
  --system-suspend-resume=passed \
  --orphan-cancellation=passed \
  --artifact-range-resume=passed \
  --content-free-audit=passed
```

Evidence записывается owner-only и содержит только platform, arch, app version,
timestamp и boolean gates. Task ids, paths, URLs, file names, hashes, prompts,
logs и credentials запрещены.

## Rollout rule

До трёх platform artifacts, SLO candidate и human sign-off:

- dogfood default остаётся только `dev/prerelease/nightly`;
- `release` остаётся default-disabled;
- emergency kill switch остаётся авторитетным;
- отсутствие backend conformance или integrity failure блокирует promotion.

## Release evidence collector

Финальный fixed-shape artifact собирается только после трёх platform smoke и
явных product/security/operations attestations:

```bash
pnpm --dir apps/browser collect:cloud-task-release-evidence -- \
  --aggregate cloud-task-aggregate.json \
  --source-commit "$(git rev-parse HEAD)" \
  --smoke darwin-arm64.json \
  --smoke win32-x64.json \
  --smoke linux-x64.json \
  --backend-conformance-passed \
  --content-free-telemetry-audit-passed \
  --product-signoff \
  --security-signoff \
  --operations-signoff
```

Schema v2 привязывает evidence к точному source commit. Collector отклоняет
duplicate/missing platforms, mixed app versions, stale/future smoke,
неподтверждённые attestations и aggregate, не проходящий SLO. Partial release
artifact никогда не записывается.

`.github/workflows/cloud-task-promotion.yml` выполняет тот же flow из trusted
`main` revision внутри GitHub Environment `cloud-task-promotion`. Inputs —
bounded gzip+base64 JSON. На выходе создаются `cloud-tasks.json`, strict
main-plan readiness receipt и checksummed metadata bundle.
