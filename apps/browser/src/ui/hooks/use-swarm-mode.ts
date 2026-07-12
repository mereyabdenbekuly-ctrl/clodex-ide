import { useCallback, useSyncExternalStore } from 'react';

export type SwarmModeVariant = 'standard' | 'battle';

let swarmModeVariant: SwarmModeVariant | null = null;
const listeners = new Set<() => void>();

function emitChange(): void {
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getSwarmModeActive(): boolean {
  return swarmModeVariant !== null;
}

export function getSwarmModeVariant(): SwarmModeVariant | null {
  return swarmModeVariant;
}

export function setSwarmModeActive(next: boolean): void {
  setSwarmModeVariant(next ? 'standard' : null);
}

export function setSwarmModeVariant(next: SwarmModeVariant | null): void {
  if (swarmModeVariant === next) return;
  swarmModeVariant = next;
  emitChange();
}

export function useSwarmMode(): {
  swarmModeActive: boolean;
  swarmModeVariant: SwarmModeVariant | null;
  setSwarmModeActive: (active: boolean) => void;
  setSwarmModeVariant: (variant: SwarmModeVariant | null) => void;
  toggleSwarmMode: () => void;
  toggleBattleMode: () => void;
} {
  const variant = useSyncExternalStore(
    subscribe,
    getSwarmModeVariant,
    getSwarmModeVariant,
  );

  const setActive = useCallback((next: boolean) => {
    setSwarmModeActive(next);
  }, []);

  const setVariant = useCallback((next: SwarmModeVariant | null) => {
    setSwarmModeVariant(next);
  }, []);

  const toggle = useCallback(() => {
    setSwarmModeVariant(
      getSwarmModeVariant() === 'standard' ? null : 'standard',
    );
  }, []);

  const toggleBattle = useCallback(() => {
    setSwarmModeVariant(getSwarmModeVariant() === 'battle' ? null : 'battle');
  }, []);

  return {
    swarmModeActive: variant !== null,
    swarmModeVariant: variant,
    setSwarmModeActive: setActive,
    setSwarmModeVariant: setVariant,
    toggleSwarmMode: toggle,
    toggleBattleMode: toggleBattle,
  };
}
