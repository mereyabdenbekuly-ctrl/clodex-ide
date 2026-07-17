export const taskEn = {
  workspace: {
    actionFailed: 'Failed to execute workspace action.',
  },
  composer: {
    placeholder:
      'Use / to plan and run commands. Use @ for context. {{queuedHint}}',
    sendQueuedHint: 'Press ↵ to send now',
    writeMessageInstead: 'Write a message instead',
    actions: {
      selectContextElements: 'Select context elements',
      stopSelectingElements: 'Stop selecting elements',
      addReferenceElements: 'Add reference elements',
      attachFile: 'Attach file',
      stopAgent: 'Stop agent',
      sendMessage: 'Send message',
    },
    swarm: {
      battleOverridesUltraLabel: 'Battle Agent overrides Ultra Deep Think',
      clearManualLabel: 'Clear manual Deep Think; Ultra remains active',
      ultraAutomaticLabel: 'Ultra automatically enables Deep Think',
      toggleLabel: 'Toggle Deep Think',
      battleOverridesUltraDescription:
        'Battle Agent overrides Ultra: this turn uses Battle instead of automatic standard Swarm.',
      clearManualDescription:
        'Manual Deep Think is also enabled. Click to clear the manual flag; Ultra will remain active.',
      ultraAutomaticDescription:
        'Ultra active: Max reasoning with automatic standard Swarm. Change model effort to disable it.',
      enabledDescription:
        'Deep Think enabled: route the next message through Swarm',
      enableDescription: 'Enable Deep Think / Swarm',
    },
    battle: {
      toggleLabel: 'Toggle Battle Agent',
      overridesUltraDescription:
        'Battle Agent overrides Ultra automatic standard Swarm for the next message.',
      enabledDescription:
        'Battle Agent enabled: models will debate before coding',
      enableDescription: 'Enable Battle Agent',
    },
  },
  approval: {
    mode: {
      alwaysAsk: {
        label: 'Always ask',
        title: 'Ask before shell commands',
        description:
          'This agent will pause and ask for your approval before running any shell command.',
      },
      smart: {
        label: 'Smart approval',
        title: 'Only ask for risky commands',
        description:
          'A fast classifier decides per command. Read-only and workspace-scoped commands run automatically; destructive or system-level commands still ask for approval.',
      },
      alwaysAllow: {
        label: 'Always allow',
        title: 'Skip future approvals',
        description:
          'This agent will run every shell command without asking. Only enable this if you trust what this agent is about to do.',
      },
    },
    actions: {
      allowOnce: 'Allow once',
      alwaysAllow: 'Always allow',
      blockOnce: 'Block once',
      alwaysBlock: 'Always block',
    },
    browser: {
      title: 'Allow browser automation?',
      requestPrefix: 'The agent wants to',
      requestOrigin: 'on',
      capabilities: {
        read: 'read page content',
        click: 'click or interact with the page',
        fileTransfer: 'upload or download files',
        fullCdpAccess: 'use unrestricted browser debugging access',
        history: 'read browsing history',
      },
    },
    desktop: {
      title: 'Allow desktop automation?',
      requestPrefix: 'The agent wants to',
      requestApplication: 'in',
      operations: {
        inspect: 'inspect accessibility controls',
        capture: 'capture the frontmost window',
        press: 'press a desktop control',
      },
      irreversibleWarning:
        'This control may be irreversible. Persistent approval is disabled.',
      systemApplicationWarning:
        'This is a system application. Persistent approval is disabled.',
    },
  },
} as const;

type LocalizedCatalog<T> = T extends string
  ? string
  : { readonly [Key in keyof T]: LocalizedCatalog<T[Key]> };

export type TaskCatalog = LocalizedCatalog<typeof taskEn>;
