# План внедрения расширенных функций Clodex

## Цель

Внедрять найденные идеи как управляемую продуктовую программу, а не как набор
несвязанных прототипов. Каждый этап должен иметь:

- feature gate;
- явную модель разрешений и угроз;
- телеметрию без записи чувствительных данных;
- целевые unit/integration-тесты;
- критерий отката;
- документацию для пользователя.

## Аудит текущего состояния

| Направление | Состояние в репозитории | Решение |
| --- | --- | --- |
| Personality System | Нет пользовательского переключателя | Реализовать первым вертикальным срезом |
| Collaboration presets | Есть plan/skills и режим Swarm, но нет единого preset-контракта | Добавить после personality |
| Mascot overlay | Не найден | Реализовать как изолированный UI overlay |
| Global dictation | Есть поддержка audio-вложений, но нет записи и realtime state machine | Начать с push-to-talk MVP |
| Memories | Уже есть архивная read-only memory и history compression | Расширять ad-hoc заметками и поиском |
| Multi-agent v2 | Уже есть Dynamic Swarm и worker roles | Добавить guardian и policy routing |
| Skills/plugins | Есть bundled discovery и settings | Добавить install/update/marketplace слой |
| Feature gates | Нет единой пользовательской системы experimental flags | Сделать общей платформенной зависимостью |
| Remote control | Не найден | Проектировать после permission/audit foundation |
| Attestation | Не найден | Делать вместе с remote/cloud trust model |
| Cloud tasks | Не найден как законченный execution backend | Выделить отдельный transport/runtime этап |
| Workbook | Не найден | Отложить до стабилизации core-функций |

## Очередность

### Этап 0. Платформенный фундамент

**Срок:** 1–2 недели.

1. Ввести типизированный реестр feature flags:
   - `stable`, `preview`, `experimental`;
   - локальные defaults;
   - пользовательские overrides;
   - kill switch;
   - проверка флага и в UI, и в backend handler.
2. Унифицировать capability/permission checks для микрофона, сети, remote
   sessions, cloud execution и plugin installation.
3. Добавить audit events без содержимого prompts, audio и файлов.
4. Описать migration policy для preferences и SQLite schemas.

**Готово, когда:** экспериментальную функцию можно включить, выключить и
аварийно скрыть без удаления данных и без перезапуска миграций.

### Этап 1. Personality System

**Срок:** 1–2 дня.

Вертикальный срез:

1. Тип `friendly | pragmatic` в user preferences.
2. Default `pragmatic`, чтобы сохранить текущее поведение.
3. Переключатель в `Settings → Personalization`.
4. Динамическая синхронизация CHAT/MAGUS system prompt.
5. Schema и prompt tests.

**Готово, когда:** изменение настройки применяется к следующему turn без
перезапуска приложения, а legacy preferences получают безопасный default.

### Этап 2. Collaboration Mode Presets

**Срок:** 3–5 дней.

1. Контракт preset:
   - id/version;
   - system prompt additions;
   - разрешённые tools/skills;
   - model/reasoning defaults;
   - post-run verification policy.
2. Базовые presets:
   - default;
   - explain-codebase;
   - plan;
   - implement;
   - review;
   - write-tests.
3. Запрет смены режима во время активного turn.
4. Отображение активного режима в composer.

**Зависимость:** Personality System должен оставаться независимой осью; mode
определяет workflow, personality — стиль взаимодействия.

### Этап 3. Mascot Avatar Overlay

**Срок:** 1–2 недели.

1. Renderer-only прототип внутри основного окна:
   - drag;
   - сохранение позиции;
   - размеры 80–224 px;
   - spring animation;
   - reduced-motion и forced-colors.
2. Состояния: idle, working, waiting, success, error.
3. Notification badge и click-to-focus-agent.
4. Только после UX-проверки — отдельное transparent always-on-top окно.

**Ограничения:** overlay не должен перехватывать клики вне маскота, мешать
screen sharing, ломать несколько дисплеев или обходить OS accessibility.

