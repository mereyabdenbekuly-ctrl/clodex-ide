# Remote Control + Attestation MVP

## Scope

Этап 8 реализован как LAN-only защищённый протокол версии 2. Cloud relay,
публичный endpoint и входящие соединения из интернета не используются.

Основные свойства:

- одноразовый шестизначный pairing code с TTL 5 минут и rate limit;
- P-256 device signing key вместо bearer-token;
- software-held private key web-клиента сохраняется в origin-scoped
  IndexedDB; LAN bootstrap использует bundled pure-JS P-256/HKDF/AES-GCM,
  потому что WebCrypto `subtle` недоступен на insecure non-loopback HTTP
  origin;
- revoke удаляет сохранённый public key и закрывает активные сессии;
- новый pairing того же `deviceId` отзывает предыдущую регистрацию;
- server identity и случайный environment identity сохраняются локально в
  файле с mode `0600`.

Старые token-based клиенты не переносятся в protocol v2 и помечаются
отозванными, потому что bearer credential нельзя безопасно преобразовать в
device-bound key.

## Session protocol

WebSocket transport использует application-layer encryption:

1. Клиент отправляет подписанный session hello:
   - client id;
   - timestamp;
   - одноразовый nonce;
   - ephemeral P-256 ECDH public key.
2. Desktop проверяет device signature, freshness и отсутствие replay.
3. Desktop отвечает подписанным hello-ack со своим ephemeral key и
   challenge-bound environment attestation.
4. Обе стороны получают session key через P-256 ECDH + HKDF-SHA-256.
5. Команды и ответы шифруются AES-256-GCM.

Для каждого направления используется отдельный IV prefix и строго
монотонный sequence number. Повторный, пропущенный или переставленный sequence
закрывает сессию. Session keys не сохраняются и истекают через 15 минут.

HTTP используется только для локальной bootstrap/pairing страницы. Страница
загружает same-origin static client bundle под CSP `script-src 'self'`; inline
script запрещён. Содержимое команд после handshake не передаётся открытым
текстом. Production mobile client должен заменить software-held browser key и
HTTP bootstrap на подписанное приложение/deep link, OS keystore и доверенный
TLS transport, чтобы устранить риск извлечения ключа и активной подмены самой
LAN-страницы.

## Guardian и human approval

Каждая удалённая команда классифицируется в fixed-shape Guardian context без
message text, agent payload, approval arguments или другого raw content.

- `openThread` и `pushToTalkStop` могут пройти как low-risk;
- `sendMessage`, `newAgent`, `stopAgent`, `rejectTool` обычно эскалируются;
- `pushToTalkStart` считается privileged microphone action;
- `approveTool` всегда irreversible и всегда требует однократного desktop
  approval независимо от ответа Guardian.

Переключатель `Allow remote commands` остаётся master switch. Он не отменяет
Guardian и per-command confirmation. Pending approval хранит только command
kind, client label, risk, explanation и timestamps; payload в state не
попадает.

## Desktop environment attestation

Desktop выдаёт challenge-bound signed attestation со следующими полями:

- protocol version;
- random server id и environment id;
- app version и release channel;
- OS platform и architecture;
- fingerprint server signing key;
- issued/expiry timestamps;
- caller challenge.

Подпись выполняется persistent P-256 server identity. Pairing proof и session
hello одновременно служат client key-possession attestation.

Для web-клиента это software attestation: она подтверждает владение
software-held P-256 ключом, но не происхождение приложения или hardware
security boundary.

## Native hardware-backed attestation contract

Protocol v2 теперь принимает optional discriminated native evidence:

- `apple-app-attest` для iOS;
- `android-play-integrity` для Android;
- `apple-secure-enclave` для будущего desktop-native Apple verifier;
- `tpm` для desktop-native TPM verifier.

Hardware evidence привязывается не только к произвольному nonce. Клиент и
verifier используют SHA-256 от canonical payload:

