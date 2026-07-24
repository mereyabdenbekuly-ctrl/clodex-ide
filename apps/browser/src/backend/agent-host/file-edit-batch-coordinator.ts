import type {
  FileEditBatchParticipant,
  FileEditBatchState,
  FileEditBatchTerminalOutcome,
} from '@clodex/agent-core/types';
import type { IsolatedAgentFileEditBatchMetadata } from './isolated-agent-turn';

interface BatchMemberRecord {
  toolCallId: string;
  arrival: 'proposal' | 'terminal' | null;
  participant?: FileEditBatchParticipant;
}

interface BatchRecord {
  signature: string;
  state: FileEditBatchState;
  members: Map<string, BatchMemberRecord>;
  release: Promise<'ready' | 'aborted'>;
  resolveRelease: (result: 'ready' | 'aborted') => void;
}

/** Main-process coordinator for one isolated turn's exact file-edit batches. */
export class FileEditBatchCoordinator {
  private readonly batches = new Map<string, BatchRecord>();

  public getParticipant(
    metadata: IsolatedAgentFileEditBatchMetadata,
  ): FileEditBatchParticipant {
    const signature = JSON.stringify(metadata.members);
    let batch = this.batches.get(metadata.batchId);
    if (!batch) {
      let resolveRelease!: (result: 'ready' | 'aborted') => void;
      const release = new Promise<'ready' | 'aborted'>((resolve) => {
        resolveRelease = resolve;
      });
      batch = {
        signature,
        state: 'collecting',
        members: new Map(
          metadata.members.map((member) => [
            member.memberId,
            { toolCallId: member.toolCallId, arrival: null },
          ]),
        ),
        release,
        resolveRelease,
      };
      this.batches.set(metadata.batchId, batch);
    } else if (batch.signature !== signature) {
      this.abort(metadata.batchId);
      throw new Error(
        `Conflicting file-edit batch membership for ${metadata.batchId}`,
      );
    }

    const member = batch.members.get(metadata.memberId);
    if (
      !member ||
      member.toolCallId !==
        metadata.members.find(
          (candidate) => candidate.memberId === metadata.memberId,
        )?.toolCallId
    ) {
      this.abort(metadata.batchId);
      throw new Error(
        `Unknown file-edit batch member ${metadata.memberId} in ${metadata.batchId}`,
      );
    }
    if (member.participant) return member.participant;

    const participant: FileEditBatchParticipant = {
      batchId: metadata.batchId,
      memberId: metadata.memberId,
      toolCallId: member.toolCallId,
      getState: () => batch!.state,
      arriveAsProposal: () => {
        this.arrive(batch!, member, 'proposal');
        return batch!.release;
      },
      settle: (outcome) => {
        if (outcome === 'aborted') {
          this.abort(metadata.batchId);
          return;
        }
        this.arrive(batch!, member, 'terminal');
      },
    };
    member.participant = participant;
    return participant;
  }

  public abort(batchId: string): void {
    const batch = this.batches.get(batchId);
    if (!batch || batch.state === 'aborted') return;
    const wasCollecting = batch.state === 'collecting';
    batch.state = 'aborted';
    if (wasCollecting) batch.resolveRelease('aborted');
  }

  private arrive(
    batch: BatchRecord,
    member: BatchMemberRecord,
    arrival: 'proposal' | 'terminal',
  ): void {
    if (batch.state !== 'collecting' || member.arrival !== null) return;
    member.arrival = arrival;
    if ([...batch.members.values()].some((candidate) => !candidate.arrival)) {
      return;
    }
    batch.state = 'ready';
    batch.resolveRelease('ready');
  }
}

export function terminalOutcomeForToolResult(
  result:
    | { status?: 'completed' }
    | { status: 'approval-required' }
    | { status: 'error' },
  aborted: boolean,
): FileEditBatchTerminalOutcome {
  if (aborted) return 'aborted';
  if (result.status === 'approval-required') return 'approval-required';
  if (result.status === 'error') return 'error';
  return 'skipped';
}
