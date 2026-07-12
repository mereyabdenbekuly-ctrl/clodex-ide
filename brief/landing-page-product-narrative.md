# Landing Page Product Narrative — Clodex Agentic IDE

**Состояние продукта:** 11 июля 2026 года
**Назначение:** контентный и продуктовый бриф для полной переработки главной
страницы `clodex.io`
**Основная страница:** `apps/website/src/app/(home)/page.tsx`

---

## 1. Главный вывод

Текущий landing page продаёт только небольшую часть Clodex:

- поддержку разных моделей;
- свободу выбора моделей и провайдеров;
- cache efficiency;
- параллельный запуск агентов;
- использование существующих подписок.

Это полезные преимущества, но они не объясняют сам продукт.

Clodex уже значительно шире, чем «интерфейс для AI-моделей». Это полноценная
agentic development environment, объединяющая:

- persistent tasks и projects;
- code editing и pending edits;
- file tree, terminal и browser;
- workspaces и worktrees;
- multi-agent Swarm;
- GitHub pull request review и protected merge;
- Generated Apps;
- Skills, Plugins и signed marketplaces;
- MCP runtime;
- SSH/remote environments;
- memory;
- Guardian и approvals;
- encrypted local data;
- Quick Task, dictation и remote control;
- local/cloud execution foundation.

### Основная проблема текущей страницы

Посетитель видит «ещё один AI coding client с выбором моделей», хотя реальная
ценность продукта:

> Clodex даёт агенту не только модель и чат, а управляемую среду выполнения
> всей инженерной задачи — от запроса и кода до проверки, запуска, review и
> merge.

---

## 2. Рекомендуемое позиционирование

### Product category

**Agentic IDE for the complete development loop**

Не:

- AI chat for coding;
- model router;
- browser with an assistant;
- multi-model frontend;
- ещё один autocomplete.

### One-line positioning

> Clodex is the Agentic IDE where agents can plan, code, run, browse, review,
> and finish work across your entire development environment.

### Короткая русская формула

> Agentic IDE, в которой агент получает всю среду разработки и может довести
> задачу до проверенного результата.

### Главная идея

**One task. Every tool. Full control.**

### Альтернативная формула

**Give agents the whole job — not just the next code edit.**

---

## 3. Основной product promise

Clodex должен обещать не «самый умный AI» и не «больше моделей».

Правильное обещание:

> Вы ставите инженерную задачу. Clodex даёт агенту контекст проекта,
> изолированные инструменты, терминал, браузер, GitHub, MCP, remote
> environments и policy boundaries. Вы сохраняете контроль над изменениями,
> разрешениями и финальным результатом.

Составляющие promise:

1. **Полный workflow**, а не только генерация кода.
2. **Persistent task context**, а не одноразовый chat.
3. **Реальные инструменты**, а не текстовые советы.
4. **Human control**, а не непрозрачная автономность.
5. **Model freedom**, а не vendor lock-in.
6. **Extensible platform**, а не закрытый набор tools.
7. **Local-first security**, а не бесконтрольная отправка данных.

---

## 4. Целевая аудитория

### 4.1 Solo developers и indie hackers

Задачи:

- быстрее собирать полноценные features;
- не переключаться между chat, terminal, browser и GitHub;
- запускать долгие задачи;
- генерировать внутренние tools и mini-apps;
- использовать доступную или локальную модель.

Сообщение:

> One developer can operate like a small engineering team without giving up
> control of the codebase.

### 4.2 Product engineers

Задачи:

- разбирать существующие codebases;
- реализовывать и проверять изменения;
- работать с worktrees;
- review diff до применения;
- запускать tests и browser workflows;
- открывать PR и проходить review loop.

Сообщение:

> Keep the agent inside the same workflow you already use to build, verify,
> and review software.

### 4.3 Tech leads и engineering teams

Задачи:

- стандартизировать permissions;
- подключать внутренние MCP tools;
- распространять signed plugins;
- использовать private marketplace;
- контролировать риск agent actions;
- применять свои models и infrastructure.

Сообщение:

> A controllable agent platform your team can configure, extend, and run on
> its own terms.

### 4.4 AI-native teams

Задачи:

- parallel agent execution;
- Swarm;
- cloud tasks;
- remote workspaces;
- generated artifacts/apps;
- model routing;
- memory и automation.

Сообщение:

> Build an agentic engineering system instead of assembling disconnected
> scripts, chats, and dashboards.

### 4.5 Security-conscious и self-hosted users

Задачи:

- local inference;
- BYOK;
- encrypted storage;
- human approvals;
- signed extensions;
- private MCP and plugins;
- controlled local and private infrastructure.

Сообщение:

> Use powerful agents without turning your development environment into an
> opaque trust boundary.

---

## 5. Боли рынка

## Pain 1 — AI coding tools видят только часть работы

Обычный coding assistant:

- отвечает в чате;
- предлагает patch;
- не владеет terminal/browser/GitHub workflow;
- теряет состояние между инструментами;
- останавливается до проверки результата.

### Решение Clodex

Одна task environment объединяет:

- conversation;
- repository;
- files;
- pending edits;
- terminal;
- browser;
- Git;
- pull request;
- MCP;
- remote connections;
- generated artifacts.

Landing message:

> Most coding agents stop at the patch. Clodex gives them the environment to
> run, inspect, review, and finish the task.

