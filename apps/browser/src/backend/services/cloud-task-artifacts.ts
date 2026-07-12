import { copyFile } from 'node:fs/promises';
import path from 'node:path';
import { dialog, shell } from 'electron';
import type {
  CloudTaskArtifactIdentity,
  CloudTaskArtifactActionResult,
} from '@shared/cloud-task-artifacts';
import {
  classifyCloudTaskFailure,
  type CloudTaskControlPlaneAuditEvent,
  type FileSystemCloudTaskArtifactStore,
} from '../agent-host';
import { DisposableService } from './disposable';
import type { KartonService } from './karton';

const PROCEDURES = [
  'cloudTasks.artifacts.open',
  'cloudTasks.artifacts.reveal',
  'cloudTasks.artifacts.export',
] as const;

export interface CloudTaskArtifactServiceOptions {
  karton: KartonService;
  store: FileSystemCloudTaskArtifactStore;
  audit?: (event: CloudTaskControlPlaneAuditEvent) => void;
  now?: () => number;
}

export class CloudTaskArtifactService extends DisposableService {
  private readonly now: () => number;

  private constructor(
    private readonly options: CloudTaskArtifactServiceOptions,
  ) {
    super();
    this.now = options.now ?? Date.now;
  }

  public static create(
    options: CloudTaskArtifactServiceOptions,
  ): CloudTaskArtifactService {
    const service = new CloudTaskArtifactService(options);
    service.registerProcedures();
    return service;
  }

  public async open(
    identity: CloudTaskArtifactIdentity,
  ): Promise<CloudTaskArtifactActionResult> {
    return await this.perform('artifact-open', async () => {
      const artifact = await this.options.store.resolve(
        identity.executionId,
        identity.artifactId,
      );
      const error = await shell.openPath(artifact.localPath);
      if (error) throw new Error('The cloud artifact could not be opened');
      return { ok: true };
    });
  }

  public async reveal(
    identity: CloudTaskArtifactIdentity,
  ): Promise<CloudTaskArtifactActionResult> {
    return await this.perform('artifact-reveal', async () => {
      const artifact = await this.options.store.resolve(
        identity.executionId,
        identity.artifactId,
      );
      shell.showItemInFolder(artifact.localPath);
      return { ok: true };
    });
  }

  public async export(
    identity: CloudTaskArtifactIdentity,
  ): Promise<CloudTaskArtifactActionResult> {
    const startedAt = this.now();
    try {
      const artifact = await this.options.store.resolve(
        identity.executionId,
        identity.artifactId,
      );
      const selection = await dialog.showSaveDialog({
        title: 'Export cloud artifact',
        defaultPath: artifact.fileName,
        buttonLabel: 'Export',
        properties: ['createDirectory', 'showOverwriteConfirmation'],
      });
      if (selection.canceled || !selection.filePath) {
        this.audit({
          operation: 'artifact-export',
          success: true,
          residency: this.options.store.residency,
          durationMs: this.now() - startedAt,
        });
        return { ok: false, cancelled: true, error: 'Export cancelled' };
      }
      if (
        path.resolve(selection.filePath) !== path.resolve(artifact.localPath)
      ) {
        await copyFile(artifact.localPath, selection.filePath);
      }
      this.audit({
        operation: 'artifact-export',
        success: true,
        residency: this.options.store.residency,
        durationMs: this.now() - startedAt,
      });
      return { ok: true };
    } catch (error) {
      this.auditFailure('artifact-export', error, startedAt);
      return {
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : 'The cloud artifact could not be exported',
      };
    }
  }

  private registerProcedures(): void {
    this.options.karton.registerServerProcedureHandler(
      'cloudTasks.artifacts.open',
      async (_clientId, identity: CloudTaskArtifactIdentity) =>
        this.open(identity),
    );
    this.options.karton.registerServerProcedureHandler(
      'cloudTasks.artifacts.reveal',
      async (_clientId, identity: CloudTaskArtifactIdentity) =>
        this.reveal(identity),
    );
    this.options.karton.registerServerProcedureHandler(
      'cloudTasks.artifacts.export',
      async (_clientId, identity: CloudTaskArtifactIdentity) =>
        this.export(identity),
    );
  }

  private async perform(
    operation: 'artifact-open' | 'artifact-reveal',
    action: () => Promise<{ ok: true }>,
  ): Promise<CloudTaskArtifactActionResult> {
    const startedAt = this.now();
    try {
      const result = await action();
      this.audit({
        operation,
        success: true,
        residency: this.options.store.residency,
        durationMs: this.now() - startedAt,
      });
      return result;
    } catch (error) {
      this.auditFailure(operation, error, startedAt);
      return {
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : 'The cloud artifact action failed',
      };
    }
  }

  private auditFailure(
    operation: 'artifact-open' | 'artifact-reveal' | 'artifact-export',
    error: unknown,
    startedAt: number,
  ): void {
    this.audit({
      operation,
      success: false,
      residency: this.options.store.residency,
      reason: classifyCloudTaskFailure(error),
      durationMs: this.now() - startedAt,
    });
  }

  private audit(event: CloudTaskControlPlaneAuditEvent): void {
    try {
      this.options.audit?.(event);
    } catch {
      // Audit transport must never change a user file action.
    }
  }

  protected onTeardown(): void {
    for (const procedure of PROCEDURES) {
      this.options.karton.removeServerProcedureHandler(procedure);
    }
  }
}
