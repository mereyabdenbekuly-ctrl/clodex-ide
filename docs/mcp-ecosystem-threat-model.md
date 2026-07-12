# P3 MCP ecosystem — threat model

Статус: remote MCP OAuth, resources/prompts, list-changed, form-mode
elicitation, MCP-capable официальный catalog, publisher signing и private
marketplace реализованы. Зафиксированный порядок P3 не менялся.

## Remote OAuth trust boundary

- OAuth metadata в registry содержит только `clientRegistrationId`, scopes и
  redirect mode. Tokens, client secrets, PKCE verifier, state и discovery
  cache в registry запрещены.
- Persisted OAuth session хранится отдельно в
  `mcp-oauth-sessions.json` через strict Electron `safeStorage`.
- Renderer/Karton получает только `configured` и
  `authorizationPending`; token values, authorization code и verifier туда не
  передаются.
- MCP utility process использует узкий typed RPC к Electron main для
  load/save/invalidate операций. Main валидирует данные перед encrypted
  persistence и перед открытием user agent.
- Встроенная регистрация `clodex-dynamic` использует собственную metadata
  Clodex и RFC 7591 dynamic client registration. Чужие client IDs и secrets не
  включаются.

## Redirect, state и PKCE

- Callback route выделен отдельно:
  `clodex-ide://mcp/oauth/callback`.
- Callback обязан точно совпасть по protocol и route.
- State генерируется через CSPRNG, хранится encrypted, имеет TTL 10 минут,
  привязан к одному server ID и потребляется один раз до token exchange.
- Повторный callback отклоняется. PKCE verifier остаётся доступен только для
  единственного token exchange и удаляется после сохранения tokens или
  invalidation.
- Authorization URL обязан использовать `response_type=code`, точный
  `redirect_uri`, matching state и PKCE `S256`.

## Network and SSRF boundary

- MCP endpoint и OAuth endpoints используют HTTPS; HTTP разрешён только для
  loopback.
- Dynamic registration по умолчанию разрешает OAuth endpoints только на origin
  MCP server. Дополнительные origins возможны только через trusted
  application registration profile.
- Discovery, authorization, registration и token endpoints проверяются против
  allowlist регистрации.
- Redirects обрабатываются как `manual` и блокируются.
- Custom MCP headers не пересылаются на отдельный OAuth origin; сохраняются
  только protocol headers `Accept`, `Content-Type` и SDK-generated
  `Authorization`.
- Protected-resource metadata URL остаётся на MCP origin, а resource indicator
  обязан совпадать с MCP origin.

## Secret handling

- OAuth values не логируются и не попадают в telemetry.
- Utility host добавляет access token, refresh token, ID token и client secret
  в redaction set до обработки SDK errors.
- OAuth responses ограничены по размеру перед persistence.
- Ошибки callback и diagnostics содержат только bounded error codes/messages,
  без query string и token payloads.

## Failure behavior

- Сервер переходит в `authorization-required`, а не маскирует OAuth redirect
  как обычный connection failure.
- Host restart сохраняет desired server config без tokens; tokens и pending
  state восстанавливаются только из main-process encrypted store.
- Disabled/removed или изменивший OAuth registration server не может принять
  старый callback; его OAuth session очищается.

## Resources and prompts boundary

- Resource URI, resource-template metadata, prompt metadata и prompt
  arguments проходят versioned typed host protocol с bounded строками и
  каталогами.
- Pagination агрегируется максимум до 5000 items и 100 pages. Повторяющийся
  cursor отклоняется, чтобы malicious server не создавал бесконечный цикл.
- `resources/read` и `prompts/get` ограничены 4 MiB до передачи результата из
  utility process в main process. Agent toolbox повторно применяет общий
  output cap.
- User/imported MCP resource read и prompt resolution требуют human approval.
  Builtin и signed marketplace plugin используют существующую trust/policy
  границу и не получают redundant approval.
- Prompt arguments уходят только выбранному MCP server. Они не сохраняются в
  registry, diagnostics или telemetry.
- Resource content и resolved prompt messages не попадают в Settings state:
  Settings показывает только bounded catalog metadata, а read/get вызываются
  отдельными procedures.

## List-changed boundary

- Host принимает notifications только если server объявил соответствующую
  MCP capability.
