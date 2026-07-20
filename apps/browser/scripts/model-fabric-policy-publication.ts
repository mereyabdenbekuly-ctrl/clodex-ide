import fs from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import {
  authorizeModelFabricPolicyPublication,
  createModelFabricPublicationApproval,
  getModelFabricPolicySnapshotHash,
  prepareSignedModelFabricPolicySnapshot,
  signModelFabricPublicationAuthority,
  verifyModelFabricPublicationState,
  type ModelFabricRolloutStage,
} from '../src/backend/services/model-fabric-policy-publication';

// PUBLIC/FREE local-reference CLI. It operates only on caller-supplied files
// and does not publish to a CLODEx-managed service. Do not add hosted delivery,
// production secret custody, billing, or enterprise control-plane behavior to
// this public command.

const MAX_JSON_BYTES = 5 * 1024 * 1024;
const MAX_KEY_BYTES = 64 * 1024;

interface ParsedArguments {
  command: string;
  values: Map<string, string[]>;
}

async function main(rawArgs: string[] = process.argv.slice(2)): Promise<void> {
  const args = parseArguments(rawArgs);
  switch (args.command) {
    case 'sign-authority':
      await signAuthority(args);
      break;
    case 'prepare-snapshot':
      await prepareSnapshot(args);
      break;
    case 'approve':
      await createApproval(args);
      break;
    case 'publish':
      await publish(args);
      break;
    case 'verify-state':
      await verifyState(args);
      break;
    case 'help':
      process.stdout.write(usage());
      break;
    default:
      throw new Error(`Unknown publication command: ${args.command}`);
  }
}

async function signAuthority(args: ParsedArguments): Promise<void> {
  const authorityPath = requiredPath(args, '--authority');
  const rootPrivateKeyPath = requiredPath(args, '--root-private-key');
  const rootPublicKeyPath = requiredPath(args, '--root-public-key');
  const outputPath = requiredPath(args, '--out');
  const [authority, rootPrivateKey, rootPublicKey] = await Promise.all([
    readJsonFile(authorityPath, 'publication authority'),
    readPrivateKeyFile(rootPrivateKeyPath, 'authority root private key'),
    readTextFile(rootPublicKeyPath, MAX_KEY_BYTES, 'authority root public key'),
  ]);
  const signed = signModelFabricPublicationAuthority({
    authority,
    rootPrivateKey,
    rootPublicKey,
  });
  await writeAtomicJson(outputPath, signed);
  reportSuccess(args.command, {
    authority_revision: signed.revision,
    output: outputPath,
  });
}

async function prepareSnapshot(args: ParsedArguments): Promise<void> {
  const payloadPath = requiredPath(args, '--payload');
  const rootPublicKeyPath = requiredPath(args, '--root-public-key');
  const rootsetPrivateKeyPath = requiredPath(args, '--rootset-private-key');
  const keysetPrivateKeyPath = requiredPath(args, '--keyset-private-key');
  const policyPrivateKeyPath = requiredPath(args, '--policy-private-key');
  const statePath = optionalPath(args, '--state');
  const outputPath = requiredPath(args, '--out');
  const [
    payload,
    rootPublicKey,
    rootsetPrivateKey,
    keysetPrivateKey,
    policyPrivateKey,
    previousState,
  ] = await Promise.all([
    readJsonFile(payloadPath, 'unsigned policy snapshot'),
    readTextFile(rootPublicKeyPath, MAX_KEY_BYTES, 'pinned root public key'),
    readPrivateKeyFile(rootsetPrivateKeyPath, 'rootset private key'),
    readPrivateKeyFile(keysetPrivateKeyPath, 'keyset private key'),
    readPrivateKeyFile(policyPrivateKeyPath, 'policy private key'),
    statePath
      ? readJsonFile(statePath, 'publication state')
      : Promise.resolve(null),
  ]);
  const verifiedPreviousState = previousState
    ? verifyModelFabricPublicationState({
        state: previousState,
        rootPublicKey,
      })
    : null;
  const snapshot = prepareSignedModelFabricPolicySnapshot({
    payload,
    pinnedRootPublicKey: rootPublicKey,
    rootsetPrivateKey,
    keysetPrivateKey,
    policyPrivateKey,
    previousSnapshot: verifiedPreviousState?.lastSnapshot,
  });
  await writeAtomicJson(outputPath, snapshot);
  reportSuccess(args.command, {
    snapshot_hash: getModelFabricPolicySnapshotHash(snapshot),
    rootset_revision: snapshot.rootset.revision,
    keyset_revision: snapshot.keyset.revision,
    policy_revision: snapshot.policy.revision,
    output: outputPath,
  });
}

