void import('../../dist/agent-host-fault-smoke.mjs').catch((error) => {
  console.error(
    'AGENT_HOST_FAULT_SMOKE crashed=false restarted=false resynced=false exit=1',
    error instanceof Error ? error.stack : error,
  );
  require('electron').app.exit(1);
});
