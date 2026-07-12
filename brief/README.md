# Бриф реализации Clodex A+B

**Состояние на 11 июля 2026 года**

## 1. Результат

Старый roadmap **A+B** завершён:

- **A — Design System Extraction:** визуальные токены Codex перенесены в
  нативную дизайн-систему Clodex.
- **B — Native UI Reconstruction:** интерфейсы переписаны на React, Stage UI,
  Karton и собственный Electron IPC.
- Извлечённый Codex bundle используется только как визуальный и
  поведенческий референс. Runtime-зависимости от него нет.
- Прямой запуск исходного bundle отклонён из-за несовместимого
  `electronBridge` и другого IPC-контракта.

Основной roadmap:


## 2. Дизайн-система

Основной слой:

- `apps/browser/src/shared/tailwind/codex-design-tokens.css`

Реализованы:

- Codex blue `#0285ff`;
- нейтральная light/dark палитра;
- semantic surface, text, border и focus tokens;
- success, warning и error states;
- chat typography;
- shell, thread, composer и review geometry;
- radius, elevation и scrollbar presets;
- responsive light/dark UI.

Общий settings shell:

- `apps/browser/src/ui/screens/settings/_components/settings-page.tsx`

Он используется для General, Account, About, Clear Data, Personalization,
Models & Providers, Custom Providers, Memory, Agent OS, Browsing, Website
Permissions, Worktrees, MCP & Cloud, Remote Connections и Skills & Plugins.

## 3. Основная оболочка IDE

Реализованы:

- task/thread shell;
- Codex-подобная titlebar;
- основной chat layout и composer;
- task sidebar;
- группировка по проектам;
- поиск, создание и возобновление задач;
- tool cards и reasoning/status UI;
- pending edits;
- file tree и diff navigation;
- workspace/worktree actions;
- collapsed и responsive states;
- интерактивные IDE titlebar actions.

Основная зона:

- `apps/browser/src/ui/screens/main`

## 4. Command Center

Реализован multi-mode Command Center:

- поиск команд;
- задачи и проекты;
- файлы;
- настройки;
- быстрые действия;
- keyboard navigation;
- навигация к Generated Apps и Skills & Plugins;
- loading и empty states.

Основная зона:

- `apps/browser/src/ui/screens/main/command-center`

## 5. Projects

Реализованы:

- поиск и summaries;
- project grouping;
- список и пагинация задач;
- resume task;
- создание новой задачи;
- loading и empty states;
- light/dark visual regression.

Основная зона:

- `apps/browser/src/ui/screens/projects`

## 6. Diff и code review

Реализованы:

- diff review page;
- file navigation;
- line-numbered patches;
- additions/deletions;
- accept/reject отдельных изменений;
- accept/reject all;
- pending-edit integration;
- безопасный просмотр external file content.

Route:

- `/diff-review/$agentInstanceId`

## 7. Hosted Pull Request Review

Реализованы:

- определение GitHub PR по workspace или URL;
- repository, branch и author metadata;
- commits, changed files и checks;
- line-numbered patches;
- inline comment drafts;
- review summary;
- `COMMENT`, `APPROVE`, `REQUEST_CHANGES`;
- confirmation dialogs;
- atomic review submission;
- stale-head, permission и provider error states.

Основные зоны:

- `apps/browser/src/backend/services/hosted-pull-request`
- `apps/browser/src/ui/screens/pull-request`
- `apps/browser/src/shared/hosted-pull-request.ts`

Route:

- `/pull-request`

### Защищённый Merge workflow

Merge отделён от review и защищён backend-политикой:

- GitHub credential check;
- repository write permission;
- branch protection rules;
- required checks;
- mergeability;
- complete changed-file coverage;
- merge queue check;
- разрешённые `merge`, `squash`, `rebase`;
- свежие head SHA и base SHA;
- exact confirmation `owner/repository#number`;
- повторная backend-проверка всех gates;
- duplicate-request coalescing;
- отсутствие review/merge content в telemetry.

## 8. Quick Task и native hotkey window

Реализованы:

- отдельный Quick Task composer;
- native Electron window;
- system-level shortcut;
- secure preload и IPC;
- workspace reuse и выбор workspace;
- создание задачи;
- loading/error/success states;
- Escape и blur dismissal;
- stale request protection;
- duplicate submission coalescing;
- active-display positioning;
- поддержка экранов с отрицательными координатами;
- overlay fallback.

