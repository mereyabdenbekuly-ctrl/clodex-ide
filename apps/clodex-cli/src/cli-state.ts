export interface CliHistoryMessage {
  readonly role: string;
  readonly parts: readonly { readonly type: string; readonly text?: unknown }[];
}

export function lastAssistantText(
  history: readonly CliHistoryMessage[],
): string {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index];
    if (message?.role !== 'assistant') continue;
    const texts = message.parts
      .filter((part) => part.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text as string);
    if (texts.length > 0) return texts.join('\n');
  }
  return '';
}
