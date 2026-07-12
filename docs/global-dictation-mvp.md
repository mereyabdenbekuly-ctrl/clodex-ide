# Global Dictation MVP

## Назначение

Global Dictation — preview-функция для явной записи речи и вставки
транскрипта в текущую позицию курсора chat composer. Первый вертикальный срез
не реализует фоновое прослушивание или TTS.

Функция по умолчанию выключена и доступна через feature gate
`global-dictation`. Дополнительный экспериментальный realtime transport
включается отдельным gate `realtime-dictation`, который также по умолчанию
выключен.

## Пользовательский сценарий

1. Пользователь нажимает кнопку микрофона в composer или
   `Mod+Shift+Space`.
2. Renderer запрашивает доступ к микрофону.
3. После выдачи разрешения начинается запись с явным красным индикатором.
4. Повторное нажатие останавливает запись и запускает транскрипцию.
5. Готовый plain-text транскрипт вставляется в текущую позицию курсора, не
   заменяя существующий draft.

Ту же state machine используют три входа:

- mic-кнопка в composer;
- draggable orb поверх основного окна;
- действие `Push to talk` в Agent OS Micro.

Кнопка отражает состояния:

- `idle` / `completed` — микрофон;
- `requesting-permission` — spinner, нажатие отменяет запрос;
- `recording` — красный pulse/orb, нажатие останавливает запись;
- `transcribing` — spinner, нажатие отменяет backend-запрос;
- retryable `failed` — повтор транскрипции сохранённого in-memory Blob;
- non-retryable `failed` — начало новой записи.

При активном realtime transport partial transcript отображается рядом с
composer mic и global orb. Partial text является только preview и не меняет
TipTap draft. В composer вставляется только финальный транскрипт.

## State machine

```text
idle
  → requesting-permission
  → recording
  → transcribing (realtime finalization или batch fallback)
  → completed | failed
```

Отмена из активного состояния возвращает state machine в `idle`.

Активные recording/transcribing states дополнительно содержат:

- `transport: batch | realtime`;
- `partialTranscript` только для realtime preview.

## Global orb

Renderer монтирует один draggable orb поверх основного окна приложения:

- короткое нажатие запускает/останавливает/отменяет dictation согласно текущему
  состоянию;
- drag перемещает orb и не запускает запись;
- arrow keys сдвигают orb по 12 px;
- позиция ограничивается viewport и сохраняется в renderer `localStorage`
  под ключом `clodex-global-dictation-orb-position-v1`;
- resize повторно ограничивает позицию, чтобы control не оказался за экраном;
- orb скрывается и активная запись отменяется при переходе в Settings,
  скрытии основного layout или потере доступного chat target.

Это renderer-only overlay внутри окна Clodex, а не отдельное native
always-on-top окно поверх других приложений.

Pointer и keyboard взаимодействия orb явно передают focus ownership панели
`clodex-ui`. Disabled orb не меняет focus state.

## Agent OS Micro

`Agent OS Micro → Push to talk` двусторонне синхронизирован с dictation:

- `false → true` запускает запрос разрешения/запись;
- `true → false` отменяет запрос разрешения или останавливает запись;
- запуск через composer, orb или hotkey включает Micro indicator;
- переход в transcription/completed/failed/idle выключает Micro indicator;
- refs `microStartRequested`/`microStopRequested` предотвращают feedback-loop
  между backend state и renderer state machine;
- stale `pushToTalkActive=true` при новом mount сбрасывается и никогда не
  запускает микрофон автоматически;
- backend разрешает `setPushToTalkActive(true)` только при включённых
  `codex-micro-controller` и `global-dictation`;
- выключение dictation gate принудительно сбрасывает активный Micro PTT.

## Жизненный цикл audio

- `MediaRecorder` работает только после явного действия пользователя.
- Chunks и итоговый `Blob` находятся только в памяти renderer.
- При включённом realtime gate тот же microphone stream добавляется в WebRTC
  peer connection, а `MediaRecorder` параллельно продолжает собирать Blob для
  fallback.
- Backend декодирует payload в in-memory `Buffer`.
- Audio не записывается в SQLite, preferences, attachment store или временный
  файл.
- После успешной транскрипции или отмены ссылки на Blob/Buffer удаляются.
- После ошибки транскрипции renderer сохраняет Blob только для явного
  `Retry`.
- Новая запись, отмена, выключение gate или размонтирование UI удаляют
  сохранённый retry Blob.
- Закрытие приложения также уничтожает данные, потому что disk persistence
  отсутствует.