---

## Pain 2 — Разработчик постоянно пересобирает контекст

Проблемы:

- нужно снова объяснять архитектуру;
- chat не знает, что изменилось в terminal или browser;
- долгие tasks раздувают token context;
- разные agents не имеют общей task structure;
- project history быстро превращается в список несвязанных чатов.

### Решение Clodex

- persistent task history;
- Projects и workspace grouping;
- context deltas;
- history compression;
- workspace/agent/global memory;
- stable environment metadata;
- cache-aware prompt pipeline.

Landing message:

> Clodex treats work as a persistent engineering task, not a disposable chat.

---

## Pain 3 — Автономность без контроля опасна

Проблемы:

- shell и network actions непрозрачны;
- tools сами объявляют себя read-only;
- secrets попадают в configs и logs;
- browser/desktop automation может сделать необратимое действие;
- plugins расширяют attack surface.

### Решение Clodex

- Guardian;
- explicit allow/ask/deny;
- human approval;
- origin-bound credentials;
- protected storage;
- isolated MCP host;
- signed plugins;
- publisher signing;
- source-scoped private marketplace provenance;
- content-free audit.

Landing message:

> Real autonomy needs real boundaries. Every powerful capability in Clodex is
> paired with permissions, provenance, and human control.

---

## Pain 4 — Инструменты разработки фрагментированы

Типичный workflow:

1. задача в одном tool;
2. код в IDE;
3. command в terminal;
4. browser test отдельно;
5. PR в GitHub;
6. remote server через SSH;
7. internal tools через scripts;
8. secrets в нескольких configs.

### Решение Clodex

Clodex соединяет их внутри одного agent runtime:

- file editing;
- terminal;
- browser;
- GitHub review;
- SSH;
- MCP;
- plugins;
- generated apps;
- cloud execution.

Landing message:

> Stop rebuilding the same context across six tools. Clodex gives agents one
> workspace for the whole development loop.

---

## Pain 5 — Model lock-in ограничивает качество и стоимость

Проблемы:

- одна модель не лучшая для всех задач;
- frontier models дорогие;
- private и local models требуют отдельной инфраструктуры;
- provider subscriptions нельзя использовать вместе.

### Решение Clodex

- Clodex Cloud Inference;
- BYOK;
- external subscriptions;
- OpenAI-compatible endpoints;
- Anthropic Messages API;
- local Ollama/vLLM;
- model/reasoning selection.

Landing message:

> Choose the right model for each job — frontier, private, cloud, BYOK, or
> local.

---

## Pain 6 — Extensibility обычно означает новый supply-chain risk

Проблемы:

- arbitrary scripts;
- неясные permissions;
- plugin packages могут измениться;
- private registries часто используют TOFU;
- extension update может заменить trust root.

### Решение Clodex

- Skills;
- typed MCP runtime;
- signed official marketplace;
- publisher signatures;
- integrity lockfile;
- rollback;
- startup quarantine;
- explicitly pinned private marketplaces;
- source-scoped provenance.

Landing message:

> Extend the IDE without abandoning verification. Plugins declare what they
> need, packages are verified, and marketplace trust is explicit.

---

## 6. Ключевые продуктовые pillars

Landing не должен показывать все функции одинаково. Рекомендуется шесть
верхнеуровневых pillars.

### Pillar 1 — Task-native development

Пользовательская ценность:

- каждая задача имеет собственный контекст;
- project/workspace history сохраняется;
- изменения, terminals, browser и artifacts относятся к задаче;
- task можно продолжить, а не начинать заново.

Функции:

- task sidebar;
- Projects;
- workspace grouping;
- task search;
- resume;
- worktree actions;
- collaboration modes;
- plan/implement/review workflows;
- Quick Task.

Headline:

> Work in tasks, not disposable chats.

Copy:

> Every Clodex task keeps the conversation, workspace, tools, edits, and
> execution state together. Resume work without reconstructing the entire
> problem.

---

### Pillar 2 — Full development loop

Пользовательская ценность:

- агент может не только написать код;
- результат можно запустить и проверить;
- developer видит diff;
- работа доводится до PR review и merge.

Функции:

- file tree;
- code editing;
- pending edits;
- accept/reject;
- terminal;
- browser tabs;
- browser automation;
- Git;
- diff review;
- hosted PR review;
- inline comments;
- approve/request changes;
- protected merge.

Headline:

> From request to reviewed code.

Copy:

> Let the agent explore the codebase, edit files, run commands, inspect the
> browser, and prepare the result. Review every change in a first-class diff
> before it reaches your branch.

---

### Pillar 3 — Agent orchestration

Пользовательская ценность:

- сложные задачи можно разбивать;
- специализированные workers выполняют части работы;
- длительные процессы не должны блокировать основной flow;
- local/cloud execution выбирается по policy.

Функции:

- Swarm orchestrator;
- worker roles;
- multi-agent progress;
- collaboration modes;
- Guardian routing;
- Cloud Tasks foundation;
- artifacts/resume;
- execution targets;
- quotas.

Headline:

> Orchestrate agents, not chat windows.

Copy:

> Split complex work across focused workers, keep progress visible, and bring
> the results back into one reviewable task.

Ограничение claim:

- не обещать полноценный independent background task manager до закрытия
  соответствующего gap;