async function createApproval(args: ParsedArguments): Promise<void> {
  const authorityPath = requiredPath(args, '--authority');
  const rootPublicKeyPath = requiredPath(args, '--root-public-key');
  const snapshotPath = requiredPath(args, '--snapshot');
  const approverPrivateKeyPath = requiredPath(args, '--approver-private-key');
  const approverId = requiredValue(args, '--approver-id');
  const stage = requiredStage(args);
  const statePath = optionalPath(args, '--state');
  const outputPath = requiredPath(args, '--out');
  const ttlMs = optionalTtlMs(args);
  const [
    authority,
    rootPublicKey,
    snapshot,
    approverPrivateKey,
    previousState,
  ] = await Promise.all([
    readJsonFile(authorityPath, 'signed publication authority'),
    readTextFile(rootPublicKeyPath, MAX_KEY_BYTES, 'pinned root public key'),
    readJsonFile(snapshotPath, 'signed policy snapshot'),
    readPrivateKeyFile(approverPrivateKeyPath, 'approver private key'),
    statePath
      ? readJsonFile(statePath, 'publication state')
      : Promise.resolve(null),
  ]);
  const approval = createModelFabricPublicationApproval({
    authority,
    authorityRootPublicKey: rootPublicKey,
    snapshot,
    snapshotRootPublicKey: rootPublicKey,
    approverId,
    approverPrivateKey,
    stage,
    previousState,
    ttlMs,
  });
  await writeAtomicJson(outputPath, approval);
  reportSuccess(args.command, {
    stage,
    snapshot_hash: approval.snapshotHash,
    expires_at: approval.expiresAt,
    output: outputPath,
  });
}

async function publish(args: ParsedArguments): Promise<void> {
  const authorityPath = requiredPath(args, '--authority');
  const rootPublicKeyPath = requiredPath(args, '--root-public-key');
  const snapshotPath = requiredPath(args, '--snapshot');
  const approvalPaths = requiredPaths(args, '--approval');
  const publisherPrivateKeyPath = requiredPath(args, '--publisher-private-key');
  const publisherKeyId = requiredValue(args, '--publisher-id');
  const stage = requiredStage(args);
  const statePath = requiredPath(args, '--state');
  const outputPath = requiredPath(args, '--out');
  const receiptPath = requiredPath(args, '--receipt');
  assertDistinctPaths([statePath, outputPath, receiptPath]);

  const [
    authority,
    rootPublicKey,
    snapshot,
    approvals,
    publisherPrivateKey,
    previousState,
  ] = await Promise.all([
    readJsonFile(authorityPath, 'signed publication authority'),
    readTextFile(rootPublicKeyPath, MAX_KEY_BYTES, 'pinned root public key'),
    readJsonFile(snapshotPath, 'signed policy snapshot'),
    Promise.all(
      approvalPaths.map((approvalPath) =>
        readJsonFile(approvalPath, 'signed publication approval'),
      ),
    ),
    readPrivateKeyFile(publisherPrivateKeyPath, 'publisher private key'),
    readOptionalJsonFile(statePath, 'publication state'),
  ]);
  const publication = authorizeModelFabricPolicyPublication({
    authority,
    authorityRootPublicKey: rootPublicKey,
    snapshot,
    snapshotRootPublicKey: rootPublicKey,
    approvals,
    stage,
    publisherKeyId,
    publisherPrivateKey,
    previousState,
    allowBootstrap: optionalBootstrap(args),
    publicationId: optionalValue(args, '--publication-id'),
  });

  // State is written last. A failure before that point leaves approvals
  // reusable for an idempotent retry rather than recording a publication that
  // never reached its configured output path.
  await writeAtomicJson(outputPath, publication.snapshot);
  await writeAtomicJson(receiptPath, publication.receipt);
  await writeAtomicJson(statePath, publication.state);
  reportSuccess(args.command, {
    stage,
    snapshot_hash: publication.receipt.snapshotHash,
    publication_id: publication.receipt.publicationId,
    output: outputPath,
    receipt: receiptPath,
    state: statePath,
  });
}

