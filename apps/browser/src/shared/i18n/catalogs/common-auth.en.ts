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
      secureHandoffTitle: 'Secure desktop sign-in',
      secureHandoffDescription:
        'CLODEx.xyz opens in your system browser and returns through a state- and PKCE-bound one-time loopback callback.',
      chooseMethod: 'Choose a sign-in method',
      continueWithTelegram: 'Continue with Telegram',
      browserHandoffButton: 'Sign in through CLODEx.xyz',
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
        callbackBound:
          'Every loopback callback is bound to the initiating IDE with state + PKCE S256',
        passwordNotHandled: 'The renderer process never handles your password',
      },
      status: {
        browserHandoff: 'Browser handoff',
        systemBrowser: 'System browser',
        ideCallback: 'Loopback callback',
        accountAccess: 'Account access',
      },
      secureCallbackBound:
        'The one-time loopback callback rejects mismatches and replay attempts',
    },
  },
} as const;

type LocalizedCatalog<T> = T extends string
  ? string
  : { readonly [Key in keyof T]: LocalizedCatalog<T[Key]> };

export type CommonAuthCatalog = LocalizedCatalog<typeof commonAuthEn>;