- Cloud Tasks маркировать как preview до production promotion evidence.

---

### Pillar 4 — Connect the whole environment

Пользовательская ценность:

- agent получает controlled access к нужным системам;
- internal tools подключаются стандартным способом;
- remote environments не требуют копировать context вручную.

Функции:

- MCP stdio;
- Streamable HTTP;
- SSE;
- OAuth;
- resources;
- prompts;
- elicitation;
- SSH profiles;
- persistent SSH sessions;
- terminal handoff;
- remote execution;
- browser;
- desktop automation preview.

Headline:

> Connect agents to the tools your work actually depends on.

Copy:

> Add local tools, internal services, documentation, databases, browsers, and
> remote machines through MCP, SSH, and controlled automation.

---

### Pillar 5 — Extensible by design

Пользовательская ценность:

- reusable knowledge и tools можно упаковать;
- team workflows не нужно повторять в prompt;
- plugins устанавливаются управляемо.

Функции:

- Skills;
- bundled plugins;
- Plugin Library;
- official marketplace;
- publisher signing;
- private marketplaces;
- compatibility;
- permissions;
- encrypted credentials;
- Generated Apps.

Headline:

> Turn repeatable work into reusable capabilities.

Copy:

> Package workflows as skills, connect tools through MCP, distribute signed
> plugins, or let agents generate focused apps for the task at hand.

---

### Pillar 6 — Security as product behavior

Пользовательская ценность:

- пользователь понимает, что агент может сделать;
- dangerous actions требуют согласия;
- secrets и local artifacts защищены;
- plugin provenance проверяется.

Функции:

- Guardian;
- approval modes;
- encrypted credentials;
- protected files;
- origin binding;
- content-free telemetry;
- signed marketplace;
- private key pinning;
- rollback/quarantine;
- remote attestation.

Headline:

> Powerful agents. Explicit boundaries.

Copy:

> Clodex combines human approvals, isolated runtimes, encrypted local data,
> signed extensions, and fail-closed policies so capability never silently
> becomes authority.

---

## 7. Ноу-хау Clodex

Этот раздел нужен для объяснения, почему продукт нельзя воспроизвести обычной
обёрткой вокруг LLM API.

### 7.1 Agent OS

Clodex использует отдельный runtime layer для:

- agents;
- tools;
- environment state;
- execution targets;
- policy;
- artifacts;
- memory;
- collaboration.

Marketing formulation:

> A runtime for agentic software development — not a prompt wrapped in an
> editor.

### 7.2 Stable context + environment deltas

Вместо полной пересборки prompt:

- conversation prefix остаётся стабильным;
- environment changes передаются компактно;
- long histories сжимаются;
- cache-hit rate повышается;
- context остаётся focused.

Marketing formulation:

> Long-running tasks stay aware of the environment without resending the
> entire world on every turn.

Важно:

- числовой claim `87.6% Avg. Cache Hit Rate` оставлять только при наличии
  воспроизводимой публичной methodology;
- без methodology лучше использовать качественную формулировку.

### 7.3 Pending Edits

Изменения агента не обязаны сразу становиться изменениями пользователя.

- diff review;
- accept/reject per file;
- accept/reject all;
- history;
- safe handoff.

Marketing formulation:

> Agents propose. You review. The workspace changes only on your terms.

### 7.4 Guardian

Guardian не выполняет действие. Он оценивает:

- risk;
- evidence;
- policy;
- need for approval.

Marketing formulation:

> A separate policy layer evaluates risky actions before execution.

### 7.5 Protected data plane

Clodex защищает:

- attachments;
- shell logs;
- memory;
- Chronicle;
- diff history;
- caches;
- agent titles.

Marketing formulation:

> Sensitive task artifacts are encrypted at rest instead of being left across
> plaintext workspace folders.

### 7.6 Isolated MCP runtime

- отдельный Electron utility process;
- local stdio без shell;
- remote HTTP/SSE;
- timeout/cancel/restart;
- redaction;
- credentials resolved in main.

Marketing formulation:

> Connect tools through MCP without turning the renderer or main application
> process into an unbounded execution surface.

### 7.7 Verified plugin supply chain

- catalog signature;
- publisher signature;
- package SHA-256;
- tree integrity;
- staging;
- rollback;
- quarantine;
- private source pinning.

Marketing formulation:

> Plugins are installed through a verified supply chain with declared
> permissions and recoverable updates.

### 7.8 Generated App ownership

Generated Apps принадлежат owner task:

- filesystem source of truth;
- containment;
- safe delete;
- regeneration через owner;
- sandboxed preview.

Marketing formulation:

> Agents can turn results into interactive apps without losing ownership or
> filesystem boundaries.

### 7.9 Hybrid execution target

Local/cloud task abstraction:

- deterministic snapshots;
- encryption;
- secret broker;
- bounded event stream;
- artifacts;
- resume;
- quotas.

Marketing formulation после production promotion:

> Start work locally, move long-running execution to controlled cloud workers,
> and bring verified artifacts back to the same task.

До promotion использовать label **Preview**.

---

## 8. Функциональная карта для landing

### Tasks and workflow

- persistent tasks;
- Projects;
- task search;
- workspace grouping;
- worktrees;
- collaboration modes;
- Quick Task window;
- global shortcut;
- planning;
- implementation;
- review.

