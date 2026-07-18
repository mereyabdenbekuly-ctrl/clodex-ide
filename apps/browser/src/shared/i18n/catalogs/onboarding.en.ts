export const onboardingEn = {
  navigation: {
    back: 'Back',
    next: 'Next',
    finish: 'Finish',
  },
  welcome: {
    intro: 'Welcome to the open-source agentic IDE.',
    product: 'Welcome to CLODEx.',
  },
  telemetryConsent: {
    title: 'Help improve CLODEx',
    description:
      'CLODEx can send a small allowlisted set of anonymous product events to PostHog using a pseudonymous installation ID. Choose whether to enable it before continuing.',
    sharedTitle: 'What may be shared',
    sharedDescription:
      'Feature usage, success or failure counters, bounded timing data, and app version or platform metadata.',
    privateTitle: 'What always stays private',
    privateDescription:
      'Prompts and messages, source code, commands, tool arguments, file paths, URLs, API keys and credentials, error text, and session recordings.',
    safeguards:
      'Account identification, GeoIP enrichment, exception capture, session recording, and AI tracing are disabled.',
    allow: 'Allow anonymous statistics',
    decline: 'Continue without statistics',
    settingsNote:
      'You can disable or enable anonymous statistics later in Settings → Account.',
    saveError: 'Could not save your choice. Please try again.',
  },
  auth: {
    blockReason: {
      withCloud: 'Connect a provider key, a local model, or CLODEx Cloud',
      localOnly: 'Connect a provider key or a local model',
    },
    signedInAs: "You're signed in as {{name}}",
    useDifferentAccount: 'Use a different account',
    telemetry: {
      identifiableLabel: 'Share identifiable chat and usage data with CLODEx.',
      defaultOffNote:
        'Telemetry is disabled by default and can be configured in settings.',
    },
    chooseConnection: {
      title: 'Choose how to connect',
      withCloud: 'Use your own key, a local model, or optional CLODEx Cloud.',
      localOnly: 'Use your own provider key or a local model.',
    },
    cloudSignIn: {
      title: 'Welcome back',
      description:
        'Sign in securely on CLODEx.xyz in your system browser to connect your account to the IDE.',
      quickStart: 'Quick start with CLODEx Cloud',
    },
    apiKey: {
      useLocalOllama: 'Use local Ollama',
      showLess: 'Show less',
      showMoreProviders: 'Show {{count}} more providers',
      createKey: 'Create key',
      connectionFailed: 'Connection failed. Please try again.',
      disconnectionFailed: 'Disconnection failed. Please try again.',
      disconnecting: 'Disconnecting…',
      disconnect: 'Disconnect',
      connecting: 'Connecting…',
      connect: 'Connect',
    },
    localOllama: {
      configured: 'Local Ollama is configured.',
      description:
        'Models will be loaded from http://localhost:11434 and no API key is required.',
      chooseAnotherProvider: 'Choose another provider',
    },
  },
  demo: {
    slides: {
      workspace: {
        heading: 'Keep the whole task in one workspace',
        previewHeading: 'Workspace',
        subtitle:
          'Connect code, terminals, browser tabs and task history in one persistent environment.',
      },
      agentOs: {
        heading: 'Govern execution with Agent OS',
        previewHeading: 'Agent OS',
        subtitle:
          'Review capabilities, goals and execution boundaries before agents take action.',
      },
      automations: {
        heading: 'Automate recurring engineering work',
        previewHeading: 'Automations',
        subtitle:
          'Turn repeatable workflows into governed automations with clear triggers and controls.',
      },
      mcpRuntime: {
        heading: 'Connect tools through MCP',
        previewHeading: 'MCP Runtime',
        subtitle:
          'Attach local and remote MCP servers without giving every tool unrestricted access.',
      },
      extensions: {
        heading: 'Extend CLODEx with plugins and skills',
        previewHeading: 'Extensions',
        subtitle:
          'Install integrations for your stack and keep their permissions visible and controlled.',
      },
    },
  },
} as const;

type LocalizedCatalog<T> = T extends string
  ? string
  : { readonly [Key in keyof T]: LocalizedCatalog<T[Key]> };

export type OnboardingCatalog = LocalizedCatalog<typeof onboardingEn>;
