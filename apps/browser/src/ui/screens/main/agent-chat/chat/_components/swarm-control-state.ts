export function shouldDisableSwarmControls(input: {
  isAgentWorking: boolean;
  hasPendingQuestion: boolean;
}): boolean {
  // A working agent can still accept a queued next turn, so its mode controls
  // must remain selectable. A pending question uses a separate atomic response
  // path and keeps these controls disabled until that interaction is resolved.
  return input.hasPendingQuestion;
}
