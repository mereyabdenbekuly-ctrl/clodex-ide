export const commonAuthEn = {
  auth: {
    signIn: {
      defaultTitle: 'Welcome back',
      defaultDescription:
        'Sign in to your CLODEx account to manage access to models and APIs.',
      panelAriaLabel: 'Sign in to CLODEx',
      eyebrow: 'Account access',
      noAccount: "Don't have an account?",
      register: 'Create account',
      secureHandoffTitle: 'Secure desktop sign-in is in progress',
      secureHandoffDescription:
        'The legacy callback is disabled until mandatory state and PKCE S256 validation is in place.',
      chooseMethod: 'Choose a sign-in method',
      continueWithTelegram: 'Continue with Telegram',
      browserHandoffDisabledButton:
        'Sign-in through CLODEx.xyz is temporarily unavailable',
      browserHandoffDisabledMessage:
        'Sign-in through CLODEx.xyz is temporarily unavailable: the server-side desktop flow does not yet validate state + PKCE. Use Telegram or local API keys.',
      genericFailure: 'Could not complete CLODEx sign-in. Please try again.',
      terms:
        'By continuing, you agree to the applicable CLODEx.xyz terms of use and privacy policy.',
      homeLink: 'Go to CLODEx.xyz',
      storyAriaLabel: 'About CLODEx',
      storyEyebrow: 'CLODEx for AI products',
      headline: {
        account: 'One account.',
        models: 'The best models.',
        control: 'Complete control.',
      },
      storyDescription:
        'Connect coding agents and AI products with a single CLODEx sign-in.',
      benefits: {
        systemBrowser:
          'Use the system browser without sending your password to the renderer process',
        callbackClosed:
          'The desktop callback stays closed until state + PKCE S256 is implemented',
        passwordNotHandled: 'The renderer process never handles your password',
      },
      status: {
        browserHandoff: 'Browser handoff',
        systemBrowser: 'System browser',
        ideCallback: 'IDE callback',
        accountAccess: 'Account access',
      },
      unsafeCallbackBlocked: 'Unsafe callback is blocked fail-closed',
    },
  },
} as const;

type LocalizedCatalog<T> = T extends string
  ? string
  : { readonly [Key in keyof T]: LocalizedCatalog<T[Key]> };

export type CommonAuthCatalog = LocalizedCatalog<typeof commonAuthEn>;
