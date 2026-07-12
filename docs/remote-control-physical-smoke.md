# Remote Control physical iOS/Android smoke

Этот smoke выполняется только на физическом телефоне и desktop host в одной
локальной сети. Simulator, emulator, Chromium LAN bootstrap и unit tests не
считаются physical evidence.

## Preconditions

1. Native client build использует OS-protected device signing key.
2. Для iOS настроен server-side App Attest verifier.
3. Для Android настроен server-side Play Integrity verifier.
4. Desktop trust policy требует `hardware-backed` для проверяемой платформы.
5. В telemetry/debug включён content-free audit без raw evidence.
6. Известны app build, OS version и human-readable device model. Уникальный
   serial, advertising ID и raw provider evidence не записываются.

## Manual sequence

Для каждой платформы выполнить отдельный полный прогон:

1. **QR pairing**
   - создать новый one-time code;
   - отсканировать QR native client;
   - убедиться, что UI показывает `hardware-backed` и ожидаемый provider;
   - убедиться, что повторное использование pairing code отклоняется.
2. **Encrypted session**
   - подключить WebSocket session;
   - выполнить low-risk command;
   - убедиться, что plaintext command отсутствует в wire/debug evidence.
3. **Background/resume**
   - перевести приложение в background дольше обычного suspend interval;
   - вернуть foreground;
   - подтвердить новый signed handshake или корректное session recovery без
     replay старого hello/envelope.
4. **Guardian approval**
   - отправить команду, требующую escalation;
   - approve once на desktop;
   - повторить irreversible command и проверить deny path.
5. **Network handoff**
   - сменить Wi-Fi access point либо выполнить Wi-Fi → cellular → Wi-Fi;
   - старый transport должен закрыться;
   - после возврата в LAN выполнить authenticated reconnect без reuse sequence.
6. **Revoke**
   - отозвать client на desktop;
   - live session должна закрыться;
   - reconnect тем же ключом должен быть отклонён;
   - новый доступ возможен только через новый one-time pairing.
7. **Hardware attestation**
   - provider verdict соответствует bundle/package/build policy;
   - challenge совпадает с canonical pairing challenge;
   - expired и replayed evidence отклоняются;
   - UI показывает `hardware-backed`.
8. **Privacy audit**
   - state, owner-only secrets, telemetry и debug не содержат raw assertion,
     token, quote, certificate chain, replay id, pairing code или command
     payload.

## Evidence collection

iOS:

```bash
pnpm --dir apps/browser smoke:remote-control-physical -- \
  --platform ios \
  --device-model "Physical iPhone" \
  --os-version "<version>" \
  --app-build "<build>" \
  --attestation-provider apple-app-attest \
  --qr-pairing-passed \
  --encrypted-session-passed \
  --background-resume-passed \
  --guardian-approval-passed \
  --network-handoff-passed \
  --revoke-passed \
  --hardware-attestation-passed \
  --privacy-audit-passed
```

Android:

```bash
pnpm --dir apps/browser smoke:remote-control-physical -- \
  --platform android \
  --device-model "Physical Android device" \
  --os-version "<version>" \
  --app-build "<build>" \
  --attestation-provider android-play-integrity \
  --qr-pairing-passed \
  --encrypted-session-passed \
  --background-resume-passed \
  --guardian-approval-passed \
  --network-handoff-passed \
  --revoke-passed \
  --hardware-attestation-passed \
  --privacy-audit-passed
```

По умолчанию artifacts создаются в:

- `.release-evidence/remote-control-physical-ios.json`;
- `.release-evidence/remote-control-physical-android.json`.

Файл имеет fixed schema, outcome `passed`, mode `0600` на поддерживаемых
платформах и создаётся atomically. Если хотя бы один manual flag отсутствует,
collector завершается с code 1 и не создаёт passed artifact.

## Promotion rule

Remote Control hardware-backed rollout нельзя продвигать, пока:

- нет свежего artifact для обеих физических платформ;
- provider verifier работает в release configuration;
- false accept/reject для challenge, expiry и replay отрицательных тестов не
  обнаружены;
- human reviewer не подтвердил privacy audit и revoke behavior.
