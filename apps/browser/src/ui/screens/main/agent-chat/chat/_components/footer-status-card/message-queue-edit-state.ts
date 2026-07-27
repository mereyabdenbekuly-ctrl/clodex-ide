import type { AgentMessage } from '@shared/karton-contracts/ui/agent';

export function replaceQueuedMessageText(
  message: AgentMessage & { role: 'user' },
  text: string,
): AgentMessage & { role: 'user' } {
  const parts = [...message.parts];
  const textIndex = parts.findIndex((part) => part.type === 'text');
  if (textIndex >= 0) {
    const previous = parts[textIndex]!;
    if (previous.type === 'text') {
      parts[textIndex] = { ...previous, text };
    }
  } else {
    parts.unshift({ type: 'text', text });
  }

  return {
    ...message,
    role: 'user',
    parts,
  };
}

export function canSaveQueuedMessageDraft(text: string): boolean {
  return text.trim().length > 0;
}
