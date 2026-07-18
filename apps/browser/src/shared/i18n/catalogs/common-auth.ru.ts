import type { CommonAuthCatalog } from './common-auth.en';

export const commonAuthRu = {
  auth: {
    signIn: {
      defaultTitle: 'С возвращением',
      defaultDescription:
        'Войдите в аккаунт CLODEx, чтобы управлять доступом к моделям и API.',
      panelAriaLabel: 'Вход в CLODEx',
      eyebrow: 'Доступ к аккаунту',
      noAccount: 'Нет аккаунта?',
      register: 'Зарегистрироваться',
      secureHandoffTitle: 'Защищённый вход в IDE',
      secureHandoffDescription:
        'CLODEx.xyz откроется в системном браузере и вернёт одноразовый loopback callback, привязанный через state и PKCE.',
      chooseMethod: 'Выберите способ входа',
      continueWithTelegram: 'Продолжить с Telegram',
      browserHandoffButton: 'Войти через CLODEx.xyz',
      genericFailure:
        'Не удалось завершить вход через CLODEx. Попробуйте ещё раз.',
      terms:
        'Продолжая, вы соглашаетесь с применимыми условиями использования и политикой конфиденциальности CLODEx.xyz.',
      homeLink: 'На CLODEx.xyz',
      storyAriaLabel: 'О CLODEx',
      storyEyebrow: 'CLODEx для AI-продуктов',
      headline: {
        account: 'Один аккаунт.',
        models: 'Лучшие модели.',
        control: 'Полный контроль.',
      },
      storyDescription:
        'Подключайте coding agents и AI-продукты через единый вход CLODEx.',
      benefits: {
        systemBrowser:
          'Системный браузер без передачи пароля процессу рендерера',
        callbackBound:
          'Каждый loopback callback привязан к запустившей вход IDE через state + PKCE S256',
        passwordNotHandled: 'Пароль не обрабатывается процессом рендерера',
      },
      status: {
        browserHandoff: 'Передача входа в браузер',
        systemBrowser: 'Системный браузер',
        ideCallback: 'Loopback callback',
        accountAccess: 'Доступ к аккаунту',
      },
      secureCallbackBound:
        'Одноразовый loopback callback отклоняет несовпадения и повторы',
    },
  },
} satisfies CommonAuthCatalog;
