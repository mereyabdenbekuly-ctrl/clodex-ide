import { createContext, useContext } from 'react';
import type { Mount } from '@shared/karton-contracts/ui/agent/metadata';

const MountedPathsContext = createContext<Mount[] | null>(null);

export const MountedPathsProvider = MountedPathsContext.Provider;

export function useMountedPaths(): Mount[] | null {
  return useContext(MountedPathsContext);
}
