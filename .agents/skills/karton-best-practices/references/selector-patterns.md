# Selector Patterns

## Table of Contents
- Primitive Selection
- Frozen Subtree Selection
- Derived Object Selection
- Array Derivation
- Conditional Selection
- Multiple Values from Different Paths
- Procedure Selection
- Full State (Avoid)

---

## Primitive Selection

Select a single primitive value. `Object.is` handles primitive comparison natively — no wrapper needed.

```typescript
// Boolean
const isWorking = useKartonState(
  (s) => s.agents.instances[id]?.state.isWorking ?? false,
);

// String
const name = useKartonState((s) => s.agents.instances[id]?.name ?? '');

// Number
const count = useKartonState((s) => Object.keys(s.agents.instances).length);
```

**Caveat with `length`:** This re-renders when instance count changes, which is correct. But `Object.keys()` runs on every state change. For hot paths, consider selecting the instances object and computing length in `useMemo`.

---

## Frozen Subtree Selection

Selecting an existing object from the state tree. Immer's structural sharing keeps the reference stable when the subtree is unmodified.

```typescript
// GOOD: Returns frozen reference — stable when subtree unchanged
const agent = useKartonState((s) => s.agents.instances[id]);
const toolbox = useKartonState((s) => s.toolbox[id]);
const preferences = useKartonState((s) => s.preferences);
```

**When this breaks:** If `id` is dynamic and changes between renders, the selector returns a different subtree (different reference). This is correct behavior — the component should re-render because it's now looking at different data.

---

## Derived Object Selection

Selectors that construct new objects always produce new references. Wrap with `useComparingSelector`.

```typescript
// BAD: New object every time
const info = useKartonState((s) => ({
  name: s.agents.instances[id]?.name,
  model: s.agents.instances[id]?.state.activeModelId,
}));

// GOOD: shallow comparison prevents re-render if fields unchanged
const info = useKartonState(
  useComparingSelector((s) => ({
    name: s.agents.instances[id]?.name,
    model: s.agents.instances[id]?.state.activeModelId,
  })),
);
```

`shallow` compares each property with `Object.is`. If both `name` and `model` are the same primitive values (or same references for objects), the previous object is returned.

---

## Array Derivation

Any operation that creates a new array (`.map`, `.filter`, `Object.keys`, `Object.values`, `Object.entries`, spread) needs `useComparingSelector`.

```typescript
// BAD: New array every state change
const agentIds = useKartonState((s) => Object.keys(s.agents.instances));

// GOOD: shallow compares array elements
const agentIds = useKartonState(
  useComparingSelector((s) => Object.keys(s.agents.instances)),
);

// GOOD: For expensive transforms, select raw data + useMemo
const instances = useKartonState(
  useComparingSelector((s) => s.agents.instances),
);
const sortedAgents = useMemo(
  () =>
    Object.entries(instances)
      .map(([id, agent]) => ({ id, ...agent }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  [instances],
);
```

**Note:** The `shallow` comparator for arrays compares each element with `Object.is`. This is efficient for string/number arrays (like ID lists) but won't help if elements are new objects.

---

## Conditional Selection

When selection depends on a condition (e.g., a selected agent ID), handle the null/undefined case in the selector.

```typescript
// GOOD: Returns primitive false when no agent selected
const isWorking = useKartonState(
  (s) => (openAgent ? s.agents.instances[openAgent]?.state.isWorking ?? false : false),
);

// GOOD: Returns null when no agent — stable reference for null
const workspace = useKartonState(
  (s) => (openAgent ? s.toolbox[openAgent]?.workspace ?? null : null),
);

// CAUTION: If openAgent changes, the selector returns a different subtree
// This is correct — the component needs the new agent's data
const agent = useKartonState((s) =>
  openAgent ? s.agents.instances[openAgent] : undefined,
);
```

---

## Multiple Values from Different Paths

**Prefer multiple `useKartonState` calls** over a single selector that combines values — each hook only re-renders when its specific value changes.

```typescript
// GOOD: Independent subscriptions — each re-renders only when its value changes
const platform = useKartonState((s) => s.appInfo.platform);
const isFullScreen = useKartonState((s) => s.appInfo.isFullScreen);
const activeAgent = useKartonState((s) => s.agents.instances[id]);

// LESS IDEAL: Single selector combining values — needs useComparingSelector
// and re-renders when ANY of the three values changes
const combined = useKartonState(
  useComparingSelector((s) => ({
    platform: s.appInfo.platform,
    isFullScreen: s.appInfo.isFullScreen,
    activeAgent: s.agents.instances[id],
  })),
);
```

**Exception:** When values are always consumed together and you want to avoid multiple hook calls for readability, the combined approach with `useComparingSelector` is acceptable.

---

## Procedure Selection

Procedures are Proxy objects — they never change. `useKartonProcedure` uses `useMemo` with stable deps.

```typescript
// GOOD: Select specific procedure
const createAgent = useKartonProcedure((p) => p.agents.create);

// GOOD: Fire-and-forget variant
const logEvent = useKartonProcedure((p) => p.telemetry.fire.logEvent);

// GOOD: Store in ref for callbacks that shouldn't re-trigger effects
const createRef = useRef(createAgent);
createRef.current = createAgent;
useEffect(() => {
  createRef.current(config);
}, [config]); // No need for createAgent in deps
```

**Don't select procedures in `useKartonState`** — procedures are separate from state and have their own hook.

---

## Full State (Avoid)

```typescript
// AVOID: Re-renders on ANY state change anywhere in the tree
const state = useKartonState();
```

Always use a selector to narrow down to what the component needs. Even selecting a top-level namespace (`s.agents`) is better than the full state, though it will still re-render when any agent changes.
