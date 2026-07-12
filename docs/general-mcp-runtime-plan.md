# General MCP Runtime — утверждённый план

Статус: **утверждён; P0, P1 и P2 завершены; P3 выполняется**

Threat model, пользовательские разрешения и verification commands:
`docs/general-mcp-runtime-threat-model.md`.

Этот документ фиксирует итоговую последовательность внедрения идей,
полученных из анализа desktop-agent архитектур. Реализация не должна
подменяться переносом чужих OAuth client IDs, telemetry DSN, внутренних
endpoint-ов, нативных бинарников или нелицензированного bundled content.
Мы переносим архитектурные принципы и реализуем их в собственных границах
Clodex.

## Неизменяемая последовательность

1. **P0 — General MCP Runtime**
2. **P1 — Protected files**
3. **P2 — Desktop Automation macOS preview**
4. **P3 — MCP ecosystem**

Новый этап не начинается до выполнения критериев готовности предыдущего.
Исправления безопасности и регрессий текущего этапа не считаются отклонением
от плана.

## Что уже является фундаментом

Clodex уже содержит:

- authenticated Clodex MCP Gateway с Guardian, approvals, timeout и output
  caps;
- Electron `utilityProcess` supervisor для изолированного Agent Host;
- fail-closed Electron `safeStorage` persistence;
- AES-256-GCM data protection для agent persistence;
- собственный PKCE/Better Auth flow;
- безопасный `.skill` installer и signed plugin marketplace;
- browser/CDP policy, screenshots, global shortcuts и `node-pty`;
- типизированную content-free telemetry.

Эти реализации расширяются, а не заменяются упрощёнными копиями.

---

# P0 — General MCP Runtime

## Цель

Преобразовать текущий single-gateway `ClodexMcpService` в общую MCP-платформу,
которая безопасно обслуживает:

- встроенный Clodex Gateway;
- пользовательские локальные stdio servers;
- Streamable HTTP servers;
- legacy SSE servers;
- MCP, поставляемые signed marketplace plugins;
- импорт конфигурации только через preview и нормализацию.

## Обязательные поставки

### 1. Core contracts

- versioned Zod schema конфигурации;
- discriminated transport union: `stdio | streamable-http | sse`;
- stable server ID и source/trust metadata;
- credential references вместо raw secrets;
- per-server и per-tool policy;
- typed main ↔ MCP host protocol;
- нормализация MCP tools без доверия к server annotations как к policy.

### 2. Isolated MCP host

- отдельный Electron `utilityProcess`;
- typed initialize/connect/list/call/close/shutdown messages;
- heartbeat, timeout, cancellation и controlled restart;
- bounded stdout/stderr и serialized errors с redaction;
- `shell: false`, явный `cwd`, очищенный environment;
- один failure domain не должен падать вместе с Electron main process.

Process isolation является fault boundary, а не полноценной OS sandbox.
Пользовательский локальный MCP явно маркируется как код с доступом уровня
текущего OS user.

### 3. Registry и persistence

- единый registry всех источников MCP;
- encrypted persistence для пользовательской конфигурации;
- raw secrets не записываются в MCP config;
- lifecycle: disabled, connecting, connected, degraded, failed;
- connection health, restart count и sanitized logs;
- atomic configuration updates и migration version.

### 4. Credentials

- разрешение credential references только в main process;
- минимальный scope и origin binding для remote headers;
- short-lived token предпочтительнее постоянного;
- secret values запрещены в UI state, telemetry, logs и error messages;
- local stdio env получает только явно выбранные пользователем secrets.

### 5. Policy и Toolbox integration

- Guardian вызывается до выполнения потенциально опасного tool;
- explicit deny сильнее annotations и Guardian approval;
- irreversible/destructive tools всегда требуют human approval;
- custom server tools по умолчанию работают в режиме `ask`;
- read-only annotation является сигналом, но не основанием для auto-allow;
- tool names получают стабильный namespace и не конфликтуют;
- output caps и timeout применяются ко всем transports.

