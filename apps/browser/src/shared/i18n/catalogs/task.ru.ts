import type { TaskCatalog } from './task.en';

export const taskRu = {
  workspace: {
    actionFailed: 'Не удалось выполнить действие с рабочей областью.',
  },
  composer: {
    placeholder:
      'Используйте / для команд и планирования, а @ — для добавления контекста. {{queuedHint}}',
    sendQueuedHint: 'Нажмите ↵, чтобы отправить сейчас',
    writeMessageInstead: 'Написать сообщение вместо ответа',
    actions: {
      selectContextElements: 'Выбрать элементы страницы для контекста',
      stopSelectingElements: 'Завершить выбор элементов',
      addReferenceElements: 'Добавить элементы страницы',
      attachFile: 'Прикрепить файл',
      stopAgent: 'Остановить агента',
      sendMessage: 'Отправить сообщение',
      queueMessage: 'Поставить в очередь на следующую итерацию',
    },
    queue: {
      explanation:
        'Активный запрос модели нельзя изменить на лету. Эти сообщения будут автоматически отправлены на следующей итерации после обработки ожидающего подтверждения.',
      queuedForNextIteration: 'В очереди на следующую итерацию: {{count}}',
      interruptAndSend: 'Прервать и отправить',
      interruptAndSendDescription:
        'Остановить текущую итерацию и сразу отправить сообщения из очереди',
      remove: 'Удалить из очереди',
    },
    swarm: {
      battleOverridesUltraLabel:
        'Battle Agent имеет приоритет над режимом Ultra',
      clearManualLabel:
        'Отключить ручной Deep Think; режим Ultra останется активным',
      ultraAutomaticLabel: 'Ultra автоматически включает Deep Think',
      toggleLabel: 'Переключить Deep Think',
      battleOverridesUltraDescription:
        'Battle Agent имеет приоритет: для этого сообщения будет использован Battle вместо автоматического стандартного Swarm.',
      clearManualDescription:
        'Ручной Deep Think также включён. Нажмите, чтобы отключить ручной режим; Ultra останется активным.',
      ultraAutomaticDescription:
        'Ultra активен: максимальная глубина рассуждений и автоматический стандартный Swarm. Чтобы отключить, измените режим рассуждений модели.',
      enabledDescription:
        'Deep Think включён: следующее сообщение будет обработано через Swarm',
      enableDescription: 'Включить Deep Think / Swarm',
    },
    battle: {
      toggleLabel: 'Переключить Battle Agent',
      overridesUltraDescription:
        'Для следующего сообщения Battle Agent имеет приоритет над автоматическим стандартным Swarm режима Ultra.',
      enabledDescription:
        'Battle Agent включён: модели обсудят решение перед написанием кода',
      enableDescription: 'Включить Battle Agent',
    },
  },
  approval: {
    fileEdits: {
      waitingForApproval: 'Ожидание подтверждения правок',
      applyingChanges: 'Применение изменений к файлам',
      mode: {
        manual: {
          label: 'Проверять правки',
          description:
            'Приостанавливать применение правок, чтобы вы могли проверить, принять или отклонить их.',
        },
        autoWorkspace: {
          label: 'Автоправки',
          description:
            'Автоматически применять допустимые правки существующих обычных текстовых файлов в подключённых рабочих областях. Новые, чувствительные, игнорируемые, связанные, исполняемые и read-only файлы по-прежнему требуют проверки.',
        },
      },
    },
    mode: {
      alwaysAsk: {
        label: 'Всегда спрашивать',
        title: 'Спрашивать перед командами терминала',
        description:
          'Агент остановится и запросит ваше разрешение перед выполнением каждой команды терминала.',
      },
      smart: {
        label: 'Умное подтверждение',
        title: 'Спрашивать только для рискованных команд',
        description:
          'Быстрый классификатор оценивает каждую команду. Команды только для чтения и действия внутри рабочей области выполняются автоматически, а разрушительные и системные команды требуют подтверждения.',
      },
      alwaysAllow: {
        label: 'Всегда разрешать',
        title: 'Не запрашивать подтверждение',
        description:
          'Агент будет выполнять любые команды терминала без подтверждения. Включайте этот режим, только если доверяете действиям агента.',
      },
    },
    actions: {
      allowOnce: 'Разрешить один раз',
      alwaysAllow: 'Разрешать всегда',
      blockOnce: 'Заблокировать один раз',
      alwaysBlock: 'Блокировать всегда',
    },
    browser: {
      title: 'Разрешить автоматизацию браузера?',
      requestPrefix: 'Агент хочет',
      requestOrigin: 'на сайте',
      capabilities: {
        read: 'прочитать содержимое страницы',
        click: 'нажимать элементы и взаимодействовать со страницей',
        fileTransfer: 'загружать и скачивать файлы',
        fullCdpAccess:
          'использовать неограниченный доступ к средствам отладки браузера',
        history: 'читать историю браузера',
      },
    },
    desktop: {
      title: 'Разрешить автоматизацию рабочего стола?',
      requestPrefix: 'Агент хочет',
      requestApplication: 'в приложении',
      operations: {
        inspect: 'проверить элементы специальных возможностей',
        capture: 'сделать снимок активного окна',
        press: 'нажать элемент управления',
      },
      irreversibleWarning:
        'Это действие может быть необратимым. Постоянное разрешение недоступно.',
      systemApplicationWarning:
        'Это системное приложение. Постоянное разрешение недоступно.',
    },
  },
} satisfies TaskCatalog;
