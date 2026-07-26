import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, realpath, writeFile } from '../../fs';
import path from 'node:path';
import type { AgentStore } from '../../store';
import type {
  FileEditBatchParticipant,
  PendingEditDecision,
  PendingEditPreview,
} from '../../types/pending-edits';
import { MAX_DIFF_TEXT_FILE_SIZE } from '../../types/diff-history';
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
  /** Host-computed structural eligibility; the model cannot set this field. */
  autoApprovalEligible?: boolean | (() => Promise<boolean>);
  /** Cancels a proposal that is still waiting for a first decision. */
  abortSignal?: AbortSignal;
  /** Host-only exact-batch capability. Never supplied by the model. */
  fileEditBatchParticipant?: FileEditBatchParticipant;
  apply: (context: {
    decisionSource: 'human' | 'auto-policy';
  }) => Promise<void>;
}

interface PendingEditRecord {
  preview: PendingEditPreview;
  apply: PendingEditRequest['apply'];
  resolve: (decision: PendingEditDecision) => void;
  resolutionState: 'pending' | 'settling' | 'resolved';
  ownerId: string;
  lockKey: string;
  leaseId: string;
  published: boolean;
  fileEditBatchParticipant?: FileEditBatchParticipant;
  removeAbortListener?: () => void;
}

interface FileLockRecord {
  leaseId: string;
  proposalId: string;
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
  /** Filesystem seam used to canonicalize lock identities. */
  resolveRealpath?: (absolutePath: string) => Promise<string>;
}

