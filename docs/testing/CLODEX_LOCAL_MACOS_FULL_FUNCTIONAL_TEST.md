# Полное локальное функциональное тестирование CLODEx на macOS

Статус документа: 16 июля 2026 года.

Этот чек-лист предназначен для локальной проверки unsigned-сборки CLODEx IDE
на Apple Silicon. Он не заменяет release acceptance, signing, notarization,
canary или независимый security-аудит.

## 1. Правила и границы проверки

1. Использовать только новую сборку с fail-closed исправлением авторизации —
   `1.16.0-authlocal4` или новее. Сборка `1.16.0-authlocal3` использовала
   callback без подтверждённых `state` и PKCE и не подходит для проверки
   account auth.
2. Не использовать реальные секреты в тестовом workspace, MCP fixture,
   командах, скриншотах или отчётах. Для adversarial-сценариев применять только
   явно фиктивные значения.
3. Каждый ручной прогон запускать с отдельным профилем внутри `$TMPDIR`.
4. Не запускать Browser packaging, Agent Core build или packaged acceptance
   параллельно в одном worktree.
5. Не считать успешные unit-тесты доказательством production signing,
   notarization, реального provider routing или безопасности серверного auth.

## 2. Предусловия

- macOS arm64;
- Node.js `22.23.1` для детерминированной упаковки;
- pnpm `10.30.3`;
- установленный Xcode Command Line Tools;
- разблокированный login Keychain;
- новая изолированная сборка установлена как
  `/Applications/clodex-dev-local-authlocal4.app`;
- для chat/tool E2E настроен отдельный тестовый BYOK либо локальный
  OpenAI-compatible provider с tool calling.

Проверить среду и идентичность приложения:

```bash
: "${REPO_ROOT:?Set REPO_ROOT to the absolute CLODEx repository path}"
cd "$REPO_ROOT"

export PATH="$HOME/.local/node-v22.23.1-darwin-arm64/bin:$PATH"
hash -r

node --version
pnpm --version
test "$(node --version)" = "v22.23.1"
test "$(pnpm --version)" = "10.30.3"

APP=/Applications/clodex-dev-local-authlocal4.app
EXE="$APP/Contents/MacOS/clodex-dev-local-authlocal4"

plutil -extract CFBundleShortVersionString raw -o - \
  "$APP/Contents/Info.plist"
plutil -extract CFBundleIdentifier raw -o - \
  "$APP/Contents/Info.plist"
test -x "$EXE"
lipo -archs "$EXE"
```

Ожидания:

- версия — `1.16.0-authlocal4` или новее;
- bundle ID — `xyz.clodex.agentic-ide.dev.local.authlocal4`;
- executable существует, имеет архитектуру `arm64` и запускается.

Unsigned-сборку открывать через Finder командой **Open**. Не отключать
Gatekeeper глобально.

### 2.1 Сборка изолированного authlocal4

```bash
: "${REPO_ROOT:?Set REPO_ROOT to the absolute CLODEx repository path}"
cd "$REPO_ROOT"

export PATH="$HOME/.local/node-v22.23.1-darwin-arm64/bin:$PATH"
hash -r
test "$(node --version)" = "v22.23.1"

env -u CI \
  RELEASE_CHANNEL=dev \
  CLODEX_DISTRIBUTION_MODE=official \
  CLODEX_ALLOW_UNSIGNED_LOCAL_BUILD=true \
  CLODEX_LOCAL_BUILD_ID=authlocal4 \
  CLODEX_AUTH_CALLBACK_SCHEME=clodex-authlocal4 \
  APP_VERSION_OVERRIDE=1.16.0-authlocal4 \
  npm_config_arch=arm64 \
  pnpm --dir apps/browser make
```

Pass criteria:

- имя приложения содержит `clodex-dev-local-authlocal4`;
- bundle ID равен `xyz.clodex.agentic-ide.dev.local.authlocal4`;
- userData не совпадает с `$HOME/Library/Application Support/clodex-dev`;
- auth callback scheme равен только `clodex-authlocal4` для account callback;
- сборка не читает session/token из authlocal1/2/3.

## 3. Изолированный профиль и тестовый workspace

