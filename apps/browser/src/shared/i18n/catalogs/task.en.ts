export const taskEn = {
  workspace: {
    actionFailed: 'Failed to execute workspace action.',
  },
  composer: {
    placeholder:
      'Use / to plan and run commands. Use @ for context. {{queuedHint}}',
    queuedWaitingHint: 'Queued messages will run after the current step.',
    writeMessageInstead: 'Write a message instead',
    actions: {
      selectContextElements: 'Select context elements',
      stopSelectingElements: 'Stop selecting elements',
      addReferenceElements: 'Add reference elements',
      attachFile: 'Attach file',
      stopAgent: 'Stop agent',
      sendMessage: 'Send message',
      queueMessage: 'Send after current step',
    },
    queue: {
      explanation:
        'Messages are delivered in order after the current read, write, or command finishes. Pending approvals stay open until you decide them.',
      queuedForNextIteration: '{{count}} waiting after current step',
      interruptAndSend: 'Stop step & send now',
      interruptAndSendDescription:
        'Explicitly abort the current step and send the queued messages immediately',
      remove: 'Remove from queue',
      edit: 'Edit queued message',
      save: 'Save',
      cancel: 'Cancel',
      noLongerQueued: 'That message has already left the queue.',
      updateFailed: 'Could not save the queued message. Try again.',
    },
    swarm: {
      battleOverridesUltraLabel: 'Battle Agent overrides Ultra Deep Think',
      clearManualLabel: 'Clear manual Deep Think; Ultra remains active',
      ultraAutomaticLabel: 'Switch Ultra to Max and disable automatic Swarm',
      toggleLabel: 'Toggle Deep Think',
      battleOverridesUltraDescription:
        'Battle Agent overrides Ultra: this turn uses Battle instead of automatic standard Swarm.',
      clearManualDescription:
        'Manual Deep Think is also enabled. Click to clear the manual flag; Ultra will remain active.',
      ultraAutomaticDescription:
        'Ultra is active: Max reasoning with automatic standard Swarm. Click to switch this model route to Max and disable automatic Swarm for later or queued turns. The current run continues until stopped.',
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
      enableDescription: 'Enable Battle Agent for the next message',
    },
  },
  approval: {
    fileEdits: {
      waitingForApproval: 'Waiting for file approval',
      applyingChanges: 'Applying file changes',
      mode: {
        manual: {
          label: 'Review edits',
          description:
            'Pause before applying file edits so you can review and accept or reject them.',
        },
        autoWorkspace: {
          label: 'Auto edits',
          description:
            'Automatically apply eligible edits to existing regular text files in connected workspaces, plus checkbox progress updates in previously approved plans. New, sensitive, ignored, linked, executable, or read-only files still require review.',
        },
      },
    },
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