### Code and repository

- file tree;
- read/search;
- multi-file edits;
- pending edits;
- diff review;
- Git;
- terminals;
- worktree setup scripts;
- workspace mounts.

### Browser and apps

- browsing tabs;
- previews;
- CDP automation;
- origin-scoped approvals;
- Generated App Library;
- sandboxed app previews;
- artifact bridge.

### GitHub

- PR detection;
- metadata;
- checks;
- commits;
- changed files;
- inline comments;
- approve;
- request changes;
- protected merge.

### Agent collaboration

- Swarm;
- worker roles;
- progress;
- Guardian;
- collaboration presets;
- local/cloud target foundation.

### Knowledge and context

- memory notes;
- scopes;
- search;
- history compression;
- workspace metadata;
- Skills;
- MCP resources;
- MCP prompts.

### Integrations

- MCP stdio;
- Streamable HTTP;
- SSE;
- OAuth;
- plugin MCP;
- SSH;
- browser automation;
- desktop automation preview.

### Security

- encrypted credentials;
- protected files;
- approval policies;
- Guardian;
- signed plugins;
- publisher identities;
- private marketplace pinning;
- remote attestation;
- content-free audit.

### Input and access

- Quick Task;
- global dictation;
- draggable dictation orb;
- remote control pairing;
- terminal handoff;
- multi-platform desktop app.

### Models

- Clodex Cloud;
- BYOK;
- subscriptions;
- OpenAI-compatible providers;
- Anthropic-compatible providers;
- local inference;
- model/reasoning selection.

---

## 9. Активно разрабатываемые gaps

Эти функции пользователь сейчас допиливает. Их нельзя описывать как полностью
shipped до отдельного validation pass.

### 9.1 Fork задачи с history и lineage

Проблема:

- новая ветка рассуждения теряет связь с родительской задачей;
- нет прозрачной parent/child topology;
- трудно сравнить альтернативные решения.

Будущий landing claim:

> Fork any task with its full context, preserve lineage, and explore a new
> approach without losing the original.

До завершения:

- не использовать `fork any task`;
- можно говорить только о Projects, tasks и worktrees.

### 9.2 Настоящий archive/unarchive

Проблема:

- текущий `agents.archive` выгружает agent, но не является полноценным
  пользовательским lifecycle;
- нет отдельного archived state и восстановления.

Будущий claim:

> Archive completed work without deleting its context, then restore it when
> the project needs another pass.

### 9.3 Task Goals

Планируемые данные:

- objective;
- status;
- token budget;
- time budget;
- completion state.

Будущий claim:

> Give every task a concrete objective, measurable status, and explicit token
> or time budget.

### 9.4 Token usage и rate-limit dashboard

Проблема:

- расходы и limits трудно контролировать;
- использование разных providers непрозрачно;
- agent runtime не показывает единую operational picture.

Будущий claim:

> See exact token usage, cost, context pressure, and provider rate limits
> across every task.

Не публиковать точный usage claim до проверки provider accounting.

### 9.5 Unified Permission Profiles

Области:

- filesystem;
- network;
- shell;
- browser;
- MCP.

Будущий claim:

> Define one permission profile and apply it consistently across files,
> network, shell, browser, and MCP tools.

Это один из сильнейших будущих differentiators.

### 9.6 Менеджер фоновых процессов задачи

Проблема:

- servers, watchers, dev processes и long-running commands живут раздельно;
- агенту и пользователю нужен единый lifecycle.

Будущий claim:

> Keep dev servers, watchers, and background jobs attached to the task that
> started them.

### 9.7 Live steering активного turn

Проблема:

- пользователь вынужден ждать завершения или полностью останавливать agent;
- нет безопасного mid-turn correction.

Будущий claim:

> Redirect an active agent without discarding the work it has already done.

### 9.8 Импорт Codex/Claude configurations и sessions

Проблема:

- migration требует ручной настройки;
- history и MCP configuration остаются в старом product.

Будущий claim:

> Bring your existing coding-agent setup and task history with you.

Security:

- не импортировать raw OAuth/session tokens;
- показывать preview;
- преобразовывать secrets в Clodex credentials;
- маркировать imported content как untrusted.

### 9.9 Расширенная trust-модель hooks

Проблема:

- hooks могут выполнять код вне ожидаемого tool policy;
- source, signature и permission scope должны быть явными.

Будущий claim:

> Automate lifecycle hooks with explicit provenance, permissions, and review.

### 9.10 Sharing/team distribution для plugins

Проблема:

- signed/private marketplace существует;
- team publishing, access policy, channels и distribution UX ещё нужно
  завершить.

Будущий claim:

> Publish verified internal capabilities to your team through controlled
> private channels.

---

## 10. Как показывать roadmap на сайте

Не рекомендуется помещать все gaps в основной feature grid.

Лучший вариант:

- основной landing описывает только shipped capabilities;
- preview-функции получают badge `Preview`;
- активно разрабатываемые функции помещаются в блок:
  **The task control layer we are building next**;
- блок содержит максимум 4 темы:
  - task lineage and forks;
  - goals, budgets and usage;
  - unified permission profiles;
  - background processes and live steering.

Import и team distribution лучше оставить для отдельного roadmap/changelog.

---

## 11. Рекомендуемая структура landing page

