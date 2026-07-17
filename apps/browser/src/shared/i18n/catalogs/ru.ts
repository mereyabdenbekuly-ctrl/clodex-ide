import { commonAuthRu } from './common-auth.ru';
import type { AppCatalog } from './en';
import { onboardingRu } from './onboarding.ru';
import { taskRu } from './task.ru';

export const ruCatalog = {
  common: {
    ...commonAuthRu,
    language: {
      system: 'System',
      english: 'English',
      russianBeta: 'Русский (beta)',
    },
    itemCount_one: '{{count}} элемент',
    itemCount_few: '{{count}} элемента',
    itemCount_many: '{{count}} элементов',
    itemCount_other: '{{count}} элемента',
  },
  settings: {
    telemetry: {
      title: 'Телеметрия',
      standardDescription:
        'Управляйте данными об использовании, которые помогают улучшать CLODEx.',
      anonymousLabel: 'Помогать улучшать CLODEx, отправляя анонимные события.',
      fullLabel:
        'Отправлять идентифицируемые данные чата и использования в CLODEx.',
      observedDescription:
        'По желанию отправляйте анонимные метрики этой тестовой community-сборки.',
      observedLabel: 'Отправлять анонимные метрики использования продукта.',
      observedPrivacyNote:
        'Никогда не отправляются промты, исходный код, аргументы инструментов, команды, пути к файлам, URL, тексты ошибок или записи сессий.',
    },
    personalization: {
      eyebrow: 'Интерфейс',
      title: 'Персонализация',
      description:
        'Настройте внешний вид, масштаб интерфейса, уведомления и стиль общения агента.',
      language: {
        sectionTitle: 'Язык',
        sectionDescription: 'Выберите язык интерфейса CLODEx.',
        title: 'Язык интерфейса',
        description:
          'Русский язык доступен как бета-версия. Непереведённый текст останется на английском.',
        saveError: 'Не удалось сохранить язык интерфейса',
      },
    },
  },
  onboarding: onboardingRu,
  task: taskRu,
} satisfies AppCatalog;
