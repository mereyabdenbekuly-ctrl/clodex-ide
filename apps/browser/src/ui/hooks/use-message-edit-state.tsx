import {
  type ReactNode,
  createContext,
  useContext,
  useState,
  useCallback,
  useMemo,
  useRef,
} from 'react';

/**
 * Context for tracking which message is being edited and routing drop events.
 * When a message enters edit mode, it registers itself and provides a callback
 * for receiving drop events. The ChatPanel uses this to route drops
 * to the correct input (main chat or editing message).
 */

type DropEventHandler = (e: React.DragEvent) => void;

interface MessageEditContext {
  /** The ID of the message currently being edited, or null if none */
  activeEditMessageId: string | null;
  /** Register this message as being edited and provide a drop event handler */
  registerEditMode: (messageId: string, onDrop: DropEventHandler) => void;
  /** Unregister edit mode (call when exiting edit) */
  unregisterEditMode: (messageId: string) => void;
  /** Forward a drop event to the active input (routes to editing message or main chat) */
  forwardDropEvent: (e: React.DragEvent) => void;
  /** Set the main drop event handler (used when no message is being edited) */
  setMainDropHandler: (handler: DropEventHandler) => void;
}

const MessageEditStateContext = createContext<MessageEditContext>({
  activeEditMessageId: null,
  registerEditMode: () => {},
  unregisterEditMode: () => {},
  forwardDropEvent: () => {},
  setMainDropHandler: () => {},
});

interface MessageEditStateProviderProps {
  children: ReactNode;
}

export const MessageEditStateProvider = ({
  children,
}: MessageEditStateProviderProps) => {
  const [activeEditMessageId, setActiveEditMessageId] = useState<string | null>(
    null,
  );
  // Use refs for synchronous access (avoids race conditions with state updater functions)
  const activeEditMessageIdRef = useRef<string | null>(null);
  const editDropHandlerRef = useRef<DropEventHandler | null>(null);
  const mainDropHandlerRef = useRef<DropEventHandler | null>(null);

  const setMainDropHandler = useCallback((handler: DropEventHandler) => {
    mainDropHandlerRef.current = handler;
  }, []);

  const registerEditMode = useCallback(
    (messageId: string, onDrop: DropEventHandler) => {
      // Set refs synchronously first (avoids race with async state updaters)
      activeEditMessageIdRef.current = messageId;
      editDropHandlerRef.current = onDrop;
      setActiveEditMessageId(messageId);
    },
    [],
  );

  const unregisterEditMode = useCallback((messageId: string) => {
    // Check ref synchronously (not async state updater) to avoid race conditions
    if (activeEditMessageIdRef.current === messageId) {
      activeEditMessageIdRef.current = null;
      editDropHandlerRef.current = null;
      setActiveEditMessageId(null);
    }
  }, []);

  const forwardDropEvent = useCallback((e: React.DragEvent) => {
    // Route to the editing message handler
    if (editDropHandlerRef.current) editDropHandlerRef.current(e);
    // Use fallback (main chat input)
    else mainDropHandlerRef.current?.(e);
  }, []);

  const value = useMemo(
    () => ({
      activeEditMessageId,
      registerEditMode,
      unregisterEditMode,
      forwardDropEvent,
      setMainDropHandler,
    }),
    [
      activeEditMessageId,
      registerEditMode,
      unregisterEditMode,
      forwardDropEvent,
      setMainDropHandler,
    ],
  );

  return (
    <MessageEditStateContext.Provider value={value}>
      {children}
    </MessageEditStateContext.Provider>
  );
};

/**
 * Hook to access message edit state.
 * Use this to track which message is being edited and route file drops.
 */
export function useMessageEditState() {
  const context = useContext(MessageEditStateContext);
  if (!context) {
    throw new Error(
      'useMessageEditState must be used within a MessageEditStateProvider',
    );
  }
  return context;
}