Создать owner-only каталог:

```bash
TEST_ROOT="$(mktemp -d "${TMPDIR%/}/clodex-full-test.XXXXXX")"
chmod 700 "$TEST_ROOT"

PROFILE="$TEST_ROOT/profile"
WORKSPACE="$TEST_ROOT/workspace"
EVIDENCE="$TEST_ROOT/evidence"

mkdir -p "$PROFILE" "$WORKSPACE" "$EVIDENCE"
chmod 700 "$PROFILE" "$EVIDENCE"

git -C "$WORKSPACE" init
git -C "$WORKSPACE" config user.name "CLODEx Test"
git -C "$WORKSPACE" config user.email "clodex-test@example.invalid"

printf '# CLODEx functional test\n' > "$WORKSPACE/README.md"
printf 'export const value = 1;\n' > "$WORKSPACE/example.ts"
printf 'CLODEX_FAKE_SECRET_DO_NOT_USE=test-only-marker\n' \
  > "$WORKSPACE/.env"

git -C "$WORKSPACE" add README.md example.ts
git -C "$WORKSPACE" commit -m "test: seed functional workspace"
```

Запустить приложение:

```bash
open -na "$APP" --args \
  --user-data-dir="$PROFILE" \
  --disable-gpu
```

После завершения всего прогона сначала полностью закрыть CLODEx, затем удалить
тестовые данные:

```bash
rm -rf "$TEST_ROOT"
```

## 4. P0 — обязательные автоматические проверки

### 4.1 Auth, keys, models и reasoning

```bash
: "${REPO_ROOT:?Set REPO_ROOT to the absolute CLODEx repository path}"
cd "$REPO_ROOT"

pnpm --dir apps/browser exec vitest run \
  src/backend/services/auth/legacy-browser-handoff-disabled.test.ts \
  src/backend/services/auth/index.test.ts \
  src/backend/services/auth/token-expiry.test.ts \
  src/backend/startup/url-routing.test.ts \
  src/shared/provider-auth.test.ts \
  src/shared/available-models.test.ts \
  src/shared/model-thinking-capabilities.test.ts \
  src/shared/model-effort-routing.test.ts \
  src/shared/hotkeys.test.ts \
  src/ui/utils/model-thinking.test.ts \
  src/ui/screens/main/agent-chat/chat/_components/model-select-thinking.test.ts \
  src/backend/agents/model-provider.test.ts \
  src/backend/agents/clodex-provider.test.ts \
  src/backend/services/agent-manager/agent-manager.test.ts \
  src/backend/services/swarm-runtime/index.test.ts \
  src/backend/agent-host/execution-target-router.test.ts
```

Pass criteria:

- все тесты завершились с кодом `0`;
- legacy callback не обменивает `code` или bearer token;
- старая unbound-сессия очищается;
- browser login не запускается до готовности state-bound PKCE;
- Sol и Terra сериализуют `Max` как provider effort `max`, а `Ultra` — как
  provider effort `max` плюс standard Swarm orchestration;
- provider payload не содержит `reasoning.enabled`.

### 4.2 Chat, tools, browser, MCP и Guardian

```bash
pnpm --dir apps/browser exec vitest run \
  src/backend/agents/chat/chat.test.ts \
  src/backend/services/agent-manager/agent-manager.test.ts \
  src/backend/agent-host/browser-agent-step-executor.test.ts \
  src/backend/services/network-policy/controlled-browser.test.ts \
  src/backend/services/network-policy/index.test.ts \
  src/backend/services/network-policy/control-center.test.ts \
  src/backend/services/mcp/index.test.ts \
  src/backend/services/mcp/tools.test.ts \
  src/backend/services/mcp/approval-broker.test.ts \
  src/backend/services/mcp/trusted-dispatch-gateway.test.ts \
  src/backend/mcp-host/runtime-sandbox.test.ts \
  src/backend/services/guardian/index.test.ts \
  src/backend/services/guardian/audit.test.ts \
  src/backend/services/guardian/shell-capability-broker.test.ts \
  src/backend/services/session-continuity/index.test.ts \
  src/backend/services/agent-runtime-recovery.test.ts
```

