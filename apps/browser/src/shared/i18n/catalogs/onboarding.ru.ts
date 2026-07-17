import type { OnboardingCatalog } from './onboarding.en';

export const onboardingRu = {
  navigation: {
    back: 'Назад',
    next: 'Далее',
    finish: 'Готово',
  },
  welcome: {
    intro: 'Добро пожаловать в агентную IDE с открытым исходным кодом.',
    product: 'Добро пожаловать в CLODEx.',
  },
  auth: {
    blockReason: {
      withCloud:
        'Подключите ключ провайдера, локальную модель или CLODEx Cloud',
      localOnly: 'Подключите ключ провайдера или локальную модель',
    },
    signedInAs: 'Вы вошли как {{name}}',
    useDifferentAccount: 'Войти в другой аккаунт',
    telemetry: {
      identifiableLabel:
        'Передавать в CLODEx идентифицируемые данные чатов и использования.',
      defaultOffNote:
        'Телеметрия по умолчанию отключена. Её можно настроить позднее.',
      anonymousObservedLabel:
        'Отправлять анонимные метрики использования продукта.',
      anonymousObservedNote:
        'Необязательно. Никогда не отправляются промты, исходный код, аргументы инструментов, команды, пути, URL, тексты ошибок или записи сессий.',
    },
    chooseConnection: {
      title: 'Выберите способ подключения',
      withCloud:
        'Используйте свой ключ, локальную модель или CLODEx Cloud по желанию.',
      localOnly: 'Используйте свой ключ провайдера или локальную модель.',
    },
    cloudSignIn: {
      title: 'С возвращением',
      description: 'Войдите в CLODEx.xyz, чтобы подключить аккаунт к IDE.',
      quickStart: 'Быстрый старт с CLODEx Cloud',
    },
    apiKey: {
      useLocalOllama: 'Использовать локальный Ollama',
      showLess: 'Показать меньше',
      showMoreProviders: 'Показать ещё {{count}} провайдера',
      createKey: 'Создать ключ',
      connectionFailed: 'Не удалось подключиться. Попробуйте ещё раз.',
      disconnectionFailed: 'Не удалось отключиться. Попробуйте ещё раз.',
      disconnecting: 'Отключение…',
      disconnect: 'Отключить',
      connecting: 'Подключение…',
      connect: 'Подключить',
    },
    localOllama: {
      configured: 'Локальный Ollama настроен.',
      description:
        'Модели будут загружаться с http://localhost:11434, API-ключ не требуется.',
      chooseAnotherProvider: 'Выбрать другого провайдера',
    },
  },
  demo: {
    slides: {
      workspace: {
        heading: 'Вся задача — в одном рабочем пространстве',
        previewHeading: 'Пространство',
        subtitle:
          'Объединяйте код, терминалы, вкладки браузера и историю задачи в постоянном окружении.',
      },
      agentOs: {
        heading: 'Управляйте выполнением через Agent OS',
        previewHeading: 'Agent OS',
        subtitle:
          'Проверяйте возможности, цели и границы выполнения до того, как агенты начнут действовать.',
      },
      automations: {
        heading: 'Автоматизируйте регулярную инженерную работу',
        previewHeading: 'Автоматизации',
        subtitle:
          'Превращайте повторяемые процессы в управляемые автоматизации с понятными триггерами и контролем.',
      },
      mcpRuntime: {
        heading: 'Подключайте инструменты через MCP',
        previewHeading: 'MCP Runtime',
        subtitle:
          'Подключайте локальные и удалённые MCP-серверы, не предоставляя каждому инструменту неограниченный доступ.',
      },
      extensions: {
        heading: 'Расширяйте CLODEx плагинами и навыками',
        previewHeading: 'Расширения',
        subtitle:
          'Устанавливайте интеграции для своего стека и контролируйте их разрешения.',
      },
    },
  },
} satisfies OnboardingCatalog;
