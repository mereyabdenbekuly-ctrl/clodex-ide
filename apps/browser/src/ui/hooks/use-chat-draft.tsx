import {
  createContext,
  useContext,
  useRef,
  useCallback,
  type ReactNode,
} from 'react';

interface ChatDraftContextValue {
  getDraft: () => string;
  registerDraftGetter: (getter: () => string) => () => void;
}

const ChatDraftContext = createContext<ChatDraftContextValue | null>(null);

export function ChatDraftProvider({ children }: { children: ReactNode }) {
  const draftGetterRef = useRef<(() => string) | null>(null);

  const getDraft = useCallback(() => {
    return draftGetterRef.current?.() ?? '';
  }, []);

  const registerDraftGetter = useCallback((getter: () => string) => {
    draftGetterRef.current = getter;
    return () => {
      draftGetterRef.current = null;
    };
  }, []);

  return (
    <ChatDraftContext.Provider value={{ getDraft, registerDraftGetter }}>
      {children}
    </ChatDraftContext.Provider>
  );
}

export function useChatDraft() {
  const context = useContext(ChatDraftContext);
  if (!context) {
    throw new Error('useChatDraft must be used within a ChatDraftProvider');
  }
  return context;
}