### 4.3 Security/runtime packages

```bash
pnpm -F @clodex/agent-core test
pnpm -F @clodex/agent-shell test
pnpm -F @clodex/mcp-runtime test
pnpm -F @clodex/guardian test
pnpm -F @clodex/approval test
pnpm -F @clodex/kernel test
```

### 4.4 Полный repository gate

Команды выполнять последовательно:

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm check
pnpm check:governance
pnpm security:secrets
pnpm security:dependencies
```

Pass criteria:

- каждая команда возвращает код `0`;
- нет пропущенных workspace tasks;
- нет новых Biome errors;
- secret scan не обнаруживает credentials;
- boundary и provenance gates остаются закрытыми;
- production feature gates не включаются тестовым прогоном.

## 5. P0 — packaged smoke и acceptance

### 5.1 Startup smoke

```bash
SMOKE_PROFILE="$(mktemp -d "${TMPDIR%/}/clodex-smoke.XXXXXX")"

"$EXE" \
  --user-data-dir="$SMOKE_PROFILE" \
  --disable-gpu \
  --smoke-test

rm -rf "$SMOKE_PROFILE"
```

Pass criteria:

- exit code `0`;
- присутствует marker
  `[smoke-test] App ready — all modules loaded successfully.`;
- нет `ERR_MODULE_NOT_FOUND`, uncaught exception или startup crash.

### 5.2 MCP packaged acceptance

```bash
pnpm --dir apps/browser acceptance:mcp-packaged -- \
  --app="$APP" \
  --output="$EVIDENCE/mcp-packaged.json"
```

Pass criteria: локальный non-secret `health_check` fixture подключён, tool
возвращает `ok`, отчёт имеет status `passed`, профиль удалён harness-ом.

### 5.3 Terminal packaged acceptance

```bash
node --import tsx scripts/release/terminal-acceptance.ts \
  --packaged-app="$APP" \
  --output="$EVIDENCE/terminal.json"
```

Pass criteria: UI создаёт терминал, выполняется только harmless marker-команда,
PTY завершается с кодом `0`, terminal tab удаляется, отчёт не содержит команд,
output, environment values или profile paths.

### 5.4 Session recovery acceptance

```bash
pnpm --dir apps/browser smoke:session-recovery -- \
  --executable="$EXE" \
  --output="$EVIDENCE/session-recovery.json"
