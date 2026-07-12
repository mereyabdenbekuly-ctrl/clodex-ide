# Cloud Tasks 9.2 — Snapshot Packaging

## Scope

Этот инкремент реализует безопасную локальную подготовку workspace snapshot
для cloud execution. Production transport boundary подключён следующим этапом
9.3, но `cloud-tasks` остаётся default-disabled, а отсутствующий adapter или
snapshot packager завершает запрос fail closed без fallback на local.

## Explicit selection

Snapshot не сканирует все подключённые диски и не синхронизирует workspace
неявно. `BaseAgent` строит `AgentTaskSnapshotSelection` из `pathReferences`
последнего user message:

- file/path links;
- file attachments;
- file и workspace mentions;
- hash, зафиксированный при подготовке user turn.

Выбор директории означает явное рекурсивное включение её допустимого
содержимого. Пустой selection отклоняется. Для напрямую выбранного файла
packager сравнивает текущий SHA-256 с hash из user message и отклоняет stale
selection вместо загрузки более новой версии файла.

## File policy

`FileSystemCloudTaskSnapshotPackager` получает только список workspace mounts
конкретного агента. Он:

- отклоняет неизвестные и protected mounts (`att`, `shells`, `memory`);
- применяет root и nested `.gitignore`;
- всегда исключает `.git`, `node_modules` и OS junk;
- исключает credential directories и secret-like files (`.env*`, private
  keys, key stores, credential/config files);
- не следует symbolic links;
- проверяет realpath containment внутри mount root;
- отклоняет protected-file envelopes через host callback;
- пропускает sockets, devices и другие нерегулярные entries;
- применяет лимиты на traversal, file count, размер одного файла и общий
  plaintext byte count.

Project-safe шаблоны `.env.example`, `.env.sample` и `.env.template` могут
быть включены.

## Immutable reading

Каждый файл открывается отдельным read-only handle. Packager сравнивает
device, inode, size, mtime и ctime до и после чтения. Изменение или усечение
файла во время подготовки завершает snapshot ошибкой. Manifest строится
только из фактически прочитанных bytes и содержит детерминированно
отсортированные:

- mount prefix;
- normalized relative path;
- plaintext size;
- SHA-256.

## Archive, encryption и signature

Plaintext archive не записывается на диск. Содержимое последовательно
кодируется в `clodex-snapshot-v1` и сразу шифруется AES-256-GCM во временный
файл с mode `0600`.

Crypto provider обязан:

1. обернуть одноразовый data key;
2. подписать canonical manifest;
3. вернуть algorithm/key id без раскрытия private key.

Descriptor, передаваемый cloud adapter, содержит:

- manifest и signature;
- путь к локальному encrypted staging archive;
- ciphertext SHA-256 и размер;
- nonce, authentication tag и wrapped data key.

Data key очищается из локального buffer после packaging. Этап 9.3 подключает
P-256 ECDH/HKDF/AES-GCM server-recipient key wrapping; небезопасного default
crypto provider по-прежнему нет.

## Router lifecycle

Для cloud target порядок фиксирован:

```text
gate check
  -> adapter availability
  -> snapshot packaging
  -> adapter.execute(request + cloudSnapshot descriptor)
  -> mandatory staging cleanup
  -> stream execution
```

Adapter обязан завершить upload/import snapshot внутри `execute()`. После
возврата execution object staging archive удаляется и больше недоступен.
Ошибка cleanup завершает task fail closed.

Cancellation проверяется до staging, во время traversal и между file chunks.
Любая ошибка удаляет task-specific staging directory. Audit использует только
coarse reasons:

- `snapshot-unavailable`;
- `snapshot-invalid`;
- `snapshot-error`;
- `aborted`.

Paths, hashes, manifest, archive location и содержимое файлов в telemetry не
передаются.

## Validation

Tests покрывают:

- selection из последнего user turn;
- deterministic ordering;
- nested `.gitignore`;
- secret, protected-mount и symlink enforcement;
- stale hash и quotas;
- AES-GCM archive без plaintext на диске;
- manifest signature;
- idempotent cleanup;
- cancellation before staging;
- router fail-closed при отсутствии packager;
- передачу descriptor adapter и cleanup после `execute()`.

## Продолжение

Этап 9.3 реализован в
`docs/cloud-tasks-secret-broker-production-adapter.md`: server-recipient key
wrapping, scoped short-lived credentials, upload sessions, integrity,
residency/quota policy и streaming logs/cancel transport.

Этап 9.4 реализован в
`docs/cloud-tasks-artifacts-resume-dogfood.md`.

Следующий инкремент — 9.5 release readiness.
