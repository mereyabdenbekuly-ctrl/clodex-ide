# Clodex — полная документация проекта

## 1. Назначение

Clodex — Electron IDE с агентной архитектурой. Приложение объединяет интерфейс
разработки, AI-агентов, инструменты, локальное и удалённое выполнение,
долгосрочный контекст, расширения и security control plane.

Документ предназначен для разработчиков, технических руководителей, QA,
DevOps и инженеров поддержки.

## 2. Технологический стек

- TypeScript;
- Electron;
- React;
- Vite;
- pnpm;
- Turbo;
- Vitest;
- Playwright;
- Storybook;
- SQLite;
- Karton;
- MCP;
- Node.js utility processes;
- Docker и SSH adapters.

Для deterministic packaging используется Node.js 22.23.1 и pnpm 10.30.3.

## 3. Архитектура

~~~mermaid
flowchart TB
    USER["Пользователь"] --> UI["Electron Renderer"]
    UI <--> IPC["Karton typed IPC"]
    IPC <--> MAIN["Electron Main"]
    MAIN <--> AGENT["Agent Host"]
    MAIN <--> MCP["MCP Host"]
    MAIN <--> SANDBOX["Sandbox Workers"]
    AGENT --> CORE["Agent Core"]
    CORE --> GOALS["Task Lifecycle and Goals"]
    CORE --> MEMORY["Context Ledger"]
    CORE --> FABRIC["Model Fabric"]
    CORE --> POLICY["Zero-Trust Policy Engine"]
    POLICY --> EXEC["Local / SSH / Docker / Cloud"]
    EXEC --> RECEIPTS["Receipts and Evidence"]
    RECEIPTS --> MEMORY
~~~

Основные процессы:

| Процесс | Ответственность |
| --- | --- |
| Electron Main | окна, credentials, filesystem, Git, policy и IPC |
| Renderer | React UI, chat, settings и review |
| Agent Host | изолированное выполнение agent turn |
| MCP Host | MCP transports, OAuth и lifecycle |
| Sandbox Worker | ограниченное untrusted execution |
| CLI | headless host для Agent Core |

Backend entry point:

apps/browser/src/backend/main.ts

## 4. Репозиторий

### Applications

- apps/browser — Electron IDE;
- apps/clodex-cli — headless Agent Core host;
- apps/update-server — update delivery;
- apps/website — сайт;
- apps/deprecated-cli — legacy CLI.

### Packages

- packages/agent-core — agent runtime;
- packages/agent-shell — PTY и terminal;
- packages/mcp-runtime — MCP;
- packages/karton — typed RPC/state;
- packages/runner-sdk — custom runner contracts;
- packages/stage-ui — UI primitives;
- packages/nucleo-* — icons.

## 5. Task Lifecycle

Задача представлена agent instance и содержит:

- ID;
- agent type;
- messages;
- model;
- approval mode;
- mounts;
- goal;
- progress;
- runtime status;
- errors;
- persistent metadata.

AgentManager отвечает за creation, loading, message dispatch, mutations, fork,
archive, persistence и teardown.

Код:

packages/agent-core/src/services/agent-manager

## 6. Goals

Goal содержит описание, статус и progress. Расширенная версия поддерживает time
budget, token budget, pause/resume и предупреждения.

Правила:

- редактирование не должно случайно сбрасывать progress;
- fork определяет copy/reset semantics;
- UI использует persisted state;
- hard limit применяется только поддерживающим execution lane.

## 7. Chat Agent

Prompt собирается из:

1. intro;
2. behavioral rules;
3. environment adapters;
4. output contract;
5. authority rules.

Environment adapters предоставляют workspaces, project instructions, skills,
memory, plans, logs, diffs и shells.

Ответ разделён на commentary и final.

## 8. Context Ledger

Код:

packages/agent-core/src/services/evidence-memory

Возможности:

- append-only events;
- claims;
- provenance;
- repository revisions;
- staleness;
- contradictions;
- supersession;
- lexical retrieval;
- guarded Context Pack;
- recursive summaries;
- evaluation и dogfood.

