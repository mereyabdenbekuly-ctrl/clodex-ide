export type AgentStatusSeverity = 'error' | 'warning' | 'success' | 'info';

export const AGENT_STATUS_COLOR_CLASSES: Record<
  AgentStatusSeverity,
  {
    dot: string;
    glow: string;
    foreground: string;
    solidText: string;
  }
> = {
  error: {
    dot: 'bg-error-solid',
    glow: 'bg-error-solid/20',
    foreground: 'text-error-foreground',
    solidText: 'text-error-solid',
  },
  warning: {
    dot: 'bg-warning-solid',
    glow: 'bg-warning-solid/20',
    foreground: 'text-warning-foreground',
    solidText: 'text-warning-solid',
  },
  success: {
    dot: 'bg-success-solid',
    glow: 'bg-success-solid/20',
    foreground: 'text-success-foreground',
    solidText: 'text-success-solid',
  },
  info: {
    dot: 'bg-info-solid',
    glow: 'bg-info-solid/20',
    foreground: 'text-info-foreground',
    solidText: 'text-info-solid',
  },
};

const TUTORIAL_COLOR_SEVERITY: Record<string, AgentStatusSeverity> = {
  blue: 'info',
  green: 'success',
  yellow: 'warning',
  red: 'error',
};

export function getTutorialStatusTextColorClass(label: string): string {
  const severity = TUTORIAL_COLOR_SEVERITY[label.trim().toLowerCase()];
  return severity
    ? AGENT_STATUS_COLOR_CLASSES[severity].foreground
    : 'text-foreground';
}