### Этап 4. Memories Extension

**Срок:** 1–2 недели.

Использовать существующий read-only `memory/` архив:

1. SQLite-таблица ad-hoc notes.
2. Tools: add, list, read, search, delete.
3. Scope: global/workspace/agent.
4. Явное подтверждение перед сохранением чувствительной информации.
5. Search modes: any, all-on-line, all-within-entry.
6. Settings: export/reset и retention.

**Готово, когда:** память не загружается в prompt автоматически, а извлекается
только по необходимости и всегда считается недоверенными данными.

### Этап 5. Global Dictation

**Срок:** 2–4 недели.

1. MVP: `MediaRecorder` → локальный audio blob → transcription endpoint.
2. State machine:
   `idle → requesting-permission → recording → transcribing → completed|failed`.
3. Orb UI, keyboard shortcut, drag, cancel, retry.
4. После MVP — realtime WebRTC transport и incremental transcript.
5. Выбор voice выносить отдельно от dictation; не смешивать STT и TTS.

**Безопасность:** явный индикатор записи, автоматическая остановка, отсутствие
фоновой записи, удаление временного audio после завершения.

### Этап 6. Multi-Agent v2 + Guardian

**Срок:** 2–4 недели.

Расширять существующие Dynamic Swarm/worker roles:

1. Guardian assessment contract:
   - action summary;
   - risk level;
   - evidence;
   - approve/deny/escalate.
2. Policy routing для network, shell escalation, MCP approvals и sandbox
   exceptions.
3. Guardian получает минимальный read-only контекст.
4. Human approval остаётся обязательным для необратимых действий.
5. Отдельные метрики false-positive/false-negative и latency.

**Готово, когда:** guardian не может сам выполнить проверяемое действие и не
может расширить собственные permissions.

### Этап 7. Plugin Marketplace

**Срок:** 2–3 недели.

1. Signed metadata index.
2. Install/update/uninstall с staging directory и rollback.
3. Проверка manifest, declared tools, permissions и compatibility.
4. Lockfile с source, version и integrity hash.
5. Private marketplace support после локального MVP.

### Этап 8. Remote Control + Attestation

**Срок:** 4–8 недель.

1. Pairing с короткоживущим одноразовым кодом.
2. Device-bound client key, revoke и session expiry.
3. WebSocket transport с sequence numbers и replay protection.
4. Remote-команды проходят тот же approval pipeline, что локальные.
5. Attestation challenge подписывает версию приложения, environment id,
   session id и nonce; секреты и содержимое workspace не включаются.
6. Native evidence связывается с pairing nonce, device key fingerprint,
   device id и protocol version; supplied evidence проверяется fail closed.
7. Trust policy может требовать App Attest, Play Integrity, Secure
   Enclave-provider или TPM verifier для native platform.

**Запрет:** не открывать локальный unauthenticated WebSocket и не считать
pairing code постоянным credential.

### Этап 9. Cloud Tasks

**Срок:** 4–8 недель.

1. Абстракция execution target: local/cloud.
2. Snapshot manifest вместо неограниченной синхронизации диска.
3. Secret broker с scoped short-lived credentials.
4. Streaming logs, cancel, resume, artifact download.
5. Cost/time quotas и data residency policy.

**Инкремент 9.1 реализован:** per-turn target contract, фиксированная task
state machine, local-preserving adapter, fail-closed cloud adapter, feature
gate, content-free audit, abort/timeout tracking и bounded explicit snapshot
manifest foundation.

**Инкремент 9.2 реализован:** selection из path references последнего user
turn, `.gitignore`/protected/secret policy, symlink containment, immutable
file reading, deterministic manifest, streaming AES-256-GCM archive,
provider-owned key wrapping/signature, quotas и cancellation-safe staging
cleanup.

