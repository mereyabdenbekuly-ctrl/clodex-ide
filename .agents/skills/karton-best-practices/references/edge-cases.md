# Edge Cases

## Table of Contents
- Dynamic Keys and Optional Chaining
- Arrays Inside State
- Map/Set in State (SuperJSON)
- Connection State Interactions
- React StrictMode
- Multiple Karton Providers
- Selector Closure Stale Values
- Large State Trees
- Rapid State Updates

---

## Dynamic Keys and Optional Chaining

When selecting by a dynamic key (e.g., `openAgent` that can be null/undefined), the selector must handle the missing case.

```typescript
// CORRECT: Return a stable fallback for missing keys
const workspace = useKartonState(
  (s) => (openAgent ? s.toolbox[openAgent]?.workspace?.path ?? null : null),
);

// DANGER: undefined !== undefined is false (Object.is), so this is safe,
// BUT if the key changes from one valid ID to another, you get a re-render
// even if both agents have the same workspace path. This is correct behavior.
```

**When `openAgent` changes:** The selector returns a different subtree. This always triggers a re-render because the new reference is from a different Immer path. `useComparingSelector` can prevent this re-render if the values are structurally equal, but usually you WANT the re-render because the component is now showing different data.

---

## Arrays Inside State

Immer treats arrays like objects for structural sharing. Modifying element at index `i` creates a new array reference, but elements at other indices keep their references.

```typescript
// Server-side:
setState((draft) => {
  draft.agents.instances['a1'].state.history.push(newMessage);
});
// Result: history array has NEW reference, but all existing message objects
// in the array keep their references. Only the array itself and the new
// element are new.
```

**For selectors returning arrays:**
```typescript
// This returns the frozen history array — stable when no messages added/changed
const history = useKartonState((s) => s.agents.instances[id]?.state.history ?? []);

// CAUTION: The `?? []` creates a new empty array every time when agent is missing.
// If agent is frequently undefined, use useComparingSelector or extract the check.
```

**Fix for the empty array fallback:**
```typescript
const EMPTY_ARRAY: readonly unknown[] = [];
const history = useKartonState(
  (s) => s.agents.instances[id]?.state.history ?? EMPTY_ARRAY,
);
```

---

## Map/Set in State (SuperJSON)

Karton uses SuperJSON for serialization, which supports Map and Set. However, Maps and Sets in state are frozen by Immer and get new references on any mutation.

```typescript
// Karton supports Map/Set in state, but the comparators handle them:
// - shallow: compares Map entries with Object.is on values
// - deep: recursively compares Map/Set entries
```

**Prefer plain objects over Maps in state** — they work better with TypeScript types and Immer's structural sharing is optimized for plain objects.

---

## Connection State Interactions

`onOpen` and `onClose` events call `onStateChange()`, which notifies ALL listeners — including `useKartonState` subscribers.

```typescript
// This means: on reconnect, every useKartonState hook re-evaluates its selector.
// For patch-based updates (normal operation), only changed state triggers re-renders.
// For full state sync (reconnection), ALL references are new → all components re-render once.
```

**Mitigation:** Use `useComparingSelector` for components that should not re-render on reconnect if their derived value hasn't changed. `shallow` or `deep` comparison will catch structural equality even when references differ after reconnect.

```typescript
// Survives reconnection without re-render if isWorking hasn't actually changed
const isWorking = useKartonState(
  useComparingSelector(
    (s) => s.agents.instances[id]?.state.isWorking ?? false,
  ),
);
// Actually, primitives already survive this because Object.is(false, false) === true
// The concern is objects/arrays that get new references after full sync
```

---

## React StrictMode

Karton handles StrictMode correctly. The client and listener Set are created at **module scope** (outside the React tree), so they survive StrictMode's mount-unmount-remount cycle.

```typescript
// From karton-react-client.tsx:
const listeners = new Set<() => void>();  // Module scope — survives remount
const client = createKartonClient({...}); // Module scope — survives remount
```

**No special handling needed** in consuming components. The `useSyncExternalStore` hook is designed for external stores and is StrictMode-safe.

---

## Multiple Karton Providers

Each `createKartonReactClient()` call creates an isolated context, client, and listener set. Multiple providers can coexist without interference.

```typescript
// Main UI karton
const [UIProvider, useUIState, useUIProcedure, useUIConnected] =
  createKartonReactClient<UIContract>({ ... });

// Page-level karton (different connection)
const [PageProvider, usePageState, usePageProcedure, usePageConnected] =
  createKartonReactClient<PageContract>({ ... });
```

**Hooks are scoped to their provider.** Using `useUIState` inside a `PageProvider` (without a `UIProvider` ancestor) throws an error.

---

## Selector Closure Stale Values

Selectors capture closure variables from the render scope. If a selector depends on a prop or local state, ensure the selector updates when that value changes.

```typescript
// CORRECT: selector captures `id` from render scope
// When `id` changes, a new selector function is created, and useCallback
// inside useKartonState creates a new selectorFunc → re-evaluates
const agent = useKartonState((s) => s.agents.instances[id]);

// CAUTION: If you memoize the selector yourself, ensure deps are correct
const selector = useCallback(
  (s: KartonState<T>) => s.agents.instances[id],
  [id], // Must include id!
);
const agent = useKartonState(selector);
```

**With `useComparingSelector`:** The returned selector function closes over `useRef`. If the outer selector captures stale values, the comparison will be against stale data. Always ensure dynamic values used inside `useComparingSelector` cause re-creation of the wrapping hook call.

```typescript
// CORRECT: useComparingSelector re-runs when id changes (new render, new hook call)
const agent = useKartonState(
  useComparingSelector((s) => s.agents.instances[id]),
);
// The selector function is recreated every render (because it's an inline arrow),
// and useComparingSelector returns a new wrapper function each time.
// useSyncExternalStore handles this correctly by always calling the latest snapshot.
```

---

## Large State Trees

For state trees with hundreds of entries (e.g., large agent instance maps), selector performance matters.

**Avoid in selectors:**
- `Object.keys(largeMap).length` — iterates all keys. Cache the count in state if needed.
- `Object.values(largeMap).filter(...)` — creates intermediate arrays.
- `.sort()` — O(n log n) on every state change.

**Prefer:**
- Select the specific subtree you need (O(1) property access)
- Use `useMemo` for any computation heavier than property access
- Consider adding computed/cached fields on the server side if a derivation is expensive and used by multiple clients

---

## Rapid State Updates

When the server updates state rapidly (e.g., streaming AI responses), React batches updates from `useSyncExternalStore`. Multiple state changes within the same microtask may result in a single re-render.

However, each state change still:
1. Runs `produce()` on the server (Immer overhead)
2. Serializes and transmits patches
3. Applies patches on the client
4. Calls all listeners
5. Each listener's selector runs

**For high-frequency updates:** Ensure selectors are cheap. If a component displays streaming text, select the text string directly rather than the entire message object:

```typescript
// GOOD: Primitive comparison — cheap
const lastMessage = useKartonState(
  (s) => s.agents.instances[id]?.state.history.at(-1)?.content ?? '',
);

// BAD: Selects entire history array — new reference on every message append
const history = useKartonState(
  (s) => s.agents.instances[id]?.state.history ?? [],
);
```
