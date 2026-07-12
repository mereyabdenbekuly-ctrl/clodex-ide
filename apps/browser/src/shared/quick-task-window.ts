export type QuickTaskWindowContext = {
  requestId: number;
  initialPrompt: string;
  modelLabel: string;
  approvalLabel: string;
  workspaceLabels: string[];
  hasCurrentWorkspace: boolean;
};

export type QuickTaskWindowSubmitInput = {
  requestId: number;
  prompt: string;
  useCurrentWorkspace: boolean;
};

export type QuickTaskWindowSubmitResult =
  | {
      ok: true;
      agentId: string;
    }
  | {
      ok: false;
      error: string;
      retryable: boolean;
    };

export type QuickTaskWindowBridge = {
  getContext: () => Promise<QuickTaskWindowContext>;
  submit: (
    input: QuickTaskWindowSubmitInput,
  ) => Promise<QuickTaskWindowSubmitResult>;
  close: () => Promise<void>;
  onContext: (
    listener: (context: QuickTaskWindowContext) => void,
  ) => () => void;
};

export const QUICK_TASK_WINDOW_CHANNELS = {
  show: 'quick-task-window:show',
  getContext: 'quick-task-window:get-context',
  submit: 'quick-task-window:submit',
  close: 'quick-task-window:close',
  context: 'quick-task-window:context',
} as const;