**Инкремент 9.3 реализован:** scoped short-lived task credentials,
server-recipient P-256 ECDH/HKDF/AES-GCM wrapping, upload sessions и integrity
acknowledgement, residency/quota enforcement, same-origin control plane,
bounded NDJSON streaming, replay cursor, reconnect, cancel и content-free
audit. Production adapter остаётся env- и feature-gated без cloud-to-local
fallback.

**Инкремент 9.4 реализован:** artifact-scoped credentials, same-origin
Range download, partial checkpoints, exact size/SHA-256 verification,
persisted content-free stream cursor, bounded reconnect, cumulative
duration/cost enforcement, artifact quotas, dogfood defaults, rollout
telemetry и emergency kill switch.

**Инкремент 9.5 реализован:** startup/resume reconciliation orphaned
executions через fresh scoped credential, terminal cleanup и fail-closed
active cancellation; artifact metadata store, 7-day retention, global 2 GiB
budget и active-part protection; secure open/reveal/export UI без renderer
path authority; production backend conformance tests; fixed dogfood SLO,
human sign-off gate и owner-only cross-platform suspend/resume evidence
harness. Release promotion остаётся заблокирован до фактических macOS,
Windows и Linux evidence artifacts.

### Этап 10. Workbook

**Срок:** отдельная продуктовая программа.

Начать с read-only CSV/XLSX viewer и agent-generated tables. Формулы,
совместное редактирование, worker runtime и review targets добавлять только
после измерения реального спроса.

## Статус реализации

- [x] Personality System: persisted preference, settings и динамический
      CHAT/MAGUS prompt.
- [x] Typed feature-gate registry с release-channel availability и
      пользовательскими overrides.
- [x] Collaboration Mode Presets: gated selector, persisted mode и backend
      enforcement.
- [x] Mascot Overlay preview MVP:
  - renderer-only overlay;
  - persisted size/position;
  - pointer и keyboard drag/nudge;
  - viewport clamp, rubber-band и spring return;
  - reduced-motion и forced-colors;
  - idle/working/waiting/success/error;
  - click-to-focus-agent;
  - size/reset controls в Personalization.
- [x] Memories Extension persistence/tooling MVP:
  - отдельная SQLite-база вне read-only `memory/` archive;
  - protected fields и hashed scope lookup;
  - scopes `global/workspace/agent`;
  - tools `add/list/read/search/delete`;
  - approval для sensitive writes и delete;
  - search modes `any/all-on-line/all-within-entry`;
  - preview gate с backend recheck;
  - память не загружается в prompt автоматически и маркируется как untrusted.
- [x] Memories settings:
  - portable decrypted JSON export без raw SQLite;
  - reset с подтверждением и выбором scope-типа;
  - retention `forever/30-days/90-days/1-year`;
  - немедленная и startup-очистка по `updatedAt`;
  - per-scope metadata counts без загрузки note content.
- [x] Global Dictation push-to-talk vertical slice:
  - preview gate с повторной backend-проверкой;
  - `MediaRecorder` и явная state machine;
  - composer mic/pulse control и `Mod+Shift+Space`;
  - вставка plain transcript в текущую позицию draft;
  - cancel/retry, backend abort и auto-stop через 120 секунд;
  - in-memory-only audio lifecycle без disk persistence;
  - audio-capable active model с fallback на Gemini/MiMo;
  - content-free logs без audio/transcript telemetry.
- [x] Global Dictation global controls:
  - единый provider/state machine для composer, hotkey и overlay;
  - двусторонняя связка с Agent OS Micro push-to-talk без feedback-loop;
  - draggable renderer orb с viewport clamp;
  - сохранение позиции orb и keyboard nudge;
  - backend gate enforcement и сброс PTT при выключении dictation.
- [x] Global Dictation realtime transport:
  - official OpenAI WebRTC negotiation через Electron main;
  - incremental transcript preview без изменения draft;
  - manual commit и final transcript;
  - автоматический batch fallback с типизированными причинами;
  - content-free latency diagnostics.
