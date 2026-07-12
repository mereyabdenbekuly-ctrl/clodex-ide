# Cloud Tasks 9.1 — Execution Target Foundation

## Scope

Этот инкремент вводит routing contract для `local | cloud`, не реализуя
cloud backend и не меняя существующее local execution behavior.

Текущий local target продолжает использовать прежний browser-owned
`BrowserAgentStepExecutor`. Внутри него шаг может исполняться в main process
или в supervised isolated utility process, но оба варианта считаются
локальными: workspace и tool capabilities не передаются внешнему cloud
runtime.

## Per-turn target

User message metadata может содержать:

```json
{
  "executionTarget": "local"
}
```

или:

```json
{
  "executionTarget": "cloud"
}
```

Последнее user message определяет target всех последующих model/tool steps
этого turn, включая approval continuation. Отсутствующее или неизвестное
значение нормализуется в `local`.

`cloud` доступен только при включённом feature gate `cloud-tasks` и наличии
реального cloud adapter.

## Fail-closed routing

`ExecutionTargetRouter` расположен над локальным step executor:

```text
BaseAgent
  -> ExecutionTargetRouter
       -> local: existing BrowserAgentStepExecutor
       -> cloud: configured cloud adapter
```

Правила:

- local остаётся default target;
- выключенный cloud gate отклоняет cloud task;
- отсутствующий cloud adapter отклоняет cloud task;
- отклонённый или уже отправленный cloud task никогда не переигрывается
  локально;
- adapter получает content-free task id и explicit execution target;
- audit failure не меняет routing result.

До подключения production cloud adapter приложение использует
`UnavailableCloudExecutionTargetAdapter`. Даже если разработчик вручную
включит gate и передаст `executionTarget: cloud`, шаг завершится fail closed.

## Task lifecycle

Task ledger использует фиксированную state machine:

```text
queued -> preparing -> running -> completed
                   \-> failed
                   \-> cancelled
running -> suspended -> running
```

Terminal statuses нельзя возобновить. Ledger:

- bounded;
- in-memory;
- не содержит prompt, message text, tool name/input/output, workspace path,
  agent id или model response;
- получает cancellation от существующего agent abort signal;
- различает user/system abort, timeout и execution failure.

## Snapshot manifest foundation

`createAgentTaskSnapshotManifest()` создаёт только metadata manifest
explicitly selected файлов:

- mount prefix;
- normalized relative path;
- size;
- SHA-256;
- total byte count.

Builder:

- отклоняет absolute path, traversal и Windows separators;
- отклоняет duplicate entries;
- требует SHA-256;
- применяет entry и total-byte budgets;
- сортирует entries детерминированно;
- не читает и не загружает содержимое файлов;
- не принимает credentials или environment variables.

Реальное чтение, packaging и local encryption реализованы в этапе 9.2.
Server-recipient wrapping, upload и streaming transport реализованы в 9.3.

## Feature gate и audit

`cloud-tasks`:

- experimental;
- доступен во всех release channels;
- default-disabled во всех release channels;
- может быть включён только explicit user/developer override.

Content-free telemetry `cloud-task-execution-event` содержит:

- operation;
- target;
- lifecycle status;
- coarse reason;
- duration.

Task id, agent id, prompt, files, hashes, paths и payload в telemetry не
передаются.

## Validation

Tests покрывают:

- local default и сохранение исходного execution options object;
- target propagation из user-message metadata;
- полный lifecycle и invalid transitions;
- gate-disabled и unavailable-adapter rejection;
- отсутствие cloud-to-local fallback;
- successful injected cloud adapter;
- abort и timeout;
- bounded recent-task ledger;
- deterministic snapshot manifest;
- traversal, duplicate, invalid hash и byte-limit rejection;
- feature gate defaults.

## Продолжение

Этап 9.2 реализован в
`docs/cloud-tasks-snapshot-packaging.md`: explicit selection, ignore/secret
policy, immutable reading, encrypted archive, manifest signature, quotas и
cancellation-safe staging cleanup.

Этап 9.3 реализован в
`docs/cloud-tasks-secret-broker-production-adapter.md`: Secret Broker,
server-recipient cryptography, upload integrity, residency/quota policy и
streaming transport.

Этап 9.4 реализован в
`docs/cloud-tasks-artifacts-resume-dogfood.md`: artifact download/resume,
usage enforcement, persisted cursor и dogfood rollout.

Следующий инкремент — 9.5 release readiness.