Основные зоны:

- `apps/browser/src/backend/services/quick-task-window`
- `apps/browser/src/ui/screens/main/quick-task`
- `apps/browser/src/ui/quick-task-window.tsx`

## 9. Generated App Library

Реализованы:

- каталог;
- поиск, фильтры и сортировка;
- ready/regenerating/broken/missing states;
- карточки и detail page;
- preview и launch;
- protected delete;
- regeneration через owner task;
- loading/error/empty states.

Routes:

- `/generated-apps`
- `/generated-apps/$appKey`
- `/preview/$appId`

Основные зоны:

- `apps/browser/src/backend/services/generated-app-library`
- `apps/browser/src/ui/screens/generated-apps`
- `apps/browser/src/shared/generated-apps.ts`

Ownership boundary:

- исходники принадлежат owner task;
- filesystem является источником истины;
- metadata хранится отдельно;
- scanner проверяет containment и безопасные пути;
- symlinked roots не обходятся;
- delete удаляет только выбранное agent-owned приложение;
- regeneration не перезаписывает файлы напрямую.

## 10. Skills & Plugins Library

Routes:

- `/plugins`
- `/plugins/$pluginId`
- `/skills`

Реализованы:

- единый bundled и marketplace catalog;
- поиск;
- source и status filters;
- enabled/disabled/update/incompatible states;
- Plugins/Skills tabs;
- summary cards;
- plugin cards и detail page;
- permissions и capabilities;
- contributed skills;
- compatibility information;
- install, update и uninstall;
- enable/disable;
- encrypted credentials;
- loading/error/empty states;
- Command Center action.

Основные зоны:

- `apps/browser/src/shared/plugin-library.ts`
- `apps/browser/src/pages/plugin-library-page.tsx`
- `apps/browser/src/ui/screens/plugin-library`
- `apps/browser/src/backend/wiring/pages-handler-wiring.ts`

В ходе visual interaction pass найден и исправлен runtime-crash React events
при поиске и изменении фильтров.

## 11. Plugin Marketplace

Реализован local official marketplace MVP:

- Ed25519-signed index;
- trusted publisher keys;
- publisher signing;
- manifest, permissions и compatibility validation;
- bounded extraction;
- traversal и symlink protection;
- staged install/update;
- backup и rollback;
- uninstall;
- integrity lockfile;
- SHA-256 file-tree validation;
- startup recovery;
- quarantine повреждённых пакетов;
- read-only plugin runtime mount;
- content-free audit telemetry.

Основная зона:

- `apps/browser/src/backend/services/plugin-marketplace`

## 12. MCP Runtime

Реализованы:

- isolated MCP host;
- registry и persistence;
- stdio, SSE и streamable HTTP;
- credentials;
- tool policy и approvals;
- plugin MCP bridge;
- safe Claude Desktop import;
- OAuth;
- connection tests;
- tools, resources и prompts;
- sanitized logs;
- MCP capability view;
- MCP & Cloud settings UI.

Основные зоны:

- `packages/mcp-runtime`
- `apps/browser/src/backend/mcp-host`
- `apps/browser/src/backend/services/mcp`
- `apps/browser/src/ui/screens/settings/sections/mcp-settings-section.tsx`

## 13. Remote Connections

Реализованы:

- encrypted SSH profiles;
- ssh-agent, private-key и password authentication;
- host-key policy;
- connection testing;
- persistent sessions;
- connect/reconnect/disconnect;
- latency и status states;
- terminal handoff;
- remote task creation;
- approval-gated execution;
- platform capability detection.

Основные зоны:

- `apps/browser/src/backend/services/remote-connections`
- `apps/browser/src/ui/screens/settings/sections/remote-connections-section.tsx`

## 14. Global Dictation

Реализован preview MVP:

- composer microphone control;
- global hotkey;
- draggable orb;
- Agent OS Micro integration;
- push-to-talk;
- batch transcription;
- OpenAI realtime WebRTC;
- incremental preview;
- final transcript insertion;
- cancel/retry;
- auto-stop;
- stale operation protection;
- exactly-once insertion;
- microphone self-test;
- WebRTC connection test;
- privacy-safe diagnostics;
- cross-platform capability harness.

Audio и transcript не сохраняются на диск и не попадают в telemetry.

## 15. Дополнительные платформенные функции

Следующие функции реализованы в рабочем дереве, но выходят за границы
исходного UI A+B roadmap.

