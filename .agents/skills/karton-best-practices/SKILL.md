---
name: karton-best-practices
description: Performance-focused guidelines for writing React code that consumes Karton state. Use when creating or reviewing components that use useKartonState, useKartonProcedure, useComparingSelector, or any Karton React hooks. Covers selector patterns, re-render prevention, structural sharing, and edge cases.
---

# Karton React Best Practices

Performance guidelines for React components consuming Karton state. Karton uses Immer internally — understanding its structural sharing model is essential for writing efficient selectors.

## Core Mental Model

Karton state is **deeply frozen** (Immer `freeze(state, true)`). Updates use `produce()` which creates **new references only for changed paths** — unchanged subtrees keep the same reference. `useSyncExternalStore` uses **`Object.is` (reference equality)** to decide re-renders.

**The golden rule:** Your selector's return value must have a **stable reference** when nothing relevant changed. If it doesn't, wrap it with `useComparingSelector`.

## Quick Rules

### Selectors

```typescript
// GOOD: Select a primitive — stable when unchanged
const isWorking = useKartonState((s) => s.agents.instances[id]?.state.isWorking ?? false);

// GOOD: Select a frozen subtree — Immer preserves the reference
const agent = useKartonState((s) => s.agents.instances[id]);

// BAD: Creates a new object every call — always re-renders
const data = useKartonState((s) => ({
  name: s.agents.instances[id]?.name,
  status: s.agents.instances[id]?.state.isWorking,
}));

// FIX: Wrap with useComparingSelector (default: shallow equality)
const data = useKartonState(
  useComparingSelector((s) => ({
    name: s.agents.instances[id]?.name,
    status: s.agents.instances[id]?.state.isWorking,
  })),
);

// BAD: Object.keys/values/entries always creates a new array
const ids = useKartonState((s) => Object.keys(s.agents.instances));

// FIX: shallow comparison handles arrays element-by-element
const ids = useKartonState(
  useComparingSelector((s) => Object.keys(s.agents.instances)),
);
```

### When to Use `useComparingSelector`

| Selector returns | Needs `useComparingSelector`? |
|---|---|
| Primitive (boolean, string, number) | No |
| Existing frozen subtree reference | No |
| New object/array created in selector | **Yes** (use `shallow`) |
| Deeply nested new structures | **Yes** (use `deep`) |

### Procedures

```typescript
// GOOD: Procedures are stable proxies — select once, use freely
const createAgent = useKartonProcedure((p) => p.agents.create);

// GOOD: Store in ref for use in callbacks to prevent effect re-triggers
const createAgentRef = useRef(createAgent);
createAgentRef.current = createAgent;
```

### Derived State

```typescript
// GOOD: useMemo to compute derived values from selected state
const agent = useKartonState((s) => s.agents.instances[id]);
const displayName = useMemo(() => agent?.name ?? 'Unnamed', [agent]);

// BAD: Expensive computation inside selector (runs on every state change)
const sorted = useKartonState((s) =>
  Object.values(s.agents.instances).sort((a, b) => a.name.localeCompare(b.name)),
);

// FIX: Select raw data, compute outside
const instances = useKartonState(
  useComparingSelector((s) => s.agents.instances),
);
const sorted = useMemo(
  () => Object.values(instances).sort((a, b) => a.name.localeCompare(b.name)),
  [instances],
);
```

## Key Pitfalls

1. **Every `useKartonState` call runs its selector on every state change** — keep selectors cheap
2. **Selectors that create new objects/arrays always cause re-renders** unless wrapped with `useComparingSelector`
3. **`useComparingSelector` with `deep` is expensive** — prefer `shallow` or restructure state
4. **Selecting the full state** (`useKartonState()` with no selector) re-renders on any change
5. **Inline selector functions recreate on every render** — this is fine because `useSyncExternalStore` compares snapshot values, not function references
6. **Connection changes (`onOpen`/`onClose`) trigger all listeners** — components using `useKartonState` may re-render briefly on reconnect even if state didn't change

## References

For detailed analysis, see:
- `references/state-update-model.md` — How Immer structural sharing affects object references
- `references/selector-patterns.md` — Comprehensive selector patterns with examples
- `references/re-render-prevention.md` — useComparingSelector internals and memoization strategies
- `references/edge-cases.md` — Arrays, Maps, conditional selection, and reconnection behavior
