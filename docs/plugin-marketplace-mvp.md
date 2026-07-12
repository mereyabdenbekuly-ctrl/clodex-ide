# Plugin Marketplace MVP

## Scope

Этап 7 реализован как локальный официальный marketplace. Приложение читает
каталог из bundled assets, но доверяет ему только после проверки Ed25519
подписи. Пользовательские URL и private marketplace indexes в MVP намеренно не
поддерживаются.

## Signed index

`bundled/marketplace/index.json` — это envelope:

- `keyId` выбирает встроенный публичный ключ;
- `payload` содержит точные подписанные JSON bytes в base64;
- `signature` — Ed25519 signature этих bytes.

Payload содержит timestamp генерации и истечения, manifest каждого plugin,
источник package и ожидаемый SHA-256. Неизвестный key, неверная подпись,
истёкший index, duplicate plugin ID или невалидная schema закрывают каталог
fail-closed.

Для publisher-identified plugins payload также содержит Clodex-endorsed
publisher public keys и отдельную publisher signature canonical attestation:
manifest + package source + SHA-256. Revoked/missing key, identity mismatch и
invalid publisher signature закрывают snapshot fail-closed. Legacy catalog
entries без publisher identity остаются только catalog-signed и явно так
маркируются в UI.

Приватные signing keys не хранятся в репозитории. Ротация выполняется через
overlap: новый public key сначала попадает в приложение, затем index
переподписывается новым ключом.

Publisher private keys также не хранятся в репозитории. Команда
`pnpm -F clodex sign:publisher-attestation` принимает отдельные private/public
PEM files, отклоняет небезопасные POSIX permissions и проверяет собственную
signature перед выдачей public envelope.

## Manifest и permissions

`plugin.json` обязан объявить:

- стабильный plugin ID и semantic version;
- publisher, display name и description;
- минимальную и опциональную максимальную версию Clodex;
- permissions: `skills`, `apps`, `mcp`, `network`, `filesystem`,
  `credentials`;
- required credential types.
- для plugin с permission `mcp`: подписанный summary каждого server с ID,
  display name, transport, endpoint и coarse authentication mode.

Manifest внутри package должен точно совпадать с manifest из подписанного
index. `metadata.json` также сверяется с manifest. Наличие `SKILL.md`,
`apps/`, `mcp/` или credentials без соответствующего permission отклоняет
установку. Фактический `mcp/servers.json` дополнительно обязан совпасть с
подписанным MCP summary, поэтому package не может скрыто заменить endpoint или
authentication mode после catalog review.

## Install, update и rollback

1. Package читается из bundled directory или загружается только по HTTPS.
2. Для archive действуют лимиты размера/числа файлов, запрет path traversal и
   symlink.
3. Проверяются source SHA-256, manifest, metadata, permissions и compatibility.
4. Package копируется в отдельный staging directory.
5. Staged tree повторно хешируется.
6. Текущая версия атомарно переносится в backup, новая — в install root.
7. Integrity lockfile записывается атомарно.
8. Если activation или lockfile commit завершается ошибкой, новая версия
   удаляется, а backup возвращается на место.

Uninstall сначала переносит package в backup и удаляет lock entry. При ошибке
commit package восстанавливается.

На старте незавершённые backups восстанавливаются или удаляются. Установленные
packages повторно сверяются с lockfile; tampered и orphan directories
отключаются и удаляются до discovery.

## Lockfile

Lockfile хранится отдельно от package directories и содержит:

- plugin ID и version;
- source `official`;
- SHA-256 установленного file tree;
- timestamps install/update;
- проверенный manifest.

Запись выполняется через temporary file + atomic rename с mode `0600`.

## Runtime exposure

Marketplace plugins:

- объединяются с bundled definitions в Settings;
- не могут затенить bundled plugin с тем же ID;
- получают отдельный read-only mount `marketplace-plugins`;
- участвуют в skill discovery после successful install/update;
- доступны через `app://plugins/...` только если bundled plugin с этим ID
  отсутствует.
- MCP servers из official plugin всегда регистрируются disabled; install не
  является согласием на network connection или tool execution.

## Gate, audit и privacy

Feature gate `plugin-marketplace`:

- default on: `dev`, `prerelease`, `nightly`;
- default off: `release`;
- backend повторно проверяет gate для refresh/install/update/uninstall;
- read-only state остаётся доступен при выключенном gate.

Telemetry не содержит URL, package content, prompts, files или credentials.
Записываются только operation, success, duration, plugin ID/version,
permission count, catalog size и signing key ID.

## Validation

Автоматические тесты покрывают:

- valid bundled/test signature;
- tampered signature и expired index;
- package hash mismatch;
- undeclared permission;
- incompatible app version;
- install/uninstall и integrity lockfile;
- update rollback при ошибке lockfile;
- startup quarantine после tampering;
- feature gate off.

Private/custom marketplace, remote index refresh и publisher onboarding
остаются отдельным post-MVP этапом.