### 6. Plugin MCP bridge

- marketplace permission `mcp` начинает иметь runtime effect;
- plugin MCP declaration находится в `mcp/servers.json`;
- manifest содержит только transport template и credential references;
- undeclared executable/network/credential access отклоняется;
- uninstall/update немедленно отключает связанные servers;
- tampered или quarantined plugin не может регистрировать MCP.

### 7. Safe import

- поддерживается preview импорта совместимых desktop MCP configs;
- import никогда не создаёт live coupling к чужому config-файлу;
- raw OAuth/session tokens автоматически не импортируются;
- env secrets превращаются в credential references либо требуют ручного ввода;
- command, args, cwd и environment показываются пользователю до подтверждения;
- traversal, malformed config и unsupported transport отклоняются.

### 8. Settings UI

- отдельные группы: Clodex Cloud, Local & Custom, Installed Plugins;
- add/edit/disable/remove/test connection;
- transport, source, trust и health status;
- sanitized endpoint/command preview;
- список tools и effective approval policy;
- restart/refresh и bounded diagnostic logs;
- credentials никогда не отображаются после сохранения.

## P0 — критерии готовности

P0 завершён только когда:

1. Работает минимум один stdio, один Streamable HTTP и один SSE fixture.
2. Падение или зависание MCP host не падает вместе с Electron main.
3. Timeout/cancel/restart покрыты тестами.
4. Ни один secret не попадает в persisted config, logs, Karton state или
   telemetry fixtures.
5. Malicious `readOnlyHint` не обходит custom-server approval policy.
6. Signed plugin с permission `mcp` может зарегистрировать server, а plugin
   без permission не может.
7. Import выполняется только после preview/confirm.
8. Clodex Gateway продолжает работать без регрессии.
9. Backend/UI typecheck, focused tests и packaged-host smoke проходят.
10. Документация описывает threat model и пользовательские разрешения.

## P0 — итоговая проверка

Проверено **10 июля 2026**:

| Критерий | Результат |
|---|---|
| stdio / Streamable HTTP / SSE fixtures | `pnpm -F clodex smoke:mcp-host` |
| host crash не падает вместе с main | smoke принудительно завершает utility process и проверяет restart/restoration |
| timeout / cancel / restart | unit tests MCP supervisor + real smoke |
| secrets не попадают в config/logs/Karton | registry, credentials, settings и smoke redaction tests |
| malicious `readOnlyHint` | policy и Toolbox focused tests |
| plugin permission bridge | signed plugin tests для `mcp`, `network`, `credentials`, update/uninstall |
| preview/confirm import | importer и Settings service tests |
| Clodex Gateway regression | существующие 10 gateway tests проходят |
| typecheck / full suite | все 5 browser TypeScript targets; 118 files / 1152 tests |
| threat model | `docs/general-mcp-runtime-threat-model.md` |

---

# P1 — Protected files

Threat model и verification:
`docs/protected-files-threat-model.md`.

Реализован versioned chunked protected-file format с уникальным nonce на
chunk, context-bound AAD, authenticated final record и потоковым чтением.

Неизменяемый порядок startup migration:

1. attachments;
2. Chronicle artifacts;
3. shell logs;
4. memory files;
5. diff-history blobs;
6. image/file caches;
7. решение по encryption/search для titles.

Текущее решение по titles: randomized encryption, decrypt/filter search в
trusted host memory, без blind index и SQL `LIKE` по ciphertext.

Реализованные инварианты:

- per-file DEK, AES-256-GCM chunks и проверка context/sequence/length;
- запись `staging → file fsync → rename → directory fsync`;
- one-way migration без plaintext staging copy;
- protected append segments для shell logs;
- plaintext OID verification для diff-history на каждом чтении;
- encrypted SQLite payloads для file/image/asset caches с WAL
  checkpoint/VACUUM;