- SDK auto-refresh отключён: host самостоятельно перечитывает весь
  paginated catalog с общими item/page limits, а не доверяет только первой
  странице SDK callback.
- Typed `list-changed` message содержит ровно один payload, соответствующий
  `tools`, `resources` или `prompts`; ambiguous payload отклоняется.
- Main process обновляет bounded cache и увеличивает `catalogRevision`.
  Resource notification также инвалидирует resource-template cache, потому
  MCP не имеет отдельной template list-changed notification.
- Ошибка refresh не уничтожает последнее корректное состояние: она попадает
  только в sanitized bounded diagnostics.

## Elicitation boundary

- Client capability рекламирует только `elicitation.form`. URL-mode не
  рекламируется и всегда получает `action: cancel`, пока не появится отдельный
  безопасный external-navigation flow.
- Elicitation разрешена только во время agent-originated MCP tool call.
  Внутренний `agentInstanceId` передаётся utility host, но не раскрывается MCP
  server.
- Если у одного server одновременно активны вызовы разных agents, host не
  пытается угадать владельца формы и возвращает `action: cancel` без открытия
  UI.
- Main process показывает display name конкретного MCP server и явное
  предупреждение, что введённые значения будут отправлены этому server.
- Server-provided message, labels и descriptions проходят bounded typed
  protocol и markdown escaping до отображения.
- Form ограничена 10 полями, 50 options на поле, bounded labels/descriptions и
  bounded answer values. Противоречивые min/max, defaults вне диапазона,
  неизвестные required IDs, duplicate field IDs и duplicate option values
  отклоняются.
- Select/multi-select не разрешают произвольный `Other`; пользователь может
  отправить только значения, объявленные server schema.
- Accept возвращает content только после явной отправки формы. Явное
  пользовательское закрытие маппится на `decline`; agent stop, timeout,
  host/main teardown и protocol cancellation маппятся на `cancel`.
- Pending form не сохраняется на диск, не попадает в telemetry и очищается при
  любом abort. Cancel исходного tool request явно закрывает все связанные
  pending elicitation RPC до отмены SDK tool call.

## Official catalog boundary

- Catalog доступен только из Ed25519-signed official index с встроенным
  trusted public key. Неизвестный key ID, invalid signature, expired payload,
  duplicate plugin ID или schema mismatch закрывают catalog fail-closed.
- Signed plugin manifest заранее раскрывает каждую MCP integration:
  server ID/display name, transport, endpoint и coarse authentication mode.
  Renderer показывает эти значения до install.
- Package `mcp/servers.json` повторно парсится при install и на каждом startup.
  Фактические declarations обязаны byte-semantically совпасть с signed MCP
  summary; скрытый или подменённый endpoint отклоняется.
- MCP summary без permission `mcp`, permission `mcp` без summary, duplicate
  summary IDs и stdio declarations отклоняются.
- Install MCP plugin требует отдельного user confirmation с destination
  origins и authentication modes.
- Installation не включает network capability автоматически. Все plugin MCP
  servers регистрируются disabled и требуют отдельного enable в MCP Settings.
- Signed publisher policy не может выдать auto-allow: plugin tool policy
  нормализуется максимум до `ask`, а explicit deny сохраняется.
- Integrity lockfile, staged activation, rollback и startup quarantine
  применяются к MCP packages так же, как к остальным official plugins.

## Publisher signing boundary

- Official index signature и publisher signature являются двумя разными
  trust layers: Clodex утверждает catalog snapshot, publisher отдельно
  подписывает canonical attestation своего manifest, package source и SHA-256.
- Publisher identity использует стабильный `publisherId`; display name в
  manifest обязан совпасть с publisher registry entry из official index.
- Publisher public keys поставляются только внутри Clodex-signed index.
  Duplicate key IDs, missing keys, identity mismatch, invalid signature и
  revoked key закрывают весь snapshot fail-closed.
- Rotation выполняется добавлением нового active key в signed registry до
  перевода старого key в revoked. Package provenance сохраняет publisher key
  ID и signature в integrity lockfile.
- Signing CLI читает private key только из отдельного regular file. На POSIX
  key с group/other permissions или symlink отклоняется. Private key,
  signature input и package content не логируются.
- CLI самостоятельно проверяет созданную signature соответствующим public key
  до выдачи результата.
