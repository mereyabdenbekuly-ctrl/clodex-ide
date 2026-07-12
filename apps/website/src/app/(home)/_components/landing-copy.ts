export type LandingLocale = 'ru' | 'en';

export const landingCopy = {
  ru: {
    status: {
      shipped: 'В продукте',
      preview: 'Preview',
      labs: 'Labs',
      building: 'В разработке',
    },
    hero: {
      eyebrow: 'Clodex Agentic IDE · локально, на серверах и в облаке',
      title: 'Одна задача.',
      titleAccent: 'Вся инженерная система.',
      description:
        'Clodex даёт агентам не только редактор и чат, а полноценную среду выполнения: кодовую базу, терминалы, браузер, GitHub, MCP, удалённые машины, автоматизации и контролируемый путь до review и merge.',
      explore: 'Посмотреть возможности',
      proof: [
        'Постоянные задачи вместо одноразовых чатов',
        'Локальные и удалённые среды в одном контексте',
        'Review и разрешения до критических действий',
      ],
      taskBadge: 'Задача не теряет контекст',
      taskBadgeDetail: 'История, workspace, процессы, артефакты',
      remoteBadge: 'Local → SSH → Cloud',
      remoteBadgeDetail: 'Один execution layer',
    },
    proofBar: [
      ['Полный цикл', 'План → код → запуск → review'],
      ['Remote-first', 'SSH, remote paths и cloud targets'],
      ['Agent OS', 'Память, policy, Swarm и lifecycle'],
      ['Расширяемость', 'MCP, skills, plugins и generated apps'],
    ],
    pain: {
      eyebrow: 'Почему обычного AI-редактора недостаточно',
      title: 'Патч — это ещё не выполненная задача.',
      description:
        'Реальная разработка продолжается после генерации кода. Нужно сохранить контекст, поднять сервисы, проверить интерфейс, работать с удалённой инфраструктурой, пройти review и не потерять контроль над действиями агента.',
      items: [
        [
          'Контекст разбросан по шести приложениям',
          'Чат, IDE, терминал, браузер, GitHub и SSH живут отдельно. Агент постоянно теряет состояние, а разработчик вручную переносит результаты.',
        ],
        [
          'Автономность заканчивается на первом риске',
          'Shell, network, browser, MCP и plugins дают большую силу, но без общей policy-модели превращаются в непрозрачную границу доверия.',
        ],
        [
          'Долгая работа не имеет операционного слоя',
          'Нет постоянной задачи, управляемых процессов, повторных запусков, remote execution, памяти и единого места для проверки результата.',
        ],
      ],
      conclusion:
        'Clodex превращает разрозненные инструменты в одну управляемую среду инженерной задачи.',
    },
    workflow: {
      eyebrow: 'От запроса до проверенного результата',
      title: 'Агент получает всю работу, а не только следующий edit.',
      description:
        'Каждый этап остаётся внутри одной задачи: контекст, инструменты, выполнение, изменения, проверки и итоговые артефакты.',
      steps: [
        [
          'Сформулируйте результат',
          'Задача хранит диалог, workspace, инструкции, модель и режим работы.',
        ],
        [
          'Исследуйте и спланируйте',
          'Агент читает кодовую базу, историю, AGENTS.md, память и подключённые источники.',
        ],
        [
          'Реализуйте',
          'Файлы, worktrees, терминалы, browser workflows и специализированные workers работают вместе.',
        ],
        [
          'Проверьте',
          'Тесты, логи, локальные сервисы, remote machines и visual/browser verification доступны в той же задаче.',
        ],
        [
          'Примите результат',
          'Pending Edits, line-by-line diff, GitHub review и protected merge оставляют финальное решение человеку.',
        ],
      ],
    },
    remote: {
      eyebrow: 'Удалённые машины — часть IDE, а не отдельный терминал',
      title: 'Работайте там, где реально живёт код.',
      description:
        'Подключите dev-сервер, GPU-машину, staging, приватную сеть или cloud worker. Clodex сохраняет задачу, policy и review-процесс, даже когда выполнение уходит с ноутбука.',
      flow: ['Локальная задача', 'Защищённая SSH-сессия', 'Remote workspace'],
      features: [
        [
          'Зашифрованные SSH-профили',
          'ssh-agent, private key и password authentication без plaintext-конфигов.',
        ],
        [
          'Постоянные соединения',
          'Connection test, latency, reconnect и повторное использование сессии вместо нового SSH на каждую команду.',
        ],
        [
          'Remote path как рабочая среда',
          'Команды выполняются в нужной директории, а интерактивный terminal handoff открывает ту же сессию человеку.',
        ],
        [
          'Approval-gated execution',
          'Удалённые команды проходят те же границы разрешений и Guardian, что и локальные действия.',
        ],
        [
          'Local / Cloud execution targets',
          'Выбирайте, где запускать работу. Cloud Tasks использует bounded snapshots, short-lived secrets и проверяемые артефакты.',
        ],
        [
          'Session Teleport',
          'Экспериментальный readiness check продолжает локальную сессию в cloud-контуре без создания нового чата.',
        ],
      ],
      terminalTitle: 'remote · gpu-build-01',
      terminalLines: [
        '$ clodex connect gpu-build-01',
        '✓ host key verified · 34 ms',
        '$ pnpm test:e2e',
        '✓ 128 checks passed',
        'artifact → task://release-report',
      ],
      note: 'SSH доступен как рабочая возможность. Cloud Tasks и Session Teleport остаются preview/experimental до production promotion.',
    },
    capability: {
      eyebrow: 'Task-native development',
      title: 'Всё, что делает агент, остаётся частью задачи.',
      description:
        'Не набор вкладок, а единый объект работы: история, workspace, terminals, browser, edits, agents, review и результаты.',
      workspaceTitle: 'Постоянные Tasks и Projects',
      workspaceText:
        'Ищите, группируйте и продолжайте задачи по проектам. Подключайте несколько workspaces, создавайте worktrees и возвращайтесь к работе без восстановления контекста вручную.',
      runTitle: 'Код, процессы и браузер',
      runText:
        'Редактирование нескольких файлов, terminal sessions, локальные порты, browser/CDP, console logs и визуальная проверка живут рядом.',
      prTitle: 'Review встроен в execution loop',
      prText:
        'Pending Edits, accept/reject, line-numbered diff, GitHub checks, inline comments, approve/request changes и защищённый merge.',
      swarmTitle: 'Swarm вместо хаоса из чатов',
      swarmText:
        'Главный агент разбивает сложную работу на роли, следит за прогрессом и собирает проверяемый результат в исходной задаче.',
      agentLabels: ['Код', 'Исследование', 'Тесты', 'Review'],
      working: 'Выполняется',
    },
    surfaces: {
      eyebrow: 'Управление за пределами окна чата',
      title: 'Clodex появляется там, где начинается работа.',
      description:
        'Быстрый запрос, поиск старой задачи, голосовая команда, проверка с телефона или запуск созданного агентом приложения не требуют собирать контекст заново.',
      items: [
        [
          'Quick Task',
          'Глобальный hotkey открывает нативный composer поверх текущего приложения, подхватывает workspace и создаёт постоянную задачу без перехода в главное окно.',
        ],
        [
          'Command Center + Projects',
          'Единый поиск по командам, файлам, настройкам, задачам и проектам. Возобновляйте работу, создавайте worktree и переходите к нужному артефакту с клавиатуры.',
        ],
        [
          'Scoped Memory',
          'Защищённая память с global, workspace и agent scopes, retention и approval для чувствительных записей — без автоматической подстановки всей базы в prompt.',
        ],
        [
          'Voice + Realtime Dictation',
          'Composer microphone, глобальный hotkey, push-to-talk, batch transcription и realtime preview. Audio и transcript не сохраняются на диск и не попадают в telemetry.',
        ],
        [
          'Remote Control + Attestation',
          'Одноразовый pairing, подписанный encrypted channel, защита от replay, Guardian и revoke для контролируемого управления задачей с доверенного устройства.',
        ],
        [
          'Generated App Library',
          'Каталог интерактивных приложений агента с поиском, состояниями, безопасным preview, regeneration через owner task и защищённым удалением.',
        ],
      ],
    },
    platform: {
      eyebrow: 'Платформа вокруг модели',
      title: 'Ноу-хау Clodex находится в runtime, а не в одном prompt.',
      description:
        'Модель можно заменить. Сложнее построить безопасную операционную систему, которая даёт агенту инструменты, состояние, расширения и управляемое выполнение.',
      groups: [
        {
          icon: 'agent',
          title: 'Agent OS',
          text: 'Persistent tasks, collaboration modes, memory, Swarm, Guardian, hooks, Quick Task, dictation и remote control.',
          status: 'shipped',
          points: [
            'Task lifecycle',
            'Memory scopes',
            'Multi-agent coordination',
          ],
        },
        {
          icon: 'mcp',
          title: 'MCP Runtime',
          text: 'Изолированный utility process для stdio, Streamable HTTP и SSE с OAuth, resources, prompts, elicitation, timeout и redaction.',
          status: 'shipped',
          points: [
            'Local + remote MCP',
            'Encrypted credentials',
            'Policy per tool',
          ],
        },
        {
          icon: 'plugins',
          title: 'Verified Extensions',
          text: 'Skills, signed plugins, publisher identity, private pinned marketplaces, staged updates, rollback и quarantine.',
          status: 'preview',
          points: [
            'Ed25519 signatures',
            'Integrity lockfile',
            'Source provenance',
          ],
        },
        {
          icon: 'apps',
          title: 'Generated Apps',
          text: 'Агенты создают интерактивные приложения, принадлежащие исходной задаче, с безопасным preview, regeneration и capability bridge.',
          status: 'preview',
          points: [
            'Task ownership',
            'Sandboxed preview',
            'Explicit capabilities',
          ],
        },
      ],
    },
    labs: {
      eyebrow: 'Clodex Labs',
      title: 'Следующий слой уже собирается внутри продукта.',
      description:
        'Эти возможности подключены через feature gates и проходят dogfood. Мы показываем их отдельно, чтобы не выдавать experimental foundation за production-ready обещание.',
      items: [
        [
          'Scheduled Tasks + Wake Scheduler',
          'One-time, interval и cron schedules, timezone, запуск после сна, missed-run policies, retries, capability grants и local/cloud target.',
        ],
        [
          'Generated App Capability Bridge',
          'Явно разрешённые приложения вызывают read-only MCP tools, задают bounded вопрос модели и запускают automation с rate и size limits.',
        ],
        [
          'Executable Extension Runtime',
          'Signed plugins могут поставлять integrity-bound stdio MCP runtime с platform/architecture checks, process permission и rollback pipeline.',
        ],
        [
          'Spaces',
          'Зашифрованные постоянные контейнеры для workspaces, ссылок и инструкций. Связи с sessions, apps и automations расширяются.',
        ],
        [
          'Session Teleport + Sharing',
          'Cloud readiness, продолжение локальной задачи в cloud и read-only share links с expiry и revoke.',
        ],
      ],
    },
    runtime: {
      eyebrow: 'Desktop runtime, построенный как система',
      title: 'Не браузерная обёртка вокруг LLM API.',
      description:
        'Clodex разделяет выполнение, инструменты, секреты и policy по отдельным trust boundaries. Ошибка расширения не должна становиться ошибкой всей IDE.',
      layers: [
        {
          label: 'Execution boundary',
          title: 'Agent Host',
          text: 'Изолированный utility process, typed IPC, health checks, heartbeat, cancellation, restart budget и circuit breaker для agent turns.',
          detail: 'Основной UI не исполняет agent workloads напрямую.',
        },
        {
          label: 'Tool boundary',
          title: 'MCP Host',
          text: 'Local stdio и remote MCP работают вне renderer/main с bounded logs, timeout, cancellation, controlled restart и secret redaction.',
          detail: 'Подключение инструмента не расширяет renderer privileges.',
        },
        {
          label: 'Protected data plane',
          title: 'Зашифрованные артефакты',
          text: 'Attachments, shell logs, memory, Chronicle, diff history и caches используют OS-backed root key и AES-256-GCM protected files.',
          detail:
            'Чувствительная история не остаётся россыпью plaintext-файлов.',
        },
        {
          label: 'Policy boundary',
          title: 'Guardian + approvals',
          text: 'Shell, browser, network, MCP, sandbox и remote actions оцениваются отдельно от агента и закрываются fail-closed при неоднозначности.',
          detail: 'Capability не равна authority.',
        },
      ],
    },
    security: {
      eyebrow: 'Безопасность как поведение продукта',
      title: 'Сильные агенты.\nЯвные границы.',
      description:
        'Clodex проектируется с предположением, что tool, plugin, remote service или generated content могут ошибаться или быть вредоносными.',
      cta: 'Посмотреть trust model',
      items: [
        ['Pending Edits', 'Изменения остаются предложениями до accept/reject.'],
        ['Guardian', 'Отдельная оценка риска до выполнения действия.'],
        ['Protected storage', 'Секреты и task artifacts зашифрованы at rest.'],
        [
          'Signed supply chain',
          'Catalog, publisher, package integrity, rollback и quarantine.',
        ],
        [
          'Origin-bound access',
          'Browser и remote credentials ограничены источником и назначением.',
        ],
        [
          'Privacy-safe audit',
          'События описывают действие без prompt, кода, audio и secrets.',
        ],
      ],
    },
    models: {
      eyebrow: 'Model-independent architecture',
      title: 'Выбирайте интеллект под задачу, не перестраивая workflow.',
      description:
        'Clodex Cloud, BYOK, существующие подписки, OpenAI-compatible endpoints, private infrastructure и local inference работают внутри одного Agent OS.',
      categories: ['Cloud models', 'BYOK и подписки', 'Private и local'],
    },
    roadmap: {
      eyebrow: 'Что ещё усиливаем',
      title: 'Контроль задачи становится глубже.',
      description:
        'Следующие функции остаются в разработке и не смешиваются с shipped-возможностями.',
      notice: 'Roadmap · не выпущено',
      items: [
        ['Fork + lineage', 'Ветвление задач с полной историей происхождения.'],
        ['Archive / restore', 'Настоящий lifecycle завершённой задачи.'],
        ['Goals + budgets', 'Objective, status, token и time budgets.'],
        ['Exact usage', 'Tokens, cost, context pressure и rate limits.'],
        [
          'Permission Profiles',
          'Одна policy для filesystem, shell, network, browser и MCP.',
        ],
        ['Process manager', 'Управление всеми фоновыми процессами задачи.'],
        ['Live steering', 'Смена направления уже выполняющегося turn.'],
        [
          'Session import',
          'Импорт конфигураций и истории из других agent clients.',
        ],
        [
          'Trusted hooks',
          'Расширенная provenance и trust-модель lifecycle hooks.',
        ],
        [
          'Team distribution',
          'Управляемая доставка approved plugins внутри команд.',
        ],
      ],
    },
    builder: {
      eyebrow: 'Независимое исследование',
      title:
        'Создано одним исследователем, который строит Zero-Trust AI infrastructure.',
      description:
        'Clodex развивается как самостоятельная инженерная система: от runtime и policy boundaries до памяти, удалённого выполнения и проверяемой цепочки поставки.',
      rolesTitle: 'Открыт к сильной инженерной роли',
      rolesDescription:
        'Solo scientist building Zero-Trust AI infrastructure. Open to core engineering and research engineering roles at frontier AI labs.',
      labs: ['Google DeepMind', 'xAI', 'OpenAI', 'Anthropic', 'Meta', 'NVIDIA'],
      contact: 'Обсудить сотрудничество',
      xProfile: 'Профиль в X',
    },
    support: {
      eyebrow: 'Поддержать независимую разработку',
      title: 'Помогите Clodex двигаться быстрее.',
      description:
        'Донаты направляются на разработку Agent OS, security research, тестовую инфраструктуру и публичную документацию. Выберите сеть и скопируйте соответствующий USDT-адрес.',
      copy: 'Скопировать адрес',
      copied: 'Адрес скопирован',
      copyError: 'Не удалось скопировать',
      warning:
        'Отправляйте только USDT и только через сеть, указанную на карточке. Сеть вывода должна совпадать с сетью адреса; перевод через другую сеть или другого токена может быть необратимо потерян.',
    },
    faq: {
      eyebrow: 'Коротко о главном',
      title: 'Вопросы о Clodex.',
      description:
        'Что уже работает, что находится в preview и как устроен контроль.',
      items: [
        [
          'Чем Clodex отличается от AI code editor?',
          'AI editor помогает писать следующий фрагмент кода. Clodex построен вокруг полной инженерной задачи: persistent context, terminals, browser, worktrees, remote machines, MCP, agents, review и защищённый путь до merge.',
        ],
        [
          'Можно ли работать на удалённых машинах?',
          'Да. Clodex поддерживает encrypted SSH profiles, ssh-agent/private-key/password authentication, host-key policy, connection tests, persistent sessions, remote command execution и terminal handoff. Cloud execution и Session Teleport маркируются как preview/experimental.',
        ],
        [
          'Применяет ли агент изменения автоматически?',
          'Не обязательно. Pending Edits сохраняет изменения как предложения. Вы можете проверить line-by-line diff и принять или отклонить отдельные файлы либо весь набор.',
        ],
        [
          'Что может Generated App?',
          'Базово это task-owned интерактивный артефакт. В Labs capability bridge позволяет выдать ему отдельный grant на конкретные read-only MCP tools, bounded askAgent или запуск automation.',
        ],
        [
          'Как устроены plugins и executable extensions?',
          'Plugins проходят проверку catalog и publisher signatures, package/tree integrity, compatibility и permissions. Experimental executable runtime дополнительно проверяет runtime manifest, SHA-256, platform, architecture и process permission.',
        ],
        [
          'Как защищены секреты и история задачи?',
          'Секреты опираются на системное хранилище ключей, а чувствительные файлы и артефакты шифруются с context binding. Повреждение key envelope закрывает доступ fail-closed вместо незаметного перехода к plaintext.',
        ],
        [
          'Можно ли использовать свои модели и инфраструктуру?',
          'Да. Поддерживаются cloud providers, BYOK, существующие подписки, совместимые private endpoints и локальный/self-hosted inference.',
        ],
      ],
    },
    final: {
      title: 'Дайте агентам среду, в которой можно закончить работу.',
      description:
        'Одна задача объединяет код, процессы, браузер, GitHub, remote machines, расширения и review — под вашим контролем.',
      sales: 'Связаться с командой',
    },
  },
  en: {
    status: {
      shipped: 'Available',
      preview: 'Preview',
      labs: 'Labs',
      building: 'In development',
    },
    hero: {
      eyebrow: 'Clodex Agentic IDE · local, remote, and cloud',
      title: 'One task.',
      titleAccent: 'The entire engineering system.',
      description:
        'Clodex gives agents more than an editor and chat. It gives them an execution environment: your codebase, terminals, browser, GitHub, MCP, remote machines, automations, and a controlled path to review and merge.',
      explore: 'Explore capabilities',
      proof: [
        'Persistent tasks instead of disposable chats',
        'Local and remote environments in one context',
        'Review and permissions before high-impact actions',
      ],
      taskBadge: 'Context survives the turn',
      taskBadgeDetail: 'History, workspace, processes, artifacts',
      remoteBadge: 'Local → SSH → Cloud',
      remoteBadgeDetail: 'One execution layer',
    },
    proofBar: [
      ['Complete loop', 'Plan → code → run → review'],
      ['Remote-first', 'SSH, remote paths, and cloud targets'],
      ['Agent OS', 'Memory, policy, Swarm, and lifecycle'],
      ['Extensible', 'MCP, skills, plugins, and generated apps'],
    ],
    pain: {
      eyebrow: 'Why an AI editor is not enough',
      title: 'A patch is not a finished task.',
      description:
        'Real engineering continues after code generation. Context must survive, services must run, interfaces must be inspected, remote infrastructure must be reached, and every result still needs review.',
      items: [
        [
          'Context is split across six apps',
          'Chat, IDE, terminal, browser, GitHub, and SSH live separately. The agent loses state while the developer manually carries results between tools.',
        ],
        [
          'Autonomy stops at the first real risk',
          'Shell, network, browser, MCP, and plugins are powerful, but without one policy model they become an opaque trust boundary.',
        ],
        [
          'Long-running work has no operating layer',
          'There is no persistent task, managed execution, repeatable scheduling, remote target, memory, or single place to verify the outcome.',
        ],
      ],
      conclusion:
        'Clodex turns disconnected developer tools into one controlled engineering task environment.',
    },
    workflow: {
      eyebrow: 'From request to verified result',
      title: 'Give agents the whole job, not just the next edit.',
      description:
        'Every stage stays inside one task: context, tools, execution, changes, verification, and final artifacts.',
      steps: [
        [
          'Define the outcome',
          'The task keeps the conversation, workspace, instructions, model, and working mode together.',
        ],
        [
          'Understand and plan',
          'The agent reads the codebase, history, AGENTS.md, memory, and connected sources.',
        ],
        [
          'Implement',
          'Files, worktrees, terminals, browser workflows, and focused workers operate together.',
        ],
        [
          'Verify',
          'Tests, logs, local services, remote machines, and browser verification remain in the same task.',
        ],
        [
          'Accept the result',
          'Pending Edits, line-by-line diff, GitHub review, and protected merge leave the final decision with you.',
        ],
      ],
    },
    remote: {
      eyebrow: 'Remote machines belong inside the IDE',
      title: 'Work where the code actually lives.',
      description:
        'Connect a development server, GPU machine, staging environment, private network, or cloud worker. Clodex preserves task context, policy, and review even when execution leaves your laptop.',
      flow: ['Local task', 'Protected SSH session', 'Remote workspace'],
      features: [
        [
          'Encrypted SSH profiles',
          'ssh-agent, private-key, and password authentication without plaintext configuration.',
        ],
        [
          'Persistent connections',
          'Connection testing, latency, reconnect, and session reuse instead of a new SSH handshake for every command.',
        ],
        [
          'Remote path as a workspace',
          'Commands execute in the selected directory, while terminal handoff opens the same session for a human.',
        ],
        [
          'Approval-gated execution',
          'Remote commands pass through the same permissions and Guardian boundaries as local actions.',
        ],
        [
          'Local / Cloud targets',
          'Choose where work runs. Cloud Tasks use bounded snapshots, short-lived secrets, and verifiable artifacts.',
        ],
        [
          'Session Teleport',
          'An experimental readiness check continues a local session in the cloud lane without starting a new chat.',
        ],
      ],
      terminalTitle: 'remote · gpu-build-01',
      terminalLines: [
        '$ clodex connect gpu-build-01',
        '✓ host key verified · 34 ms',
        '$ pnpm test:e2e',
        '✓ 128 checks passed',
        'artifact → task://release-report',
      ],
      note: 'SSH is an available product capability. Cloud Tasks and Session Teleport remain preview/experimental until production promotion.',
    },
    capability: {
      eyebrow: 'Task-native development',
      title: 'Everything the agent does stays part of the task.',
      description:
        'Not a collection of tabs, but one durable object of work: history, workspace, terminals, browser, edits, agents, review, and results.',
      workspaceTitle: 'Persistent Tasks and Projects',
      workspaceText:
        'Search, group, and resume work by project. Attach multiple workspaces, create worktrees, and return without reconstructing context by hand.',
      runTitle: 'Code, processes, and browser',
      runText:
        'Multi-file editing, terminal sessions, local ports, browser/CDP, console logs, and visual verification live side by side.',
      prTitle: 'Review inside the execution loop',
      prText:
        'Pending Edits, accept/reject, line-numbered diff, GitHub checks, inline comments, approve/request changes, and protected merge.',
      swarmTitle: 'Swarm instead of chat chaos',
      swarmText:
        'The lead agent splits complex work into roles, tracks progress, and returns a reviewable result to the original task.',
      agentLabels: ['Code', 'Research', 'Tests', 'Review'],
      working: 'Running',
    },
    surfaces: {
      eyebrow: 'Control beyond the chat window',
      title: 'Clodex shows up where work begins.',
      description:
        'A quick request, an old task, a voice command, a phone check, or an agent-generated app can continue without rebuilding context from scratch.',
      items: [
        [
          'Quick Task',
          'A global hotkey opens a native composer over the current app, reuses the workspace, and creates a persistent task without switching to the main window.',
        ],
        [
          'Command Center + Projects',
          'Search commands, files, settings, tasks, and projects in one place. Resume work, create a worktree, or jump to an artifact from the keyboard.',
        ],
        [
          'Scoped Memory',
          'Protected memory with global, workspace, and agent scopes, retention, and approval for sensitive writes—without injecting the entire store into every prompt.',
        ],
        [
          'Voice + Realtime Dictation',
          'Composer microphone, global hotkey, push-to-talk, batch transcription, and realtime preview. Audio and transcripts are not persisted or included in telemetry.',
        ],
        [
          'Remote Control + Attestation',
          'Single-use pairing, a signed encrypted channel, replay protection, Guardian, and revocation for controlled task access from a trusted device.',
        ],
        [
          'Generated App Library',
          'A catalog of agent-built interactive apps with search, health states, safe preview, regeneration through the owner task, and protected deletion.',
        ],
      ],
    },
    platform: {
      eyebrow: 'A platform around the model',
      title: "Clodex's know-how lives in the runtime, not one prompt.",
      description:
        'Models can be swapped. The hard part is building a safe operating system that gives agents tools, state, extensions, and controlled execution.',
      groups: [
        {
          icon: 'agent',
          title: 'Agent OS',
          text: 'Persistent tasks, collaboration modes, memory, Swarm, Guardian, hooks, Quick Task, dictation, and remote control.',
          status: 'shipped',
          points: [
            'Task lifecycle',
            'Memory scopes',
            'Multi-agent coordination',
          ],
        },
        {
          icon: 'mcp',
          title: 'MCP Runtime',
          text: 'An isolated utility process for stdio, Streamable HTTP, and SSE with OAuth, resources, prompts, elicitation, timeouts, and redaction.',
          status: 'shipped',
          points: [
            'Local + remote MCP',
            'Encrypted credentials',
            'Policy per tool',
          ],
        },
        {
          icon: 'plugins',
          title: 'Verified Extensions',
          text: 'Skills, signed plugins, publisher identity, pinned private marketplaces, staged updates, rollback, and quarantine.',
          status: 'preview',
          points: [
            'Ed25519 signatures',
            'Integrity lockfile',
            'Source provenance',
          ],
        },
        {
          icon: 'apps',
          title: 'Generated Apps',
          text: 'Agents create interactive apps owned by the source task, with safe preview, regeneration, and a capability bridge.',
          status: 'preview',
          points: [
            'Task ownership',
            'Sandboxed preview',
            'Explicit capabilities',
          ],
        },
      ],
    },
    labs: {
      eyebrow: 'Clodex Labs',
      title: 'The next layer is already being assembled in the product.',
      description:
        'These capabilities are behind feature gates and in dogfood. They are separated from production claims intentionally.',
      items: [
        [
          'Scheduled Tasks + Wake Scheduler',
          'One-time, interval, and cron schedules, timezones, wake recovery, missed-run policies, retries, capability grants, and local/cloud targets.',
        ],
        [
          'Generated App Capability Bridge',
          'Explicitly granted apps can call read-only MCP tools, ask a bounded model question, and launch an automation with rate and size limits.',
        ],
        [
          'Executable Extension Runtime',
          'Signed plugins can ship integrity-bound stdio MCP runtimes with platform/architecture checks, process permission, and rollback.',
        ],
        [
          'Spaces',
          'Encrypted persistent containers for workspaces, links, and instructions. Connections to sessions, apps, and automations are expanding.',
        ],
        [
          'Session Teleport + Sharing',
          'Cloud readiness, local-to-cloud continuation, and read-only share links with expiry and revocation.',
        ],
      ],
    },
    runtime: {
      eyebrow: 'A desktop runtime built as a system',
      title: 'Not a browser wrapper around an LLM API.',
      description:
        'Clodex separates execution, tools, secrets, and policy into explicit trust boundaries. An extension failure should not become an IDE failure.',
      layers: [
        {
          label: 'Execution boundary',
          title: 'Agent Host',
          text: 'An isolated utility process with typed IPC, health checks, heartbeat, cancellation, restart budgets, and a circuit breaker for agent turns.',
          detail: 'The main UI does not execute agent workloads directly.',
        },
        {
          label: 'Tool boundary',
          title: 'MCP Host',
          text: 'Local stdio and remote MCP run outside renderer/main with bounded logs, timeouts, cancellation, controlled restart, and secret redaction.',
          detail: 'Connecting a tool does not expand renderer privileges.',
        },
        {
          label: 'Protected data plane',
          title: 'Encrypted artifacts',
          text: 'Attachments, shell logs, memory, Chronicle, diff history, and caches use an OS-backed root key and AES-256-GCM protected files.',
          detail:
            'Sensitive history is not scattered across plaintext folders.',
        },
        {
          label: 'Policy boundary',
          title: 'Guardian + approvals',
          text: 'Shell, browser, network, MCP, sandbox, and remote actions are assessed separately from the agent and fail closed when ambiguous.',
          detail: 'Capability is not authority.',
        },
      ],
    },
    security: {
      eyebrow: 'Security as product behavior',
      title: 'Powerful agents.\nExplicit boundaries.',
      description:
        'Clodex assumes that a tool, plugin, remote service, or generated artifact can be wrong or malicious.',
      cta: 'Explore the trust model',
      items: [
        [
          'Pending Edits',
          'Changes remain proposals until you accept or reject them.',
        ],
        ['Guardian', 'A separate risk assessment runs before execution.'],
        [
          'Protected storage',
          'Secrets and task artifacts are encrypted at rest.',
        ],
        [
          'Signed supply chain',
          'Catalog, publisher, package integrity, rollback, and quarantine.',
        ],
        [
          'Origin-bound access',
          'Browser and remote credentials are scoped to source and destination.',
        ],
        [
          'Privacy-safe audit',
          'Events describe actions without prompts, code, audio, or secrets.',
        ],
      ],
    },
    models: {
      eyebrow: 'Model-independent architecture',
      title: 'Choose intelligence per task without rebuilding the workflow.',
      description:
        'Clodex Cloud, BYOK, existing subscriptions, OpenAI-compatible endpoints, private infrastructure, and local inference run inside one Agent OS.',
      categories: ['Cloud models', 'BYOK & subscriptions', 'Private & local'],
    },
    roadmap: {
      eyebrow: 'What we are strengthening next',
      title: 'Task control keeps getting deeper.',
      description:
        'The following capabilities remain in development and are not mixed with shipped product claims.',
      notice: 'Roadmap · not shipped',
      items: [
        ['Fork + lineage', 'Branch tasks with complete origin history.'],
        ['Archive / restore', 'A real lifecycle for completed task state.'],
        [
          'Goals + budgets',
          'Objectives, status, token budgets, and time budgets.',
        ],
        ['Exact usage', 'Tokens, cost, context pressure, and rate limits.'],
        [
          'Permission Profiles',
          'One policy for filesystem, shell, network, browser, and MCP.',
        ],
        [
          'Process manager',
          'Control every background process owned by a task.',
        ],
        [
          'Live steering',
          'Redirect an active turn without discarding progress.',
        ],
        [
          'Session import',
          'Import configuration and history from other agent clients.',
        ],
        ['Trusted hooks', 'Stronger provenance and trust for lifecycle hooks.'],
        [
          'Team distribution',
          'Managed delivery of approved plugins inside teams.',
        ],
      ],
    },
    builder: {
      eyebrow: 'Independent research',
      title:
        'Built by a solo scientist working on Zero-Trust AI infrastructure.',
      description:
        'Clodex is developed as an independent engineering system—from runtime and policy boundaries to memory, remote execution, and a verifiable software supply chain.',
      rolesTitle: 'Open to a high-impact engineering role',
      rolesDescription:
        'Solo scientist building Zero-Trust AI infrastructure. Open to core engineering and research engineering roles at frontier AI labs.',
      labs: ['Google DeepMind', 'xAI', 'OpenAI', 'Anthropic', 'Meta', 'NVIDIA'],
      contact: 'Discuss collaboration',
      xProfile: 'Follow on X',
    },
    support: {
      eyebrow: 'Support independent development',
      title: 'Help Clodex move faster.',
      description:
        'Donations support Agent OS development, security research, test infrastructure, and public documentation. Select a network and copy its corresponding USDT address.',
      copy: 'Copy address',
      copied: 'Address copied',
      copyError: 'Copy failed',
      warning:
        'Send USDT only, using the exact network shown on the card. The withdrawal network must match the address network; another network or token may cause irreversible loss.',
    },
    faq: {
      eyebrow: 'The short version',
      title: 'Questions about Clodex.',
      description:
        'What is available now, what is preview, and how control works.',
      items: [
        [
          'How is Clodex different from an AI code editor?',
          'An AI editor helps produce the next piece of code. Clodex is built around the complete engineering task: persistent context, terminals, browser, worktrees, remote machines, MCP, agents, review, and a protected path to merge.',
        ],
        [
          'Can Clodex work on remote machines?',
          'Yes. Clodex supports encrypted SSH profiles, ssh-agent/private-key/password authentication, host-key policy, connection testing, persistent sessions, remote command execution, and terminal handoff. Cloud execution and Session Teleport are marked preview/experimental.',
        ],
        [
          'Does the agent apply every change automatically?',
          'Not necessarily. Pending Edits keeps changes as proposals. You can review line-by-line diffs and accept or reject individual files or the entire set.',
        ],
        [
          'What can a Generated App do?',
          'At its core it is a task-owned interactive artifact. In Labs, the capability bridge can grant access to specific read-only MCP tools, bounded askAgent, or an automation.',
        ],
        [
          'How do plugins and executable extensions work?',
          'Plugins pass catalog and publisher signature checks, package/tree integrity, compatibility, and permission review. The experimental executable runtime also validates its runtime manifest, SHA-256, platform, architecture, and process permission.',
        ],
        [
          'How are secrets and task history protected?',
          'Secrets rely on the operating system key store, while sensitive files and artifacts use context-bound encryption. A damaged key envelope fails closed instead of silently falling back to plaintext.',
        ],
        [
          'Can I use my own models and infrastructure?',
          'Yes. Clodex supports cloud providers, BYOK, existing subscriptions, compatible private endpoints, and local or self-hosted inference.',
        ],
      ],
    },
    final: {
      title: 'Give agents an environment where work can actually finish.',
      description:
        'One task combines code, processes, browser, GitHub, remote machines, extensions, and review under your control.',
      sales: 'Talk to the team',
    },
  },
} as const;
