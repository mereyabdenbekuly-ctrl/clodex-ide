# Memories Extension: MVP long-term notes

## Назначение

Memory Notes добавляет явную долгосрочную память между сессиями, не меняя
существующий read-only архив `memory/`.

- Архив `memory/` остаётся файловой историей и монтируется только для чтения.
- Notes хранятся отдельно в `memory-notes.sqlite`.
- Notes никогда не добавляются в system prompt автоматически.
- Агент получает notes только через явные tools.
- Любое извлечённое содержимое считается недоверенными пользовательскими
  данными, а не инструкциями.

## Feature gate

Функция доступна через preview gate `memory-notes`.

- При выключенном gate tools не входят в активный toolset.
- Каждый tool повторно проверяет gate при выполнении.
- Ошибка открытия preview-БД не блокирует запуск приложения; tools остаются
  недоступными до восстановления хранилища.

## Хранилище

SQLite-файл:

```text
<host dataDir>/memory-notes.sqlite
```

База намеренно не находится внутри `memoryDir()`, поэтому raw SQLite никогда
не появляется в read-only mount `memory/`.

Поля `scopeKey`, `title`, `content` и `tags` защищаются host
`DataProtection`. Для SQL-фильтрации scope хранится только SHA-256:

```text
sha256(scope + "\0" + canonicalScopeKey)
```

При появлении DataProtection существующие plaintext-поля шифруются, после чего
SQLite WAL/free pages очищаются через checkpoint и `VACUUM`.

## Scopes

| Scope | Canonical key | Доступ |
| --- | --- | --- |
| `global` | `null` | Все агенты |
| `workspace` | Абсолютный путь текущего mount | Агенты с этим workspace |
| `agent` | Текущий agent instance id | Только этот экземпляр агента |

Модель не может передать произвольный canonical key. Для workspace tool
принимает mount prefix и backend разрешает его через текущий mount manager.

## Tools

- `addMemory`
  - default scope: `agent`;
  - `sensitivity=sensitive` требует AI SDK approval;
  - title/content/tags имеют строгие лимиты.
- `listMemories`
  - возвращает metadata без полного content;
  - без scope объединяет global, current-agent и mounted-workspace notes.
- `readMemory`
  - читает полное содержимое только из доступных текущему агенту scopes.
- `searchMemories`
  - `any`: достаточно любого query term;
  - `all-on-line`: все terms должны находиться в одной строке;
  - `all-within-entry`: все terms должны находиться где-либо в entry;
  - поиск выполняется после расшифровки ограниченного scoped набора;
  - результат содержит bounded excerpt, полное содержимое читается отдельно.
- `deleteMemory`
  - всегда требует approval;
  - не удаляет note за пределами доступных scopes.

## MVP limits

| Ограничение | Значение |
| --- | ---: |
| Title | 160 символов |
| Content | 20 000 символов |
| Tags | 16 |
| Один tag | 48 символов |
| Search query | 500 символов |
| List/search result limit | 50 |
| Search candidates after SQL scope filter | 1 000 |

## Settings

`Settings → Memory` доступен при включённом preview gate `memory-notes`.

- Export создаёт переносимый JSON формата `clodex-memory-notes` версии 1.
  Экспорт содержит расшифрованные notes выбранного типа scope, но никогда не
  копирует raw SQLite или protected envelopes. Файл создаётся через системный
  Save dialog с правами `0600`, где платформа их поддерживает.
- Reset требует отдельного подтверждения и выбора `all`, `global`,
  `workspace` или `agent`. Выбор scope-типа относится ко всем сохранённым
  workspace/agent notes соответствующего типа, а не только к открытому
  workspace или активному агенту.
- Retention хранится в типизированных preferences:
  `forever | 30-days | 90-days | 1-year`.
- При изменении retention просроченные notes удаляются немедленно; при запуске
  политика применяется повторно. Срок считается от `updatedAt`.
- Bulk reset и retention cleanup выполняют SQLite checkpoint/VACUUM.
- Read-only архив `memory/` этими действиями не изменяется.

## Следующие инкременты

1. UI для просмотра/редактирования заметок.
2. Audit events без title/content/tags.