## Section 1 — Hero

Eyebrow:

> Agentic IDE for the complete development loop

Headline:

> Give agents the whole job — not just the next code edit.

Subheadline:

> Clodex gives coding agents a complete development environment: your
> codebase, terminal, browser, GitHub, MCP tools, remote machines, and
> review workflow — with explicit permissions and human control.

Supporting line:

> Work locally or remotely. Use the right model. Stay in control.

Primary CTA:

> Download Clodex

Secondary CTA:

> Explore the platform

Optional tertiary:

> Contact sales

Proof chips:

- macOS, Windows, Linux;
- Cloud, private and local models;
- Local-first task runtime.

### Alternative hero

Headline:

> From task to shipped software.

Subheadline:

> Plan, code, run, browse, review, and merge with agents that work across your
> entire development environment.

---

## Section 2 — Pain statement

Heading:

> Coding agents are powerful. Their workflow is still fragmented.

Cards:

### They stop at the patch

> A code suggestion is not a finished task. The result still needs to run,
> pass checks, survive review, and integrate with the rest of the project.

### They lose the environment

> Context is scattered across chats, terminals, browser tabs, GitHub, and
> remote machines.

### They gain power without clear boundaries

> Shell, network, browser, plugins, and secrets need a consistent permission
> model — not a collection of hidden defaults.

Closing:

> Clodex turns these disconnected surfaces into one controlled task
> environment.

---

## Section 3 — End-to-end workflow

Heading:

> One task. The complete development loop.

Steps:

1. **Describe the outcome**
   - start from Quick Task, Projects, or a workspace.
2. **Explore and plan**
   - inspect code, history, memory, docs, MCP resources.
3. **Implement**
   - edit files, use worktrees, run terminals, coordinate workers.
4. **Verify**
   - run tests, inspect browser behavior, connect remote environments.
5. **Review**
   - inspect pending edits and line-by-line diffs.
6. **Ship**
   - review the pull request, comment, approve, or merge through protected
     gates.

Visual:

- wide task screenshot;
- overlaid workflow labels;
- optional animated path through file tree → terminal → diff → PR.

---

## Section 4 — Task-native environment

Heading:

> The task is the workspace.

Copy:

> Conversations, code, terminals, browser state, edits, artifacts, and
> execution stay attached to the work they belong to.

Feature bullets:

- Projects and persistent task history;
- workspace and worktree actions;
- collaboration modes;
- memory scoped to global, workspace, or agent;
- Quick Task from a global shortcut.

Future badge:

> In development: task forks, lineage, goals, budgets, and real archive.

---

## Section 5 — Code, run, review

Heading:

> Agents can do the work. You still control the change.

Copy:

> Clodex combines file editing, terminal execution, browser inspection, and
> Pending Edits. Review every file before accepting the result.

Feature bullets:

- multi-file edits;
- integrated terminals;
- browser tabs and preview;
- pending edits;
- diff review;
- accept/reject;
- Git and worktrees.

Visual:

- split view with agent, file tree and diff.

---

## Section 6 — GitHub workflow

Heading:

> Review and ship without leaving the IDE.

Copy:

> Open a pull request, inspect checks and changed files, leave inline
> comments, approve or request changes, and merge only after backend policy
> gates pass.

Feature bullets:

- PR detection;
- checks and commits;
- line-numbered patches;
- inline comment drafts;
- review submission;
- branch protection-aware merge;
- stale-head protection.

---

## Section 7 — Agent orchestration

Heading:

> One interface for many agents.

Copy:

> Break complex work into focused roles, monitor progress, and review the
> combined result from the same task.

Feature bullets:

- Swarm;
- worker roles;
- collaboration modes;
- Guardian assessment;
- local/cloud execution target foundation;
- resumable artifacts.

Badge:

> Cloud execution: Preview

Do not claim yet:

- complete task background-process manager;
- live steering;
- exact task budgets.

---

## Section 8 — MCP, SSH and environment integrations

Heading:

> Connect the systems behind the code.

Copy:

> Give agents controlled access to local tools, internal services,
> documentation, databases, remote machines, and custom workflows.

Feature groups:

### MCP

- stdio;
- Streamable HTTP;
- SSE;
- OAuth;
- resources;
- prompts;
- elicitation.

### Remote

- encrypted SSH profiles;
- persistent sessions;
- remote execution;
- integrated terminal handoff.

### Automation

- browser/CDP;
- origin-scoped approvals;
- macOS desktop automation preview.

---

## Section 9 — Skills, plugins and generated apps

Heading:

> Make the IDE learn your workflow.

Copy:

> Turn repeatable instructions into skills, connect tools through MCP,
> distribute verified plugins, and let agents build interactive apps around
> their results.

Feature bullets:

- Skills;
- Plugin Library;
- signed official marketplace;
- publisher identities;
- pinned private marketplaces;
- encrypted plugin credentials;
- Generated App Library;
- sandboxed previews.

Future:

> Team plugin distribution is in development.

---

## Section 10 — Security

Heading:

> Autonomy with an explicit trust model.

Subheading:

> Clodex is designed around the assumption that tools, plugins, remote
> services, and generated content can be wrong or malicious.

Cards:

### Human approval

> Irreversible and destructive actions require explicit confirmation.

### Guardian policy

