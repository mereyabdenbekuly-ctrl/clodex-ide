export const CLODEX_CONTRACT_VERSION = 1 as const;

export type ClodexContractVersion = typeof CLODEX_CONTRACT_VERSION;

declare const brand: unique symbol;

export type Brand<Value, Name extends string> = Value & {
  readonly [brand]: Name;
};

export type TaskId = Brand<string, 'TaskId'>;
export type WorkspaceId = Brand<string, 'WorkspaceId'>;
export type ActionId = Brand<string, 'ActionId'>;
export type GuardianDecisionId = Brand<string, 'GuardianDecisionId'>;
export type ExecutionId = Brand<string, 'ExecutionId'>;
export type EvidenceReceiptId = Brand<string, 'EvidenceReceiptId'>;
export type ModelRequestId = Brand<string, 'ModelRequestId'>;
export type ModelResponseId = Brand<string, 'ModelResponseId'>;
export type IsoTimestamp = Brand<string, 'IsoTimestamp'>;
export type Sha256 = Brand<string, 'Sha256'>;

export type JsonPrimitive = boolean | null | number | string;
export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export interface ContractContext {
  readonly version: ClodexContractVersion;
  readonly taskId: TaskId;
  readonly workspaceId: WorkspaceId;
}

export interface ModelMessage {
  readonly role: 'assistant' | 'system' | 'tool' | 'user';
  readonly content: string;
}

export interface ModelRequest extends ContractContext {
  readonly requestId: ModelRequestId;
  readonly model: string;
  readonly messages: readonly ModelMessage[];
  readonly maxOutputTokens?: number;
}

export type ModelResult =
  | (ContractContext & {
      readonly status: 'completed';
      readonly requestId: ModelRequestId;
      readonly responseId: ModelResponseId;
      readonly model: string;
      readonly output: string;
      readonly inputTokens?: number;
      readonly outputTokens?: number;
    })
  | (ContractContext & {
      readonly status: 'failed';
      readonly requestId: ModelRequestId;
      readonly code: string;
      readonly message: string;
      readonly retryable: boolean;
    });

interface ProposedActionBase extends ContractContext {
  readonly actionId: ActionId;
  readonly proposedAt: IsoTimestamp;
  readonly summary: string;
}

export type ProposedAction =
  | (ProposedActionBase & {
      readonly kind: 'shell';
      readonly command: string;
      readonly cwd: string;
    })
  | (ProposedActionBase & {
      readonly kind: 'file-write';
      readonly path: string;
      readonly contentSha256: Sha256;
    })
  | (ProposedActionBase & {
      readonly kind: 'network';
      readonly method: string;
      readonly url: string;
    })
  | (ProposedActionBase & {
      readonly kind: 'browser';
      readonly operation: string;
      readonly origin: string;
    })
  | (ProposedActionBase & {
      readonly kind: 'mcp';
      readonly serverId: string;
      readonly toolName: string;
      readonly argumentsSha256: Sha256;
    });

interface GuardianDecisionBase extends ContractContext {
  readonly decisionId: GuardianDecisionId;
  readonly actionId: ActionId;
  readonly decidedAt: IsoTimestamp;
  readonly policyRevision: string;
  readonly reasonCodes: readonly string[];
}

export type GuardianDecision =
  | (GuardianDecisionBase & {
      readonly outcome: 'approve';
      readonly expiresAt: IsoTimestamp;
    })
  | (GuardianDecisionBase & {
      readonly outcome: 'deny';
    })
  | (GuardianDecisionBase & {
      readonly outcome: 'escalate';
      readonly prompt: string;
    });

export interface ExecutionRequest extends ContractContext {
  readonly executionId: ExecutionId;
  readonly action: ProposedAction;
  /**
   * Structural typing is not authorization. The runtime must fail closed unless
   * version, task, workspace, action id, policy revision, and expiry are bound
   * to this exact request by a trusted validator.
   */
  readonly authorization: GuardianDecision & { readonly outcome: 'approve' };
}

export type ExecutionResult =
  | (ContractContext & {
      readonly executionId: ExecutionId;
      readonly actionId: ActionId;
      readonly status: 'succeeded';
      readonly startedAt: IsoTimestamp;
      readonly finishedAt: IsoTimestamp;
      readonly outputSha256?: Sha256;
    })
  | (ContractContext & {
      readonly executionId: ExecutionId;
      readonly actionId: ActionId;
      readonly status: 'cancelled' | 'failed';
      readonly startedAt: IsoTimestamp;
      readonly finishedAt: IsoTimestamp;
      readonly code: string;
      readonly message: string;
    });

export interface EvidenceProvenance {
  readonly sourceType: 'agent-event' | 'file' | 'guardian' | 'model' | 'tool';
  readonly sourceId: string;
  readonly sourceSha256?: Sha256;
  readonly observedAt: IsoTimestamp;
}

export interface EvidenceReceipt extends ContractContext {
  readonly receiptId: EvidenceReceiptId;
  readonly actionId?: ActionId;
  readonly executionId?: ExecutionId;
  readonly recordedAt: IsoTimestamp;
  readonly kind: string;
  readonly payloadSha256: Sha256;
  readonly provenance: readonly EvidenceProvenance[];
}

export interface TaskSnapshot extends ContractContext {
  readonly revision: number;
  readonly savedAt: IsoTimestamp;
  readonly state: Readonly<Record<string, JsonValue>>;
}

export interface PersistencePort {
  loadTask(taskId: TaskId): Promise<TaskSnapshot | null>;
  saveTask(snapshot: TaskSnapshot): Promise<void>;
  appendEvidence(receipt: EvidenceReceipt): Promise<void>;
}

export * from './canonical-json.js';
export * from './intent-contract.js';