- encrypted agent titles;
- protected mounts читаются только trusted host read/glob/grep boundary;
- `att`, `shells`, `memory` исключены из sandbox и shell cwd;
- physical ciphertext paths не публикуются в environment prompt;
- graceful shell teardown ждёт durable log drain;
- порядок миграций проверяется runtime guard и unit tests.

P1 не закрывается до прохождения agent-core, agent-shell и всех пяти browser
TypeScript targets, focused security tests и полного browser test suite.

## P1 — итоговая проверка

Проверено **10 июля 2026**:

| Критерий | Результат |
|---|---|
| protected-file format, migrations и trusted read boundary | `@clodex/agent-core`: 54 files / 661 tests |
| durable shell-log drain и propagation ошибок persistence | `@clodex/agent-shell`: 7 files / 149 tests |
| startup order, Chronicle и asset cache | focused browser suite: 4 files / 12 tests |
| browser integration regression | `clodex`: 129 files / 1226 tests |
| TypeScript | `agent-core`, `agent-shell` и все 5 browser targets |
| formatting / whitespace | Biome по финальным P1-файлам; scoped `git diff --check` |
| threat model | `docs/protected-files-threat-model.md` |

---

# P2 — Desktop Automation macOS preview

Threat model и verification:
`docs/desktop-automation-macos-threat-model.md`.

Browser/CDP остаётся основным и предпочтительным automation path.

Desktop automation реализуется отдельным feature-gated provider:

- explicit Screen Recording и Accessibility onboarding;
- capture, accessibility inspection и bounded actions;
- app allowlist;
- постоянный visual indicator и global kill switch;
- запрет secure/password fields;
- human approval для системных и необратимых действий;
- content-free audit;
- AppleScript только как статический узкий fallback;
- никаких чужих Swift/Rust/native binaries.

## P2 — критерии готовности

- feature gate выключен по умолчанию на всех release channels;
- provider доступен только на macOS и требует Screen Recording +
  Accessibility;
- global kill switch обязан успешно зарегистрироваться до enable/session;
- активная session и approval state не восстанавливаются и не записываются на
  диск;
- capture выбирает только единственное точное frontmost-window совпадение и
  хранится как P1 protected attachment;
- inspect возвращает только bounded allowlist pressable AX roles;
- press использует opaque one-shot target и повторно проверяет app, window,
  role, title, enabled и secure subrole;
- permission revocation, feature-gate disable, stop, teardown и kill switch
  обрывают pending/in-flight work fail-closed;
- system и irreversible actions всегда требуют one-time human approval;
- telemetry/debug audit не содержат screenshot, window title, control label,
  AppleScript output или typed content;
- подписанная macOS сборка содержит Apple Events entitlement и usage
  descriptions;
- статические AppleScript sources компилируются без исполнения.

## P2 — итоговая проверка

Проверено **10 июля 2026**:

| Критерий | Результат |
|---|---|
| feature gates, exact capture matching, service security, tools и agent wiring | focused browser suite: 5 files / 47 tests |
| browser integration regression | `clodex`: 132 files / 1254 tests |
| TypeScript | `agent-core`, `agent-shell` и все 5 browser targets |
| AppleScript | 3 static sources успешно скомпилированы `/usr/bin/osacompile` без исполнения |
| macOS packaging metadata | entitlements plist прошёл `/usr/bin/plutil -lint` |
| formatting / whitespace | Biome по финальным P2-файлам; scoped `git diff --check` |
| threat model | `docs/desktop-automation-macos-threat-model.md` |

---

# P3 — MCP ecosystem

Статус: **P3.1 remote OAuth, P3.2 resources/prompts, P3.3 list-changed,
P3.4 form-mode elicitation, P3.5 официальный catalog, P3.6 publisher signing
и P3.7 private marketplace завершены.**

После стабилизации core runtime:

- remote MCP OAuth через собственные зарегистрированные clients;
- resources и prompts;
- list-changed notifications;
- elicitation UI с обязательным user control;
- официальный каталог MCP plugins;
- publisher signing pipeline;
- private marketplace только после стабилизации official pipeline.

Неизменяемый внутренний порядок P3:

1. remote MCP OAuth;
2. resources и prompts;
3. list-changed notifications;
4. elicitation UI;
5. официальный catalog;
6. publisher signing;
7. private marketplace.

Threat model и verification для P3:
`docs/mcp-ecosystem-threat-model.md`.

## P3.1–P3.3 — итоговая проверка

Проверено **11 июля 2026**:

| Критерий | Результат |
|---|---|
| собственный OAuth DCR + PKCE + one-time callback | real utility-process smoke через loopback authorization server |
| stdio / Streamable HTTP / SSE / OAuth resources | static resource read для всех четырёх connection modes |
| resource templates и prompts | list/read/get через typed host protocol и Settings contracts |
| list-changed | real stdio notifications для tools/resources/prompts с bounded full-catalog refresh |
| pagination safety | общий лимит 5000 items / 100 pages, repeated-cursor rejection |
| context result safety | 4 MiB cap для resource read и prompt get |
| agent policy | user/imported context требует approval; builtin/signed-plugin context не получает redundant approval |
| runtime cache | list-changed обновляет cache и `catalogRevision`; resource change инвалидирует template cache |
| MCP runtime | 4 files / 22 tests |
| focused browser MCP | 5 files / 33 tests |
| browser integration regression | `clodex`: 136 files / 1287 tests |
| TypeScript | все 5 browser targets |
| real host smoke | OAuth, context, list-changed, cancel, timeout, redaction и restart прошли |

## P3.4 — итоговая проверка

Проверено **11 июля 2026**:

| Критерий | Результат |
|---|---|
| capability boundary | рекламируется только `elicitation.form`; URL-mode fail-closed cancel |
| agent ownership | `agentInstanceId` остаётся внутренним; agentless и multi-agent ambiguity не открывают UI |
| destination disclosure | UI явно показывает MCP server и предупреждает об отправке значений |
| bounded form schema | максимум 10 fields / 50 options; min/max/default/required/duplicate invariants |
| user control | submit → `accept`, close → `decline`, abort/timeout/stop → `cancel` |
| cancellation propagation | cancel tool call закрывает связанный pending form и abort-ит main handler |
| persistence/telemetry | pending form и ответы не сохраняются и не попадают в telemetry |
| MCP runtime | 4 files / 26 tests |
| focused browser elicitation/MCP | 5 files / 34 tests |
| browser integration regression | `clodex`: 142 files / 1309 tests |
| TypeScript | `@clodex/mcp-runtime` и все 5 browser targets |
| real host smoke | accept, submitted content, agentless cancel, ambiguity cancel и abort propagation прошли |
| threat model | `docs/mcp-ecosystem-threat-model.md` |

## P3.5 — итоговая проверка

Проверено **11 июля 2026**:

| Критерий | Результат |
|---|---|
| official trust root | bundled Ed25519-signed index проверяется встроенным public key fail-closed |
| MCP catalog disclosure | signed manifest содержит server name, transport, endpoint и authentication mode |
| package/index consistency | `mcp/servers.json` обязан совпасть с signed summary; скрытая подмена endpoint отклоняется |
| user control | перед install показываются MCP destinations/auth modes; после install servers остаются disabled |
| runtime policy | plugin declaration не может поднять default выше `ask`; explicit deny сохраняется |
| lifecycle | install/update/uninstall, integrity lockfile, rollback и startup quarantine остаются обязательными |
| focused marketplace/MCP | 2 files / 14 tests |
| browser integration regression | `clodex`: 142 files / 1311 tests |
| TypeScript | все 5 browser targets |
| formatting / whitespace | Biome и scoped `git diff --check` |
| threat model | `docs/mcp-ecosystem-threat-model.md` |