- [x] Global Dictation hardening:
  - локальный четырёхсекундный microphone self-test через Web Audio без
    `MediaRecorder`, upload и persistence;
  - явный WebRTC connection test без microphone track с немедленным закрытием
    peer/data channel;
  - cancel/teardown для tracks, `AudioContext`, timers, animation frames,
    backend negotiation и WebRTC resources;
  - lifecycle authority для gate-off, hidden document, active-agent switch,
    rapid toggles, stale operation и exactly-once transcript insertion;
  - deterministic macOS/Windows/Linux Chromium capability matrix;
  - privacy-safe diagnostic report версии 2.
- [x] Multi-Agent Guardian policy MVP:
  - experimental feature gate `multi-agent-guardian`;
  - default on в `dev/prerelease/nightly`, default off в `release` и
    пользовательский opt-out;
  - строгий контракт `approve/deny/escalate` и risk
    `low/medium/high/critical`;
  - policy routing для shell, browser/network, Clodex MCP и sandbox;
  - fixed-shape read-only context без raw command, script, MCP arguments,
    origin, prompts, файлов и credentials;
  - GuardianService не имеет execution/model/credential dependencies;
  - irreversible actions всегда возвращаются в human approval pipeline;
  - explicit browser block и пользовательский `alwaysAsk` остаются
    авторитетнее Guardian approval;
  - content-free audit/latency telemetry и канал `guardian` в Debug
    Inspector;
  - unit/integration coverage для gate-off, fail-closed, approve, deny,
    escalate и privacy boundaries.
- [ ] Отдельное transparent always-on-top окно для маскота — только после
      UX-проверки renderer-only MVP.
- [x] Guardian dogfood feedback loop:
  - persisted content-free distribution по decision, risk и action kind;
  - bounded ledger из 100 последних assessments;
  - policy version в local ledger и telemetry для разделения итераций
    эвристик;
  - UI `Settings → Agent OS → Guardian dogfood`;
  - ручные labels `correct/false-positive/false-negative`;
  - relabel без двойного учёта;
  - отдельная privacy-safe feedback telemetry без correlation id и action
    content.
- [x] Guardian release-readiness framework:
  - отдельные накопительные cohorts для каждой policy version;
  - one-time backfill доступного legacy ledger без raw action data;
  - sample gates: 250 labels, 30% coverage, 100 approve, 100
    deny/escalate и 30 labels для каждого action kind;
  - operational false-positive threshold ≤10% среди deny/escalate;
  - safety false-negative threshold ≤2% среди approve;
  - состояния `collecting/needs-tuning/candidate` в Agent OS Settings;
  - прохождение thresholds не включает release gate автоматически и требует
    human sign-off.
- [x] Remote Connections typecheck blockers:
  - backend использует корректный `ChildProcess` contract;
  - Settings section восстановлена и включена в renderer build;
  - общий browser backend/UI typecheck проходит.
- [x] Plugin Marketplace local official MVP:
  - experimental feature gate `plugin-marketplace`;
  - default on в `dev/prerelease/nightly`, default off в `release`;
  - bundled Ed25519-signed metadata index и встроенный trusted public key;
  - строгие manifest, permission и compatibility checks;
  - bounded HTTPS archive extraction без traversal/symlink;
  - staged install/update/uninstall с backup и rollback;
  - atomic integrity lockfile с source, version, manifest и SHA-256 file tree;
  - startup recovery и quarantine tampered/orphan packages;
  - отдельный read-only runtime mount для marketplace plugins;
  - Settings UI для verify/install/update/uninstall;
  - content-free audit telemetry и targeted tests.
- [x] macOS Electron UI/hardware smoke:
  - основное окно отображается и больше не остаётся пустым;
  - Remote Connections settings render без console/page errors;
  - signed marketplace verified, bundled sample install/uninstall проходит;
  - Global Dictation gate включает composer control и draggable global orb
    рядом с Micro controller без focus/renderer errors;
  - локальный четырёхсекундный Settings self-test обнаруживает сигнал;
  - microphone capture, MediaRecorder, Web Audio и WebRTC доступны;
  - 3.1 s microphone signal test пройден, local WebRTC latency 226 ms.
