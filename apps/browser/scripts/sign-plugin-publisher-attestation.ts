import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { signPublisherAttestation } from '../src/backend/services/plugin-marketplace/publisher-signing';

type Arguments = {
  entryPath: string;
  privateKeyPath: string;
  publicKeyPath: string;
  keyId: string;
  outputPath?: string;
};

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  const result = await signPublisherAttestation(options);
  const output = `${JSON.stringify(result, null, 2)}\n`;
  if (options.outputPath) {
    await fs.mkdir(path.dirname(options.outputPath), { recursive: true });
    await fs.writeFile(options.outputPath, output, {
      encoding: 'utf8',
      mode: 0o600,
    });
  } else {
    process.stdout.write(output);
  }
}

function parseArguments(args: string[]): Arguments {
  const normalizedArgs = args[0] === '--' ? args.slice(1) : args;
  const values = new Map<string, string>();
  for (let index = 0; index < normalizedArgs.length; index += 2) {
    const name = normalizedArgs[index];
    const value = normalizedArgs[index + 1];
    if (!name?.startsWith('--') || !value) {
      throw new Error(
        'Usage: --entry <json> --private-key <pem> --public-key <pem> --key-id <id> [--out <json>]',
      );
    }
    values.set(name, value);
  }
  const entryPath = values.get('--entry');
  const privateKeyPath = values.get('--private-key');
  const publicKeyPath = values.get('--public-key');
  const keyId = values.get('--key-id');
  if (!entryPath || !privateKeyPath || !publicKeyPath || !keyId) {
    throw new Error(
      'Usage: --entry <json> --private-key <pem> --public-key <pem> --key-id <id> [--out <json>]',
    );
  }
  if (!/^[A-Za-z0-9._-]{1,120}$/.test(keyId)) {
    throw new Error('Publisher key ID is invalid');
  }
  return {
    entryPath: path.resolve(entryPath),
    privateKeyPath: path.resolve(privateKeyPath),
    publicKeyPath: path.resolve(publicKeyPath),
    keyId,
    outputPath: values.get('--out')
      ? path.resolve(values.get('--out')!)
      : undefined,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  void main().catch((error) => {
    console.error(
      'PUBLISHER_ATTESTATION_SIGNED ok=false',
      error instanceof Error ? error.message : error,
    );
    process.exitCode = 1;
  });
}
