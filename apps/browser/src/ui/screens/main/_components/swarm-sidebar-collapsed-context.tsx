import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

// Persisted in localStorage so the user's preference survives reloads.
// Mirrors the pattern used by ContentCollapsedProvider / SidebarCollapsedProvider
// in this folder.

const STORAGE_KEY = 'clodex-swarm-sidebar-collapsed';

function readInitialCollapsed(): boolean {
  try {
    // Default to collapsed — the sidebar should appear only when a swarm is
    // actually running, otherwise the panel wastes horizontal space.
    return localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return true;
  }
}

function persist(value: boolean) {
  try {
    localStorage.setItem(STORAGE_KEY, value ? '1' : '0');
  } catch {
    // ignore
  }
}

interface SwarmSidebarCollapsedCtx {
  collapsed: boolean;
  setCollapsed: (value: boolean) => void;
  toggle: () => void;
}

const SwarmSidebarCollapsedContext =
  createContext<SwarmSidebarCollapsedCtx | null>(null);

export function SwarmSidebarCollapsedProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [collapsed, setCollapsedState] =
    useState<boolean>(readInitialCollapsed);

  const setCollapsed = useCallback((value: boolean) => {
    setCollapsedState((prev) => {
      if (prev === value) return prev;
      persist(value);
      return value;
    });
  }, []);

  const toggle = useCallback(() => {
    setCollapsedState((prev) => {
      const next = !prev;
      persist(next);
      return next;
    });
  }, []);

  const value = useMemo<SwarmSidebarCollapsedCtx>(
    () => ({ collapsed, setCollapsed, toggle }),
    [collapsed, setCollapsed, toggle],
  );

  return (
    <SwarmSidebarCollapsedContext.Provider value={value}>
      {children}
    </SwarmSidebarCollapsedContext.Provider>
  );
}

export function useSwarmSidebarCollapsed(): SwarmSidebarCollapsedCtx {
  const ctx = useContext(SwarmSidebarCollapsedContext);
  if (!ctx) {
    throw new Error(
      'useSwarmSidebarCollapsed must be used inside SwarmSidebarCollapsedProvider',
    );
  }
  return ctx;
}
