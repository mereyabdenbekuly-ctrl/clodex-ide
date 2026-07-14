import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('Artifact Bridge production audit wiring', () => {
  it('uses one durable ledger for both recording and trusted inspection', async () => {
    const directory = path.dirname(fileURLToPath(import.meta.url));
    const mainSource = await fs.readFile(
      path.resolve(directory, '../../main.ts'),
      'utf8',
    );

    expect(mainSource).toContain(
      'new ArtifactBridgeAuditLedger(\n    getArtifactBridgeAuditPath(),',
    );
    expect(mainSource).toContain(
      'await artifactBridgeAuditLedger.listRecent(1);',
    );
    expect(mainSource).toContain('auditRecorder: artifactBridgeAuditLedger,');
    expect(mainSource).toContain('auditReader: artifactBridgeAuditLedger,');
  });
});
