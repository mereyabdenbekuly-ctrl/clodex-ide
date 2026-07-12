import type { ChronicleEvent } from '@shared/agent-os';

export function createChronicleContext(events: ChronicleEvent[]): string {
  const context = events
    .map(
      (event) => `- ${new Date(event.capturedAt).toISOString()}: ${event.text}`,
    )
    .join('\n');
  return `<chronicle-context>\n${context}\n</chronicle-context>\n\n`;
}

export function schedulePrefillWhenChatReady(options: {
  isReady: () => boolean;
  requestPrefill: () => void;
  scheduleFrame: (callback: () => void) => void;
  maxWaitFrames?: number;
}): void {
  const maxWaitFrames = Math.max(0, options.maxWaitFrames ?? 10);
  let waitedFrames = 0;
  const attempt = () => {
    if (options.isReady() || waitedFrames >= maxWaitFrames) {
      options.requestPrefill();
      return;
    }
    waitedFrames += 1;
    options.scheduleFrame(attempt);
  };
  options.scheduleFrame(attempt);
}

export type SkillDropDataTransfer<TFile> = {
  files: ArrayLike<TFile>;
  getData: (format: string) => string;
};

export function resolveDroppedSkillPath<TFile>(
  dataTransfer: SkillDropDataTransfer<TFile>,
  getPathForFile: (file: TFile) => string | null | undefined,
): string | null {
  const file = dataTransfer.files[0];
  if (file !== undefined) {
    const nativePath = getPathForFile(file);
    if (nativePath) return nativePath;
  }

  const uri = dataTransfer
    .getData('text/uri-list')
    .split(/\r?\n/)
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate && !candidate.startsWith('#'));
  if (!uri) return null;

  try {
    const parsed = new URL(uri);
    if (
      parsed.protocol !== 'file:' ||
      (parsed.hostname && parsed.hostname !== 'localhost')
    ) {
      return null;
    }
    const decodedPath = decodeURIComponent(parsed.pathname);
    return /^\/[A-Za-z]:\//.test(decodedPath)
      ? decodedPath.slice(1)
      : decodedPath;
  } catch {
    return null;
  }
}