Транскрипция выполняется через настроенного удалённого model provider, поэтому
audio передаётся выбранному провайдеру модели. MVP не является полностью
локальным/offline STT.

В realtime режиме audio передаётся напрямую из renderer WebRTC peer connection
в OpenAI Realtime API. Стандартный OpenAI API key остаётся только в Electron
main process.

## Автоматическая остановка и отмена

- максимальная длительность записи: `120 секунд`;
- максимальный размер audio: `20 MB`;
- записи короче `250 ms` отклоняются;
- переход UI document в `hidden` во время запроса разрешения, записи или
  finalization/transcription отменяет операцию;
- audio tracks останавливаются на stop, cancel, error и teardown;
- cancel во время транскрипции вызывает backend `AbortController`;
- cancel во время WebRTC negotiation прерывает backend `fetch`;
- cancel, hidden document, gate-off и teardown закрывают data channel,
  `RTCPeerConnection`, timers и audio tracks;
- backend позволяет отменить уже запущенный запрос даже после выключения
  feature gate, но не принимает новые запросы при выключенном gate.

Фоновая запись после потери видимости не допускается.

## Выбор модели

Backend сначала проверяет активную модель агента. Она используется только если:

1. модель объявляет audio input capability;
2. модель доступна текущему `ModelProviderService`.

Fallback-порядок:

1. `gemini-3.5-flash`;
2. `mimo-v2.5`.

Если audio-capable модель недоступна, операция завершается retryable error без
сохранения audio на диск.

## Realtime WebRTC transport

Экспериментальный transport следует GA unified WebRTC flow:

1. Renderer создаёт `RTCPeerConnection`, добавляет microphone audio track и
   data channel `oai-events`.
2. SDP offer передаётся через Karton procedure
   `dictation.negotiateRealtime`.
3. Electron main отправляет multipart `sdp + session` на
   `POST https://api.openai.com/v1/realtime/calls`.
4. Session имеет `type: transcription`,
   `audio.input.transcription.model: gpt-realtime-whisper`,
   `delay: low` и `turn_detection: null`.
5. При stop renderer отправляет `input_audio_buffer.commit`.
6. Deltas
   `conversation.item.input_audio_transcription.delta` обновляют только
   preview.
7. `conversation.item.input_audio_transcription.completed` даёт финальный
   plain-text transcript.

`item_id` используется для сопоставления committed/delta/completed events.
Shared assembler сохраняет commit order, поэтому completion events разных
items не переставляют текст.

Realtime запускается только при одновременно включённых gates
`global-dictation` и `realtime-dictation`, наличии WebRTC API и подключённом
официальном OpenAI API key. Clodex relay, coding-plan endpoints и arbitrary
OpenAI-compatible endpoints намеренно не используются для
`/v1/realtime/calls`.

При negotiation error, data-channel/peer failure, empty final transcript или
finalization timeout session закрывается, partial preview очищается, а
сохранённый `MediaRecorder` Blob автоматически отправляется в существующую
batch transcription path.

SDP, transcript, provider error body и audio content не записываются в logs.

## Privacy-safe diagnostics

`Settings → General → Dictation diagnostics` показывает:

- наличие microphone capture API, `MediaRecorder` и WebRTC;
- наличие Web Audio для локального signal meter;
- выбранный recorder MIME;
- состояние gates `global-dictation` и `realtime-dictation`;
- наличие настроенного official OpenAI key без раскрытия самого key;
- outcome и transport последней in-memory session;
- negotiation, first-delta, finalization и recording duration;
- типизированную причину realtime → batch fallback.

В diagnostics доступны два только вручную запускаемых smoke-теста:

- **Local microphone test** — четыре секунды измеряет RMS/peak через Web Audio,
  не создаёт `MediaRecorder`, не отправляет audio и не сохраняет samples;
- **Realtime connection test** — проверяет SDP negotiation и открытие data
  channel через send-only audio transceiver без microphone track, после чего
  немедленно закрывает peer connection.

Оба теста отменяются при уходе document в `hidden` и при размонтировании
Settings. Microphone test останавливает tracks, отключает audio nodes, закрывает
`AudioContext`, очищает timer и animation frame. Realtime test отменяет
backend negotiation и закрывает data channel/peer connection.

Поддерживаемые fallback reasons:

- `official-openai-key-unavailable`;
- `webrtc-unavailable`;
- `realtime-gate-disabled`;
- `negotiation-failed`;
- `negotiation-timeout`;
- `data-channel-open-timeout`;
- `realtime-runtime-failure`;
- `final-transcript-timeout`;
- `empty-final-transcript`.

