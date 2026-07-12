const path = require('node:path');
const fs = require('node:fs');
const { app } = require('electron');

const LOCK_FILE_NAME = 'evidence-memory-live-dogfood.lock';

process.env.TSX_TSCONFIG_PATH = path.join(
  __dirname,
  '../tsconfig.backend.json',
);
app.setName('Clodex Agentic IDE (Dev-Build)');
app.setPath('userData', path.join(app.getPath('appData'), 'clodex-dev'));
app.setPath('sessionData', path.join(app.getPath('userData'), 'session'));

app
  .whenReady()
  .then(async () => {
    const releaseLock = acquireRunLock();
    try {
      const { register } = await import('tsx/esm/api');
      register();
      const { runEvidenceMemoryLiveDogfood } = await import(
        './run-evidence-memory-live-dogfood.ts'
      );
      return await runEvidenceMemoryLiveDogfood(process.argv.slice(2));
    } finally {
      releaseLock();
    }
  })
  .then((exitCode) => app.exit(exitCode))
  .catch((error) => {
    console.error(
      'EVIDENCE_MEMORY_LIVE_DOGFOOD ready=false',
      error instanceof Error ? error.stack : error,
    );
    app.exit(1);
  });

function acquireRunLock() {
  const lockPath = path.join(app.getPath('userData'), LOCK_FILE_NAME);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const descriptor = fs.openSync(lockPath, 'wx', 0o600);
      fs.writeFileSync(
        descriptor,
        `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`,
      );
      return () => {
        try {
          fs.closeSync(descriptor);
        } finally {
          fs.rmSync(lockPath, { force: true });
        }
      };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const existingPid = readLockPid(lockPath);
      if (existingPid !== null && isProcessAlive(existingPid)) {
        throw new Error(
          `Evidence Memory live dogfood is already running (pid ${existingPid})`,
        );
      }
      fs.rmSync(lockPath, { force: true });
    }
  }

  throw new Error('Unable to acquire Evidence Memory live dogfood lock');
}

function readLockPid(lockPath) {
  try {
    const value = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    return Number.isSafeInteger(value?.pid) && value.pid > 0 ? value.pid : null;
  } catch {
    return null;
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}