- [x] Remote Control + Attestation local secure MVP:
  - одноразовый pairing code с TTL, single-use и rate limit;
  - device-bound P-256 signing keys вместо bearer-token;
  - revoke удаляет public key и закрывает live sessions;
  - signed ephemeral ECDH handshake и session expiry;
  - AES-256-GCM command transport с отдельными direction IV и строгими
    sequence numbers;
  - replay/out-of-order shutdown и command rate limit;
  - Guardian assessment для каждой remote command без raw payload;
  - one-time desktop approval для escalate и обязательный human approval для
    remote `approveTool`;
  - challenge-bound signed environment attestation;
  - insecure LAN HTTP bootstrap переведён с недоступного `crypto.subtle` на
    bundled pure-JS P-256/HKDF/AES-GCM client; inline script запрещён CSP;
  - non-loopback Chromium smoke при `isSecureContext=false` подтвердил
    pairing, attestation, encrypted WebSocket и command round-trip;
  - content-free security audit, Agent OS UI и targeted tests;
  - legacy bearer clients fail closed и требуют повторного pairing.
- [x] Native hardware-attestation enforcement infrastructure:
  - optional provider-discriminated evidence contract для App Attest, Play
    Integrity, Secure Enclave и TPM;
  - canonical SHA-256 challenge связан с pairing nonce, device id, protocol
    version и signing-key fingerprint;
  - injected provider verifier abstraction и platform/provider matching;
  - configurable `hardware-backed` requirement для iOS/Android/desktop;
  - fail-closed при missing required evidence, unavailable/unsupported
    verifier, challenge mismatch, expiry и invalid verdict;
  - persistent privacy-safe anti-replay keys с expiry;
  - state/UI/telemetry содержат только trust level, provider и coarse verdict;
    raw assertion/token/quote не сохраняется и не аудируется;
  - targeted tests покрывают valid, missing, mismatch, expired, replay,
    unsupported/unavailable и raw-evidence privacy.
- [x] Physical phone smoke evidence harness:
  - fixed-shape owner-only atomic JSON;
  - обязательные явные gates для QR pairing, encrypted session,
    background/resume, Guardian approval, network handoff, revoke,
    hardware-attestation verdict и privacy audit;
  - collector не создаёт passed artifact при неполном наборе подтверждений;
  - harness не считается фактическим прохождением без физического устройства.
- [ ] Windows/Linux UI и physical microphone smoke:
  - [x] standalone Electron harness разделён на `hardware` и не запрашивающий
    permission `capabilities` mode;
  - [x] fixed-shape privacy-safe JSON schema version 2, platform expectation,
    OS-specific recorder MIME policy и atomic owner-only evidence output;
  - [x] Windows x64/Linux x64 capability smoke включён в PR build matrix,
    отчёты сохраняются отдельными CI artifacts;
  - [x] stale `stagewise-dev` binary/artifact paths в cross-platform CI
    заменены на `clodex-dev`;
  - [ ] physical microphone и полный UI smoke на реальном Windows host;
  - [ ] physical microphone и полный UI smoke на реальном Linux
    Wayland/X11 host.
- [ ] Physical phone pairing/command/hardware-attestation smoke на iOS и
      Android:
  - [x] privacy-safe evidence collector и manual checklist;
  - [ ] physical iOS App Attest evidence;
  - [ ] physical Android Play Integrity evidence.
- [ ] Production provider verification:
  - [x] verifier contract, trust policy, freshness и anti-replay enforcement;
  - [ ] native iOS client + configured App Attest verifier;
  - [ ] native Android client + configured Play Integrity verifier;
  - [ ] desktop Secure Enclave/TPM verifier с configured trust roots.