Приоритет истины:

1. текущее состояние workspace;
2. последнее решение пользователя;
3. подтверждённый tool или test result;
4. active decision;
5. model-inferred claim;
6. историческое summary.

Short summaries создаются примерно на десятиминутных интервалах. Long summaries
рекурсивно компактируют их на шестичасовых интервалах.

## 9. Memory Notes

Memory Notes поддерживают global, workspace и agent scope, а также
list/read/search/delete.

Notes являются управляемыми записями. Context Ledger является доказательной
историей задачи.

## 10. Model Fabric

Код:

packages/agent-core/src/services/model-fabric

Model Fabric учитывает:

- intent;
- capabilities;
- context size;
- latency и quality;
- provider health;
- quotas;
- budget;
- release policy.

Поддерживаются shadow routing, active routing, fallback, circuit breaker,
usage ledger, budget events и signed managed policy.

## 11. Zero-Trust Policy Engine

Код:

apps/browser/src/backend/services/guardian

Policy получает action kind, capabilities, scope, target trust, read-only,
irreversible, user authorization и evidence codes.

Результат: approve, escalate или deny. Deterministic policy остаётся authority.
Optional model работает только в shadow mode.

## 12. Egress Control Gateway

Код:

apps/browser/src/backend/services/network-policy

Функции:

- deny-by-default;
- exact destination grants;
- protocol, host и port matching;
- private и loopback protection;
- DNS validation;
- IP-pinned sockets;
- authenticated proxy;
- controlled browser;
- MCP proxy fetch;
- audit;
- Settings UI.

## 13. Shell и Terminal

Код:

- packages/agent-shell;
- browser terminal service;
- browser toolbox.

Поддерживаются PTY sessions, commands, cancellation, tabs, logs, approval modes
и capability-bound authorization.

## 14. Agent Host

Agent Host выполняет agent turns и isolated steps вне Electron Main.

Supervisor реализует ready timeout, health, bounded restart, rejection pending
work, circuit breaker и pre-dispatch fallback.

Side effect не replay-ится автоматически после crash.

## 15. MCP

Состав:

- browser MCP service;
- MCP Host;
- packages/mcp-runtime.

Поддерживаются stdio, HTTP, OAuth, tools, resources, templates, prompts,
elicitation, cancellation, timeout и reconnect.

## 16. Files, Git и Diff

Функции:

- paginated file tree;
- file preview;
- protected reads;
- Git status и branches;
- commits;
- pending edits;
- diff history;
- accept/reject;
- worktrees.

## 17. Browser Runtime

Поддерживаются tabs, navigation, history, downloads, permissions, screenshots,
selected-element context, automation policies и managed egress.

Основной код:

apps/browser/src/backend/services/window-layout

## 18. Execution

### Local

Agent Shell и local workspace.

### SSH

Saved profiles, revision verification, materialization, workspace cache,
artifacts, receipts и cleanup.

### Docker

Digest-pinned image, resource limits, network policy, snapshot archive,
artifacts и receipt verification.

### Cloud

Bounded request, snapshot, residency, scoped secrets, resume, cancellation,
usage и SLO evidence.

## 19. Runner SDK

packages/runner-sdk позволяет подключать custom providers.

Runner объявляет identity, version, command classes, environment, cancellation,
artifacts, leases, receipts и security capabilities.

## 20. Session Continuity

Функции:

- workspace snapshots;
- Git revision;
- dirty patch identity;
- environment fingerprint;
- checkpoints;
- suspend/resume;
- resumable artifacts;
- lease, epoch и fencing;
- atomic memory sync;
- teleport controls.

## 21. Generated Apps

Generated App Library поддерживает discovery, metadata validation, preview,
launch, regeneration, safe delete, package import и trust.

Source приложения принадлежит owner task.

## 22. Artifact Bridge

Generated app является untrusted principal.

Bridge предоставляет explicit capabilities:

- read resource;
- MCP call;
- bounded model question;
- prepare sensitive operation;
- approve;
- one-time commit;
- automation;
- lifecycle subscription.