```

Pass criteria:

- seed и verify phases завершаются с кодом `0`;
- присутствует `Tail-flush complete` с `0 failed`;
- task state переживает restart;
- нет повторного исполнения side effects или pending approvals.

## 6. P0 — ручная функциональная матрица

### 6.1 Auth fail-closed

1. Открыть **Settings → Account** на чистом профиле.
2. Убедиться, что UI явно сообщает о временно отключённом browser sign-in до
   внедрения `state` и PKCE S256.
3. Нажать или попытаться активировать вход через CLODEx.xyz.
4. Убедиться, что системный браузер не открылся и login attempt не начался.
5. Проверить `CFBundleURLTypes` в `Info.plist`: account callback должен
   использовать только изолированную схему `clodex-authlocal4`.
6. При запущенном приложении выполнить оба fake callback:

   ```bash
   open 'clodex-authlocal4://auth/callback?code=fake-code&state=fake-state'
   open 'clodex-authlocal4://auth/callback?token=fake-bearer-token'
   ```

7. Отдельно открыть разрешённые ссылки регистрации и главной страницы.
8. Вернуться в IDE и перезапустить приложение.

Pass criteria:

- пользователь остаётся `Signed out`;
- fake callback не создаёт session, key, model token или account profile;
- callback не открывается как web content;
- ссылки регистрации/главной страницы могут открыть браузер, но не создают
  IDE-сессию;
- в UI нет утверждения, что legacy callback безопасен;
- сохранённая authlocal3-сессия не восстанавливается;
- BYOK и local mode продолжают работать без managed account.

Live CLODEx account models нельзя отмечать как проверенные без отдельно
выданного тестового account key и готового server-side state + PKCE flow.

Telegram — отдельный внешний flow и не доказывает безопасность browser
handoff. Его проверять только отдельным тестовым аккаунтом и не включать в
browser-auth sign-off.

### 6.2 Provider keys и список моделей

1. Открыть **Settings → Models & Providers**.
2. Добавить отдельный тестовый BYOK либо local OpenAI-compatible endpoint.
3. Сохранить профиль и обновить каталог моделей.
4. Выбрать модель в composer через `Command+/`.
5. Перезапустить IDE с тем же isolated profile.
6. Заменить key на заведомо невалидное тестовое значение и повторить запрос.
7. Удалить provider profile.

Pass criteria:

- валидный provider показывает только доступные ему модели;
- key не отображается открытым текстом и не попадает в логи;
- Refresh обновляет models без orphan-профилей;
- invalid/revoked key приводит к bounded error, а не silent fallback;
- после удаления профиля его модели нельзя выбрать;
- account keys/models не подменяются relay credential.

### 6.3 GPT-5.6 SOL, GPT-5.6 Terra, Max и Ultra

Семантика для exact model IDs:

| Route/profile                   | Порядок режимов                                          |
| ------------------------------- | -------------------------------------------------------- |
| CLODEx Sol/Terra                | Minimal → Low → Medium → High → Extra high → Max → Ultra |
| OpenAI Responses Sol/Terra      | Off → Low → Medium → High → Extra high → Max → Ultra     |
| OpenAI Chat Completions         | Low → Medium → High                                      |
| Ollama/OpenRouter/compatible    | Только не редактируемый `Reasoning`                      |

Проверка:

1. Выбрать Sol, затем Terra через `Command+/`.
2. Использовать `Command+Option+/` для полного цикла reasoning effort.
3. Отдельно выбрать `Max` для каждой модели и отправить локальный turn.
4. Выбрать `Ultra`, отправить turn из основного composer и проверить видимый
   автоматический Deep Think/Swarm indicator.
5. При активном Ultra вручную включить Battle Agent и отправить ещё один turn.
6. Повторить Ultra из Quick Task (`Command+Shift+N`) и через `/implement`.
7. Во время отдельного Ultra-run нажать **Stop** и убедиться, что workflow не
   продолжает model/tool side effects после abort.
8. Отправить Ultra-turn с image/file attachment либо mentions/pathReferences:
   IDE должна сохранить контекст и безопасно выполнить обычный Max turn, а не
   запускать text-only automatic Swarm.
9. Если настроен cloud execution, повторить Ultra и Ultra + Battle с
   `executionTarget=cloud`; без credentials отметить сценарий `blocked`.
10. Создать два provider-qualified profile с одинаковым raw ID
   `gpt-5.6-sol` (например, два direct OpenAI Responses profile), назначить
   разные effort, сбросить один профиль и проверить второй.
11. Проверить OpenAI Responses, OpenAI Chat и generic profile. Для generic
   profile повторить проверку и с пустым discovered-model catalog.
12. Создать новую задачу, переключиться между задачами и перезапустить IDE.
13. Проверить provider-level unit test либо sanitized test proxy.

Pass criteria:

- labels и порядок совпадают с таблицей;
- `Max` сохраняется как override `max`, передаёт provider effort `max`, не
  запускает Swarm автоматически и не показывает Ultra-indicator;
- `Ultra` сохраняется как override `ultra`, передаёт provider effort `max` и
  запускает ровно один standard Swarm для каждого локального user turn;
- user turn сначала проходит штатный BaseAgent lifecycle: approval
  invalidation, evidence, durable history и busy-agent queue не обходятся;
- tooltip содержит `Ultra active: Max reasoning with automatic standard
  Swarm`;
- ручной Battle выше Ultra и создаёт ровно один `battle` run, без параллельного
  standard run;
- ручной standard Deep Think не подавляет Ultra: сохраняются converted context
  и forced standard Swarm; только Battle меняет variant;
- Stop отменяет admitted Swarm и не оставляет post-stop assistant/failure
  continuation;
- automatic Ultra не отбрасывает unsupported attachments/mentions/context:
  такой turn безопасно остаётся обычным Max turn;
- previous multimodal context, current request больше 16k или отсутствие
  workspace mount также приводят к обычному Max turn, а не к урезанному Swarm;
- multi-turn context, rendered env-state и resolved `/implement` body берутся
  из bounded post-conversion model context; private reasoning не копируется;
- даже при low-complexity triage Ultra выполняет реальный deterministic Swarm,
  а не возвращает status-only сообщение;
- local Ultra проходит внешний ExecutionTargetRouter и оставляет terminal
  execution-task/audit record;
- CLODEx payload никогда не содержит literal `reasoning.effort = "ultra"`;
- payload не содержит `reasoning.enabled`;
- namespaced ID вида `provider/gpt-5.6-sol` распознаётся по bare model ID;
- выбор сохраняется между задачами и после restart;
- direct OpenAI route поддерживает provider-native `Max`, но никогда не
  получает literal `ultra`; Ultra остаётся IDE orchestration поверх Max;
- provider-qualified профили хранят override раздельно, например
  `openai-main:gpt-5.6-sol` и `openai-lab:gpt-5.6-sol`;
- reset qualified-профиля сохраняет пустой `{}` tombstone и не возвращает
  legacy raw override;
- Quick Task и `/implement` соблюдают Ultra так же, как основной composer;
- cloud-handoff не перехватывается локальным Ultra/Swarm;
- UI явно показывает автоматический Ultra/Swarm до отправки сообщения;
- generic Ollama/OpenRouter/openai-compatible profile показывает только
  не редактируемый `Reasoning`, без `Edit`, Max/Ultra и OpenAI providerOptions;
- CLODEx profile с model metadata `provider=openai-compatible` продолжает
  поддерживать Max/Ultra;
- Luna не получает Max/Ultra;
- другие GPT-модели не получают `Max`/`Ultra` по нестрогому совпадению имени.

Для прямого Anthropic route Opus 4.7/4.8 имеет собственную модельную семантику
`Low → Medium → High → Extra high → Max`. Это не означает, что Anthropic API
поддерживает CLODEx-specific `Ultra`. В CLODEx route provider-native и gateway
presets не должны смешиваться.

### 6.4 Chat и task lifecycle

1. Подключить `$WORKSPACE`.
2. Создать новую задачу и отправить короткое сообщение.
3. Проверить streaming reasoning/text, затем остановить длинный ответ.
4. Отправить follow-up во время активного ответа.
5. Добавить файл attachment и упоминание workspace-файла.
6. Установить task goal, затем изменить его.
7. Fork task из последнего сообщения.
8. Archive и restore задачу.
9. Перезапустить IDE.

Pass criteria:

- один user message создаёт один model turn;
- Stop прекращает stream без зависшего статуса;
- follow-up выполняется после текущего turn и не теряется;
- attachment доступен только текущей задаче;
- goal, lineage, выбранная модель и chat history сохраняются;
- после restart нет duplicate assistant response или повторного tool call;
- provider error показывается bounded-сообщением без response body и key.

### 6.5 Terminal, shell tools и diff review

В IDE выполнить:

```bash
printf 'CLODEX_TERMINAL_OK\n'
pwd
git status --short
```

Затем попросить агента изменить `example.ts`, открыть diff review, сначала
отклонить изменение, затем повторить и принять.

Для cancellation использовать harmless-команду:

```bash
sleep 30
```

Pass criteria:

- terminal tab открывается и закрывается без orphan PTY;
- cancellation завершает процесс и UI возвращается в idle;
- рабочая директория соответствует выбранному workspace;
- denied shell action не выполняется;
- approval once выполняет side effect ровно один раз;
- reject восстанавливает исходный файл;
- accept фиксирует ожидаемый diff без лишних файлов;
- output и environment проходят bounded/redaction правила.

### 6.6 Controlled browser и egress

Запустить локальный fixture:

```bash
WEB_ROOT="$TEST_ROOT/web"
mkdir -p "$WEB_ROOT"
printf '<h1 data-clodex-test="ok">CLODEx local fixture</h1>\n' \
  > "$WEB_ROOT/index.html"

