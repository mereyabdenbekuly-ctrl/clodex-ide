# Cloud Tasks 9.3 — Secret Broker и production adapter boundary

## Scope

Этап подключает production-ready client boundary для Cloud Tasks, не включая
cloud execution по умолчанию. Runtime создаётся только при наличии
`CLODEX_CLOUD_TASKS_URL`; сам feature gate `cloud-tasks` остаётся
default-disabled и routing продолжает работать fail closed без replay на local.

Реализация включает:

- short-lived task credentials;
- server-recipient key wrapping;
- upload sessions и integrity acknowledgement;
- локальное применение residency/quota policy;
- streaming NDJSON transport с reconnect cursor;
- удалённую отмену;
- content-free telemetry.

Cloud backend и выпуск доверенных server recipient keys остаются внешней
границей: desktop client проверяет их контракт, но не подменяет production
control plane локальным небезопасным fallback.

## Secret Broker

`CloudTaskSecretBroker` выдаёт memory-only lease, привязанный к:

- task id;
- audience `clodex-cloud-task-runtime`;
- residency;
- точному набору scopes;
- короткому сроку жизни.

Поддерживаемые scopes:

- `task:start`;
- `task:stream`;
- `task:cancel`;
- `artifact:read`.

Ответ broker проверяется fail closed: task, audience, residency, scopes,
issued/expiry timestamps и максимальный TTL должны совпадать с запросом.
Revoke является idempotent и best effort, а token не записывается в snapshot,
metadata, telemetry или persistent storage.

Account access token используется только для запросов к настроенному HTTPS
control-plane origin. Signed upload URL никогда не получает `Authorization`,
`Cookie` или proxy credentials.

## Server-recipient encryption

Upload session создаётся до локального packaging и возвращает ограниченный по
времени P-256 recipient public key. Для каждого task client:

1. создаёт ephemeral P-256 ECDH key pair;
2. получает shared secret;
3. выводит wrapping key через HKDF-SHA256 с task/key binding;
4. оборачивает одноразовый snapshot data key через AES-256-GCM;
5. подписывает canonical manifest через HMAC-SHA256 с отдельным derived key.

Recipient key обязан быть P-256, иметь допустимый key id и не быть expired.
Ephemeral private material, shared secret, wrapping/signing keys и data-key
buffers очищаются после использования. Ротация выполняется control plane:
каждая новая upload session может вернуть новый recipient key, и client не
кэширует его между задачами.

## Upload session и integrity

До чтения workspace control plane возвращает:

- session id;
- HTTPS signed upload URL;
- безопасный набор upload headers;
- residency;
- file/byte quotas;
- expiry;
- recipient key.

Локальный packager применяет минимум из локальных policy limits и session
limits. После streaming upload server обязан подтвердить ciphertext SHA-256 и
выдать opaque object id. Несовпадение hash удаляет staging archive и завершает
task ошибкой.

В snapshot descriptor после успешной загрузки добавляется только ограниченная
upload reference: session/object id, residency, expiry и ciphertext hash.
Account/task credentials туда не попадают.

## Residency и quotas

Production wiring использует консервативную локальную policy:

- residency: `CLODEX_CLOUD_TASKS_RESIDENCY`, допустимы `us`, `eu`, `apac`,
  default — `us`;
- snapshot: до 256 MiB и 5 000 файлов;
- execution duration: до 30 минут;
- cost: до 5 000 000 micros.

Upload session не может ослабить локальные лимиты. Residency session, uploaded
snapshot и execution request должна совпадать с локальной policy.

## Streaming transport

Execution запускается task-scoped credential и возвращает same-origin stream и
cancel URLs. Cross-origin redirect/reference отклоняется.

Stream использует bounded NDJSON:

- response и line size ограничены;
- execution id проверяется для каждого event;
- sequence должен строго возрастать;
- cursor `after=<lastSequence>` защищает от replay;
- после transport failure выполняется не более одного reconnect;
- `chunk` и bounded `log` events передаются UI;
- `completed`, `failed` и `cancelled` завершают stream и вызывают существующие
  lifecycle callbacks;
- локальный abort отправляет remote cancel и освобождает credential lease.

UI и internal consumer получают tee branches одного source stream. Staging
archive удаляется router после успешного старта remote execution.

## Configuration и rollout

Production adapter доступен только когда одновременно:

1. настроен валидный HTTPS `CLODEX_CLOUD_TASKS_URL`;
2. существует account access token;
3. включён feature gate `cloud-tasks`;
4. snapshot selection и packaging успешно прошли policy checks.

Отсутствие любого условия завершает cloud request fail closed. Cloud-to-local
fallback запрещён.

## Audit

`cloud-task-control-plane-event` содержит только:

- operation: `upload | start | stream | cancel`;
- success;
- residency;
- coarse reason;
- duration;
- aggregate snapshot byte/file counts только для upload.

В audit запрещены token, prompt, paths, hashes, manifest, URLs, task id, agent
id и log contents. Ошибка telemetry transport не меняет execution outcome.

## Validation

Targeted tests покрывают:

- строгую валидацию short-lived credential lease и revoke;
- P-256 ECDH/HKDF/AES-GCM wrapping и manifest signature;
- отсутствие account bearer token на signed upload URL;
- upload quotas и integrity acknowledgement;
- same-origin stream/cancel;
- bounded NDJSON и monotonic sequence;
- recipient-bound packaging и staging cleanup;
- scoped execution lease;
- UI/log streaming, completion callback, reconnect и remote cancellation;
- отсутствие cloud-to-local fallback в router.

## Продолжение

Этап 9.4 реализован в
`docs/cloud-tasks-artifacts-resume-dogfood.md`: artifact-scoped download,
Range resume, integrity, persisted stream cursor, usage enforcement и
ограниченный dogfood rollout.

Следующий инкремент — 9.5 release readiness и startup reconciliation.
