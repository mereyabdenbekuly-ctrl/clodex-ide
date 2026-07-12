import { createHash } from 'node:crypto';
import { writeFile, mkdir } from '../../fs';
import path from 'node:path';
import type { AgentStore } from '../../store';
import type {
  PendingEditDecision,
  PendingEditPreview,
} from '../../types/pending-edits';
import {
  buildContributorMap,
  createFileDiffsFromGenerations,
} from '../diff-history/utils/diff';
import type { OperationWithContent } from '../diff-history/utils/diff';
import type { Logger } from '../../host';

export interface PendingEditRequest {
  toolCallId: string;
  agentInstanceId: string;
  lockOwnerId?: string;
  absolutePath: string;
  relativePath: string;
  oldContent: string | null;
  newContent: string;
  apply: () => Promise<void>;
}

interface PendingEditRecord {
  preview: PendingEditPreview;
  apply: () => Promise<void>;
  resolve: (decision: PendingEditDecision) => void;
}

interface FileLockRecord {
  ownerId: string;
  agentInstanceId: string;
  relativePath: string;
  toolCallId: string;
  createdAt: number;
}

export const POST_EDIT_VERIFICATION_NUDGE =
  'Changes accepted. Run the smallest relevant verification now unless the change is docs-only, text-only, or impossible to verify. Use the existing shell tools so normal command approval policy still applies.';

export interface PendingEditServiceDeps {
  store: AgentStore;
  logger?: Logger;
}