python3 -m http.server 8765 \
  --bind 127.0.0.1 \
  --directory "$WEB_ROOT" \
  >"$EVIDENCE/http-fixture.log" 2>&1 &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null || true' EXIT
```

1. Открыть browser tab в CLODEx.
2. Перейти на `http://127.0.0.1:8765/` без заранее созданного broad grant.
3. При запросе разрешения сначала выбрать **Deny**.
4. Убедиться по access log fixture, что запрос не дошёл.
5. Повторить и выдать exact destination grant для `127.0.0.1:8765`.
6. Проверить navigation, Back, Forward, Reload и screenshot/context capture.
7. Отозвать grant и повторить navigation.
8. Завершить fixture: `kill "$SERVER_PID"; wait "$SERVER_PID" 2>/dev/null ||
   true; trap - EXIT`.

Pass criteria:

- deny происходит до сетевого side effect;
- exact grant разрешает только выбранные protocol, host и port;
- после revoke запрос снова блокируется;
- private/loopback destination не получает broad bypass;
- browser error не раскрывает внутреннюю policy или response body;
- sanitized audit содержит решение и reason code без пользовательского content.

### 6.7 MCP

Для ручной проверки добавить stdio server в **Settings → MCP**:

```text
Command: node
Arguments:
$REPO_ROOT/apps/browser/scripts/fixtures/mcp-acceptance-fixture.mjs
```