Кнопка `Copy report` создаёт JSON фиксированной формы версии 2. В отчёт невозможно
добавить audio, SDP, transcript, provider error body, API key, request id или
произвольный payload. Report дополнительно содержит только outcome, duration,
peak percentage и connection latency диагностических тестов. Metrics хранятся
только в renderer memory и сбрасываются при закрытии UI.

## Контракты и безопасность

- renderer передаёт `requestId`, base64 audio, MIME type, duration и
  preferred model id;
- shared Zod schema нормализует codec-параметры MIME и проверяет лимиты;
- backend повторно проверяет `global-dictation` перед транскрипцией;
- одновременно допускается не более двух backend-транскрипций;
- duplicate `requestId` отклоняется;
- logs содержат только размер, длительность и model id;
- audio и transcript content не отправляются в продуктовую телеметрию и не
  записываются в logs.

## Cross-platform smoke coverage

Автоматизированный smoke matrix моделирует Chromium capability profiles для
macOS, Windows и Linux:

- `getUserMedia` + `MediaRecorder`;
- WebM/Opus и Ogg/Opus MIME selection;
- WebRTC capability и сохранение batch fallback без `RTCPeerConnection`;
- современные и legacy permission error names;
- pointer/keyboard focus handoff для orb и Micro;
- viewport clamp/resize/persisted orb geometry;
- SDP negotiation, data-channel delta, manual commit, final event и runtime
  failure fallback signal;
- negotiation/data-channel/final timeouts, empty final и cancel во время
  finalization;
- preflight fallback при отсутствии WebRTC, выключенном gate и отсутствии
  official OpenAI key;
- fixed-shape redacted diagnostic report.

Это deterministic software smoke coverage. Реальные Windows/Linux устройства,
системные permission dialogs, конкретные audio drivers и multi-display
hardware в текущем macOS окружении не тестировались и остаются release QA
шагом.

## Основные точки реализации

- shared state/contracts: `apps/browser/src/shared/dictation.ts`;
- runtime/cross-platform helpers:
  `apps/browser/src/shared/dictation-runtime.ts`;
- realtime event assembler:
  `apps/browser/src/shared/dictation-realtime.ts`;
- diagnostics contracts/report:
  `apps/browser/src/shared/dictation-diagnostics.ts`;
- feature gate: `apps/browser/src/shared/feature-gates.ts`;
- hotkey: `apps/browser/src/shared/hotkeys.ts`;
- RPC contract: `apps/browser/src/shared/karton-contracts/ui/index.ts`;
- backend service: `apps/browser/src/backend/services/dictation.ts`;
- renderer lifecycle: `apps/browser/src/ui/hooks/use-dictation.ts`;
- renderer WebRTC transport:
  `apps/browser/src/ui/hooks/dictation-realtime.ts`;
- Settings diagnostics:
  `apps/browser/src/ui/screens/settings/sections/general-settings-section.tsx`;
- global state/Micro bridge:
  `apps/browser/src/ui/hooks/use-global-dictation.tsx`;
- composer control:
  `apps/browser/src/ui/screens/main/agent-chat/chat/_components/dictation-control.tsx`;
- draggable renderer orb:
  `apps/browser/src/ui/screens/main/_components/global-dictation-orb.tsx`;
- transcript insertion:
  `apps/browser/src/ui/screens/main/agent-chat/chat/_components/chat-input.tsx`;
- footer wiring:
  `apps/browser/src/ui/screens/main/agent-chat/chat/_components/panel-footer.tsx`.

## Следующие инкременты

1. Провести ручной hardware smoke-test разрешений, drag/focus, audio devices и
   MIME support на Windows и Linux.
2. Проверить UX совместного использования Dictation orb, Micro и Mascot,
   включая маленькие viewport и несколько дисплеев.
3. Измерить realtime latency, word error rate, fallback rate и стоимость на
   целевых языках/микрофонах до включения gate по умолчанию.
4. Рассмотреть отдельное native always-on-top окно только после renderer UX
   validation.
5. Рассмотреть локальный/offline STT как отдельный privacy-oriented backend.

Актуальная protocol база:

- OpenAI Realtime WebRTC:
  https://developers.openai.com/api/docs/guides/realtime-webrtc
- OpenAI Realtime transcription:
  https://developers.openai.com/api/docs/guides/realtime-transcription