Приложение не получает credentials, filesystem paths или unrestricted IPC.

## 23. Package Trust

Проверяются schema, path containment, package identity, publisher identity,
signature, key fingerprint, revocation, capabilities, replay и import limits.

Ошибка trust блокирует выполнение.

## 24. Plugins и Skills

Skills поддерживают global/workspace scope, metadata и enable state.

Plugins поддерживают catalog, private sources, integrity, staged install,
update, rollback, capability review и credential mapping.

## 25. Automations

Поддерживаются one-time, interval и cron schedules, retry, missed-run policy и
local/cloud execution.

## 26. Pull Request Review

Поддерживаются PR detection, metadata, checks, commits, files, patches, inline
comments, approve/request changes и protected merge.

## 27. Quick Task и Command Center

Quick Task предоставляет native window, global shortcut, workspace selection и
task creation.

Command Center объединяет commands, tasks, projects, files, settings и actions.

## 28. Dictation и Remote Control

Dictation поддерживает push-to-talk, batch transcription и optional realtime
preview.

Remote control использует pairing, device-bound keys, encryption, replay
protection и attestation.

## 29. Karton

Karton синхронизирует typed state, procedures и subscriptions между backend и
renderer.

Contracts:

apps/browser/src/shared/karton-contracts/ui

## 30. Persistence

Persistence включает agent DB, chat state, attachments, caches, diff history,
Context Ledger и model usage.

Protected files используют authenticated encryption и context binding.

## 31. Telemetry

Разрешены status, enum values, counts, rates, latency, feature state и bounded
errors.

Запрещены prompts, completions, file contents, commands, credentials, cookies,
MCP payloads, audio и transcript.

## 32. Feature Gates

Definitions:

apps/browser/src/shared/feature-gates.ts

Channels:

- dev;
- nightly;
- prerelease;
- release.

Experimental capability остаётся default-off до evidence-backed promotion.

## 33. Local Development

~~~bash
pnpm install --frozen-lockfile
pnpm build:packages
pnpm --dir apps/browser start:fast
~~~

Проверки:

~~~bash
pnpm check
pnpm typecheck
pnpm test
~~~

## 34. Packaging

Local nightly:

~~~bash
RELEASE_CHANNEL=nightly +CLODEX_ALLOW_UNSIGNED_LOCAL_BUILD=true +pnpm --dir apps/browser package
~~~

Official:

~~~bash
pnpm --dir apps/browser make
~~~

Concurrent builds одного package в одном worktree запрещены.

## 35. Testing

Слои:

- Biome;
- TypeScript;
- unit и integration tests;
- utility-process smoke;
- visual regression;
- physical SSH, Docker и hardware smoke;
- ASAR и signature validation;
- release-readiness.

## 36. Readiness

Normal gate:

~~~bash
pnpm --dir apps/browser check:main-plan-readiness -- +  --channel release +  --require-clean
~~~

Strict gate:

~~~bash
pnpm --dir apps/browser check:main-plan-readiness -- +  --channel prerelease +  --require-clean +  --require-promotion all
~~~

Strict gate остаётся красным без real production evidence.

## 37. Troubleshooting

### Missing package output

~~~bash
pnpm -F @clodex/agent-runtime-node build
pnpm build:packages
~~~

### Electron missing after ignore-scripts

Выполнить normal install/postinstall и повторить тест.

### Network blocked

Проверить feature gate, proxy status, destination grant и audit reason.

### Readiness failed

Проверить per-epic blockers. Gate не обходить.

### Secret scanner blocked push

Проверить finding, ротировать реальный credential и удалить его из reachable
history при необходимости.

## 38. Правила разработки

1. Одна capability — один atomic commit.
2. Shared worktree нельзя reset или clean без координации.
3. Release validation выполняется в clean worktree.
4. Sensitive feature получает fail-closed policy.
5. External input проходит schema validation.
6. Telemetry остаётся content-free.
7. Dispatched side effect не replay-ится автоматически.
8. Private keys не попадают в repository.
9. Feature gate и promotion contract создаются до production.
10. Документация обновляется вместе с source.