### Personality и Collaboration

- persisted personality;
- dynamic agent prompts;
- collaboration presets;
- backend enforcement;
- release-channel feature gates.

### Mascot Overlay

- renderer overlay;
- pointer и keyboard movement;
- persisted position/size;
- viewport clamp;
- working/waiting/success/error states;
- reduced-motion;
- click-to-focus-agent.

### Memory Notes

- защищённая SQLite-база;
- global/workspace/agent scopes;
- add/list/read/search/delete tools;
- approval для sensitive writes;
- retention;
- export и reset;
- metadata counters;
- отсутствие автоматической загрузки note content в prompt.

### Guardian

- approve/deny/escalate;
- low/medium/high/critical risk;
- shell/browser/network/MCP/sandbox routing;
- fail-closed policy;
- human approval для irreversible operations;
- privacy-safe context;
- dogfood ledger;
- manual labels;
- readiness thresholds.

### Remote Control + Attestation

- single-use pairing;
- P-256 device keys;
- signed ECDH handshake;
- AES-256-GCM transport;
- replay и sequence protection;
- Guardian assessment;
- human approval;
- environment attestation;
- hardware-attestation contracts;
- revoke и privacy-safe audit.

### Cloud Tasks 9.1–9.4

- local/cloud execution targets;
- fail-closed routing;
- task lifecycle;
- snapshot manifest;
- immutable packaging;
- encryption и signature;
- upload quotas;
- secret broker;
- short-lived credentials;
- server-recipient key wrapping;
- bounded event stream;
- resumable artifacts;
- SHA-256 integrity;
- duration, cost и artifact quotas;
- dogfood rollout и kill switch.

## 16. Защита данных

Реализованы:

- OS-backed root key через Electron `safeStorage`;
- AES-256-GCM protected files;
- context binding;
- chunked encryption;
- atomic writes;
- protected attachments;
- Chronicle artifacts;
- protected shell logs;
- memory files;
- diff-history blobs;
- cache migrations;
- fail-closed startup при повреждённом key envelope.

Основные документы и файлы:

- `packages/agent-core/src/host/protected-files.ts`
- `docs/security/encryption-at-rest.md`
- `docs/protected-files-threat-model.md`

## 17. Internal routes

Зарегистрированы:

- `/home`
- `/pull-request`
- `/diff-review/$agentInstanceId`
- `/generated-apps`
- `/generated-apps/$appKey`
- `/plan/$filename`
- `/plugins`
- `/plugins/$pluginId`
- `/skills`
- `/preview/$appId`
- `/error/page-load-failed`

Blueprint из 80 Codex pages использовался как карта UI-поверхностей. В Clodex
они не копировались один-к-одному: часть реализована как main-window screens,
settings sections, dialogs и native windows.

## 18. Visual regression

Storybook и Playwright покрывают:

- Settings;
- Projects;
- Hosted PR;
- Quick Task;
- Generated Apps;
- Skills & Plugins.

Interaction coverage:

- inline PR comments;
- request changes;
- protected merge;
- Generated Apps search/detail/delete/regenerate;
- Plugin Library search и filters;
- Skills tab;
- plugin detail;
- permissions и credentials;
- update;
- uninstall confirmation.

Текущий результат:

- 15 visual tests passed;
- 15 committed snapshots.

## 19. Packaging и release validation

Закреплён runtime:

- Node.js `22.23.1`;
- `.node-version`;
- `.nvmrc`;
- packaging preflight отклоняет несовместимые версии.

Реализованы:

- production Electron package;
- bundled-assets validation;
- macOS DMG;
- ZIP validation;
- recursive signature validation;
- clean-profile smoke;
- UI launch markers;
- installer validation;
- notarization и stapling scripts;
- Windows silent-install smoke;
- Linux DEB/RPM validation;
- Xvfb clean-profile smoke;
- release evidence manifests и checksums.

macOS arm64 release rehearsal `1.16.0` успешно прошёл package, DMG/ZIP
validation и clean-profile launch. Rehearsal использовал ad-hoc подпись и не
является распространяемым production RC.

## 20. Последний validation pass

После завершения Skills & Plugins:

- Browser Vitest: **147 файлов, 1335 тестов — passed**;
- UI/backend/preload/Storybook/visual typecheck — passed;
- visual regression: **15 тестов — passed**;
- production Pages Vite build — passed;
- Storybook build — passed;
- scoped Biome — passed;
- TanStack route tree generation — passed.