- [x] Cloud Tasks 9.1 — Execution Target Foundation:
  - per-turn message metadata `executionTarget: local | cloud`;
  - local target сохраняет существующий main/isolated runtime routing;
  - cloud gate default-disabled на всех release channels;
  - отсутствующий или disabled cloud adapter fail closed без local replay;
  - lifecycle `queued/preparing/running/suspended/completed/failed/cancelled`;
  - existing agent abort signal отмечает cancellation, timeout отделён от
    user abort;
  - bounded content-free in-memory task ledger;
  - deterministic explicit snapshot manifest с normalized relative paths,
    SHA-256, entry/byte limits и traversal rejection;
  - content-free telemetry и targeted tests.
- [x] Cloud Tasks 9.2 — Snapshot Packaging:
  - explicit file selection и protected-path policy;
  - immutable reads, hashing, archive staging и local encryption;
  - signed manifest, upload quotas и cancellation-safe cleanup.
- [x] Cloud Tasks 9.3 — Secret Broker + production adapter boundary:
  - task-scoped short-lived credentials и idempotent revoke;
  - server-recipient key wrapping и per-session key rotation;
  - signed HTTPS upload без forwarding account credentials;
  - ciphertext integrity acknowledgement;
  - residency, snapshot, duration и cost quotas;
  - bounded NDJSON stream, replay protection, reconnect и remote cancel;
  - env/feature gate, content-free audit и targeted tests.
- [x] Cloud Tasks 9.4 — Artifacts, resume, usage enforcement и dogfood:
  - отдельный `artifact:read` credential;
  - same-origin download без redirects и content transformation;
  - HTTP Range resume и atomic partial checkpoints;
  - exact size/SHA-256 integrity verification;
  - persisted monotonic stream cursor и bounded reconnect;
  - duration/cost/artifact quota enforcement с remote cancel;
  - default-on только для dev/prerelease/nightly;
  - release default-disabled и emergency kill switch;
  - content-free rollout/control-plane telemetry и tests.
- [x] Cloud Tasks 9.5 — Release readiness infrastructure:
  - bounded startup/resume reconciliation для orphaned executions;
  - fresh `task:status`/`task:cancel` credentials без persisted token/URL;
  - terminal checkpoint cleanup и active orphan cancellation;
  - artifact metadata store, 7-day retention и global 2 GiB disk budget;
  - active partial download protection и oldest-first eviction;
  - secure artifact open/reveal/export через opaque ids;
  - fixed-origin backend conformance coverage;
  - dogfood SLO evaluator и explicit human sign-off;
  - owner-only cross-platform network/suspend/resume evidence harness.
- [ ] Cloud Tasks release promotion evidence:
  - собрать ≥72 h dogfood evidence и пройти SLO thresholds;
  - выполнить physical suspend/resume smoke на macOS;
  - выполнить physical suspend/resume smoke на Windows;
  - выполнить physical suspend/resume smoke на Linux;
  - получить product/security/operations sign-off.

## Ближайший инкремент

1. Получить Windows/Linux capability evidence из PR CI, затем повторить полный
   UI/physical microphone smoke на реальных hosts; macOS и capability mode не
   считаются подтверждением physical platform flow.
2. На физических iOS/Android устройствах выполнить
   `docs/remote-control-physical-smoke.md` и собрать оба owner-only artifacts;
   наличие harness без artifacts не считается прохождением.
3. Продолжить Guardian dogfood до readiness thresholds и human sign-off.
4. После local marketplace dogfood спроектировать remote official index
   refresh и publisher signing pipeline.
5. Подключить реальные provider verifiers к готовому native-attestation
   contract: App Attest, Play Integrity и desktop Secure Enclave/TPM; затем
   включить mandatory hardware policy для release native clients.
6. Private marketplace support начинать только после стабилизации local
   official MVP.
7. Собрать Cloud Tasks 9.5 dogfood/SLO evidence, выполнить physical
   network/suspend/resume smoke на macOS, Windows и Linux и только после
   product/security/operations sign-off рассматривать release promotion.