Перед вставкой аргумента заменить `$REPO_ROOT` на абсолютный путь из
`printf '%s\n' "$REPO_ROOT"`: поле аргументов MCP не обязано раскрывать переменные
окружения shell.

1. Подключить server.
2. Убедиться, что появился read-only tool `health_check`.
3. Вызвать его из chat и получить `ok`.
4. Отключить и снова подключить server.
5. Перезапустить IDE.
6. Добавить конфигурацию с несуществующим executable и проверить ошибку.

Pass criteria:

- tool catalog относится к правильному server identity;
- read-only fixture не требует effect approval;
- effectful MCP tools не обходят approval broker;
- disconnect/cancel не оставляет зависших requests;
- invalid server не роняет IDE и не запускает shell fallback;
- после restart нет replay предыдущего tool call;
- stdout используется только как MCP transport, stderr bounded и sanitized.

### 6.8 Guardian и approvals

1. Установить режим **Always ask**.
2. Попросить агента прочитать `.env` с фиктивным marker.
3. Отказать в разрешении.
4. Попросить создать файл вне `$WORKSPACE`, например
   `/tmp/clodex-guardian-denied`.
5. Отказать, затем проверить отсутствие файла:

   ```bash
   test ! -e /tmp/clodex-guardian-denied
   ```

6. Разрешить один безопасный write внутри workspace.
7. Повторно отправить тот же tool request.

Pass criteria:

- защищённый content не попадает в model output до authorization;
- denial сохраняется proactively и не выполняет effect;
- approval привязан к конкретным object, arguments и lifecycle attempt;
- approval once нельзя переиспользовать для второго effect;
- stale/replayed approval отклоняется;
- receipt/audit не содержит fake secret, raw prompt или file content;
- Guardian failure приводит к deny, а не allow.

### 6.9 Git и файлы

1. Проверить file tree, content search и file preview.
2. Изменить `README.md` через editor и через agent tool.
3. Проверить pending edits и line-numbered diff.
4. Создать тестовую ветку:

   ```bash
   git -C "$WORKSPACE" switch -c clodex-functional-test
   ```

5. Выполнить commit только ожидаемых файлов.
6. Создать и удалить временный worktree внутри `$TEST_ROOT`.

Pass criteria:

- gitignored/protected файлы не добавляются автоматически;
- diff соответствует byte-level содержимому файлов;
- branch и commit выполняются только после требуемого approval;
- repository root и worktree identity не смешиваются;
- удаление task не удаляет Git workspace;
- никаких файлов вне `$TEST_ROOT` не меняется.

### 6.10 Persistence и restart

Перед restart сохранить в задаче:

- chat history;
- task goal;
- выбранную модель;
- reasoning effort;
- accepted edit;
- открытый workspace;
- один завершённый denial и один завершённый approval.

Полностью закрыть приложение, убедиться, что процесс завершён, затем снова
запустить с тем же `$PROFILE`.

Pass criteria:

- принятые состояния восстановлены;
- pending approval не исполняется автоматически;
- completed denial/approval не превращается в новую authority;
- незавершённый model stream помечен завершённым/прерванным корректно;
- нет duplicate task, message, receipt или side effect;
- приложение корректно закрывается после повторного запуска.

## 7. P1 — расширенные проверки

### 7.1 Host runtimes и visual regression

```bash
pnpm --dir apps/browser smoke:mcp-host
pnpm --dir apps/browser smoke:agent-host
pnpm --dir apps/browser smoke:agent-host:fault

pnpm --dir apps/browser visual:build
pnpm --dir apps/browser visual:test
```

### 7.2 Acceptance harness и release plumbing tests

```bash
pnpm release:acceptance:test
pnpm release:attribution:test
pnpm community:unsigned:test
pnpm release:signing:readiness:test
```

Эти команды тестируют contracts и harness. Они не доказывают наличие реальной
Apple/Azure подписи или notarization.

### 7.3 Browser egress packaged acceptance

Этот harness намеренно принимает только bundle ID каналов `nightly` или
`prerelease`. Dev app вернёт `controlled-egress-gates-unavailable`.

Для подходящей отдельной сборки:

```bash
NIGHTLY_APP=/path/to/clodex-nightly.app

pnpm --dir apps/browser smoke:browser-egress:packaged -- \
  --app="$NIGHTLY_APP" \
  --output="$EVIDENCE/browser-egress.json"
```

### 7.4 Hardware/external checks

```bash
pnpm --dir apps/browser smoke:dictation-capabilities
```

Полный dictation smoke, physical remote control, SSH runner, Docker runner и
cloud tasks требуют отдельной среды, hardware либо credentials. Их результаты
фиксируются отдельными content-free evidence reports.

## 8. Известные ограничения unsigned local build

1. Managed login через CLODEx.xyz временно отключён fail-closed. Поэтому live
   account keys, balance и managed model issuance нельзя считать проверенными.
2. `authlocal3` нельзя использовать для account-auth тестирования. Перед
   дальнейшим использованием старую сессию следует logout/revoke на стороне
   сервиса.
3. `Max` для Sol/Terra — provider reasoning effort. `Ultra` — IDE preset:
   provider `Max` плюс proactive standard Swarm для exact IDs `gpt-5.6-sol` и
   `gpt-5.6-terra`; literal `ultra` не отправляется provider API. Настройка
   qualified provider profile хранится отдельно от другого профиля с тем же
   raw model ID. Managed CLODEx account catalog сейчас использует raw model ID
   и один account-scoped override; per-profile isolation для этого raw account
   route не заявляется.
4. UI model selector требует ручного E2E: shared/backend тесты проверяют
   mapping, но не заменяют проверку клика, hotkey и persistence в packaged app.
5. Unsigned или ad-hoc signed app не проходит Developer ID, notarization,
   stapling и стабильный update-channel acceptance.
6. `release:validate:macos` без официальных credentials не должен считаться
   release sign-off, даже если source/package checks прошли.
7. Browser packaged egress harness недоступен для dev/release bundle ID и
   требует nightly/prerelease build.
8. Telegram, microphone, mobile attestation, SSH, Docker и cloud execution
   требуют отдельных доверенных внешних компонентов.
9. Успешный локальный прогон не разрешает включать production feature gates и
   не заменяет независимый аудит, CI и canary.
10. Автоматическое покрытие пока не заменяет ручную renderer-проверку disabled
    auth UI, Ultra-indicator/Battle control и lifecycle hooks для Ultra через
    direct backend dispatch/Quick Task.

## 9. Итоговый sign-off

Локальный build допускается к следующему этапу только если:

- все P0 automated команды завершились с кодом `0`;
- packaged startup, Terminal, MCP и session recovery acceptance прошли;
- все P0 manual scenarios имеют фактический pass;
- auth остаётся fail-closed;
- deny не приводит к side effect;
- Max/Ultra semantics соответствуют точным route/model правилам;
- нет утечки ключей, fake secrets, prompts или source content в evidence;
- отклонения и P1/external blockers перечислены явно, а не помечены как pass.