async function verifyState(args: ParsedArguments): Promise<void> {
  const statePath = requiredPath(args, '--state');
  const rootPublicKeyPath = requiredPath(args, '--root-public-key');
  const [state, rootPublicKey] = await Promise.all([
    readJsonFile(statePath, 'publication state'),
    readTextFile(rootPublicKeyPath, MAX_KEY_BYTES, 'authority root public key'),
  ]);
  const verified = verifyModelFabricPublicationState({
    state,
    rootPublicKey,
  });
  reportSuccess(args.command, {
    authority_revision: verified.highestAuthorityRevision,
    stage: verified.lastReceipt.stage,
    snapshot_hash: verified.lastReceipt.snapshotHash,
    publication_id: verified.lastReceipt.publicationId,
  });
}

function parseArguments(rawArgs: string[]): ParsedArguments {
  const args = rawArgs[0] === '--' ? rawArgs.slice(1) : rawArgs;
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    return { command: 'help', values: new Map() };
  }
  const command = args[0]!;
  const values = new Map<string, string[]>();
  for (let index = 1; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!name?.startsWith('--') || !value || value.startsWith('--')) {
      throw new Error(`Invalid arguments for ${command}. Run with --help.`);
    }
    const current = values.get(name) ?? [];
    current.push(value);
    values.set(name, current);
  }
  return { command, values };
}

function requiredValue(args: ParsedArguments, name: string): string {
  const values = args.values.get(name);
  if (!values || values.length !== 1 || !values[0]?.trim()) {
    throw new Error(`${name} is required exactly once`);
  }
  return values[0].trim();
}

function optionalValue(
  args: ParsedArguments,
  name: string,
): string | undefined {
  const values = args.values.get(name);
  if (!values) return undefined;
  if (values.length !== 1 || !values[0]?.trim()) {
    throw new Error(`${name} may be provided at most once`);
  }
  return values[0].trim();
}

function requiredPath(args: ParsedArguments, name: string): string {
  return path.resolve(requiredValue(args, name));
}

function optionalPath(args: ParsedArguments, name: string): string | undefined {
  const value = optionalValue(args, name);
  return value === undefined ? undefined : path.resolve(value);
}

function requiredPaths(args: ParsedArguments, name: string): string[] {
  const values = args.values.get(name);
  if (!values || values.length === 0) {
    throw new Error(`At least one ${name} is required`);
  }
  if (values.length > 64) throw new Error(`Too many ${name} values`);
  return values.map((value) => path.resolve(value));
}

function requiredStage(args: ParsedArguments): ModelFabricRolloutStage {
  const stage = requiredValue(args, '--stage');
  if (stage !== 'canary' && stage !== 'production') {
    throw new Error('--stage must be canary or production');
  }
  return stage;
}

function optionalTtlMs(args: ParsedArguments): number | undefined {
  const value = optionalValue(args, '--ttl-hours');
  if (value === undefined) return undefined;
  const hours = Number(value);
  if (!Number.isFinite(hours)) throw new Error('--ttl-hours is invalid');
  return Math.round(hours * 60 * 60_000);
}

function optionalBootstrap(args: ParsedArguments): boolean {
  const value = optionalValue(args, '--bootstrap');
  if (value === undefined) return false;
  if (value !== 'true' && value !== 'false') {
    throw new Error('--bootstrap must be true or false');
  }
  return value === 'true';
}

