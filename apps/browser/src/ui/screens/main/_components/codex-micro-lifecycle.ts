export type MountedFlag = {
  current: boolean;
};

/**
 * React StrictMode replays effect setup/cleanup during development. Resetting
 * the flag in setup keeps async Micro actions from getting stuck after that
 * replay marks the first mount as disposed.
 */
export function activateMountedFlag(flag: MountedFlag): () => void {
  flag.current = true;
  return () => {
    flag.current = false;
  };
}
