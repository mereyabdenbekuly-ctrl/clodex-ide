import { useKartonProcedure } from '@ui/hooks/use-karton';
import {
  CheckIcon,
  DownloadIcon,
  ExternalLinkIcon,
  FileArchiveIcon,
  FolderOpenIcon,
  LoaderCircleIcon,
  type LucideIcon,
} from 'lucide-react';
import { useCallback, useState } from 'react';

export type CloudTaskArtifactUIPart = {
  type: 'data-cloud-artifact';
  id?: string;
  data: {
    executionId: string;
    artifactId: string;
    fileName: string;
    mediaType: string;
    sizeBytes: number;
  };
};

type Action = 'open' | 'reveal' | 'export';

export function CloudTaskArtifactPart({
  part,
}: {
  part: CloudTaskArtifactUIPart;
}) {
  const openArtifact = useKartonProcedure(
    (procedures) => procedures.cloudTasks.artifacts.open,
  );
  const revealArtifact = useKartonProcedure(
    (procedures) => procedures.cloudTasks.artifacts.reveal,
  );
  const exportArtifact = useKartonProcedure(
    (procedures) => procedures.cloudTasks.artifacts.export,
  );
  const [pending, setPending] = useState<Action | null>(null);
  const [completed, setCompleted] = useState<Action | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(
    async (action: Action) => {
      if (pending) return;
      setPending(action);
      setCompleted(null);
      setError(null);
      const identity = {
        executionId: part.data.executionId,
        artifactId: part.data.artifactId,
      };
      try {
        const result =
          action === 'open'
            ? await openArtifact(identity)
            : action === 'reveal'
              ? await revealArtifact(identity)
              : await exportArtifact(identity);
        if (!result.ok) {
          if (!result.cancelled) setError(result.error);
          return;
        }
        setCompleted(action);
        window.setTimeout(
          () =>
            setCompleted((current) => (current === action ? null : current)),
          1_600,
        );
      } catch (reason) {
        setError(
          reason instanceof Error
            ? reason.message
            : 'Cloud artifact action failed',
        );
      } finally {
        setPending(null);
      }
    },
    [
      exportArtifact,
      openArtifact,
      part.data.artifactId,
      part.data.executionId,
      pending,
      revealArtifact,
    ],
  );

  return (
    <section className="overflow-hidden rounded-xl border border-token-border-light bg-token-bg-secondary/35 shadow-codex-hairline">
      <div className="flex items-start gap-3 px-3.5 py-3">
        <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg bg-codex-blue-400/10 text-codex-blue-400">
          <FileArchiveIcon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium text-sm text-token-text-primary">
            {part.data.fileName}
          </div>
          <div className="mt-0.5 flex flex-wrap gap-x-2 text-[11px] text-token-text-tertiary">
            <span>{formatBytes(part.data.sizeBytes)}</span>
            <span>{part.data.mediaType || 'application/octet-stream'}</span>
          </div>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1.5 border-token-border-light border-t px-3 py-2">
        <ArtifactAction
          label="Open"
          icon={ExternalLinkIcon}
          active={pending === 'open'}
          complete={completed === 'open'}
          disabled={pending !== null}
          onClick={() => void run('open')}
        />
        <ArtifactAction
          label="Show in folder"
          icon={FolderOpenIcon}
          active={pending === 'reveal'}
          complete={completed === 'reveal'}
          disabled={pending !== null}
          onClick={() => void run('reveal')}
        />
        <ArtifactAction
          label="Export"
          icon={DownloadIcon}
          active={pending === 'export'}
          complete={completed === 'export'}
          disabled={pending !== null}
          onClick={() => void run('export')}
        />
        {error && (
          <span className="min-w-0 flex-1 truncate px-1 text-error-solid text-xs">
            {error}
          </span>
        )}
      </div>
    </section>
  );
}

function ArtifactAction({
  label,
  icon: Icon,
  active,
  complete,
  disabled,
  onClick,
}: {
  label: string;
  icon: LucideIcon;
  active: boolean;
  complete: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      className="inline-flex h-7 items-center gap-1.5 rounded-lg border border-token-border-light bg-token-main-surface-primary px-2.5 text-token-text-secondary text-xs transition-colors hover:bg-token-list-hover-background hover:text-token-text-primary disabled:opacity-55"
      onClick={onClick}
    >
      {active ? (
        <LoaderCircleIcon className="size-3 animate-spin" />
      ) : complete ? (
        <CheckIcon className="size-3 text-success-foreground" />
      ) : (
        <Icon className="size-3" />
      )}
      {label}
    </button>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = units[0]!;
  for (let index = 1; index < units.length && value >= 1024; index += 1) {
    value /= 1024;
    unit = units[index]!;
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${unit}`;
}