> A separate risk layer evaluates shell, network, browser, MCP, and remote
> actions.

### Encrypted local data

> Credentials and sensitive task artifacts are encrypted at rest.

### Isolated tool runtimes

> MCP servers run behind a typed, bounded utility-process boundary.

### Verified plugins

> Catalog, publisher, package integrity, rollback, quarantine, and private
> source pinning.

### Privacy-safe telemetry

> Audit events describe actions without storing prompts, files, screenshots,
> audio, or secrets.

CTA:

> Read the security model

---

## Section 11 — Model freedom

Model showcase нужно переместить ниже product workflow.

Heading:

> Use the right model for the task.

Copy:

> Connect frontier providers, private models, your existing subscriptions,
> or local inference through one agent environment.

Groups:

- Clodex Cloud;
- BYOK;
- external subscriptions;
- local inference.

Это важный differentiator, но не главный hero message.

---

## Section 12 — Enterprise control and deployment

Heading:

> Configure it. Extend it. Run it on your terms.

Copy:

> Clodex is an open-source Agentic IDE designed for teams that need
> control over models, integrations, data, permissions, and deployment.

Enterprise bullets:

- private marketplaces;
- internal MCP;
- custom providers;
- local or controlled infrastructure;
- signed capabilities;
- audit and permission policy.

---

## Section 13 — Coming next

Heading:

> The next layer of task control.

Cards:

1. **Task forks and lineage**
2. **Goals, budgets and exact usage**
3. **Unified permission profiles**
4. **Background processes and live steering**

Label:

> In active development

Не указывать release date без утверждённого schedule.

---

## Section 14 — Final CTA

Headline:

> Give your agents a real development environment.

Subheadline:

> Download Clodex, choose your model, and start with a task.

Buttons:

- Download Clodex;
- Explore the platform.

---

## 12. Ready-to-use homepage copy

## Metadata

Title:

> Clodex — Agentic IDE for the Complete Development Loop

Description:

> Plan, code, run, review, and ship with AI agents that work across your
> codebase, terminal, browser, GitHub, MCP tools, and remote environments.
> Local-first, secure, extensible, and model-independent.

Open Graph title:

> Give agents the whole job — Clodex Agentic IDE

Open Graph description:

> A complete development environment for coding agents, with persistent
> tasks, terminals, browser automation, GitHub review, MCP, plugins, and
> explicit security controls.

## Hero

```text
Agentic IDE for the complete development loop

Give agents the whole job —
not just the next code edit.

Clodex gives coding agents a complete development environment: your codebase,
terminal, browser, GitHub, MCP tools, remote machines, and review workflow —
with explicit permissions and human control.

Work locally or remotely. Use the right model. Stay in control.

[Download Clodex] [Explore the platform]
```

## Product proof bar

```text
Persistent tasks
Integrated terminal and browser
Pending Edits and diff review
GitHub PR review and protected merge
MCP and signed plugins
Encrypted local data
```

## Pain section

```text
Coding agents are powerful.
Their workflow is still fragmented.

They stop at the patch.
A suggestion is not a finished task. Code still needs to run, pass checks,
survive review, and integrate with the rest of the project.

They lose the environment.
Context is scattered across chats, terminals, browser tabs, GitHub, and remote
machines.

They gain power without clear boundaries.
Shell, network, browser, plugins, and secrets need one explicit trust model.

Clodex turns these disconnected surfaces into one controlled task environment.
```

## Core value section

```text
One task. The complete development loop.

Describe the outcome.
Let the agent inspect the codebase and build a plan.

Implement.
Edit files, run commands, browse the app, and coordinate focused workers.

Verify.
Run tests, inspect browser behavior, and connect remote environments.

Review.
See every proposed change in Pending Edits and line-by-line diffs.

Ship.
Review the pull request, leave comments, approve, or merge through protected
gates.
```

## Security section

```text
Powerful agents. Explicit boundaries.

Clodex pairs every high-impact capability with a trust model:

Human approvals for destructive actions.
Guardian risk assessment before execution.
Encrypted credentials and task artifacts.
Isolated MCP runtimes with timeout and redaction.
Signed plugins with integrity checks and rollback.
Pinned private marketplaces without trust-on-first-use.
```

## Enterprise control section

```text
Your models. Your tools. Your control.

Use cloud providers, private models, your existing subscriptions, or local
inference. Connect internal tools through MCP. Package workflows as skills.
Distribute verified plugins through controlled private channels.
```

---

## 13. FAQ для новой страницы

### What makes Clodex different from an AI code editor?

> Clodex is built around persistent engineering tasks rather than isolated
> prompts or autocomplete. Agents can work across files, terminals, browser
> tabs, GitHub pull requests, MCP tools, and remote environments, while you
> review changes and control permissions.

### Can Clodex run tasks autonomously?

> Clodex can execute multi-step coding workflows and coordinate agent workers,
> but autonomy remains bounded by tool policies and human approvals.
> Destructive or irreversible actions require explicit confirmation.

### Can I review changes before they are applied?

> Yes. Agent changes appear as Pending Edits with file-level and line-level
> diffs. You can accept or reject individual changes or the full set.

### Does Clodex support GitHub pull requests?

> Yes. Clodex can inspect pull request metadata, checks, commits, and changed
> files; draft inline comments; submit reviews; and perform protected merges
> after backend policy gates pass.