## P3.6 — publisher signing

Статус: **завершён.**

Реализовано:

- отдельная publisher signature поверх canonical manifest/source/SHA-256
  attestation;
- publisher key registry внутри Clodex-signed official index;
- stable `publisherId`, identity/name binding и unique key IDs;
- active/revoked key policy, invalid/missing/revoked fail-closed verification; <!-- gitleaks:allow -->
- publisher provenance в integrity lockfile и UI badge;
- legacy catalog-only entries остаются явно отличимыми;
- CLI без private keys в repo, с regular-file/POSIX mode checks и
  self-verification public key;
- targeted marketplace, bridge и signing tests.

Проверено **11 июля 2026**:

| Критерий | Результат |
|---|---|
| publisher identity/signature | canonical manifest/source/SHA-256 attestation и stable publisher ID |
| key lifecycle | active/revoked verification, identity binding и duplicate key rejection |
| provenance | publisher key ID/signature сохраняются в integrity lockfile |
| signing CLI | private-key mode/symlink checks и public-key self-verification |
| focused publisher/marketplace/MCP | 3 files / 17 tests |
| combined regression | Cloud Tasks + publisher/marketplace/MCP: 4 files / 24 tests |
| browser integration regression | `clodex`: 147 files / 1335 tests |
| TypeScript | все 5 browser targets |
| CLI smoke | real Ed25519 keypair/entry/signature output прошёл |
| formatting / whitespace | Biome и scoped `git diff --check` |

## P3.7 — private marketplace

Статус: **завершён.**

Реализовано:

- encrypted registry private sources через strict Electron `safeStorage`;
- HTTPS-only source URL без credentials/query/fragment и без TOFU;
- явно pinned Ed25519 key ID + PEM key с публичным SHA-256 SPKI fingerprint;
- redirect-blocked, timeout-bounded и 4 MiB-bounded index fetch;
- exact payload-byte signature verification, expiration/schema/duplicate
  checks и повторная publisher verification;
- private index остаётся только in-memory и требует refresh после restart;
- source-scoped install/update/uninstall provenance в integrity lockfile;
- cross-source plugin ID collision fail-closed, trust-root mutation/removal
  блокируются при установленных plugins;
- Settings UI для add/enable/verify/remove, catalog review и scoped plugin
  lifecycle;
- MCP destination/auth confirmation и disabled-by-default behavior
  переиспользуют official pipeline.

Проверено **11 июля 2026**:

| Критерий | Результат |
|---|---|
| encrypted registry | strict safeStorage envelope; persisted PEM не возвращается через Karton state |
| pinned fetch | HTTPS, redirects blocked, 20s timeout, 4 MiB header/stream cap, exact key ID |
| fail-closed verification | invalid key/signature, expiry, duplicates, non-HTTPS packages и publisher failures отклоняются |
| provenance | source ID/key ID/SPKI fingerprint сохраняются; cross-source overwrite/uninstall запрещены |
| lifecycle safety | source trust нельзя изменить/удалить до uninstall зависимых plugins |
| focused private/marketplace/MCP | 4 files / 30 tests |
| browser integration regression | `clodex`: 154 files / 1365 tests |
| TypeScript | все 5 browser targets |
| formatting / whitespace | scoped `git diff --check` |
| threat model | `docs/mcp-ecosystem-threat-model.md` |

---

# Запрещённые сокращения

- использовать чужие OAuth client IDs;
- использовать чужой telemetry/crash-reporting DSN;
- зависеть от внутренних непубличных endpoint-ов другого продукта;
- распространять извлечённые native binaries;
- автоматически доверять MCP annotations;
- хранить raw MCP secrets в JSON config;
- включать user-installed skill/plugin в always-trusted tier;
- рекламировать MCP capability, для которой нет полного UI/policy handler.
