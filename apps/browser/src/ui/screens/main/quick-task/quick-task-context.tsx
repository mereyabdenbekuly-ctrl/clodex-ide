import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

type QuickTaskOpenOptions = {
  initialPrompt?: string;
};

type QuickTaskContextValue = {
  isOpen: boolean;
  initialPrompt: string;
  open: (options?: QuickTaskOpenOptions) => void;
  close: () => void;
  toggle: (options?: QuickTaskOpenOptions) => void;
};

const QuickTaskContext = createContext<QuickTaskContextValue | null>(null);

export function QuickTaskProvider({ children }: { children: ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);
  const [initialPrompt, setInitialPrompt] = useState('');

  const open = useCallback((options?: QuickTaskOpenOptions) => {
    const prompt = options?.initialPrompt ?? '';
    const openOverlay = () => {
      setInitialPrompt(prompt);
      setIsOpen(true);
    };
    const nativeWindow = window.electron.quickTaskWindow;
    if (!nativeWindow) {
      openOverlay();
      return;
    }
    void nativeWindow
      .open(prompt)
      .then((opened) => {
        if (!opened) openOverlay();
      })
      .catch(openOverlay);
  }, []);

  const close = useCallback(() => {
    setIsOpen(false);
    setInitialPrompt('');
  }, []);

  const toggle = useCallback(
    (options?: QuickTaskOpenOptions) => {
      if (isOpen) {
        close();
        return;
      }
      const prompt = options?.initialPrompt ?? '';
      const nativeWindow = window.electron.quickTaskWindow;
      if (!nativeWindow) {
        open(options);
        return;
      }
      void nativeWindow
        .toggle(prompt)
        .then((opened) => {
          if (!opened) open(options);
        })
        .catch(() => open(options));
    },
    [close, isOpen, open],
  );

  const value = useMemo(
    () => ({ isOpen, initialPrompt, open, close, toggle }),
    [close, initialPrompt, isOpen, open, toggle],
  );

  return (
    <QuickTaskContext.Provider value={value}>
      {children}
    </QuickTaskContext.Provider>
  );
}

export function useQuickTask() {
  const value = useContext(QuickTaskContext);
  if (!value) {
    throw new Error('useQuickTask must be used within QuickTaskProvider');
  }
  return value;
}
