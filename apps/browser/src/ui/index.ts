/**
 * This file will automatically be loaded by vite and run in the "renderer" context.
 * To learn more about the differences between the "main" and the "renderer" context in
 * Electron, visit:
 *
 * https://electronjs.org/docs/tutorial/process-model
 *
 * By default, Node.js integration in this file is disabled. When enabling Node.js integration
 * in a renderer process, please be aware of potential security implications. You can read
 * more about security risks here:
 *
 * https://electronjs.org/docs/tutorial/security
 *
 * To enable Node.js integration in this file, open up `main.ts` and enable the `nodeIntegration`
 * flag:
 *
 * ```
 *  // Create the browser window.
 *  mainWindow = new BrowserWindow({
 *    width: 800,
 *    height: 600,
 *    webPreferences: {
 *      nodeIntegration: true
 *    }
 *  });
 * ```
 */
import { createElement, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import posthog from 'posthog-js';
import '@ui/app.css';
import { containsResizeObserverLoopError } from '@ui/utils/resize-observer';

function errorFromErrorEvent(event: ErrorEvent) {
  if (event.error instanceof Error) return event.error;

  const message = event.message || 'Unknown renderer error';
  return new Error(message);
}

// Global safety net: capture unhandled errors and rejections to PostHog
window.addEventListener('error', (event) => {
  if (
    containsResizeObserverLoopError(event.error) ||
    containsResizeObserverLoopError(event.message)
  ) {
    event.preventDefault();
    return;
  }

  posthog.captureException(errorFromErrorEvent(event), {
    source: 'renderer',
    handler: 'globalOnError',
    message: event.message,
    filename: event.filename,
    lineno: event.lineno,
    colno: event.colno,
  });
});

window.addEventListener('unhandledrejection', (event) => {
  const error =
    event.reason instanceof Error
      ? event.reason
      : new Error(String(event.reason));
  posthog.captureException(error, {
    source: 'renderer',
    handler: 'unhandledRejection',
  });
});

async function bootstrapRenderer() {
  const windowMode = new URLSearchParams(window.location.search).get('window');
  if (windowMode === 'quick-task') {
    const { QuickTaskWindowApp } = await import('@ui/quick-task-window');
    createRoot(document.body).render(
      createElement(StrictMode, null, createElement(QuickTaskWindowApp)),
    );
    return;
  }

  // Keep the main-window-only services out of the native Quick Task renderer.
  // In particular, importing use-karton eagerly would connect a second client
  // to the main UI transport and replace the primary renderer connection.
  await Promise.all([
    import('@ui/monaco-workers'),
    import('@ui/services/turnstile-solver'),
  ]);
  const [{ App }, { initThemeColorSync }] = await Promise.all([
    import('@ui/app'),
    import('@ui/utils/theme-color-sync'),
  ]);
  initThemeColorSync();
  createRoot(document.body).render(
    createElement(StrictMode, null, createElement(App)),
  );
}

void bootstrapRenderer().catch((error) => {
  console.error(error);
  posthog.captureException(
    error instanceof Error ? error : new Error(String(error)),
    { source: 'renderer', handler: 'reactRootRender' },
  );
});
