void import('../../dist/agent-host-smoke.mjs').catch((error) => {
  console.error(
    'AGENT_STEP_EXECUTOR_SMOKE ready=false exit=1',
    error instanceof Error ? error.stack : error,
  );
  require('electron').app.exit(1);
});
