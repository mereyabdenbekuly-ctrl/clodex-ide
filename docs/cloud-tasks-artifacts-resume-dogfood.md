# Cloud Tasks 9.4 — Artifacts, resume, usage enforcement и dogfood

## Scope

Этап 9.4 завершает desktop-side transport lifecycle для ограниченного
Cloud Tasks dogfood:

- artifact download с отдельным `artifact:read` credential;
- HTTP Range resume и crash-safe checkpoints;
- ciphertext/result integrity verification;
- persisted content-free stream cursor;
- cumulative duration/cost enforcement;
- artifact count/byte quotas;
- dogfood channel defaults, telemetry и emergency kill switch.

Release channel остаётся default-disabled. Наличие feature gate само по себе не
делает adapter доступным: по-прежнему обязательны HTTPS control plane,
account session и валидная локальная policy.

## Artifact event contract

Cloud stream может передать event `artifact` с:

- opaque artifact id;
- display-only file name без path separators/control characters;
- bounded media type;
- declared byte size;
- SHA-256;
- same-origin HTTPS download URL;
- expiry.

Client не принимает absolute/local paths от server. Файл сохраняется только в
app-owned каталоге:

```text
<userData>/cloud-task-artifacts/<executionId>/<artifactId>.artifact
```

Directories создаются с mode `0700`, файлы/checkpoints — `0600`. UI получает
готовый `data-cloud-artifact` event только после проверки размера и digest.

## Scoped download

Start/stream credential не используется для artifact body. Downloader получает
от Secret Broker отдельный memory-only lease со scope `artifact:read`.

Download URL обязан оставаться на configured control-plane origin. Запрос:

- запрещает redirects;
- использует `Accept-Encoding: identity`;
- передаёт bearer credential только same-origin endpoint;
- проверяет `x-clodex-sha256`;
- проверяет status, `Content-Range`, `Content-Length`, offset и total size.

## Resume и integrity

Незавершённая загрузка хранится как:

- `<artifactId>.part`;
- `<artifactId>.resume.json`.

Checkpoint содержит только execution/artifact ids, expected size/hash, byte
offset и timestamp. Credential, URL, prompt, paths workspace и содержимое
artifact не сохраняются.

При transport failure downloader:

1. fsync-ит записанные bytes;
2. сохраняет checkpoint атомарным rename;
3. повторяет запрос с `Range: bytes=<offset>-`;
4. хэширует уже сохранённый prefix и продолжение одним SHA-256 digest;
5. проверяет точный final size/hash;
6. атомарно переименовывает `.part` в `.artifact`.

Integrity/policy failure удаляет partial state. Network/abort оставляет
checkpoint для безопасного повторного resume.

## Stream resume

После каждого полностью обработанного event сохраняется monotonic sequence
cursor:

```text
<userData>/cloud-task-resume/<executionId>.json
```

Cursor записывается только после успешной обработки event. Поэтому artifact
event с незавершённой загрузкой не пропускается при reconnect. Transport
выполняет до трёх reconnect с bounded exponential backoff и
`after=<lastSequence>`.

Terminal server event очищает checkpoint. Unrecoverable local/network failure
сохраняет его для последующего восстановления того же execution contract.
Автоматическое восстановление UI после полного перезапуска приложения не
входит в этот инкремент.

## Usage enforcement

Server обязан передавать cumulative monotonic `usage` events:

- `durationMs`;
- `costMicros`.

Client:

- отклоняет decreasing counters;
- требует usage accounting до successful completion;
- сравнивает counters с local policy;
- дополнительно применяет wall-clock duration timer;
- отправляет remote cancel при превышении duration/cost;
- завершает task ошибкой без local replay.

Artifact policy применяется до download:

- не более 100 artifacts;
- не более 512 MiB cumulative artifact bytes;
- declared size и фактически полученные bytes должны совпасть.

Production defaults:

- snapshot: 256 MiB / 5 000 files;
- artifacts: 512 MiB / 100 files;
- duration: 30 минут;
- cost: 5 000 000 micros.

Server policy не может ослабить local limits.

## Dogfood rollout

`cloud-tasks` default-enabled только в:

- `dev`;
- `prerelease`;
- `nightly`.

В `release` gate остаётся default-disabled. Пользовательский override может
отключить dogfood gate.

Emergency stop:

```text
CLODEX_CLOUD_TASKS_KILL_SWITCH=true
```

Kill switch блокирует runtime creation и cloud admission независимо от gate.
Cloud-to-local fallback запрещён.

`cloud-task-rollout-observed` фиксирует только:

- rollout stage;
- gate enabled/source;
- наличие control-plane configuration;
- adapter availability;
- kill-switch state;
- residency.

Control-plane audit дополнен operations `artifact`, `resume`, `usage` и
aggregate values: bytes, cursor, duration, cost и coarse policy limit.
Credentials, URLs, ids, hashes, paths, file names и log contents в telemetry не
передаются.

## Validation

Tests покрывают:

- artifact/usage stream parsing;
- same-origin Range download;
- response range/length/hash binding;
- artifact-scoped credential;
- partial retry и resume offset;
- final SHA-256 и cleanup при mismatch;
- stream checkpoint save/load/expiry/clear;
- cursor advancement только после успешной обработки;
- duration/cost/artifact quota cancellation;
- dogfood defaults и emergency kill-switch parsing;
- полный fail-closed routing без local replay.

## Следующий инкремент

Этап 9.5 release-readiness infrastructure реализован в
`docs/cloud-tasks-release-readiness.md`. До release promotion остаются
фактические dogfood SLO evidence, physical macOS/Windows/Linux
network/suspend/resume artifacts и human sign-off.