## 21. Отложено или не завершено

### Старый UI roadmap

- `pricing-plan-page`;
- `checkout-webview-page`.

Они явно отложены и не входят в текущий local-first product scope.

### Дополнительный feature roadmap

- отдельное transparent always-on-top окно маскота;
- physical microphone/UI smoke на реальном Windows;
- physical microphone/UI smoke на реальном Linux;
- physical iOS App Attest;
- physical Android Play Integrity;
- production Secure Enclave/TPM/App Attest/Play Integrity verifiers;
- remote official marketplace index;
- private marketplace;
- Cloud Tasks 9.5;
- production-signed и notarized distributable RC с реальными сертификатами.

## 22. Финальный статус

Старый A+B UI/UX roadmap выполнен полностью, кроме двух заранее отложенных
billing-страниц.

Поверх него реализована платформенная база Agent OS, MCP Runtime, Guardian,
Plugin Marketplace, Remote Control, Cloud Tasks, encrypted storage и
production release validation.

Коммит для данного брифа не создавался.

## 23. Дополнительный experimental platform layer

После первоначального брифа в рабочем дереве появился ещё один слой
возможностей. Он должен учитываться в product narrative, но пока отделяется от
production claims feature-gates со статусом `experimental`.

### Scheduled Tasks + Wake Scheduler

- one-time, interval и cron schedules;
- timezone-aware cron;
- восстановление расписания после sleep/resume;
- `skip`, `run-on-wake` и coalesced missed-run policies;
- retries с exponential backoff;
- сохранённые capability grants и expiry;
- `alwaysAsk` / `alwaysAllow` approval mode;
- local или cloud execution target;
- encrypted persistence и recent run history.

Основные зоны:

- `apps/browser/src/backend/services/automations`
- `apps/browser/src/shared/automations.ts`
- `apps/browser/src/ui/screens/settings/sections/automations-settings-section.tsx`

### Generated App Capability Bridge

- capability manifest для `mcp:call`, `agent:ask`, `automation:run`;
- grant привязан к owner agent, app и optional plugin;
- вызов только явно разрешённых read-only MCP tools;
- bounded model question;
- запуск automation;
- 30 calls/minute на app context;
- 1 MiB result cap;
- encrypted grants, expiry и revoke.

Основные зоны:

- `apps/browser/src/backend/services/artifact-bridge`
- `apps/browser/src/shared/artifact-bridge.ts`
- `apps/browser/src/pages/lib/iframe-app-bridge.ts`

### Executable Extension Runtime

- plugin stdio MCP через `runtime/manifest.json`;
- feature gate `executable-extensions`;
- обязательные `mcp` и `process` permissions;
- runtime ID binding;
- containment и realpath checks;
- regular executable file check;
- SHA-256 integrity;
- platform и architecture compatibility;
- signed marketplace install/update/rollback pipeline;
- MCP server остаётся disabled после install.

Основная зона:

- `apps/browser/src/backend/services/mcp/plugin-bridge.ts`

### Spaces

Текущий experimental foundation:

- encrypted persistent containers;
- workspaces;
- links;
- instructions;
- archive marker;
- импорт существующих Projects.

Связи Spaces с sessions, Generated Apps, memory и automations нужно считать
следующим integration slice, а не полностью завершённой возможностью.

Основные зоны:

- `apps/browser/src/backend/services/spaces`
- `apps/browser/src/shared/spaces.ts`

### Session Teleport + Sharing

- readiness check для local-to-cloud continuation;
- проверка наличия session и cloud runtime;
- продолжение существующей session через cloud execution target;
- read-only share payload;
- HTTPS-only share adapter;
- expiry;
- revoke;
- encrypted local share registry.

Функция зависит от настроенного Cloud Tasks runtime и external sharing
control plane, поэтому остаётся experimental.

Основные зоны:

- `apps/browser/src/backend/services/session-continuity`
- `apps/browser/src/shared/session-continuity.ts`

### Product status

| Capability | Текущий статус |
|---|---|
| Scheduled Tasks + Wake Scheduler | Experimental / dogfood |
| Generated App Capability Bridge | Experimental / dogfood |
| Executable Extension Runtime | Experimental / dogfood |
| Spaces foundation | Experimental, integration incomplete |
| Session Teleport + Sharing | Experimental, control-plane dependent |
