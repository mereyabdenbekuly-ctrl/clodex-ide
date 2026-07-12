# Multi-Agent Guardian policy MVP

## Назначение

Guardian — отдельный read-only policy assessor перед потенциально опасными
действиями агента. Он возвращает одно из трёх решений:

- `approve` — действие обратимое, ограниченное и имеет низкий риск;
- `deny` — действие нарушает жёсткое ограничение;
- `escalate` — требуется стандартное подтверждение человеком.

Guardian не является исполнителем. У `GuardianService` нет зависимостей от
shell, browser, MCP, sandbox, credentials или model provider, поэтому сервис
не может выполнить проверяемое действие либо расширить свои разрешения.

## Feature gate

Флаг: `multi-agent-guardian`.

- experimental;
- доступен во всех release channels;
- default on для dogfood-каналов `dev`, `prerelease`, `nightly`;
- default off для `release`;
- пользовательский override может немедленно выключить Guardian на любом
  dogfood-канале;
- проверяется при каждом assessment, поэтому переключение применяется без
  пересборки toolset и без перезапуска приложения.

При выключенном флаге assessor возвращает `null`, а существующая approval
логика продолжает работать без изменений.

## Минимальный контекст

Guardian получает только строгий fixed-shape объект:

- `kind`: `shell | network | mcp | sandbox`;
- фиксированный action summary;
- `readOnly` и `irreversible`;
- resource scope;
- target trust class;
- operation class;
- не более восьми capability-кодов.

В контексте запрещены raw command, script, MCP arguments, URL/origin, prompt,
file content, transcript, credential и agent explanation. Domain adapter
локально превращает исходные данные в capability-сигналы до вызова Guardian.
Zod-схема strict: лишнее поле делает контекст невалидным и приводит к
fail-closed `escalate`.

## Маршрутизация

| Домен | Примеры сигналов | Поведение |
| --- | --- | --- |
| Shell | read-only inspection, bounded project checks, delete, network, remote execution, privileged access | Low-risk bounded actions могут пройти без smart classifier; irreversible всегда требуют человека; unbounded host deletion блокируется |
| Browser/network | read, click, history, file transfer, full CDP | `approve` не обходит существующую origin policy; `escalate` принудительно создаёт human prompt; явный block остаётся сильнее Guardian |
| MCP | read-only remote check, remote execution, destructive hint | Raw arguments не передаются; `ssh_exec` остаётся approval-required независимо от ответа assessor |
| Sandbox | bounded JS, filesystem mutation, CDP, fetch, credential access, arbitrary code | Low-risk isolated JS разрешается; side effects/credentials/CDP эскалируются; deny прекращает tool call |

## Необратимые операции

Защита дублируется:

1. `GuardianService` никогда не возвращает `approve` для
   `irreversible: true`.
2. Shell, MCP и sandbox integration повторно проверяют `irreversible` и
   запрашивают human approval даже при ошибочном ответе внешнего checker.
3. Пользовательский `alwaysAsk` никогда не обходится Guardian approval.
4. Existing explicit browser block никогда не превращается в allow.

## Аудит и приватность

Событие `guardian-assessed` содержит только:

- action kind;
- risk/decision;
- irreversible/read-only flags;
- количество capabilities/evidence;
- latency;
- valid-context flag.

Те же content-free metadata можно увидеть в Agent OS Debug Inspector в
канале `guardian`, если inspector отдельно включён. Summary и исходный
контекст в telemetry/debug audit не записываются.

## Dogfood ledger и ручная разметка

Каждый assessment получает случайный локальный correlation id. В Agent OS
state сохраняются только:

- timestamp;
- policy version;
- action kind, risk и decision;
- read-only/irreversible/valid-context flags;
- latency;
- необязательная feedback label.

Хранятся не более 100 последних assessments. Aggregate distribution по
decision, risk и action kind сохраняется отдельно и не обнуляется при очистке
списка последних событий.

UI расположен в `Settings → Agent OS → Guardian dogfood` и поддерживает:

- просмотр распределения `approve/deny/escalate`;
- распределение по risk и action kind;
- label `Correct`;
- label `Too strict` → `false-positive`;
- label `Too permissive` → `false-negative`;
- повторную разметку без двойного учёта;
- очистку списка последних assessments.

Assessment и feedback telemetry содержат policy version для разделения
результатов разных эвристик. `guardian-feedback-submitted` передаёт только
risk, decision, action kind, label, previous label, irreversible flag и
возраст assessment. После каждой изменённой label событие также содержит
content-free local readiness snapshot: status и счётчики sample/FP/FN для
текущей policy version. Correlation id и исходное действие не отправляются.
Для fleet-анализа следует брать последний snapshot каждого dogfood install,
а не суммировать все snapshots одного install.

## Release-readiness thresholds

Readiness считается отдельно для каждой версии policy. После изменения
эвристик новая версия не наследует статистическую готовность предыдущей.
Legacy ledger один раз backfill-ится из доступных последних assessments;
неизвлекаемые старые записи не считаются новой репрезентативной выборкой.

Операционные определения:

- false-positive rate = `Too strict` среди размеченных `deny/escalate`;
- false-negative rate = `Too permissive` среди размеченных `approve`;
- `Correct` допустим для любого решения;
- `Too strict` недопустим для `approve`, а `Too permissive` — для
  `deny/escalate`, чтобы знаменатели не смешивали разные outcome-классы.

Минимальные критерии release candidate для текущей policy version:

| Критерий | Порог |
| --- | --- |
| Всего размеченных assessments | не менее 250 |
| Доля размеченных assessments | не менее 30% |
| Размеченные `approve` | не менее 100 |
| Размеченные `deny/escalate` | не менее 100 |
| Разметка каждого kind | не менее 30 для shell/network/MCP/sandbox |
| False-positive rate | не более 10% |
| False-negative rate | не более 2% |

Readiness имеет три состояния:

- `collecting` — не пройдены sample/coverage gates;
- `needs-tuning` — выборка достаточна, но превышен FP или FN threshold;
- `candidate` — все автоматические критерии пройдены.

`candidate` является только рекомендацией. Он не включает Guardian в
`release`, не меняет feature gate и не заменяет явное подтверждение человеком.

## Проверка

Unit/integration coverage включает:

- gate-off совместимость;
- `approve / deny / escalate`;
- fail-closed на invalid context и assessor failure;
- shell override для `alwaysAllow` и сохранение `alwaysAsk`;
- принудительный browser prompt и приоритет explicit block;
- content-free MCP context;
- sandbox escalation/deny;
- обязательную human approval для irreversible actions;
- отсутствие raw action content в audit calls;
- persisted content-free dogfood distribution;
- deduplication, relabeling и feedback counters;
- per-policy cohort accumulation и one-time legacy backfill;
- release readiness sample/coverage/FP/FN thresholds;
- запрет несовместимых с decision feedback labels;
- dogfood channel defaults и пользовательский opt-out.

Основной smoke для разработки:

```bash
pnpm -F @clodex/agent-shell test
pnpm -F clodex test
pnpm -F clodex typecheck
```