### What can I connect through MCP?

> Clodex supports local stdio servers, Streamable HTTP, legacy SSE, OAuth,
> tools, resources, prompts, and controlled form elicitation. MCP integrations
> can also be distributed through verified plugins.

### How are secrets protected?

> Credentials are stored using OS-backed encryption and are referenced by ID
> instead of being copied into tool configuration. Sensitive task artifacts
> use encrypted protected storage, and secrets are redacted from logs and UI
> state.

### Can my team distribute internal plugins?

> Clodex already supports publisher-signed plugins and explicitly pinned
> private marketplaces. A broader team distribution workflow is in active
> development.

### Can I use local or private models?

> Yes. Clodex supports cloud providers, BYOK, external subscriptions, and
> local or self-hosted inference through compatible APIs.

### Is Cloud Tasks generally available?

> Cloud execution infrastructure is currently a preview and remains gated
> while cross-platform release evidence is completed.

### Can my team control deployment and integrations?

> Yes. Clodex supports controlled infrastructure, private MCP integrations,
> signed plugins, custom providers, encrypted credentials, and explicit
> permission policies.

---

## 14. Что нельзя заявлять как shipped

| Claim | Статус | Как говорить сейчас |
|---|---|---|
| Fork any task with lineage | В разработке | Coming next |
| Full archive/unarchive | В разработке | Не упоминать как shipped |
| Task goals and budgets | В разработке | Coming next |
| Exact token/cost dashboard | В разработке | Не публиковать точные данные |
| Unified permission profiles | В разработке | Coming next |
| Task background-process manager | В разработке | Не путать с terminal sessions |
| Live steering | В разработке | Не заявлять |
| Import Claude/Codex sessions | В разработке | Preview-first migration planned |
| Trusted hooks framework | В разработке | Не заявлять |
| Team plugin distribution | В разработке | Private marketplace available; team UX coming |
| Production Cloud Tasks | Release blocked | Preview |
| Production hardware attestation | Не завершено | Local secure MVP / preview |
| Desktop automation cross-platform | macOS preview | Указывать macOS Preview |
| Billing/pricing integration | Отложено | Не строить основной conversion вокруг pricing |

---

## 15. Claim-to-evidence matrix

| Landing claim | Evidence |
|---|---|
| Persistent tasks and Projects | `apps/browser/src/ui/screens/projects`, `apps/browser/src/ui/screens/main` |
| Integrated terminal | `apps/browser/src/backend/services/terminal`, `apps/browser/src/ui/screens/main/terminal-panel` |
| Browser and preview | `apps/browser/src/backend/services/window-layout`, browser toolbox tools |
| Pending Edits and diff review | `packages/agent-core/src/services/pending-edits`, `/diff-review/$agentInstanceId` |
| Worktree workflow | mount manager and worktree settings/services |
| GitHub PR review | `apps/browser/src/backend/services/hosted-pull-request`, `apps/browser/src/ui/screens/pull-request` |
| Protected merge | `apps/browser/src/shared/hosted-pull-request-merge.ts` and backend service |
| Swarm | `apps/browser/src/backend/services/swarm-orchestrator` |
| Guardian | `apps/browser/src/backend/services/guardian` |
| Memory | `packages/agent-core/src/services/memory-notes` |
| Generated Apps | `apps/browser/src/backend/services/generated-app-library`, `apps/browser/src/ui/screens/generated-apps` |
| MCP runtime | `packages/mcp-runtime`, `apps/browser/src/backend/mcp-host` |
| SSH connections | `apps/browser/src/backend/services/remote-connections` |
| Skills and plugins | `apps/browser/src/ui/screens/plugin-library`, bundled plugins/skills |
| Signed marketplace | `apps/browser/src/backend/services/plugin-marketplace` |
| Private marketplace | `apps/browser/src/backend/services/plugin-marketplace/private-sources.ts` |
| Encrypted credentials | `apps/browser/src/backend/services/credentials`, persisted-data safeStorage |
| Protected task artifacts | `packages/agent-core/src/host/protected-files.ts` |
| Quick Task | `apps/browser/src/backend/services/quick-task-window` |
| Dictation | `apps/browser/src/backend/services/dictation.ts`, dictation UI/hooks |
| Remote control | `apps/browser/src/backend/services/agent-os/remote-control.ts` |
| Cloud Tasks preview | `apps/browser/src/backend/agent-host/cloud-task-*` |

Любой новый marketing claim должен иметь такую evidence-ссылку и статус:

- Shipped;
- Preview;
- In development;
- Deferred.

---

## 16. Визуальная стратегия

Сейчас landing использует четыре крупных изображения:

- full demo;
- model selection;
- efficient agent;
- agent management;
- subscription selection.

Новая страница должна показывать сам workflow.

### Обязательные screenshots

1. Main task view:
   - sidebar;
   - chat;
   - file tree;
   - terminal/browser.
2. Pending Edits / diff review.
3. Hosted Pull Request review.
4. Projects.
5. Swarm progress.
6. MCP Settings.
7. Plugin Library/private marketplace.
8. Generated App Library.
9. Guardian approval.
10. Security settings/credentials.

### Рекомендуемые visual patterns