## 39. Текущий статус

Реализованы основная IDE, Agent Core, память, модели, policy, egress,
local/SSH/Docker/Cloud contracts, session continuity, generated apps,
extensions и release-readiness infrastructure.

До production остаются authoritative repository, official signing, real
observations, cross-platform acceptance, canary, monitoring и rollback.

## 40. Модульная документация

- [Developer index](docs/developer/README.md)
- [Architecture](docs/developer/architecture.md)
- [Repository map](docs/developer/repository-map.md)
- [Local development](docs/developer/local-development.md)
- [Capabilities](docs/developer/capabilities.md)
- [Agent platform](docs/developer/agent-platform.md)
- [Security and data](docs/developer/security-and-data.md)
- [Extensions](docs/developer/extensions-and-integrations.md)
- [Testing and release](docs/developer/testing-and-release.md)
- [Operations](docs/developer/operations-and-troubleshooting.md)
- [Status](docs/developer/status-and-roadmap.md)

## 41. Каталог backend services

| Service | Ответственность |
| --- | --- |
| agent-core-bridge | связывает Browser host и Agent Core |
| agent-manager | UI-facing управление agent instances |
| agent-os | общая координация policy, memory и inspectors |
| artifact-bridge | capability boundary generated apps |
| auth | login, callback и account state |
| automations | scheduled tasks |
| credentials | provider и integration credentials |
| data-protection | encryption capabilities |
| docker-runner | Docker execution provider |
| file-tree | безопасное чтение и наблюдение за workspace |
| generated-app-library | generated apps lifecycle |
| git | Git operations и worktrees |
| history | task history и search |
| hosted-pull-request | GitHub PR review и merge |
| mcp | MCP settings, registry и host coordination |
| network-policy | managed egress |
| plugin-marketplace | plugin installation и private sources |
| protected-files | protected data views |
| quick-task-window | native Quick Task |
| remote-connections | SSH profiles и remote execution |
| runner-routing | provider choice и shadow evidence |
| sandbox | untrusted workload execution |
| session-continuity | snapshots, checkpoints и teleport |
| telemetry | content-free product telemetry |
| terminal | PTY sessions для UI |
| toolbox | host tool implementations |
| window-layout | Electron windows, tabs и browser views |

## 42. Data lifecycle

### Создание задачи

1. Renderer вызывает typed procedure.
2. AgentManager создаёт instance.
3. Agent database сохраняет metadata.
4. MountManager привязывает workspaces.
5. UI получает reactive state.

### User message

1. Message валидируется.
2. Сохраняется в agent state.
3. Context Ledger получает material event.
4. Agent turn отправляется в Agent Host.
5. Результат streaming обновляет state.
6. Persistence сохраняет завершённый turn.

### Tool call

1. Agent выбирает tool.
2. Host формирует capability context.
3. Policy принимает решение.
4. Tool выполняется или ожидает approval.
5. Result возвращается агенту.
6. Content-free receipt сохраняется в audit/evidence.

### Shutdown

1. Новые turns перестают приниматься.
2. Pending state flush выполняется атомарно.
3. Utility processes завершаются.
4. PTY sessions закрываются.
5. Data services выполняют teardown.

## 43. Environment variables

Основной template:

.env.example

### Product endpoints

- CLODEX_ORIGIN;
- CLODEX_LOGIN_URL;
- CLODEX_API_URL;
- CLODEX_LLM_RELAY_URL;
- CLODEX_CONSOLE_URL;
- UPDATE_SERVER_ORIGIN.

### Runtime controls

- CLODEX_DISABLE_ISOLATED_AGENT_RUNTIME;
- CLODEX_CLOUD_TASKS_KILL_SWITCH;
- CLODEX_CLOUD_TASKS_URL;
- CLODEX_CLOUD_TASKS_RESIDENCY;
- CLODEX_BROWSER_EGRESS_ALLOWED_HOSTS;
- CLODEX_DOCKER_RUNNER_IMAGE.

