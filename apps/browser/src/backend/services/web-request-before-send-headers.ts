import type { OnBeforeSendHeadersListenerDetails, Session } from 'electron';

export type BeforeSendHeadersMutator = (
  details: OnBeforeSendHeadersListenerDetails,
  requestHeaders: Record<string, string>,
) => void;

type SessionHeaderPipeline = {
  mutators: Set<BeforeSendHeadersMutator>;
};

const pipelines = new WeakMap<Session, SessionHeaderPipeline>();

/**
 * Electron permits only one `onBeforeSendHeaders` listener per session. Keep a
 * single dispatcher so security headers and the browser stealth rewrite can be
 * composed without silently replacing one another.
 */
export function registerBeforeSendHeadersMutator(
  targetSession: Session,
  mutator: BeforeSendHeadersMutator,
): () => void {
  let pipeline = pipelines.get(targetSession);
  if (!pipeline) {
    pipeline = { mutators: new Set() };
    pipelines.set(targetSession, pipeline);
    targetSession.webRequest.onBeforeSendHeaders((details, callback) => {
      const requestHeaders = { ...details.requestHeaders };
      const current = pipelines.get(targetSession);
      for (const registered of current?.mutators ?? []) {
        registered(details, requestHeaders);
      }
      callback({ requestHeaders });
    });
  }

  pipeline.mutators.add(mutator);
  return () => {
    pipelines.get(targetSession)?.mutators.delete(mutator);
  };
}