async function readPrivateKeyFile(
  filePath: string,
  label: string,
): Promise<string> {
  const stat = await fs.lstat(filePath).catch(() => null);
  if (!stat?.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a regular non-symlink file`);
  }
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
    throw new Error(`${label} must not be accessible by group or other users`);
  }
  return await readTextFile(filePath, MAX_KEY_BYTES, label);
}

async function readJsonFile(filePath: string, label: string): Promise<unknown> {
  const raw = await readTextFile(filePath, MAX_JSON_BYTES, label);
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

async function readOptionalJsonFile(
  filePath: string,
  label: string,
): Promise<unknown | null> {
  try {
    await fs.lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`${label} could not be read`);
  }
  return await readJsonFile(filePath, label);
}

async function readTextFile(
  filePath: string,
  maximumBytes: number,
  label: string,
): Promise<string> {
  const stat = await fs.stat(filePath).catch(() => null);
  if (!stat) {
    throw new Error(`${label} could not be read`);
  }
  if (!stat.isFile() || stat.size > maximumBytes) {
    throw new Error(`${label} is not a bounded regular file`);
  }
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch {
    throw new Error(`${label} could not be read`);
  }
}

async function writeAtomicJson(
  filePath: string,
  value: unknown,
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  const content = `${JSON.stringify(value, null, 2)}\n`;
  let handle: FileHandle | null = null;
  try {
    handle = await fs.open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(content, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temporaryPath, filePath);
    if (process.platform !== 'win32') await fs.chmod(filePath, 0o600);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function assertDistinctPaths(paths: readonly string[]): void {
  if (new Set(paths).size !== paths.length) {
    throw new Error('Publication output, receipt, and state paths must differ');
  }
}

function reportSuccess(
  command: string,
  fields: Record<string, string | number>,
): void {
  const details = Object.entries(fields)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join(' ');
  process.stdout.write(
    `MODEL_FABRIC_POLICY_PUBLICATION ok=true command=${JSON.stringify(command)} ${details}\n`,
  );
}

function usage(): string {
  return `Model Fabric policy publication CLI

Usage:
  pnpm policy:publication -- sign-authority \\
    --authority authority.unsigned.json \\
    --root-private-key root.private.pem \\
    --root-public-key root.public.pem \\
    --out authority.signed.json

  pnpm policy:publication -- prepare-snapshot \\
    --payload snapshot.unsigned.json \\
    --root-public-key root.public.pem \\
    --rootset-private-key root.private.pem \\
    --keyset-private-key root.private.pem \\
    --policy-private-key policy.private.pem \\
    [--state publication-state.json] \\
    --out snapshot.signed.json

  pnpm policy:publication -- approve \\
    --authority authority.signed.json \\
    --root-public-key root.public.pem \\
    --snapshot snapshot.signed.json \\
    --approver-id approver-release \\
    --approver-private-key approver.private.pem \\
    --stage canary \\
    [--state publication-state.json] \\
    --out approval.json

  pnpm policy:publication -- publish \\
    --authority authority.signed.json \\
    --root-public-key root.public.pem \\
    --snapshot snapshot.signed.json \\
    --approval approval-1.json [--approval approval-2.json] \\
    --publisher-id publisher-a \\
    --publisher-private-key publisher.private.pem \\
    --stage canary \\
    --bootstrap true \\
    --state publication-state.json \\
    --receipt publication-receipt.json \\
    --out control-plane-snapshot.json

  pnpm policy:publication -- verify-state \\
    --state publication-state.json \\
    --root-public-key root.public.pem

Private key files must be regular files with mode 0600 on POSIX systems.
Only the first canary publication may use --bootstrap true.
Production publication requires the exact previously published canary snapshot.
After bootstrap, pass --state to prepare-snapshot and approve so root rotations
are checked against the authenticated previous trust snapshot.
`;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  void main().catch((error) => {
    const rawArgs = process.argv.slice(2);
    const command =
      (rawArgs[0] === '--' ? rawArgs[1] : rawArgs[0]) ?? 'unknown';
    process.stderr.write(
      `MODEL_FABRIC_POLICY_PUBLICATION ok=false command=${JSON.stringify(command)} error=${JSON.stringify(
        error instanceof Error ? error.message : 'Publication failed',
      )}\n`,
    );
    process.exitCode = 1;
  });
}

export { main as runModelFabricPolicyPublicationCli };