function oid(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function normalizeLockKey(value: string): string {
  const normalized = path.normalize(path.resolve(value));
  return process.platform === 'win32' || process.platform === 'darwin'
    ? normalized.toLowerCase()
    : normalized;
}

class PendingEditAdmissionAbortedError extends Error {
  public constructor() {
    super('Pending edit admission was aborted.');
    this.name = 'PendingEditAdmissionAbortedError';
  }
}

/**
 * Race a filesystem admission step against the turn abort signal. The
 * underlying filesystem promise may not be cancellable, but both its resolve
 * and reject paths stay observed after abort so it cannot leak an unhandled
 * rejection or keep the serialized admission queue waiting.
 */
function runAbortableAdmissionStep<T>(
  abortSignal: AbortSignal | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  if (!abortSignal) return operation();
  if (abortSignal.aborted) {
    return Promise.reject(new PendingEditAdmissionAbortedError());
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = () => abortSignal.removeEventListener('abort', handleAbort);
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const handleAbort = () =>
      finish(() => reject(new PendingEditAdmissionAbortedError()));

    abortSignal.addEventListener('abort', handleAbort, { once: true });
    if (abortSignal.aborted) {
      handleAbort();
      return;
    }

    let operationPromise: Promise<T>;
    try {
      operationPromise = operation();
    } catch (error) {
      finish(() => reject(error));
      return;
    }
    void operationPromise.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

/**
 * Resolve the deepest existing ancestor so aliases through a symlink/junction
 * share one physical lock even when the final file does not exist yet.
 */
async function canonicalizeLockKey(
  absolutePath: string,
  abortSignal: AbortSignal | undefined,
  resolveRealpath: (absolutePath: string) => Promise<string>,
): Promise<string> {
  let cursor = path.resolve(absolutePath);
  const missingSegments: string[] = [];

  while (true) {
    try {
      const physicalAncestor = await runAbortableAdmissionStep(
        abortSignal,
        () => resolveRealpath(cursor),
      );
      return normalizeLockKey(path.join(physicalAncestor, ...missingSegments));
    } catch (error) {
      if (error instanceof PendingEditAdmissionAbortedError) throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) return normalizeLockKey(absolutePath);
      missingSegments.unshift(path.basename(cursor));
      cursor = parent;
    }
  }
}

function activeToolCallKey(request: PendingEditRequest): string {
  return JSON.stringify([request.agentInstanceId, request.toolCallId]);
}

function createPreview(
  request: PendingEditRequest,
  proposalId: string,
  decisionReady = true,
): PendingEditPreview {
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
    id: proposalId,
    toolCallId: request.toolCallId,
    agentInstanceId: request.agentInstanceId,
    lockOwnerId: request.lockOwnerId,
    path: request.absolutePath,
    relativePath: request.relativePath,
    status: 'pending',
    decisionReady,
    createdAt: Date.now(),
    fileDiff,
  };
}

export class PendingEditService {
  private readonly store: AgentStore;
  private readonly logger?: Logger;
  private readonly resolveRealpath: (absolutePath: string) => Promise<string>;
  private readonly pending = new Map<string, PendingEditRecord>();
  private readonly activeToolCalls = new Map<string, string>();
  private readonly fileLocks = new Map<string, FileLockRecord>();
  private admissionTail: Promise<void> = Promise.resolve();

  constructor(deps: PendingEditServiceDeps) {
    this.store = deps.store;
    this.logger = deps.logger;
    this.resolveRealpath = deps.resolveRealpath ?? realpath;
  }

  public requestApproval(
    request: PendingEditRequest,
  ): Promise<PendingEditDecision> {
    const autoModeEnabled =
      this.store.get().agents.instances[request.agentInstanceId]?.state
        .fileEditApprovalMode === 'autoWorkspace';
    const autoApprovalEligibility = autoModeEnabled
      ? Promise.resolve()
          .then(async () => {
            const eligibility = request.autoApprovalEligible;
            return typeof eligibility === 'function'
              ? await eligibility()
              : eligibility === true;
          })
          .catch((error) => {
            this.logger?.warn(
              '[PendingEditService] Automatic edit eligibility failed closed',
              { error, toolCallId: request.toolCallId },
            );
            return false;
          })
      : Promise.resolve(false);
    const admission = this.admissionTail.then(() =>
      this.admitRequest(request, autoModeEnabled, autoApprovalEligibility),
    );
    this.admissionTail = admission.then(
      () => undefined,
      () => undefined,
    );
    return admission.then(({ decision }) => decision);
  }

  private async admitRequest(
    request: PendingEditRequest,
    autoModeEnabled: boolean,
    autoApprovalEligibility: Promise<boolean>,
  ): Promise<{ decision: Promise<PendingEditDecision> }> {
    const proposalId = randomUUID();
    const toolCallKey = activeToolCallKey(request);
    if (request.abortSignal?.aborted) {
      return {
        decision: Promise.resolve({
          status: 'aborted',
          message: 'Operation aborted before the file edit could be reviewed.',
        }),
      };
    }
    if (this.activeToolCalls.has(toolCallKey)) {
      return {
        decision: Promise.resolve({
          status: 'rejected',
          message:
            `Error: Pending edit ${request.toolCallId} is already awaiting resolution. ` +
            'Wait for the current edit decision before retrying this tool call.',
        }),
      };
    }
    this.activeToolCalls.set(toolCallKey, proposalId);

    const eligibility = autoModeEnabled
      ? await this.waitForAutoApprovalEligibility(
          request.abortSignal,
          autoApprovalEligibility,
        )
      : 'ineligible';
    if (eligibility === 'aborted') {
      this.releaseActiveToolCall(toolCallKey, proposalId);
      return {
        decision: Promise.resolve({
          status: 'aborted',
          message: 'Operation aborted during automatic edit policy review.',
        }),
      };
    }
    const autoApprove = eligibility === 'eligible';

    let lockKey: string;
    try {
      lockKey = await canonicalizeLockKey(
        request.absolutePath,
        request.abortSignal,
        this.resolveRealpath,
      );
    } catch (error) {
      this.releaseActiveToolCall(toolCallKey, proposalId);
      if (error instanceof PendingEditAdmissionAbortedError) {
        return {
          decision: Promise.resolve({
            status: 'aborted',
            message:
              'Operation aborted while resolving the file edit lock identity.',
          }),
        };
      }
      throw error;
    }

    if (request.abortSignal?.aborted) {
      this.releaseActiveToolCall(toolCallKey, proposalId);
      return {
        decision: Promise.resolve({
          status: 'aborted',
          message: 'Operation aborted before the file edit could be reviewed.',
        }),
      };
    }

    const ownerId = request.lockOwnerId ?? request.toolCallId;
    const lockedBy = this.fileLocks.get(lockKey);
    if (lockedBy) {
      this.releaseActiveToolCall(toolCallKey, proposalId);
      return {
        decision: Promise.resolve({
          status: 'rejected',
          message:
            `Error: File ${request.relativePath} is currently locked by ${lockedBy.ownerId}. ` +
            'Please wait, choose a different file, or coordinate with the other swarm task.',
        }),
      };
    }

    const leaseId = randomUUID();
    this.fileLocks.set(lockKey, {
      leaseId,
      proposalId,
      ownerId,
      agentInstanceId: request.agentInstanceId,
      relativePath: request.relativePath,
      toolCallId: request.toolCallId,
      createdAt: Date.now(),
    });

    let preview: PendingEditPreview;
    try {
      preview = createPreview(request, proposalId);
    } catch (error) {
      this.releaseLock(lockKey, leaseId);
      this.releaseActiveToolCall(toolCallKey, proposalId);
      throw error;
    }

    let resolveDecision!: (decision: PendingEditDecision) => void;
    const decisionPromise = new Promise<PendingEditDecision>((resolve) => {
      resolveDecision = resolve;
    });
    const record: PendingEditRecord = {
      preview,
      apply: request.apply,
      resolve: resolveDecision,
      resolutionState: 'pending',
      ownerId,
      lockKey,
      leaseId,
      published: !autoApprove,
      fileEditBatchParticipant: request.fileEditBatchParticipant,
    };
    this.pending.set(proposalId, record);

    if (request.abortSignal) {
      const onAbort = () => {
        this.abortRecord(
          record,
          'Operation aborted before the user approved the file edit.',
        );
      };
      request.abortSignal.addEventListener('abort', onAbort, { once: true });
      record.removeAbortListener = () =>
        request.abortSignal?.removeEventListener('abort', onAbort);
    }

    let batchRelease: Promise<'ready' | 'aborted'> | null = null;
    if (!autoApprove && record.fileEditBatchParticipant) {
      try {
        batchRelease = record.fileEditBatchParticipant.arriveAsProposal();
        record.preview = {
          ...record.preview,
          decisionReady: record.fileEditBatchParticipant.getState() === 'ready',
        };
      } catch (error) {
        this.discardRecord(record);
        throw error;
      }
    }

    try {
      if (record.published) this.publishPreview(record.preview);
    } catch (error) {
      this.discardRecord(record);
      throw error;
    }

    if (batchRelease && record.preview.decisionReady === false) {
      void batchRelease.then(
        (release) => {
          if (
            release === 'ready' &&
            record.fileEditBatchParticipant?.getState() === 'ready'
          ) {
            this.markDecisionReady(record);
            return;
          }
          this.abortRecord(
            record,
            'Operation aborted while preparing the file edit batch.',
          );
        },
        (error) => {
          this.logger?.error(
            '[PendingEditService] File-edit batch readiness failed closed',
            { error, pendingEditId: proposalId },
          );
          this.abortRecord(
            record,
            'Operation aborted because the file edit batch could not be prepared.',
          );
        },
      );
    }

    if (request.abortSignal?.aborted) {
      this.abortRecord(
        record,
        'Operation aborted before the user approved the file edit.',
      );
    } else if (autoApprove) {
      try {
        record.fileEditBatchParticipant?.settle('auto-policy');
      } catch (error) {
        this.discardRecord(record);
        throw error;
      }
      if (record.fileEditBatchParticipant?.getState() === 'aborted') {
        this.abortRecord(
          record,
          'Operation aborted while preparing the automatic file edit batch.',
        );
      } else {
        void this.acceptEdit(proposalId, 'auto-policy');
      }
    }

    return { decision: decisionPromise };
  }

  private async waitForAutoApprovalEligibility(
    abortSignal: AbortSignal | undefined,
    eligibility: Promise<boolean>,
  ): Promise<'eligible' | 'ineligible' | 'aborted'> {
    if (!abortSignal) {
      return (await eligibility) ? 'eligible' : 'ineligible';
    }
    if (abortSignal.aborted) return 'aborted';

    return await new Promise((resolve) => {
      let settled = false;
      const finish = (result: 'eligible' | 'ineligible' | 'aborted') => {
        if (settled) return;
        settled = true;
        abortSignal.removeEventListener('abort', onAbort);
        resolve(result);
      };
      const onAbort = () => finish('aborted');
      abortSignal.addEventListener('abort', onAbort, { once: true });
      void eligibility.then((eligible) =>
        finish(eligible ? 'eligible' : 'ineligible'),
      );
    });
  }

  public async acceptEdit(
    pendingEditId: string,
    decisionSource: 'human' | 'auto-policy' = 'human',
  ): Promise<void> {
    const record = this.pending.get(pendingEditId);
    const batchParticipant = record?.fileEditBatchParticipant;
    if (
      decisionSource === 'human' &&
      batchParticipant &&
      batchParticipant.getState() !== 'ready'
    ) {
      throw new Error(
        'This file edit belongs to a batch that is still being prepared.',
      );
    }
    if (!record || !this.beginResolution(record)) return;

    try {
      this.markApplying(record);
      await record.apply({ decisionSource });
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
    const batchParticipant = record?.fileEditBatchParticipant;
    if (batchParticipant && batchParticipant.getState() !== 'ready') {
      throw new Error(
        'This file edit belongs to a batch that is still being prepared.',
      );
    }
    if (!record || !this.beginResolution(record)) return;

    const message = feedback?.trim()
      ? `Action rejected by user. Feedback: ${feedback.trim()}`
      : 'Action rejected by user. Re-evaluate the edit and try again.';
    this.resolve(record, { status: 'rejected', message });
  }

  public abortAgentEdits(agentInstanceId: string): void {
    for (const record of [...this.pending.values()]) {
      if (record.preview.agentInstanceId !== agentInstanceId) continue;
      this.abortRecord(
        record,
        'Operation aborted before the user approved the edit.',
      );
    }
  }

  public releaseLocksForOwner(ownerId: string): void {
    for (const record of [...this.pending.values()]) {
      if (record.ownerId !== ownerId) continue;
      this.abortRecord(
        record,
        'Operation aborted because its edit owner was released.',
      );
    }
  }

  public releaseAgentLocks(agentInstanceId: string): void {
    for (const record of [...this.pending.values()]) {
      if (record.preview.agentInstanceId !== agentInstanceId) continue;
      this.abortRecord(
        record,
        'Operation aborted because its agent was released.',
      );
    }
  }

  private publishPreview(preview: PendingEditPreview): void {
    this.store.update((draft) => {
      const entry = draft.toolbox[preview.agentInstanceId] ?? {
        workspace: { mounts: [] },
        pendingFileDiffs: [],
        pendingProposedEdits: [],
        editSummary: [],
        pendingUserQuestion: null,
      };
      draft.toolbox[preview.agentInstanceId] = entry;
      entry.pendingProposedEdits = [
        ...entry.pendingProposedEdits.filter((edit) => edit.id !== preview.id),
        preview,
      ];
    });
  }

  private releaseLock(lockKey: string, leaseId: string): void {
    const record = this.fileLocks.get(lockKey);
    if (record?.leaseId === leaseId) this.fileLocks.delete(lockKey);
  }

  private releaseActiveToolCall(toolCallKey: string, proposalId: string): void {
    if (this.activeToolCalls.get(toolCallKey) === proposalId) {
      this.activeToolCalls.delete(toolCallKey);
    }
  }

  private abortRecord(record: PendingEditRecord, message: string): void {
    if (!this.beginResolution(record)) return;
    this.resolve(record, { status: 'aborted', message });
  }

  private discardRecord(record: PendingEditRecord): void {
    if (this.pending.get(record.preview.id) === record) {
      this.pending.delete(record.preview.id);
    }
    record.removeAbortListener?.();
    this.releaseLock(record.lockKey, record.leaseId);
    this.releaseActiveToolCall(
      JSON.stringify([
        record.preview.agentInstanceId,
        record.preview.toolCallId,
      ]),
      record.preview.id,
    );
  }

  /**
   * Atomically claim the first decision for a pending edit. JavaScript runs
   * this synchronous state transition before `acceptEdit()` can yield to the
   * asynchronous apply callback, so repeated Accept clicks, a concurrent
   * Reject, or an abort cannot resolve or apply the same proposal twice.
   */
  private beginResolution(record: PendingEditRecord): boolean {
    if (record.resolutionState !== 'pending') return false;
    record.resolutionState = 'settling';
    return true;
  }

  private markDecisionReady(record: PendingEditRecord): void {
    if (
      this.pending.get(record.preview.id) !== record ||
      record.resolutionState !== 'pending' ||
      record.fileEditBatchParticipant?.getState() !== 'ready' ||
      record.preview.decisionReady === true
    ) {
      return;
    }
    record.preview = { ...record.preview, decisionReady: true };
    if (!record.published) return;

    this.store.update((draft) => {
      const entry = draft.toolbox[record.preview.agentInstanceId];
      if (!entry) return;
      const index = entry.pendingProposedEdits.findIndex(
        (edit) => edit.id === record.preview.id,
      );
      if (index < 0) return;
      entry.pendingProposedEdits[index] = record.preview;
    });
  }

  /**
   * Publish the post-authorization apply phase without removing the preview.
   * Keeping this identity live until the tool reaches a terminal result lets
   * the renderer distinguish filesystem application from model generation.
   */
  private markApplying(record: PendingEditRecord): void {
    record.preview = { ...record.preview, status: 'applying' };
    if (!record.published) return;

    this.store.update((draft) => {
      const entry = draft.toolbox[record.preview.agentInstanceId];
      if (!entry) return;
      const index = entry.pendingProposedEdits.findIndex(
        (edit) => edit.id === record.preview.id,
      );
      if (index < 0) return;
      entry.pendingProposedEdits[index] = record.preview;
    });
  }

  private resolve(
    record: PendingEditRecord,
    decision: PendingEditDecision,
  ): void {
    if (record.resolutionState === 'resolved') return;
    record.resolutionState = 'resolved';

    if (this.pending.get(record.preview.id) === record) {
      this.pending.delete(record.preview.id);
      record.removeAbortListener?.();
      this.releaseLock(record.lockKey, record.leaseId);
      this.releaseActiveToolCall(
        JSON.stringify([
          record.preview.agentInstanceId,
          record.preview.toolCallId,
        ]),
        record.preview.id,
      );
      if (record.published) {
        this.store.update((draft) => {
          const entry = draft.toolbox[record.preview.agentInstanceId];
          if (!entry) return;
          entry.pendingProposedEdits = entry.pendingProposedEdits.filter(
            (edit) => edit.id !== record.preview.id,
          );
        });
      }
    }
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

export interface AutoApprovedEditReceipt {
  /** Content that the guarded writer durably wrote and verified. */
  contentAfter: string;
  /**
   * A cleanup-only failure after commit/rollback closed the held file handle.
   * Synced and verified bytes remain authoritative despite close failure.
   */
  readonly cleanupError?: unknown;
  /** Verify binding, held-inode identity, and exact content without closing. */
  verify: () => Promise<boolean>;
  /**
   * Final binding/content verification followed by handle close. Returns false
   * and deliberately leaves the handle open when verification drifted so the
   * caller can still restore the exact agent effect.
   */
  commit: () => Promise<boolean>;
  /**
   * Restore the baseline through the held inode only while it still contains
   * the exact agent effect, then close. This remains available after a parent
   * binding drift so an observed path escape can be undone safely.
   */
  rollback: () => Promise<boolean>;
}

export interface AutoApprovedFileIdentity {
  dev: number;
  ino: number;
}

/**
 * Physical authorization captured before an automatic edit is admitted.
 * `workspaceRoot` is the lexical mount path used to re-resolve the two
 * canonical paths below at every guarded-write phase. The capability is
 * object-bound: it authorizes this exact root/target inode pair as observed
 * inside the workspace. A same-user process can relocate that already
 * authorized inode after the final check on platforms without openat2 or
 * equivalent handle APIs; it cannot substitute a different inode unnoticed.
 * Observable relocation fails closed and restores only the exact bytes this
 * capability wrote through its held handle.
 */
export interface AutoApprovedFileBinding extends AutoApprovedFileIdentity {
  workspaceRoot: string;
  physicalWorkspaceRoot: string;
  physicalTarget: string;
  workspaceRootIdentity: AutoApprovedFileIdentity;
}

function identityOf(stats: {
  dev: number;
  ino: number;
}): AutoApprovedFileIdentity {
  return { dev: stats.dev, ino: stats.ino };
}

function sameIdentity(
  left: { dev: number; ino: number },
  right: { dev: number; ino: number },
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameMutationStamp(
  left: { size: number; mtimeMs: number; ctimeMs: number },
  right: { size: number; mtimeMs: number; ctimeMs: number },
): boolean {
  return (
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function samePhysicalPath(left: string, right: string): boolean {
  return normalizeLockKey(left) === normalizeLockKey(right);
}

function isPhysicalPathWithin(root: string, candidate: string): boolean {
  const relative = path.relative(
    normalizeLockKey(root),
    normalizeLockKey(candidate),
  );
  return (
    relative === '' ||
    (relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

/**
 * Re-establish the lexical-path -> physical-workspace -> physical-target
 * binding around every effectful phase. This catches observable parent
 * symlink/junction swaps and mount/target replacement while retaining the
 * final-file inode and hardlink guards.
 */
async function assertAutoApprovedPathBinding(
  absolutePath: string,
  expected: AutoApprovedFileBinding,
): Promise<void> {
  const [
    physicalWorkspaceRoot,
    physicalTarget,
    lexicalWorkspaceStat,
    physicalWorkspaceStat,
    lexicalTargetStat,
    physicalTargetStat,
  ] = await Promise.all([
    realpath(expected.workspaceRoot),
    realpath(absolutePath),
    lstat(expected.workspaceRoot),
    lstat(expected.physicalWorkspaceRoot),
    lstat(absolutePath),
    lstat(expected.physicalTarget),
  ]);

  if (
    !samePhysicalPath(physicalWorkspaceRoot, expected.physicalWorkspaceRoot) ||
    !samePhysicalPath(physicalTarget, expected.physicalTarget) ||
    !isPhysicalPathWithin(physicalWorkspaceRoot, physicalTarget) ||
    !isPhysicalPathWithin(
      expected.physicalWorkspaceRoot,
      expected.physicalTarget,
    ) ||
    !lexicalWorkspaceStat.isDirectory() ||
    lexicalWorkspaceStat.isSymbolicLink() ||
    !physicalWorkspaceStat.isDirectory() ||
    !sameIdentity(lexicalWorkspaceStat, physicalWorkspaceStat) ||
    !sameIdentity(lexicalWorkspaceStat, expected.workspaceRootIdentity) ||
    !lexicalTargetStat.isFile() ||
    lexicalTargetStat.isSymbolicLink() ||
    lexicalTargetStat.nlink !== 1 ||
    !physicalTargetStat.isFile() ||
    physicalTargetStat.nlink !== 1 ||
    !sameIdentity(lexicalTargetStat, physicalTargetStat) ||
    !sameIdentity(lexicalTargetStat, expected)
  ) {
    throw new Error('Automatic edit path binding changed after authorization.');
  }
}

type OpenFileHandle = Awaited<ReturnType<typeof open>>;

async function readHandleBuffer(handle: OpenFileHandle): Promise<Buffer> {
  const stats = await handle.stat();
  if (
    !Number.isSafeInteger(stats.size) ||
    stats.size > MAX_DIFF_TEXT_FILE_SIZE
  ) {
    throw new Error('Automatic edits are limited to small text files.');
  }
  const buffer = Buffer.alloc(stats.size);
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(
      buffer,
      offset,
      buffer.length - offset,
      offset,
    );
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  return buffer.subarray(0, offset);
}

async function readHandleContent(handle: OpenFileHandle): Promise<string> {
  return (await readHandleBuffer(handle)).toString('utf8');
}

class AutoApprovedWriteProgressError extends Error {
  public constructor(
    message: string,
    public readonly stage: 'write' | 'truncate' | 'sync',
    public readonly bytesWritten: number,
    options: { cause: unknown },
  ) {
    super(message, options);
    this.name = 'AutoApprovedWriteProgressError';
  }
}

async function writeHandleContent(
  handle: OpenFileHandle,
  content: string,
): Promise<void> {
  const buffer = Buffer.from(content, 'utf8');
  let offset = 0;
  try {
    while (offset < buffer.length) {
      const { bytesWritten } = await handle.write(
        buffer,
        offset,
        buffer.length - offset,
        offset,
      );
      if (bytesWritten === 0) throw new Error('File write made no progress');
      offset += bytesWritten;
    }
  } catch (error) {
    throw new AutoApprovedWriteProgressError(
      'Automatic file write failed before all bytes were written.',
      'write',
      offset,
      { cause: error },
    );
  }
  try {
    await handle.truncate(buffer.length);
  } catch (error) {
    throw new AutoApprovedWriteProgressError(
      'Automatic file write failed while truncating the old tail.',
      'truncate',
      offset,
      { cause: error },
    );
  }
  try {
    await handle.sync();
  } catch (error) {
    throw new AutoApprovedWriteProgressError(
      'Automatic file write failed while syncing the new content.',
      'sync',
      offset,
      { cause: error },
    );
  }
}

function expectedPartialWrite(
  baseline: Buffer,
  replacement: Buffer,
  progress: AutoApprovedWriteProgressError,
): Buffer {
  if (progress.stage === 'sync') return replacement;
  const written = Math.min(progress.bytesWritten, replacement.length);
  const length = Math.max(baseline.length, written);
  const expected = Buffer.alloc(length);
  baseline.copy(expected);
  replacement.copy(expected, 0, 0, written);
  return expected;
}

async function recoverFailedAutoApprovedWrite(
  handle: OpenFileHandle,
  identity: AutoApprovedFileIdentity,
  expectedContent: string,
  replacementContent: string,
  error: unknown,
): Promise<boolean> {
  try {
    const handleStat = await handle.stat();
    if (!handleStat.isFile() || !sameIdentity(handleStat, identity))
      return false;

    const current = await readHandleBuffer(handle);
    const baseline = Buffer.from(expectedContent, 'utf8');
    const replacement = Buffer.from(replacementContent, 'utf8');
    if (current.equals(baseline)) return true;

    const knownOwnedState =
      current.equals(replacement) ||
      (error instanceof AutoApprovedWriteProgressError &&
        current.equals(expectedPartialWrite(baseline, replacement, error)));
    if (!knownOwnedState) {
      // A direct same-inode writer produced content we cannot attribute to our
      // sequential write. Never overwrite that newer user state.
      return true;
    }

    await writeHandleContent(handle, expectedContent);
    return (await readHandleBuffer(handle)).equals(baseline);
  } catch {
    return false;
  }
}

interface GuardedRewriteResult {
  identity: AutoApprovedFileIdentity;
  handle: OpenFileHandle;
}

async function rewriteExistingFileWithGuards(
  absolutePath: string,
  expectedContent: string,
  replacementContent: string,
  expectedBinding: AutoApprovedFileBinding,
): Promise<GuardedRewriteResult> {
  await assertAutoApprovedPathBinding(absolutePath, expectedBinding);
  const beforePathStat = await lstat(absolutePath);
  if (
    !beforePathStat.isFile() ||
    beforePathStat.isSymbolicLink() ||
    beforePathStat.nlink !== 1 ||
    (beforePathStat.mode & 0o111) !== 0 ||
    (process.platform !== 'win32' && (beforePathStat.mode & 0o222) === 0)
  ) {
    throw new Error(
      'Automatic edits require an existing writable, non-executable regular file.',
    );
  }
  if (!sameIdentity(beforePathStat, expectedBinding)) {
    throw new Error(
      'File identity changed after the automatic edit was applied.',
    );
  }
  const handle = await open(absolutePath, 'r+');
  let rewriteResult: GuardedRewriteResult | null = null;
  let rewriteError: { error: unknown } | null = null;
  try {
    const openedStat = await handle.stat();
    await assertAutoApprovedPathBinding(absolutePath, expectedBinding);
    const afterOpenPathStat = await lstat(absolutePath);
    if (
      !openedStat.isFile() ||
      !afterOpenPathStat.isFile() ||
      openedStat.nlink !== 1 ||
      afterOpenPathStat.nlink !== 1 ||
      !sameIdentity(beforePathStat, openedStat) ||
      !sameIdentity(openedStat, afterOpenPathStat)
    ) {
      throw new Error(
        'File path changed while the automatic edit was opening.',
      );
    }

    const beforeReadStat = await handle.stat();
    const currentContent = await readHandleContent(handle);
    const afterReadStat = await handle.stat();
    if (
      !sameIdentity(beforeReadStat, afterReadStat) ||
      !sameMutationStamp(beforeReadStat, afterReadStat) ||
      currentContent !== expectedContent
    ) {
      throw new Error(
        'File changed after the edit was proposed; review the latest content and retry.',
      );
    }

    // Re-read immediately before the first write. Atomic-save editors that
    // replace the path are caught by the identity checks; direct same-inode
    // writes that remain observable are caught by this final comparison or by
    // the post-write verification below.
    //
    // Residual risk: portable filesystems expose neither a compare-and-write
    // primitive for an already-open regular file nor one cross-platform API
    // that pins every parent component. A non-cooperating same-inode writer or
    // parent swap can therefore finish in the nanosecond window after this
    // comparison. The guards below fail closed for every race that remains
    // observable, but this function must not be described as a kernel-atomic
    // CAS or as excluding all external writers.
    const beforeWriteStat = await handle.stat();
    const latestContent = await readHandleContent(handle);
    const afterSecondReadStat = await handle.stat();
    await assertAutoApprovedPathBinding(absolutePath, expectedBinding);
    const latestPathStat = await lstat(absolutePath);
    if (
      !sameIdentity(openedStat, latestPathStat) ||
      !sameMutationStamp(beforeWriteStat, afterSecondReadStat) ||
      latestContent !== expectedContent
    ) {
      throw new Error(
        'File changed immediately before the automatic edit; retry the edit.',
      );
    }

    const identity = identityOf(openedStat);
    try {
      await writeHandleContent(handle, replacementContent);
      await assertAutoApprovedPathBinding(absolutePath, expectedBinding);
      const beforeVerificationStat = await handle.stat();
      const beforeVerificationPathStat = await lstat(absolutePath);
      const writtenContent = await readHandleContent(handle);
      const afterVerificationStat = await handle.stat();
      await assertAutoApprovedPathBinding(absolutePath, expectedBinding);
      const afterVerificationPathStat = await lstat(absolutePath);
      if (
        beforeVerificationStat.nlink !== 1 ||
        beforeVerificationPathStat.nlink !== 1 ||
        afterVerificationStat.nlink !== 1 ||
        afterVerificationPathStat.nlink !== 1 ||
        !sameIdentity(beforeVerificationStat, beforeVerificationPathStat) ||
        !sameIdentity(beforeVerificationStat, afterVerificationStat) ||
        !sameIdentity(afterVerificationStat, afterVerificationPathStat) ||
        !sameMutationStamp(beforeVerificationStat, afterVerificationStat) ||
        writtenContent !== replacementContent
      ) {
        throw new Error(
          'File changed while the automatic edit was being applied; inspect it before retrying.',
        );
      }
      rewriteResult = {
        identity: identityOf(afterVerificationStat),
        handle,
      };
    } catch (error) {
      const recovered = await recoverFailedAutoApprovedWrite(
        handle,
        identity,
        expectedContent,
        replacementContent,
        error,
      );
      if (!recovered) {
        throw new Error(
          'Automatic edit failed and the original file content could not be restored safely.',
          { cause: error },
        );
      }
      throw error;
    }
  } catch (error) {
    rewriteError = { error };
  }

  if (rewriteError) {
    try {
      await handle.close();
    } catch {
      // Preserve the effect failure. There is no successful receipt whose
      // cleanup warning could be surfaced separately.
    }
    throw rewriteError.error;
  }
  if (!rewriteResult) {
    try {
      await handle.close();
    } catch {
      // The missing verified result is the authoritative failure.
    }
    throw new Error('Automatic edit did not produce a verified write result.');
  }
  return rewriteResult;
}

async function verifyHeldGuardedRewrite(
  handle: OpenFileHandle,
  absolutePath: string,
  expectedContent: string,
  expectedBinding: AutoApprovedFileBinding,
): Promise<boolean> {
  try {
    await assertAutoApprovedPathBinding(absolutePath, expectedBinding);
    const beforePathStat = await lstat(absolutePath);
    if (
      !beforePathStat.isFile() ||
      beforePathStat.isSymbolicLink() ||
      beforePathStat.nlink !== 1 ||
      !sameIdentity(beforePathStat, expectedBinding)
    ) {
      return false;
    }

    const openedStat = await handle.stat();
    await assertAutoApprovedPathBinding(absolutePath, expectedBinding);
    const afterOpenPathStat = await lstat(absolutePath);
    if (
      !openedStat.isFile() ||
      openedStat.nlink !== 1 ||
      afterOpenPathStat.nlink !== 1 ||
      !sameIdentity(openedStat, expectedBinding) ||
      !sameIdentity(openedStat, afterOpenPathStat)
    ) {
      throw new Error('Automatic edit identity changed during verification.');
    }

    const beforeReadStat = await handle.stat();
    const content = await readHandleContent(handle);
    const afterReadStat = await handle.stat();
    await assertAutoApprovedPathBinding(absolutePath, expectedBinding);
    const finalPathStat = await lstat(absolutePath);
    return (
      beforeReadStat.nlink === 1 &&
      afterReadStat.nlink === 1 &&
      finalPathStat.nlink === 1 &&
      sameIdentity(beforeReadStat, expectedBinding) &&
      sameIdentity(beforeReadStat, afterReadStat) &&
      sameIdentity(afterReadStat, finalPathStat) &&
      sameMutationStamp(beforeReadStat, afterReadStat) &&
      content === expectedContent
    );
  } catch {
    return false;
  }
}

async function restoreHeldGuardedRewrite(
  handle: OpenFileHandle,
  identity: AutoApprovedFileIdentity,
  expectedContent: string,
  replacementContent: string,
): Promise<boolean> {
  try {
    const handleStat = await handle.stat();
    if (!handleStat.isFile() || !sameIdentity(handleStat, identity))
      return false;
    const current = await readHandleContent(handle);
    if (current === expectedContent) return true;
    if (current !== replacementContent) return false;
    await writeHandleContent(handle, expectedContent);
    const restoredStat = await handle.stat();
    return (
      sameIdentity(restoredStat, identity) &&
      (await readHandleContent(handle)) === expectedContent
    );
  } catch {
    return false;
  }
}

/**
 * Guarded in-place write for deterministic auto-policy edits. It preserves
 * the existing inode (mode, ACLs and xattrs), refuses symlinks/read-only or
 * executable files, compares the baseline through the opened handle, and
 * returns a conflict-aware rollback receipt. This is deliberately not called
 * an atomic CAS: a portable filesystem cannot exclude a non-cooperating
 * same-inode writer or a parent-path swap in the nanosecond window between the
 * final binding check and the first write without openat2/open-by-handle style
 * primitives (or the Windows handle equivalents). Observable races fail closed
 * and a post-write binding mismatch restores the baseline through the already
 * opened handle before returning failure.
 */
export async function writeAutoApprovedEditToDisk(
  absolutePath: string,
  expectedContent: string,
  content: string,
  expectedBinding: AutoApprovedFileBinding,
): Promise<AutoApprovedEditReceipt> {
  const applied = await rewriteExistingFileWithGuards(
    absolutePath,
    expectedContent,
    content,
    expectedBinding,
  );
  let state: 'open' | 'committed' | 'rolled-back-success' | 'closed-failed' =
    'open';
  let cleanupError: unknown;
  const closeHeldHandle = async (): Promise<void> => {
    try {
      await applied.handle.close();
    } catch (error) {
      cleanupError = error;
    }
  };
  return {
    contentAfter: content,
    get cleanupError() {
      return cleanupError;
    },
    verify: () =>
      state === 'open'
        ? verifyHeldGuardedRewrite(
            applied.handle,
            absolutePath,
            content,
            expectedBinding,
          )
        : Promise.resolve(false),
    commit: async () => {
      if (state !== 'open') return false;
      if (
        !(await verifyHeldGuardedRewrite(
          applied.handle,
          absolutePath,
          content,
          expectedBinding,
        ))
      ) {
        return false;
      }
      state = 'committed';
      await closeHeldHandle();
      return true;
    },
    rollback: async () => {
      if (state !== 'open') return state === 'rolled-back-success';
      // Perform the binding check even though an observed drift must not block
      // restoring exact agent bytes through the already-authorized open inode.
      // The exact-content + inode check below is the rollback capability.
      try {
        await assertAutoApprovedPathBinding(absolutePath, expectedBinding);
      } catch {
        // Expected for the parent-swap path this rollback is designed to heal.
      }
      const restored = await restoreHeldGuardedRewrite(
        applied.handle,
        applied.identity,
        expectedContent,
        content,
      );
      state = restored ? 'rolled-back-success' : 'closed-failed';
      await closeHeldHandle();
      return restored;
    },
  };
}
