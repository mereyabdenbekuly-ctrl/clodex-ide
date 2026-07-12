# State Update Model

## How State Flows

```
Server: setState((draft) => { draft.foo.bar = 1; })
  -> Immer produce() generates patches + new state
  -> freeze(newState, true) — deep recursive freeze
  -> Broadcast patches to all clients
  -> Client: applyPatches(currentState, patches)
  -> freeze(result, true)
  -> onStateChange() fires -> all React listeners notified
  -> useSyncExternalStore calls each component's selector
  -> Object.is(prevResult, newResult) determines re-render
```

## Structural Sharing (Immer)

When the server calls `setState((draft) => { draft.agents.instances['a1'].state.isWorking = true; })`:

**New references created** (entire path from root to changed leaf):
- Root state object
- `state.agents`
- `state.agents.instances`
- `state.agents.instances['a1']`
- `state.agents.instances['a1'].state`

**Same references preserved** (unchanged subtrees):
- `state.agents.instances['a2']` (different agent, untouched)
- `state.browser` (different namespace)
- `state.toolbox` (different namespace)
- `state.preferences` (different namespace)
- All other unchanged branches

This means:
```typescript
// Before and after update:
oldState.agents.instances['a2'] === newState.agents.instances['a2'] // true
oldState.browser === newState.browser // true

// Changed path — all new references:
oldState !== newState // true
oldState.agents !== newState.agents // true
oldState.agents.instances['a1'] !== newState.agents.instances['a1'] // true
```

## What This Means for Selectors

A selector that returns a reference from the frozen state tree benefits from structural sharing automatically:

```typescript
// This selector returns the SAME reference if agent 'a2' wasn't modified
const agent = useKartonState((s) => s.agents.instances['a2']);
// No re-render when a1 changes, because the reference is identical
```

A selector that derives a new value loses structural sharing:

```typescript
// This creates a NEW boolean every time, but Object.is handles primitives correctly
const isWorking = useKartonState((s) => s.agents.instances['a1']?.state.isWorking ?? false);
// Re-renders only when the boolean value actually changes (Object.is compares by value for primitives)
```

## Frozen State Is Read-Only

All state returned by Karton is `Object.freeze`'d recursively. Attempting to mutate it throws in strict mode:

```typescript
const agent = useKartonState((s) => s.agents.instances[id]);
agent.name = 'new name'; // TypeError: Cannot assign to read only property
```

To modify state, use server procedures which call `setState` with an Immer draft.

## Patch-Based Sync

Only deltas are transmitted over the wire (Immer `Patch[]` format). On the client, `applyPatches()` reconstructs the new state. This is efficient for large state trees with small changes. Full state sync only happens on initial connection.

## Full State Sync on Reconnect

When a client reconnects (WebSocket reconnect or initial connection), the server sends the entire state via `state_sync` message. This replaces the client state entirely — **all references become new**. Every component re-renders once after reconnection regardless of selectors.
