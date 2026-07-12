export const CHAT_INPUT_FOCUS_REQUESTED_EVENT =
  'chat-input-focus-requested' as const;
export const CHAT_INPUT_PREFILL_REQUESTED_EVENT =
  'chat-input-prefill-requested' as const;
export const CHAT_INPUT_INSERT_TEXT_REQUESTED_EVENT =
  'chat-input-insert-text-requested' as const;

export type ChatInputPrefillRequestedEvent = CustomEvent<{
  text: string;
}>;
export type ChatInputInsertTextRequestedEvent = CustomEvent<{
  text: string;
}>;

declare global {
  interface WindowEventMap {
    [CHAT_INPUT_PREFILL_REQUESTED_EVENT]: ChatInputPrefillRequestedEvent;
    [CHAT_INPUT_INSERT_TEXT_REQUESTED_EVENT]: ChatInputInsertTextRequestedEvent;
  }
}

export function requestChatInputFocus() {
  window.dispatchEvent(new Event(CHAT_INPUT_FOCUS_REQUESTED_EVENT));
}

export function requestChatInputPrefill(text: string) {
  window.dispatchEvent(
    new CustomEvent(CHAT_INPUT_PREFILL_REQUESTED_EVENT, {
      detail: { text },
    }),
  );
}

export function requestChatInputInsertText(text: string) {
  window.dispatchEvent(
    new CustomEvent(CHAT_INPUT_INSERT_TEXT_REQUESTED_EVENT, {
      detail: { text },
    }),
  );
}
