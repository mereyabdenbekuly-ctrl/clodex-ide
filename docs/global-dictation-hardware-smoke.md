# Global Dictation hardware smoke

Автоматизированные тесты моделируют Chromium capability profiles, но не
заменяют проверку реального microphone device, OS permission prompt и сетевого
маршрута WebRTC.

## Execution status

- **macOS, July 10, 2026:** schema-v2 standalone Electron hardware smoke
  passed: microphone capture, `MediaRecorder`, Web Audio and WebRTC available;
  one physical audio track; peak level 43%; local data channel connected in
  198 ms. Capability mode отдельно прошёл с microphone outcome `skipped`;
  evidence file имел permissions `0600`.
- **Cross-platform automation, July 10, 2026:** capability-only Electron smoke
  добавлен в PR CI для Windows x64 и Linux x64. Он проверяет API, recorder MIME
  policy и локальный WebRTC data channel без запроса microphone permission.
  Отчёты публикуются как `clodex-dictation-smoke-win32-x64` и
  `clodex-dictation-smoke-linux-x64`.
- Provider WebRTC and complete composer/orb flow remain part of the manual app
  checklist because the current dev shell has a separate blank-window issue.
- Windows and Linux physical microphone/UI runs всё ещё требуют
  соответствующих hosts; capability smoke не считается их заменой.

## Общие предусловия

Для автономной проверки текущего компьютера без запуска основного shell:

```bash
pnpm -F clodex smoke:dictation-hardware
```

Команда не создаёт запись и не выполняет upload. Она три секунды измеряет
локальный RMS, останавливает microphone track и проверяет локальный WebRTC data
channel. Provider WebRTC отдельно проверяется кнопкой в Settings.

Для безопасной capability-проверки без открытия microphone device:

```bash
pnpm -F clodex smoke:dictation-capabilities -- \
  --expect-platform=linux \
  --output=../../dictation-smoke-linux-x64.json
```

Поддерживаемые параметры standalone harness:

- `--mode=hardware|capabilities` — по умолчанию `hardware`;
- `--expect-platform=darwin|linux|win32` — fail-closed проверка CI runner;
- `--output=<path>` — атомарно записать JSON evidence рядом с временным файлом.

Capability mode не вызывает `getUserMedia` и не показывает permission prompt.
Он проверяет наличие microphone capture API, `MediaRecorder`, Web Audio,
WebRTC, platform-specific MIME fallback и локальный WebRTC data channel.
Windows требует WebM/Opus или WebM; Linux принимает WebM/Opus, WebM либо
Ogg/Opus.

JSON report имеет фиксированную schema version 2 и не содержит device
labels/IDs, audio, transcript, SDP, ICE/IP candidates, API keys, request IDs,
username или output path. Файл создаётся с owner-only permissions там, где это
поддерживает ОС.

1. Включить `Global dictation`.
2. Для realtime включить `Realtime dictation` и подключить официальный OpenAI
   API key.
3. Открыть `Settings → General → Dictation diagnostics`.
4. Убедиться, что copied report не содержит audio, SDP, transcript, API key или
   request id.

## macOS

1. Проверить, что `Microphone capture API`, `Web Audio`, `MediaRecorder` и
   `WebRTC` доступны.
2. Запустить `Local microphone test`, выдать разрешение в системном prompt и
   говорить не менее двух секунд.
3. Ожидается `Signal detected`, ненулевой peak и автоматическая остановка через
   четыре секунды.
4. Повторить тест и нажать `Cancel`; системный индикатор микрофона должен
   погаснуть сразу.
5. Запустить `Realtime connection test`; ожидается `Connected` с latency и
   немедленное закрытие соединения.
6. Проверить composer mic, `Cmd+Shift+Space`, orb drag/focus и Agent OS Micro
   push-to-talk.
7. Во время permission, recording и finalization скрыть окно; операция должна
   отмениться без вставки текста.

## Windows

Повторить общий сценарий и дополнительно:

- проверить Windows Privacy & security → Microphone permission;
- подтвердить WebM/Opus recorder MIME;
- проверить orb pointer focus и keyboard arrows при display scaling 100% и
  150%;
- проверить cancel при minimize и смене активного agent.

## Linux

Повторить общий сценарий и дополнительно:

- проверить PipeWire/PulseAudio device selection;
- подтвердить WebM/Opus или Ogg/Opus MIME fallback;
- проверить Wayland и X11, если доступны;
- проверить orb focus, hide/minimize cancellation и отсутствие оставшегося
  capture indicator.

## Pass criteria

- capability CI: platform совпал, все четыре API доступны, recorder MIME
  соответствует OS policy, local data channel подключился, microphone outcome
  равен `skipped`;
- transcript вставлен ровно один раз;
- partial transcript никогда не меняет draft;
- stale session не изменяет новый agent/draft;
- после cancel/hide/gate-off нет активных tracks, `AudioContext`, timers,
  backend requests, data channels или peer connections;
- fallback reason и latency отображаются без чувствительного содержимого.
