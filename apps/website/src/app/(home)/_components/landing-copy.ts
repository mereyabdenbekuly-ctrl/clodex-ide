export type LandingLocale = 'ru' | 'en';

export const landingCopy = {
  ru: {
    status: {
      shipped: 'Free · в исходниках',
      preview: 'Preview',
      labs: 'Labs',
      notFree: 'Не входит в Free',
    },
    hero: {
      eyebrow: 'CLODEx Community · бесплатный open-source Technical Preview',
      title: 'Одна задача.',
      titleAccent: 'Вся локальная инженерная среда.',
      description:
        'CLODEx объединяет постоянные задачи, код, Git, терминал, браузер, модели и MCP в одном desktop workspace. Проверенная Community Observed 11 доступна для macOS Apple Silicon и Intel, Windows x64 и Linux x64.',
      explore: 'Что входит в Free',
      proof: [
        'Постоянные задачи и восстановление после перезапуска',
        'CLODEx account, BYOK, compatible endpoints и Ollama',
        'Pending Edits, diffs и review до принятия результата',
      ],
      taskBadge: 'Контекст остаётся в задаче',
      taskBadgeDetail: 'История, workspace, процессы и изменения',
      remoteBadge: 'Community · Free',
      remoteBadgeDetail: 'macOS · Windows · Linux',
    },
    proofBar: [
      ['Постоянная задача', 'История и restart recovery'],
      ['Один workspace', 'Файлы, Git, terminal и browser'],
      ['Модели на выбор', 'Account, BYOK, compatible и Ollama'],
      ['Открытые инструменты', 'MCP stdio, HTTP/SSE и OAuth'],
    ],
    pain: {
      eyebrow: 'Почему обычного AI-редактора недостаточно',
      title: 'Патч — это ещё не выполненная задача.',
      description:
        'Реальная разработка продолжается после генерации кода. Нужно сохранить контекст, поднять локальные сервисы, проверить интерфейс, изучить diff и решить, что действительно принять.',
      items: [
        [
          'Контекст разбросан по приложениям',
          'Чат, IDE, терминал, браузер и Git живут отдельно. Разработчик вручную переносит команды, результаты и состояние между ними.',
        ],
        [
          'Инструменты требуют видимого контроля',
          'Shell, browser и MCP полезны именно тогда, когда запросы разрешений, результат выполнения и изменения можно проверить.',
        ],
        [
          'Долгая работа переживает один диалог',
          'Без постоянной задачи легко потерять workspace, историю решений, запущенные процессы и незавершённые изменения после перезапуска.',
        ],
      ],
      conclusion:
        'CLODEx собирает локальный инженерный цикл в одну продолжаемую и проверяемую задачу.',
    },
    workflow: {
      eyebrow: 'От запроса до проверяемого результата',
      title: 'Дайте агенту всю задачу, а не только следующий edit.',
      description:
        'Контекст, инструменты, выполнение, изменения и проверка остаются внутри одного desktop workspace.',
      steps: [
        [
          'Сформулируйте результат',
          'Задача хранит диалог, выбранный workspace, инструкции, модель и режим работы.',
        ],
        [
          'Исследуйте и спланируйте',
          'Агент читает кодовую базу, Git-историю, AGENTS.md и подключённые пользователем источники.',
        ],
        [
          'Реализуйте',
          'Файлы, worktrees, terminal sessions и browser workflows доступны рядом с диалогом.',
        ],
        [
          'Проверьте',
          'Логи, локальные сервисы, browser state, console output и diff остаются в той же задаче.',
        ],
        [
          'Примите результат',
          'Pending Edits и line-level diff позволяют принять, отклонить, доработать или закоммитить изменения.',
        ],
      ],
    },
    remote: {
      eyebrow: 'Remote workflows · отдельный Preview',
      title: 'Free-версия сегодня остаётся local-first.',
      description:
        'SSH и remote workspace — Free-eligible Preview поверхности. Их наличие и готовность определяются release notes каждой сборки; возможности, которым нужен управляемый hosted-сервис, не включены в Free.',
      flow: [
        'Локальная Free-задача',
        'SSH Preview',
        'Remote workspace Preview',
      ],
      features: [
        [
          'SSH connection setup',
          'Пользовательские hosts и credentials настраиваются явно. Поверхность предназначена для preview-тестирования, а не для production-обещания.',
        ],
        [
          'Проверка подключения',
          'Тест соединения и host verification находятся в Preview; проверяйте конфигурацию перед выполнением команд.',
        ],
        [
          'Remote working directory',
          'Экспериментальная рабочая директория позволяет направить команды в выбранный пользователем remote workspace.',
        ],
        [
          'Review перед remote actions',
          'Интеграция permission и review surfaces для удалённых действий ещё проходит проверку.',
        ],
        [
          'Managed execution',
          'Выполнение, зависящее от hosted-сервиса, не входит в Community Free.',
        ],
        [
          'Hosted continuity',
          'Продолжение работы через управляемую инфраструктуру не входит в Community Free.',
        ],
      ],
      terminalTitle: 'remote preview · user host',
      terminalLines: [
        '$ ssh dev-box',
        'preview · verify host and permissions',
        '$ cd /workspace/project',
        'remote workspace · explicit setup required',
      ],
      note: 'SSH и remote workspace могут поставляться в Free как Preview, но не входят в baseline-обещание доступности. Release notes определяют scope каждой сборки; service-backed возможности остаются отдельным продуктовым scope.',
    },
    capability: {
      eyebrow: 'Что определяет Free Product Contract',
      title: 'Всё важное остаётся частью задачи.',
      description:
        'Free-карточки ниже описывают открытый локальный product scope. Доступность в готовом артефакте подтверждается release notes; эксперименты всегда маркируются отдельно.',
      workspaceTitle: 'Постоянные Tasks и Workspaces',
      workspaceText:
        'Ищите и продолжайте задачи, сохраняйте workspace-aware контекст, создавайте worktrees и восстанавливайте работу после перезапуска приложения.',
      runTitle: 'Код, локальные процессы и браузер',
      runText:
        'Редактирование нескольких файлов, terminal sessions, локальные порты, embedded browser, console inspection и screenshots живут рядом.',
      prTitle: 'Review встроен в рабочий цикл',
      prText:
        'Pending Edits, accept/reject, line-level diff, Git operations, commits, worktrees и pull-request review surfaces.',
      swarmTitle: 'Multi-agent coordination · Preview',
      swarmText:
        'Координация нескольких агентов остаётся source-tree экспериментом и не входит в baseline Free-обещание.',
      agentLabels: ['Код', 'Исследование', 'Проверка', 'Review'],
      working: 'Preview',
    },
    surfaces: {
      eyebrow: 'Чёткая граница Free',
      title: 'Доступное отделено от экспериментального.',
      description:
        'Free · в исходниках означает открытый локальный product scope. Release notes подтверждают конкретный artifact scope; Preview и Labs не означают stable readiness.',
      items: [
        [
          'История задач + recovery',
          'Продолжайте сохранённые задачи и восстанавливайте незавершённую работу после перезапуска приложения.',
        ],
        [
          'Файлы, Git и worktrees',
          'Работайте с файлами, Pending Edits, diffs, Git operations, локальными commits и pull-request review.',
        ],
        [
          'Terminal + Browser',
          'Запускайте локальные команды и сервисы, открывайте страницы, смотрите console output и делайте screenshots.',
        ],
        [
          'Quick Task',
          'Экспериментальный локальный composer для быстрого создания задачи без перехода в основное окно.',
        ],
        [
          'Scoped Memory',
          'Экспериментальные memory scopes и правила retention пока не входят в текущий release contract.',
        ],
        [
          'Multi-agent coordination',
          'Экспериментальная декомпозиция работы между несколькими агентами остаётся в Labs.',
        ],
      ],
    },
    platform: {
      eyebrow: 'Community Free сегодня',
      title: 'Локальный workflow вокруг выбранной вами модели.',
      description:
        'CLODEx Community фокусируется на desktop-задаче, локальных инструментах, пользовательских моделях и проверяемых изменениях.',
      groups: [
        {
          icon: 'agent',
          title: 'Community Desktop',
          text: 'Постоянные задачи, workspace-aware context, локальный terminal/browser и review surfaces в одном приложении.',
          status: 'shipped',
          points: ['Restart recovery', 'Local tools', 'Diff & review'],
        },
        {
          icon: 'mcp',
          title: 'MCP Runtime',
          text: 'Пользовательские stdio, Streamable HTTP и SSE servers с OAuth, tools, resources и prompts.',
          status: 'shipped',
          points: ['stdio', 'HTTP / SSE', 'OAuth'],
        },
        {
          icon: 'plugins',
          title: 'Локальные эксперименты',
          text: 'Quick Task, scoped memory и multi-agent coordination доступны только там, где явно включены как Preview или Labs.',
          status: 'preview',
          points: ['Feature-gated', 'Tester feedback', 'No stable claim'],
        },
        {
          icon: 'managed',
          title: 'Service-backed возможности',
          text: 'Возможности, которым нужна управляемая инфраструктура, не входят в Community Free и документируются отдельно, если становятся доступными.',
          status: 'notFree',
          points: [
            'Separate scope',
            'Not a Free entitlement',
            'No release promise',
          ],
        },
      ],
    },
    labs: {
      eyebrow: 'Локальные Labs',
      title: 'Эксперименты остаются экспериментами.',
      description:
        'Эти source-tree поверхности не входят в baseline Free Product Contract. Их наличие не обещает stable-релиз или автоматическое включение в готовый Free-артефакт.',
      items: [
        [
          'Quick Task overlay',
          'Локальный быстрый вход в новую задачу без переключения основного окна.',
        ],
        [
          'Scoped Memory',
          'Прототипы memory scopes, retention и пользовательского review.',
        ],
        [
          'Multi-agent coordination',
          'Экспериментальная декомпозиция сложной задачи между локальными agent workers.',
        ],
        [
          'Voice input',
          'Экспериментальный ввод голосом для composer; поведение и privacy contract ещё проверяются.',
        ],
        [
          'Generated local apps',
          'Экспериментальные task-owned интерактивные артефакты в локальном preview.',
        ],
      ],
    },
    runtime: {
      eyebrow: 'Что поставляет текущая проверенная сборка',
      title: 'Local-first desktop workspace с видимым review.',
      description:
        'Community Observed 11 прошла Free/managed boundary и packaged-byte проверки, но Technical Preview не является заявлением о полном hardening или идеальной изоляции. Claims ограничены опубликованным release evidence.',
      layers: [
        {
          label: 'Local workspace',
          title: 'Desktop-first по умолчанию',
          text: 'Task state и desktop tooling работают локально; network используется функциями и сервисами, которые выбирает пользователь.',
          detail:
            'Hosted-модели, account, remote MCP и browser navigation требуют сети.',
        },
        {
          label: 'Task lifecycle',
          title: 'Продолжение после перезапуска',
          text: 'История задачи, workspace context и незавершённая работа могут быть восстановлены после перезапуска приложения.',
          detail: 'Это основной проверяемый сценарий Free Technical Preview.',
        },
        {
          label: 'Tool surfaces',
          title: 'Инструменты остаются наблюдаемыми',
          text: 'Terminal, browser, MCP, Pending Edits и Git возвращают результат в задачу и используют permission или review surfaces там, где они поддерживаются.',
          detail:
            'Проверяйте команды, tool requests и diffs перед принятием результата.',
        },
        {
          label: 'Release evidence',
          title: 'Проверяемая тестовая поставка',
          text: 'Community Observed 11 публикует SHA-256, SBOM, validation manifests и evidence archive для пяти installers.',
          detail:
            'macOS packages не trust-signed и не notarized; Technical Preview не является stable signed release.',
        },
      ],
    },
    security: {
      eyebrow: 'Безопасность без абсолютных обещаний',
      title: 'Сильные инструменты.\nВидимый контроль.',
      description:
        'CLODEx показывает permission, diff, sign-in и privacy surfaces, но Technical Preview не следует считать доказательством полной изоляции или отсутствия уязвимостей.',
      cta: 'Security и работа с данными',
      items: [
        ['Pending Edits', 'Изменения можно изучить до accept или reject.'],
        [
          'Permission surfaces',
          'Чувствительные tool actions могут запрашивать явное разрешение.',
        ],
        [
          'System-browser sign-in',
          'CLODEx.xyz login использует system browser, state и PKCE S256.',
        ],
        [
          'Protected credentials',
          'Account и provider credentials используют protected storage path приложения.',
        ],
        [
          'Явный выбор статистики',
          'При первом запуске пользователь разрешает или отклоняет optional product statistics.',
        ],
        [
          'Публичное evidence',
          'Проверенный release публикует checksums, SBOM и validation manifests для проверки.',
        ],
      ],
    },
    models: {
      eyebrow: 'Model-independent workflow',
      title: 'Выбирайте модель под задачу, не меняя рабочий цикл.',
      description:
        'Free Product Contract включает CLODEx account, provider API keys, custom OpenAI-compatible endpoints и локальный Ollama. Конкретную доступность подтверждают release notes; условия и стоимость внешних providers остаются между пользователем и provider.',
      categories: ['CLODEx account', 'BYOK и compatible', 'Local Ollama'],
    },
    builder: {
      eyebrow: 'Независимая open-source разработка',
      title:
        'Публичный desktop-продукт, который можно проверить самостоятельно.',
      description:
        'CLODEx развивается в открытом репозитории. Free Product Contract отделяется от Preview/Labs, а claims конкретной сборки привязываются к её публичным артефактам и документации.',
      rolesTitle: 'Открыт к сильной инженерной роли',
      rolesDescription:
        'Independent builder working on agentic developer tools and secure local execution. Open to core engineering and research engineering roles.',
      labs: ['Google DeepMind', 'xAI', 'OpenAI', 'Anthropic', 'Meta', 'NVIDIA'],
      contact: 'Обсудить сотрудничество',
      xProfile: 'Профиль в X',
    },
    support: {
      eyebrow: 'Поддержать независимую разработку',
      title: 'Помогите CLODEx двигаться быстрее.',
      description:
        'Донаты направляются на Community IDE, тестовую инфраструктуру и публичную документацию. Выберите сеть и скопируйте соответствующий USDT-адрес.',
      copy: 'Скопировать адрес',
      copied: 'Адрес скопирован',
      copyError: 'Не удалось скопировать',
      warning:
        'Отправляйте только USDT и только через сеть, указанную на карточке. Сеть вывода должна совпадать с сетью адреса; перевод через другую сеть или другого токена может быть необратимо потерян.',
    },
    faq: {
      eyebrow: 'Коротко о главном',
      title: 'Вопросы о CLODEx Community.',
      description:
        'Что определяет Free Product Contract, что подтверждают release notes и где начинается Preview.',
      items: [
        [
          'Чем CLODEx отличается от AI code editor?',
          'CLODEx построен вокруг продолжаемой инженерной задачи: workspace context, files, Git, terminal, browser, models, MCP и review остаются в одном desktop-приложении.',
        ],
        [
          'Что входит в Free Product Contract?',
          'Free Product Contract включает persistent tasks и restart recovery, files/diffs/Git/worktrees, local terminal и browser, CLODEx account, BYOK, compatible endpoints, Ollama, user-configured MCP, EN/RU beta и privacy choice. Community Observed 11 — текущий проверенный Technical Preview; точный scope определяют его release notes и evidence.',
        ],
        [
          'Входят ли remote и cloud workflows в Free?',
          'SSH и remote workspace могут входить в Free как Preview; их наличие определяют release notes каждой сборки. Возможности, зависящие от управляемого hosted-сервиса, не входят в Community Free.',
        ],
        [
          'Применяет ли агент изменения автоматически?',
          'Не обязательно. Pending Edits и line-level diffs позволяют проверить и принять или отклонить изменения до commit или merge.',
        ],
        [
          'Какие модели можно использовать?',
          'Поддерживаются CLODEx account, provider API keys, custom OpenAI-compatible endpoints и локальный Ollama.',
        ],
        [
          'Как устроены вход и product statistics?',
          'CLODEx.xyz sign-in открывается в system browser и использует state/PKCE. Optional product statistics включаются или отклоняются явным выбором пользователя.',
        ],
        [
          'Что означают Preview и Labs?',
          'Это экспериментальные поверхности вне текущего release contract. Они могут измениться или исчезнуть и не создают обещание включить функцию в будущий Free-релиз.',
        ],
      ],
    },
    final: {
      title: 'Скачайте проверенный Free Technical Preview.',
      description:
        'Community Observed 11 привязана к точному source commit, build run, checksums и release evidence.',
      sales: 'Отправить feedback',
    },
  },
  en: {
    status: {
      shipped: 'Free · in source',
      preview: 'Preview',
      labs: 'Labs',
      notFree: 'Not included in Free',
    },
    hero: {
      eyebrow: 'CLODEx Community · free open-source Technical Preview',
      title: 'One task.',
      titleAccent: 'Your local engineering workspace.',
      description:
        'CLODEx brings persistent tasks, code, Git, terminal, browser, models, and MCP into one desktop workspace. Verified Community Observed 11 is available for macOS Apple Silicon and Intel, Windows x64, and Linux x64.',
      explore: "What's included in Free",
      proof: [
        'Persistent tasks with restart recovery',
        'CLODEx account, BYOK, compatible endpoints, and Ollama',
        'Pending Edits, diffs, and review before acceptance',
      ],
      taskBadge: 'Context stays with the task',
      taskBadgeDetail: 'History, workspace, processes, and changes',
      remoteBadge: 'Community · Free',
      remoteBadgeDetail: 'macOS · Windows · Linux',
    },
    proofBar: [
      ['Persistent task', 'History and restart recovery'],
      ['One workspace', 'Files, Git, terminal, and browser'],
      ['Model choice', 'Account, BYOK, compatible, and Ollama'],
      ['Open tooling', 'MCP stdio, HTTP/SSE, and OAuth'],
    ],
    pain: {
      eyebrow: 'Why an AI editor is not enough',
      title: 'A patch is not a finished task.',
      description:
        'Real engineering continues after code generation. Context must survive, local services must run, the interface must be inspected, and the developer must decide what to accept.',
      items: [
        [
          'Context is split across applications',
          'Chat, IDE, terminal, browser, and Git live separately. Developers manually carry commands, results, and state between them.',
        ],
        [
          'Tools need visible control',
          'Shell, browser, and MCP are most useful when permission requests, execution results, and changes remain inspectable.',
        ],
        [
          'Long work outlives one conversation',
          'Without a persistent task, workspace state, decisions, running processes, and unfinished changes are easy to lose after a restart.',
        ],
      ],
      conclusion:
        'CLODEx turns the local engineering loop into one resumable, reviewable task.',
    },
    workflow: {
      eyebrow: 'From request to reviewable result',
      title: 'Give the agent the whole task, not just the next edit.',
      description:
        'Context, tools, execution, changes, and verification stay inside one desktop workspace.',
      steps: [
        [
          'Define the outcome',
          'The task keeps the conversation, selected workspace, instructions, model, and working mode together.',
        ],
        [
          'Understand and plan',
          'The agent reads the codebase, Git history, AGENTS.md, and sources configured by the user.',
        ],
        [
          'Implement',
          'Files, worktrees, terminal sessions, and browser workflows remain next to the conversation.',
        ],
        [
          'Verify',
          'Logs, local services, browser state, console output, and diffs remain in the same task.',
        ],
        [
          'Accept the result',
          'Pending Edits and line-level diffs let you accept, reject, revise, or commit the changes.',
        ],
      ],
    },
    remote: {
      eyebrow: 'Remote workflows · separate Preview',
      title: 'The Free release is local-first today.',
      description:
        "SSH and remote workspaces are Free-eligible Preview surfaces. Their presence and readiness are determined by each build's release notes; capabilities that require a managed hosted service are not included in Free.",
      flow: ['Local Free task', 'SSH Preview', 'Remote workspace Preview'],
      features: [
        [
          'SSH connection setup',
          'User-provided hosts and credentials are configured explicitly. This surface is for preview testing, not a production promise.',
        ],
        [
          'Connection checks',
          'Connection testing and host verification remain Preview; verify configuration before running commands.',
        ],
        [
          'Remote working directory',
          'An experimental working-directory surface can target a remote workspace selected by the user.',
        ],
        [
          'Review before remote actions',
          'Permission and review integration for remote actions is still being validated.',
        ],
        [
          'Managed execution',
          'Execution that depends on a hosted service is not included in Community Free.',
        ],
        [
          'Hosted continuity',
          'Continuing work through managed infrastructure is not included in Community Free.',
        ],
      ],
      terminalTitle: 'remote preview · user host',
      terminalLines: [
        '$ ssh dev-box',
        'preview · verify host and permissions',
        '$ cd /workspace/project',
        'remote workspace · explicit setup required',
      ],
      note: "SSH and remote workspaces may ship in Free as Preview, but are not part of the baseline availability promise. Release notes define each build's scope; service-backed capabilities remain a separate product scope.",
    },
    capability: {
      eyebrow: 'What the Free Product Contract defines',
      title: 'Everything important stays part of the task.',
      description:
        'Free cards below describe the open local product scope. Availability in a packaged artifact is confirmed by its release notes; experiments are always labeled separately.',
      workspaceTitle: 'Persistent Tasks and Workspaces',
      workspaceText:
        'Search and resume tasks, keep workspace-aware context, create worktrees, and recover unfinished work after restarting the application.',
      runTitle: 'Code, local processes, and browser',
      runText:
        'Multi-file editing, terminal sessions, local ports, the embedded browser, console inspection, and screenshots live side by side.',
      prTitle: 'Review inside the work loop',
      prText:
        'Pending Edits, accept/reject, line-level diffs, Git operations, commits, worktrees, and pull-request review surfaces.',
      swarmTitle: 'Multi-agent coordination · Preview',
      swarmText:
        'Multi-agent coordination remains a source-tree experiment and is not part of the baseline Free promise.',
      agentLabels: ['Code', 'Research', 'Verification', 'Review'],
      working: 'Preview',
    },
    surfaces: {
      eyebrow: 'A clear Free boundary',
      title: 'Available is separated from experimental.',
      description:
        'Free · in source means the open local product scope. Release notes confirm the scope of a specific artifact; Preview and Labs do not imply stable readiness.',
      items: [
        [
          'Task history + recovery',
          'Resume saved tasks and recover unfinished work after restarting the application.',
        ],
        [
          'Files, Git, and worktrees',
          'Use files, Pending Edits, diffs, Git operations, local commits, and pull-request review.',
        ],
        [
          'Terminal + Browser',
          'Run local commands and services, open pages, inspect console output, and capture screenshots.',
        ],
        [
          'Quick Task',
          'An experimental local composer for creating a task without switching to the main window.',
        ],
        [
          'Scoped Memory',
          'Experimental memory scopes and retention rules are outside the current release contract.',
        ],
        [
          'Multi-agent coordination',
          'Experimental decomposition across multiple agents remains in Labs.',
        ],
      ],
    },
    platform: {
      eyebrow: 'Community Free today',
      title: 'A local workflow around the model you choose.',
      description:
        'CLODEx Community focuses on the desktop task, local tools, user-selected models, and reviewable changes.',
      groups: [
        {
          icon: 'agent',
          title: 'Community Desktop',
          text: 'Persistent tasks, workspace-aware context, local terminal/browser, and review surfaces in one application.',
          status: 'shipped',
          points: ['Restart recovery', 'Local tools', 'Diff & review'],
        },
        {
          icon: 'mcp',
          title: 'MCP Runtime',
          text: 'User-configured stdio, Streamable HTTP, and SSE servers with OAuth, tools, resources, and prompts.',
          status: 'shipped',
          points: ['stdio', 'HTTP / SSE', 'OAuth'],
        },
        {
          icon: 'plugins',
          title: 'Local experiments',
          text: 'Quick Task, scoped memory, and multi-agent coordination are available only where explicitly enabled as Preview or Labs.',
          status: 'preview',
          points: ['Feature-gated', 'Tester feedback', 'No stable claim'],
        },
        {
          icon: 'managed',
          title: 'Service-backed capabilities',
          text: 'Capabilities that require managed infrastructure are not included in Community Free and are documented separately if offered.',
          status: 'notFree',
          points: [
            'Separate scope',
            'Not a Free entitlement',
            'No release promise',
          ],
        },
      ],
    },
    labs: {
      eyebrow: 'Local Labs',
      title: 'Experiments remain experiments.',
      description:
        'These source-tree surfaces are outside the baseline Free Product Contract. Their presence does not promise a stable release or automatic inclusion in a packaged Free artifact.',
      items: [
        [
          'Quick Task overlay',
          'A local fast path into a new task without switching the main window.',
        ],
        [
          'Scoped Memory',
          'Prototypes for memory scopes, retention, and user review.',
        ],
        [
          'Multi-agent coordination',
          'Experimental decomposition of a complex task across local agent workers.',
        ],
        [
          'Voice input',
          'Experimental voice input for the composer; behavior and the privacy contract are still being validated.',
        ],
        [
          'Generated local apps',
          'Experimental task-owned interactive artifacts in a local preview.',
        ],
      ],
    },
    runtime: {
      eyebrow: 'What the current verified build ships',
      title: 'A local-first desktop workspace with visible review.',
      description:
        'Community Observed 11 passed the Free/managed boundary and packaged-byte gates, but a Technical Preview is not a claim of complete hardening or perfect isolation. Claims remain limited to the published release evidence.',
      layers: [
        {
          label: 'Local workspace',
          title: 'Desktop-first by default',
          text: 'Task state and desktop tooling run locally; network access is used by features and services selected by the user.',
          detail:
            'Hosted models, account access, remote MCP, and browser navigation require network access.',
        },
        {
          label: 'Task lifecycle',
          title: 'Continue after restart',
          text: 'Task history, workspace context, and unfinished work can be recovered after restarting the application.',
          detail:
            'This is a core verifiable workflow of the Free Technical Preview.',
        },
        {
          label: 'Tool surfaces',
          title: 'Tools remain observable',
          text: 'Terminal, browser, MCP, Pending Edits, and Git return results to the task and use permission or review surfaces where supported.',
          detail:
            'Review commands, tool requests, and diffs before accepting the result.',
        },
        {
          label: 'Release evidence',
          title: 'A verifiable testing distribution',
          text: 'Community Observed 11 publishes SHA-256 checksums, SBOMs, validation manifests, and an evidence archive for five installers.',
          detail:
            'macOS packages are not trust-signed or notarized; a Technical Preview is not a stable signed release.',
        },
      ],
    },
    security: {
      eyebrow: 'Security without absolute claims',
      title: 'Powerful tools.\nVisible control.',
      description:
        'CLODEx exposes permission, diff, sign-in, and privacy surfaces, but the Technical Preview should not be treated as proof of complete isolation or an absence of vulnerabilities.',
      cta: 'Security and data handling',
      items: [
        ['Pending Edits', 'Changes can be inspected before accept or reject.'],
        [
          'Permission surfaces',
          'Sensitive tool actions can request explicit permission.',
        ],
        [
          'System-browser sign-in',
          'CLODEx.xyz sign-in uses the system browser, state, and PKCE S256.',
        ],
        [
          'Protected credentials',
          'Account and provider credentials use the application protected-storage path.',
        ],
        [
          'Explicit statistics choice',
          'On first launch, the user allows or declines optional product statistics.',
        ],
        [
          'Public evidence',
          'A verified release publishes checksums, SBOMs, and validation manifests for inspection.',
        ],
      ],
    },
    models: {
      eyebrow: 'Model-independent workflow',
      title: 'Choose the model for the task without changing the workflow.',
      description:
        'The Free Product Contract includes a CLODEx account, provider API keys, custom OpenAI-compatible endpoints, and local Ollama. Release notes confirm availability in a specific artifact; external provider terms and charges remain between the user and provider.',
      categories: ['CLODEx account', 'BYOK & compatible', 'Local Ollama'],
    },
    builder: {
      eyebrow: 'Independent open-source development',
      title: 'A public desktop product you can inspect for yourself.',
      description:
        "CLODEx is developed in an open repository. The Free Product Contract is separated from Preview/Labs, and each build's claims are tied to its public artifacts and documentation.",
      rolesTitle: 'Open to a high-impact engineering role',
      rolesDescription:
        'Independent builder working on agentic developer tools and secure local execution. Open to core engineering and research engineering roles.',
      labs: ['Google DeepMind', 'xAI', 'OpenAI', 'Anthropic', 'Meta', 'NVIDIA'],
      contact: 'Discuss collaboration',
      xProfile: 'Follow on X',
    },
    support: {
      eyebrow: 'Support independent development',
      title: 'Help CLODEx move faster.',
      description:
        'Donations support the Community IDE, test infrastructure, and public documentation. Select a network and copy its corresponding USDT address.',
      copy: 'Copy address',
      copied: 'Address copied',
      copyError: 'Copy failed',
      warning:
        'Send USDT only, using the exact network shown on the card. The withdrawal network must match the address network; another network or token may cause irreversible loss.',
    },
    faq: {
      eyebrow: 'The short version',
      title: 'Questions about CLODEx Community.',
      description:
        'What the Free Product Contract defines, what release notes confirm, and where Preview begins.',
      items: [
        [
          'How is CLODEx different from an AI code editor?',
          'CLODEx is built around a resumable engineering task: workspace context, files, Git, terminal, browser, models, MCP, and review remain in one desktop application.',
        ],
        [
          'What does the Free Product Contract include?',
          'The Free Product Contract includes persistent tasks and restart recovery, files/diffs/Git/worktrees, local terminal and browser, CLODEx account, BYOK, compatible endpoints, Ollama, user-configured MCP, EN/RU beta, and the privacy choice. Community Observed 11 is the current verified Technical Preview; its exact scope is defined by its release notes and evidence.',
        ],
        [
          'Are remote and cloud workflows included in Free?',
          "SSH and remote workspaces may be included in Free as Preview; each build's release notes determine their availability. Capabilities that depend on a managed hosted service are not included in Community Free.",
        ],
        [
          'Does the agent apply every change automatically?',
          'Not necessarily. Pending Edits and line-level diffs let you inspect and accept or reject changes before commit or merge.',
        ],
        [
          'Which models can I use?',
          'CLODEx supports a CLODEx account, provider API keys, custom OpenAI-compatible endpoints, and local Ollama.',
        ],
        [
          'How do sign-in and product statistics work?',
          'CLODEx.xyz sign-in opens in the system browser and uses state/PKCE. Optional product statistics are allowed or declined through an explicit user choice.',
        ],
        [
          'What do Preview and Labs mean?',
          'They are experimental surfaces outside the current release contract. They may change or disappear and do not promise inclusion in a future Free release.',
        ],
      ],
    },
    final: {
      title: 'Download the verified Free Technical Preview.',
      description:
        'Community Observed 11 is pinned to one exact source commit, build run, checksum set, and release-evidence archive.',
      sales: 'Send feedback',
    },
  },
} as const;
