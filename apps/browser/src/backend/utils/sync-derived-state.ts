type StateSource<S> = {
  registerStateChangeCallback: (cb: (state: S) => void) => void;
  unregisterStateChangeCallback: (cb: (state: S) => void) => void;
  state: S;
};

/**
 * Keeps a derived slice of a Karton state source in sync with a consumer.
 *
 * On every state change, runs `selector` to derive a value, then compares
 * a string snapshot of that value against the previous one. The `onChanged`
 * callback only fires when the snapshot actually differs, preventing
 * redundant updates.
 *
 * @param source      Any object with Karton-style register/unregister callbacks
 *                    and a `state` property (e.g. `KartonService`, `KartonServer`).
 * @param selector    Pure function that extracts/derives data from the full state.
 * @param onChanged   Called with the derived value whenever it changes.
 * @param options.snapshotFn   Converts the derived value to a string for comparison.
 *                             Defaults to `JSON.stringify`. Supply a custom function
 *                             when the derived value is large or you need a cheaper
 *                             equality check.
 * @param options.fireImmediately  If `true`, evaluates the selector against the
 *                                 current state and fires `onChanged` once at
 *                                 registration time (if the snapshot is non-empty).
 * @returns An unsubscribe function that removes the state-change listener.
 *
 * @example
 * ```ts
 * // Sync deduplicated workspace mounts from uiKarton to pagesService:
 * const unsubscribe = syncDerivedState(
 *   uiKarton,
 *   (state) => {
 *     const seen = new Map();
 *     for (const id in state.toolbox) {
 *       for (const m of state.toolbox[id]?.workspace?.mounts ?? [])
 *         if (!seen.has(m.path)) seen.set(m.path, m);
 *     }
 *     return [...seen.values()];
 *   },
 *   (mounts) => pagesService.syncWorkspaceMountsState(mounts),
 * );
 *
 * // Later, to stop syncing:
 * unsubscribe();
 * ```
 */
export function syncDerivedState<TSource, TDerived>(
  source: StateSource<TSource>,
  selector: (state: TSource) => TDerived,
  onChanged: (derived: TDerived) => void,
  options?: {
    snapshotFn?: (derived: TDerived) => string;
    fireImmediately?: boolean;
  },
): () => void {
  const snapshotFn = options?.snapshotFn ?? JSON.stringify;
  let previousSnapshot = '';

  const callback = (state: TSource) => {
    const derived = selector(state);
    const snapshot = snapshotFn(derived);
    if (snapshot !== previousSnapshot) {
      previousSnapshot = snapshot;
      onChanged(derived);
    }
  };

  source.registerStateChangeCallback(callback);

  if (options?.fireImmediately) callback(source.state);

  return () => {
    source.unregisterStateChangeCallback(callback);
  };
}
