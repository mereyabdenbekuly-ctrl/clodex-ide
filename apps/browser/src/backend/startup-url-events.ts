import { app } from 'electron';

const MAX_QUEUED_STARTUP_URLS = 10;
const MAX_QUEUED_STARTUP_FILES = 10;

type StartupUrlHandler = (url: string) => void;
type StartupFileHandler = (filePath: string) => void;

let installed = false;
let fileListenerInstalled = false;
let runtimeHandler: StartupUrlHandler | null = null;
let runtimeFileHandler: StartupFileHandler | null = null;
const pendingUrls: string[] = [];
const pendingFilePaths: string[] = [];

function invokeHandler(handler: StartupUrlHandler, url: string): void {
  try {
    handler(url);
  } catch {
    // A bad URL handler must not prevent later startup URLs from draining.
  }
}

function handleOrQueueUrl(url: string): void {
  if (runtimeHandler) {
    invokeHandler(runtimeHandler, url);
    return;
  }

  if (pendingUrls.length >= MAX_QUEUED_STARTUP_URLS) {
    pendingUrls.shift();
  }
  pendingUrls.push(url);
}

function handleOrQueueFile(filePath: string): void {
  if (runtimeFileHandler) {
    invokeHandler(runtimeFileHandler, filePath);
    return;
  }

  if (pendingFilePaths.length >= MAX_QUEUED_STARTUP_FILES) {
    pendingFilePaths.shift();
  }
  pendingFilePaths.push(filePath);
}

export function installStartupOpenUrlListener(): void {
  if (installed) return;
  installed = true;

  app.on('open-url', (event, url) => {
    event.preventDefault();
    handleOrQueueUrl(url);
  });
}

export function installStartupOpenFileListener(): void {
  if (fileListenerInstalled) return;
  fileListenerInstalled = true;

  app.on('open-file', (event, filePath) => {
    event.preventDefault();
    handleOrQueueFile(filePath);
  });
}

export function registerStartupUrlHandler(
  handler: StartupUrlHandler,
): () => void {
  runtimeHandler = handler;
  const urls = pendingUrls.splice(0);
  for (const url of urls) {
    invokeHandler(handler, url);
  }

  return () => {
    if (runtimeHandler === handler) {
      runtimeHandler = null;
    }
  };
}

export function registerStartupFileHandler(
  handler: StartupFileHandler,
): () => void {
  runtimeFileHandler = handler;
  const filePaths = pendingFilePaths.splice(0);
  for (const filePath of filePaths) {
    invokeHandler(handler, filePath);
  }

  return () => {
    if (runtimeFileHandler === handler) {
      runtimeFileHandler = null;
    }
  };
}