function oid(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function createPreview(request: PendingEditRequest): PendingEditPreview {
  const baselineOid =
    request.oldContent === null ? null : oid(request.oldContent);
  const currentOid = oid(request.newContent);
  const idxBase = Date.now();
  const operations: OperationWithContent[] = [
    {
      idx: idxBase,
      filepath: request.absolutePath,
      snapshot_oid: baselineOid,
      operation: 'baseline',
      contributor: 'user',
      reason: 'init',
      isExternal: false,
      snapshot_content: request.oldContent,
    },
    {
      idx: idxBase + 1,
      filepath: request.absolutePath,
      snapshot_oid: currentOid,
      operation: 'edit',
      contributor: `agent-${request.agentInstanceId}`,
      reason: `tool-${request.toolCallId}`,
      isExternal: false,
      snapshot_content: request.newContent,
    },
  ];
  const generationId = oid(request.absolutePath);
  const generations = { [generationId]: operations };
  const fileDiff = createFileDiffsFromGenerations(
    generations,
    buildContributorMap(generations),
  )[0];
  if (!fileDiff) {
    throw new Error(
      `Failed to create pending edit preview for ${request.absolutePath}`,
    );
  }
  return {
    id: request.toolCallId,
    toolCallId: request.toolCallId,
    agentInstanceId: request.agentInstanceId,
    lockOwnerId: request.lockOwnerId,
    path: request.absolutePath,
    relativePath: request.relativePath,
    status: 'pending',
    createdAt: Date.now(),
    fileDiff,
  };
}

export class PendingEditService {
  private readonly store: AgentStore;
  private readonly logger?: Logger;
  private readonly pending = new Map<string, PendingEditRecord>();
  private readonly fileLocks = new Map<string, FileLockRecord>();

  constructor(deps: PendingEditServiceDeps) {
    this.store = deps.store;
    this.logger = deps.logger;
  }

  public requestApproval(
    request: PendingEditRequest,
  ): Promise<PendingEditDecision> {
    const ownerId = request.lockOwnerId ?? request.toolCallId;
    const lockedBy = this.fileLocks.get(request.absolutePath);
    if (lockedBy && lockedBy.ownerId !== ownerId) {
      return Promise.resolve({
        status: 'rejected',
        message:
          `Error: File ${request.relativePath} is currently locked by ${lockedBy.ownerId}. ` +
          'Please wait, choose a different file, or coordinate with the other swarm task.',
      });
    }

    this.fileLocks.set(request.absolutePath, {
      ownerId,
      agentInstanceId: request.agentInstanceId,
      relativePath: request.relativePath,
      toolCallId: request.toolCallId,
      createdAt: Date.now(),
    });

    let preview: PendingEditPreview;
    try {
      preview = createPreview(request);
      this.store.update((draft) => {
        const entry = draft.toolbox[request.agentInstanceId] ?? {
          workspace: { mounts: [] },
          pendingFileDiffs: [],
          pendingProposedEdits: [],
          editSummary: [],
          pendingUserQuestion: null,
        };
        draft.toolbox[request.agentInstanceId] = entry;
        entry.pendingProposedEdits = [
          ...entry.pendingProposedEdits.filter(
            (edit) => edit.id !== preview.id,
          ),
          preview,
        ];
      });
    } catch (error) {
      this.releaseLock(request.absolutePath, ownerId);
      throw error;
    }

    return new Promise<PendingEditDecision>((resolve) => {
      this.pending.set(preview.id, {
        preview,
        apply: request.apply,
        resolve,
      });
    });
  }

  public async acceptEdit(pendingEditId: string): Promise<void> {
    const record = this.pending.get(pendingEditId);
    if (!record) return;

    try {
      await record.apply();
      this.resolve(record, {
        status: 'accepted',
        message: `Success: applied changes to ${record.preview.relativePath}.\n\n${POST_EDIT_VERIFICATION_NUDGE}`,
      });
    } catch (error) {
      this.logger?.error('[PendingEditService] Failed to apply pending edit', {
        error,
        pendingEditId,
        path: record.preview.path,
      });
      this.resolve(record, {
        status: 'rejected',
        message: `Failed to apply changes to ${record.preview.relativePath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
    }
  }

  public rejectEdit(pendingEditId: string, feedback?: string): void {
    const record = this.pending.get(pendingEditId);
    if (!record) return;

    const message = feedback?.trim()
      ? `Action rejected by user. Feedback: ${feedback.trim()}`
      : 'Action rejected by user. Re-evaluate the edit and try again.';
    this.resolve(record, { status: 'rejected', message });
  }

  public abortAgentEdits(agentInstanceId: string): void {
    for (const record of [...this.pending.values()]) {
      if (record.preview.agentInstanceId !== agentInstanceId) continue;
      this.resolve(record, {
        status: 'aborted',
        message: 'Operation aborted before the user approved the edit.',
      });
    }
    this.releaseAgentLocks(agentInstanceId);
  }

  public releaseLocksForOwner(ownerId: string): void {
    for (const [absolutePath, record] of [...this.fileLocks.entries()]) {
      if (record.ownerId === ownerId) this.fileLocks.delete(absolutePath);
    }
  }

  public releaseAgentLocks(agentInstanceId: string): void {
    for (const [absolutePath, record] of [...this.fileLocks.entries()]) {
      if (record.agentInstanceId === agentInstanceId) {
        this.fileLocks.delete(absolutePath);
      }
    }
  }

  private releaseLock(absolutePath: string, ownerId: string): void {
    const record = this.fileLocks.get(absolutePath);
    if (record?.ownerId === ownerId) this.fileLocks.delete(absolutePath);
  }

  private resolve(
    record: PendingEditRecord,
    decision: PendingEditDecision,
  ): void {
    this.pending.delete(record.preview.id);
    this.releaseLock(
      record.preview.path,
      record.preview.lockOwnerId ?? record.preview.toolCallId,
    );
    this.store.update((draft) => {
      const entry = draft.toolbox[record.preview.agentInstanceId];
      if (!entry) return;
      entry.pendingProposedEdits = entry.pendingProposedEdits.filter(
        (edit) => edit.id !== record.preview.id,
      );
    });
    record.resolve(decision);
  }
}

export async function writePendingEditToDisk(
  absolutePath: string,
  content: string,
): Promise<void> {
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, content);
}
