# Re-render Prevention

## Table of Contents
- How useSyncExternalStore Triggers Re-renders
- useComparingSelector Internals
- Choosing a Comparator
- useMemo for Derived State
- useRef for Callback Stability
- Component Splitting Strategy
- React.memo Considerations

---

## How useSyncExternalStore Triggers Re-renders

`useKartonState` uses React's `useSyncExternalStore` with a snapshot function:

```typescript
const selectorFunc = useCallback(
  () => selector(client.state),
  [selector, client.state],
);
const selectedValue = useSyncExternalStore(subscribe, selectorFunc, selectorFunc);
```

Re-render flow:
1. Server state change arrives
2. `onStateChange()` notifies all listeners (the subscribe callback set)
3. React calls `selectorFunc()` to get the new snapshot
4. React compares with previous snapshot using `Object.is(prev, next)`
5. If different: component re-renders. If same: no re-render

**Key insight:** The `useCallback` wrapping `selectorFunc` depends on `client.state`. When state changes, `client.state` is a new reference (Immer), so `selectorFunc` gets recreated. But `useSyncExternalStore` compares **snapshot values**, not function references.

---

## useComparingSelector Internals

Source: `packages/karton/src/react/client/karton-react-client.tsx:171-187`

```typescript
function useComparingSelector<T, R>(
  selector: StateSelector<T, R>,
  comparator: EqualityFn<R> = shallow,  // defaults to shallow
): StateSelector<T, R> {
  const previousValueRef = useRef<R | null>(null);
  return (state) => {
    const next = selector(state);
    if (previousValueRef.current !== null && comparator(previousValueRef.current, next)) {
      return previousValueRef.current;  // return OLD reference if equal
    }
    previousValueRef.current = next;
    return next;
  };
}
```

**How it prevents re-renders:** When the comparator determines the new value equals the previous one, it returns the **previous reference**. Since `useSyncExternalStore` uses `Object.is`, returning the same reference = no re-render.

**Important:** `useComparingSelector` is a hook (uses `useRef`) — call it at the top level of your component, not inside callbacks or conditions.

```typescript
// CORRECT: Hook at top level
const data = useKartonState(
  useComparingSelector((s) => ({ foo: s.foo, bar: s.bar })),
);

// WRONG: Hook inside callback
const getData = useCallback(() => {
  return useKartonState(useComparingSelector((s) => s.foo)); // Rules of Hooks violation
}, []);
```

---

## Choosing a Comparator

### `shallow` (default)
Source: `packages/karton/src/react/comparators.ts:45-70`

- First checks `Object.is` (reference equality)
- For objects: compares each property value with `Object.is`
- For arrays/iterables: compares each element with `Object.is`
- For Maps: compares each entry's value with `Object.is`
- **Does NOT recurse** into nested objects

**Use when:** Selector returns a flat object or array of primitives/stable references.

```typescript
// shallow works: all values are primitives
useComparingSelector((s) => ({
  name: s.agents.instances[id]?.name,        // string
  isWorking: s.agents.instances[id]?.state.isWorking, // boolean
}));

// shallow works: array of strings
useComparingSelector((s) => Object.keys(s.agents.instances));

// shallow FAILS: nested objects get new references from Immer
useComparingSelector((s) => ({
  agent: s.agents.instances[id],    // object — new reference if any field changed
  toolbox: s.toolbox[id],           // object — new reference if any field changed
}));
// Even if the objects are structurally equal, shallow only checks Object.is on values
// Actually this WORKS with Immer because unchanged subtrees keep same reference
```

### `deep`
Source: `packages/karton/src/react/comparators.ts:107-132`

- Recursively compares all nested values
- Handles Maps, Sets, arrays, plain objects
- **Expensive for large structures** — O(n) where n is total number of leaf values

**Use when:** You must compare derived structures with nested objects that Immer can't preserve.

```typescript
// deep needed: map/filter creates new objects inside the array
useComparingSelector(
  (s) =>
    Object.entries(s.agents.instances).map(([id, agent]) => ({
      id,
      name: agent.name,
    })),
  deep,
);
```

### Custom comparator

```typescript
// Custom: only compare specific fields
useComparingSelector(
  (s) => s.agents.instances[id],
  (a, b) => a?.name === b?.name && a?.state.isWorking === b?.state.isWorking,
);
```

---

## useMemo for Derived State

Select raw state with a stable selector, then compute derived values with `useMemo`. This keeps the selector cheap and leverages React's memoization.

```typescript
const instances = useKartonState(
  useComparingSelector((s) => s.agents.instances),
);

// Only recomputes when instances reference changes
const activeAgentsList = useMemo(
  () =>
    Object.entries(instances)
      .filter(([_, agent]) => agent.type === AgentTypes.CHAT)
      .map(([id, agent]) => ({ id, name: agent.name, createdAt: agent.createdAt }))
      .sort((a, b) => b.createdAt - a.createdAt),
  [instances],
);
```

**Why not compute in the selector?** Selectors run on *every* state change (even unrelated ones). `useMemo` only recomputes when its deps change.

---

## useRef for Callback Stability

Store procedures and derived values in refs when used inside callbacks that should not re-trigger effects or be passed as props.

```typescript
const deleteAgent = useKartonProcedure((p) => p.agents.delete);
const agentsList = useKartonState(useComparingSelector((s) => s.agents.instances));

const deleteAgentRef = useRef(deleteAgent);
deleteAgentRef.current = deleteAgent;
const agentsListRef = useRef(agentsList);
agentsListRef.current = agentsList;

const handleDelete = useCallback((id: string) => {
  deleteAgentRef.current(id);
  // Access latest list without adding to callback deps
  console.log('remaining:', Object.keys(agentsListRef.current).length - 1);
}, []); // stable callback — never changes
```

---

## Component Splitting Strategy

Split components along state boundaries. A parent that selects broad state forces all children to re-render, even if children only need a subset.

```typescript
// BAD: Parent selects everything, all children re-render
function AgentPanel({ id }: { id: string }) {
  const agent = useKartonState((s) => s.agents.instances[id]);
  return (
    <>
      <AgentHeader name={agent.name} />
      <AgentChat history={agent.state.history} />
      <AgentStatus isWorking={agent.state.isWorking} />
    </>
  );
}

// GOOD: Each child selects its own slice
function AgentHeader({ id }: { id: string }) {
  const name = useKartonState((s) => s.agents.instances[id]?.name ?? '');
  return <h2>{name}</h2>;
}

function AgentStatus({ id }: { id: string }) {
  const isWorking = useKartonState(
    (s) => s.agents.instances[id]?.state.isWorking ?? false,
  );
  return <span>{isWorking ? 'Working...' : 'Idle'}</span>;
}
```

---

## React.memo Considerations

`React.memo` is useful for child components receiving Karton-derived props. But if the child can use `useKartonState` directly, that's usually better — it avoids prop drilling and gives finer-grained subscriptions.

```typescript
// OPTION A: memo'd child with props (useful when child is generic/reusable)
const AgentCard = React.memo(({ name, isWorking }: Props) => (
  <div>{name}: {isWorking ? 'busy' : 'idle'}</div>
));

// OPTION B: Child subscribes directly (preferred for domain-specific components)
function AgentCard({ id }: { id: string }) {
  const name = useKartonState((s) => s.agents.instances[id]?.name ?? '');
  const isWorking = useKartonState(
    (s) => s.agents.instances[id]?.state.isWorking ?? false,
  );
  return <div>{name}: {isWorking ? 'busy' : 'idle'}</div>;
}
```
