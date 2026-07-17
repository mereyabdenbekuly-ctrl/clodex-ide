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
      secureHandoffTitle: 'Защищённый desktop-вход готовится',
      secureHandoffDescription:
        'Legacy callback отключён до обязательной проверки state и PKCE S256.',
      chooseMethod: 'Выберите способ входа',
      continueWithTelegram: 'Продолжить с Telegram',
      browserHandoffDisabledButton: 'Вход через CLODEx.xyz временно отключён',
      browserHandoffDisabledMessage:
        'Вход через CLODEx.xyz временно отключён: серверный desktop-flow ещё не проверяет state + PKCE. Используйте Telegram или локальные API-ключи.',
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
        callbackClosed:
          'Desktop callback закрыт до внедрения state + PKCE S256',
        passwordNotHandled: 'Пароль не обрабатывается процессом рендерера',
      },
      status: {
        browserHandoff: 'Передача входа в браузер',
        systemBrowser: 'Системный браузер',
        ideCallback: 'Callback IDE',
        accountAccess: 'Доступ к аккаунту',
      },
      unsafeCallbackBlocked: 'Небезопасный callback заблокирован fail-closed',
    },
  },
} satisfies CommonAuthCatalog;