### Packaging

- RELEASE_CHANNEL;
- APP_VERSION_OVERRIDE;
- CLODEX_BUILD_COMMIT_SHA;
- CLODEX_ALLOW_UNSIGNED_LOCAL_BUILD.

### Signing

- APPLE_ID;
- APPLE_PASSWORD;
- APPLE_TEAM_ID;
- Windows signing variables;
- promotion authority keys.

Private values нельзя печатать в logs или добавлять в документацию.

## 44. UI map

### Main

- task sidebar;
- agent chat;
- composer;
- file tree;
- terminal;
- browser;
- pending edits;
- status cards;
- command center.

### Routes

- projects;
- diff review;
- pull request;
- generated apps;
- preview pages;
- plugins;
- skills;
- settings;
- quick task.

### Settings

- General;
- Account;
- Models and Providers;
- Custom Providers;
- Memory;
- Agent OS;
- Browsing;
- Website Permissions;
- Worktrees;
- MCP and Cloud;
- Remote Connections;
- Skills and Plugins;
- Network Egress;
- About and Updates;
- Clear Data.

Каждая settings feature должна поддерживать loading, empty, error, disabled и
success state.

## 45. Добавление нового tool

1. Определить typed input/output.
2. Реализовать tool в provider-neutral или host layer.
3. Определить approval semantics.
4. Добавить capability context.
5. Ограничить paths, arguments и output.
6. Добавить timeout и cancellation.
7. Добавить negative tests.
8. Добавить UI tool card при необходимости.
9. Проверить telemetry.
10. Обновить docs.

Tool не должен самостоятельно читать credentials или расширять permissions.

## 46. Добавление model provider

Provider должен реализовать:

- model discovery;
- authentication;
- streaming;
- structured output;
- token limits;
- normalized errors;
- health;
- quota signals;
- cancellation.

После подключения:

1. добавить provider settings;
2. добавить model catalog mapping;
3. добавить validation API key;
4. добавить Model Fabric capabilities;
5. добавить tests;
6. проверить fallback.

## 47. Failure semantics

### До dispatch

Разрешён fallback на совместимый runtime или provider.

### После dispatch

Нельзя автоматически повторять side effect. Ошибка возвращается вызывающей
стороне. Повтор возможен только через explicit idempotency contract.

### Invalid evidence

Promotion и sensitive action блокируются.

### Missing optional subsystem

Основная задача должна продолжаться без него, если capability не является
обязательной. Например, недоступный model summarizer не должен отключать
Context Ledger.

### Corrupted protected data

Не перезаписывать автоматически. Вернуть bounded error и предложить
диагностику или явный reset.

## 48. QA acceptance checklist

### Task

- create;
- restart recovery;
- fork;
- archive/unarchive;
- goal persistence;
- follow-up queue;
- cancellation.

### Files

- large directory;
- binary preview;
- symlink/path traversal;
- concurrent update;
- diff accept/reject.

### Terminal

- create session;
- execute;
- cancel;
- resize;
- restart;
- protected logs.

### Browser

- navigation;
- permissions;
- network deny;
- temporary grant;
- revoke;
- download;
- screenshot.

### Models

- provider login;
- custom endpoint;
- model switch;
- quota error;
- fallback;
- cancellation.

### Memory

- long task;
- restart;
- stale fact;
- contradiction;
- repository revision change.

### Remote execution

- SSH success/failure;
- Docker unavailable;
- artifact mismatch;
- cancellation;
- stale lease.

### Generated apps

- preview;
- capability request;
- denied write;
- approved one-time commit;
- package revocation.

## 49. Production checklist

1. Clean exact source.
2. Full formatting, typecheck и tests.
3. Secret scan.
4. Release readiness.
5. Package build.
6. ASAR and fuse verification.
7. Signing.
8. Notarization.
9. Installer checksum.
10. Clean-profile smoke.
11. Manual acceptance.
12. Promotion evidence.
13. Canary.
14. Monitoring.
15. Rollback validation.