- Legacy official entries без `publisherId` остаются catalog-signed, но UI не
  маркирует их как publisher-signed. Новая publisher-identified entry без
  signature schema validation не проходит.

## Private marketplace boundary

- Registry private sources хранится только через strict Electron `safeStorage`.
  Persisted state, возвращаемый renderer через Karton, содержит URL, key ID и
  SHA-256 SPKI fingerprint, но не возвращает сохранённый PEM public key.
  Plaintext fallback и TOFU запрещены.
- Source URL обязан быть HTTPS без username/password, query и fragment.
  Redirects блокируются, fetch ограничен 20 секундами и 4 MiB по
  `Content-Length` и фактически прочитанным decompressed bytes.
- Каждый source требует явно заданные Ed25519 key ID и PEM public key.
  Envelope key ID обязан точно совпасть с pin; payload и signature принимаются
  только в canonical base64 и проверяются по exact decoded payload bytes.
- Expired index, generation/expiration inversion, schema mismatch, duplicate
  plugin ID, invalid publisher signature и non-HTTPS package source закрывают
  конкретный source fail-closed. Verified index остаётся только в памяти и
  после restart должен быть загружен и проверен заново.
- Private marketplace credentials и auth headers в первом безопасном срезе не
  поддерживаются. Tokens запрещены в URL и source config, пока не появится
  отдельный origin-bound credential type.
- Integrity lockfile сохраняет source ID, pinned key ID и SHA-256 SPKI
  fingerprint. Install/update/uninstall разрешены только из того же source
  provenance; plugin с совпавшим ID из official или другого private source не
  может незаметно заменить установленный package.
- URL или signing key source нельзя менять, а source нельзя удалять, пока из
  него установлены plugins. Это не позволяет перепривязать существующий
  lockfile provenance к новому trust root.
- Private MCP plugins проходят тот же signed manifest/package comparison,
  staged activation, rollback, startup integrity quarantine и explicit MCP
  destination confirmation, что official plugins. Их MCP servers также
  остаются disabled до отдельного enable в MCP Settings.

## Verification

Remote OAuth block не считается завершённым без:

```bash
pnpm -F @clodex/mcp-runtime test
pnpm -F clodex exec vitest run \
  src/backend/services/mcp/oauth.test.ts \
  src/backend/services/mcp/index.test.ts \
  src/backend/mcp-host/network.test.ts \
  src/backend/mcp-host/supervisor.test.ts \
  src/backend/services/mcp/settings.test.ts
pnpm -F clodex smoke:mcp-host
pnpm -F clodex typecheck
```

Resources/prompts и list-changed дополнительно требуют:

```bash
pnpm -F clodex exec vitest run \
  src/backend/mcp-host/context-limits.test.ts \
  src/backend/mcp-host/supervisor.test.ts \
  src/backend/services/mcp/index.test.ts \
  src/backend/services/mcp/settings.test.ts \
  src/backend/services/mcp/tools.test.ts
pnpm -F clodex test
```

Form-mode elicitation дополнительно требует:

```bash
pnpm -F @clodex/mcp-runtime test
pnpm -F clodex exec vitest run \
  src/backend/mcp-host/supervisor.test.ts \
  src/backend/services/mcp/index.test.ts \
  src/backend/services/mcp/tools.test.ts \
  src/backend/services/toolbox/tools/user-interaction/ask-user-questions.test.ts \
  src/backend/services/toolbox/tools/user-interaction/mcp-elicitation.test.ts
pnpm -F clodex smoke:mcp-host
pnpm -F clodex typecheck
pnpm -F clodex test
```

Official catalog дополнительно требует:

```bash
pnpm -F clodex exec vitest run \
  src/backend/services/plugin-marketplace/index.test.ts \
  src/backend/services/mcp/plugin-bridge.test.ts
pnpm -F clodex typecheck
pnpm -F clodex test
```

Publisher signing дополнительно требует:

```bash
pnpm -F clodex exec vitest run \
  src/backend/services/plugin-marketplace/index.test.ts \
  src/backend/services/plugin-marketplace/publisher-signing.test.ts
pnpm -F clodex sign:publisher-attestation -- \
  --entry <entry.json> \
  --private-key <publisher-private.pem> \
  --public-key <publisher-public.pem> \
  --key-id <publisher-key-id> \
  --out <publisher-signature.json>
```