- один большой hero screenshot;
- sticky workflow sequence;
- zoomed product details вместо абстрактных illustrations;
- capability diagrams только для MCP/security;
- badges `Shipped`, `Preview`, `In development`;
- light/dark screenshots;
- реальные states вместо декоративных mockups.

### Источники готовых visual surfaces

- `apps/browser/src/ui/visual-regression/codex-surfaces.stories.tsx`
- `apps/browser/visual-regression/`
- `apps/browser/storybook-static/`

Visual regression уже содержит:

- Settings;
- Projects;
- Hosted PR;
- Quick Task;
- Generated Apps;
- Skills & Plugins.

---

## 17. Изменения текущего landing implementation

## `apps/website/src/app/(home)/page.tsx`

Рекомендуемый порядок:

1. Hero;
2. proof bar;
3. pain section;
4. end-to-end workflow;
5. task-native section;
6. code/run/review;
7. orchestration;
8. integrations;
9. extensibility;
10. security;
11. model freedom;
12. enterprise control and deployment;
13. coming next;
14. FAQ;
15. final CTA.

News и Company:

- перенести после product/security sections;
- не разрывать основной conversion narrative.

## `hero-section.tsx`

Заменить headline:

```text
The Agentic IDE for AI Models
```

на:

```text
Give agents the whole job —
not just the next code edit.
```

Model freedom оставить supporting line, а не category definition.

## `feature-section.tsx`

Текущий section нужно полностью переработать:

- убрать четыре одинаковых двухколоночных cards как единственную product
  story;
- разбить на workflow и capability pillars;
- сохранить model section ниже;
- убрать неподтверждённый numeric cache claim или добавить methodology.

## `model-provider-showcase.tsx`

- переместить ниже основных product capabilities;
- сократить список конкретных model-version names;
- version lists быстро устаревают;
- лучше показывать provider categories и compatibility.

## `home-faq.tsx`

Добавить вопросы:

- difference from AI editor;
- approvals/security;
- Pending Edits;
- GitHub;
- MCP;
- secrets;
- cloud preview;
- team plugins.

## Metadata

Заменить focus с моделей на полный development loop и управляемое выполнение
задач.

---

## 18. Новые рекомендуемые components

```text
apps/website/src/app/(home)/_components/
├── proof-bar.tsx
├── pain-section.tsx
├── workflow-section.tsx
├── task-workspace-section.tsx
├── review-section.tsx
├── orchestration-section.tsx
├── integrations-section.tsx
├── extensibility-section.tsx
├── security-section.tsx
├── roadmap-preview-section.tsx
└── product-screenshot-frame.tsx
```

Не нужно делать один giant `feature-section.tsx`.

Контент лучше хранить в typed arrays:

```ts
type ProductClaimStatus = 'shipped' | 'preview' | 'in-development';

type ProductFeature = {
  title: string;
  description: string;
  status: ProductClaimStatus;
  evidence?: string;
};
```

Это уменьшит риск случайно выдать roadmap за shipped feature.

---

## 19. Conversion strategy

### Primary conversion

- desktop download.

### Secondary conversion

- GitHub star/repository visit.

### Enterprise conversion

- enterprise contact.

### Product education conversion

- feature/security documentation.

### Events

Рекомендуемые content-free events:

- `hero_download_click`;
- `hero_github_click`;
- `workflow_section_view`;
- `security_model_click`;
- `mcp_section_view`;
- `enterprise_cta_click`;
- `roadmap_section_view`;
- platform-specific download.

Не записывать:

- search query;
- code/workspace identifiers;
- model credentials;
- imported config details.

---

## 20. SEO clusters

Основной:

- agentic IDE;
- AI coding agent IDE;
- coding agent workspace;
- local AI coding agent;
- MCP IDE;
- multi-agent coding IDE.

Вторичные:

- GitHub pull request AI review;
- AI worktree workflow;
- secure coding agents;
- local LLM coding IDE;
- enterprise coding agent;
- private MCP marketplace;
- AI terminal and browser automation;
- agent orchestration for developers.

Не строить SEO вокруг конкретных будущих model version names.

---

## 21. Итоговая product hierarchy

### Первый экран

**Agentic IDE for the complete development loop**

### Второй уровень

1. Persistent task workspace
2. Code/run/review
3. Agent orchestration
4. Integrations
5. Extensibility
6. Security

### Третий уровень

- model freedom;
- remote workflows;
- generated apps;
- dictation;
- Quick Task;
- remote control;
- enterprise/private distribution.

### Roadmap

- fork/lineage;
- archive;
- goals/budgets;
- usage dashboard;
- permission profiles;
- process manager;
- live steering;
- imports;
- hooks trust;
- team plugin distribution.

---

## 22. Финальная рекомендация

Главная страница должна перестать объяснять Clodex через список моделей.

Модели — это двигатель. Продукт — это среда.

Правильная история:

1. Coding agents сегодня ограничены фрагментированным workflow.
2. Clodex превращает задачу в persistent development environment.
3. Агент получает файлы, terminal, browser, GitHub, MCP и remote tools.
4. Пользователь сохраняет контроль через Pending Edits, Guardian и approvals.
5. Платформа расширяется Skills, Plugins, MCP и Generated Apps.
6. Любая модель может работать внутри одной и той же agent architecture.

Финальная формула:

> **Clodex is the Agentic IDE that gives agents the environment, tools, and
> boundaries to finish real software tasks.**