```json
{
  "context": "clodex.remote.native-attestation.v1",
  "protocolVersion": 2,
  "pairingNonce": "<client nonce>",
  "deviceId": "<client installation UUID>",
  "signingKeyFingerprint": "<SHA-256 fingerprint of P-256 SPKI>"
}
```

Таким образом provider verdict связан с конкретным pairing attempt,
device-bound signing key и protocol version. Полный `nativeAttestation`
также входит в подписанный pairing request.

Desktop использует injected server-side verifier contract. Verifier обязан:

1. проверить signature/certificate/token/quote по правилам провайдера;
2. вернуть именно проверенный challenge;
3. проверить app identity, package/bundle identity и configured trust roots;
4. вернуть проверенный policy freshness interval;
5. вернуть privacy-safe replay id.

Переданное hardware evidence **fail closed**, если verifier отсутствует,
провайдер не соответствует платформе, challenge не совпадает, verdict
просрочен, evidence старше policy window или replay id уже использован.
Replay cache хранит только SHA-256-derived keys и expiry в owner-only secrets
file; raw assertion/token/quote туда не попадает.

Trust policy по умолчанию сохраняет совместимость: web и native clients без
evidence могут иметь `software` trust. Для `ios`, `android` и `desktop` policy
может потребовать `hardware-backed`; тогда отсутствие evidence блокирует
pairing.

Текущая реализация предоставляет protocol contract, policy enforcement,
provider dispatch abstraction, freshness/replay protection, state/UI/audit и
детерминированные verifier tests. Реальные Apple/Google/TPM production
verifiers требуют native client, provider configuration/trust roots и
physical-device evidence; без этого проект не заявляет, что App Attest, Play
Integrity, Secure Enclave или TPM проверены end-to-end.

## Audit и privacy

Telemetry/debug audit содержит только:

- operation;
- success;
- protocol version;
- command kind;
- Guardian decision/risk;
- irreversible flag;
- latency;
- coarse failure reason.
- trust level, provider kind и coarse attestation verdict.

В telemetry не передаются message text, pairing code, public/private keys,
IP/URL, client id, agent id, approval id, attestation challenge или command
payload. Raw App Attest object, Play Integrity token, Secure Enclave evidence,
TPM quote/certificate chain и verifier replay id также не передаются.

## Validation

Targeted tests покрывают:

- expiry и single-use pairing code;
- WebCrypto P-256 proof interoperability;
- pure-JS P-256 proof, ECDH/HKDF и AES-GCM interoperability;
- insecure LAN bootstrap без `crypto.subtle`, с external client bundle и CSP;
- non-loopback Chromium smoke на `http://<LAN-IP>` при
  `isSecureContext=false`: pairing, attestation, encrypted WebSocket session и
  low-risk command round-trip;
- signed environment attestation;
- отсутствие bearer-token storage;
- encrypted command envelopes;
- sequence replay shutdown;
- Guardian escalation и desktop approve/deny;
- irreversible remote tool approval;
- live revoke;
- pairing rate limit;
- invalid device signature;
- hardware-backed verifier success и trust metadata;
- required-but-missing native evidence;
- challenge mismatch и expired verdict;
- unsupported/unavailable provider verifier;
- persisted anti-replay across server restart;
- отсутствие raw native evidence в state, secrets и audit.

## Physical iOS/Android smoke

`pnpm smoke:remote-control-physical -- ...` создаёт fixed-shape owner-only
JSON evidence только после явного подтверждения всех device-only шагов:

- QR pairing;
- encrypted session;
- background/resume;
- Guardian approval;
- network handoff;
- revoke;
- hardware-attestation verdict;
- privacy audit.

Collector намеренно не принимает raw assertion/token/quote, pairing code,
device identifier, IP address или command payload. Команды и пошаговая
процедура описаны в `docs/remote-control-physical-smoke.md`.

Наличие harness не считается прохождением physical smoke. До запуска на
реальных iOS/Android устройствах соответствующие roadmap-пункты остаются
незавершёнными.
