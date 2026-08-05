import { describe, expect, it } from 'vitest';
import {
  SANDBOX_DOMAIN_SCHEMA_VERSION,
  createSandboxDomainAdapter,
} from './sandbox-domain-adapter';
import JavaScriptSandboxSkill from '../../../bundled/plugins/javascript-sandbox/SKILL.md?raw';
import JavaScriptSandboxExamples from '../../../bundled/plugins/javascript-sandbox/references/examples.md?raw';
import SandboxWorkerSource from '../services/sandbox/sandbox-worker.ts?raw';

describe('createSandboxDomainAdapter', () => {
  it('reports the expected contract metadata', () => {
    const adapter = createSandboxDomainAdapter({ getSessionId: () => null });
    expect(adapter.domainId).toBe('sandboxSessionId');
    expect(adapter.renderOrder).toBe(10);
    expect(adapter.schemaVersion).toBe(SANDBOX_DOMAIN_SCHEMA_VERSION);
  });

  it('renders nothing when there is no session and no prior state', () => {
    const adapter = createSandboxDomainAdapter({ getSessionId: () => null });
    expect(adapter.renderState(null, null)).toBe('');
  });

  it('renders the full session tag as the keyframe', () => {
    const adapter = createSandboxDomainAdapter({ getSessionId: () => 'sb-1' });
    const curr = adapter.getState('agent-1') as string;
    expect(adapter.renderState(null, curr)).toBe('<sandbox session="sb-1" />');
  });

  it('emits sandbox-restarted on id transition', () => {
    const adapter = createSandboxDomainAdapter({ getSessionId: () => 'sb-2' });
    const curr = adapter.getState('agent-1') as string;
    const diff = adapter.renderState('sb-1', curr);
    expect(diff).toContain('sandbox-restarted');
  });

  it('uses identity equality, not deep equality', () => {
    const adapter = createSandboxDomainAdapter({ getSessionId: () => null });
    expect(adapter.equals?.('a', 'a')).toBe(true);
    expect(adapter.equals?.('a', 'b')).toBe(false);
    expect(adapter.equals?.(null, null)).toBe(true);
  });

  it('exposes a non-empty promptSection covering sandbox keywords', () => {
    const adapter = createSandboxDomainAdapter({ getSessionId: () => null });
    expect(adapter.promptSection).toBeTruthy();
    const section = adapter.promptSection ?? '';
    expect(section).toContain('Sandbox');
    expect(section).toContain('API.output');
    expect(section).toContain('API.sendCDP');
  });

  it('keeps agent guidance aligned with the fail-closed runtime boundary', () => {
    const adapter = createSandboxDomainAdapter({ getSessionId: () => null });
    const guidance = [
      adapter.promptSection ?? '',
      JavaScriptSandboxSkill,
      JavaScriptSandboxExamples,
    ];

    for (const document of guidance) {
      expect(document).toContain('Remote module imports are disabled');
      expect(document).toContain('Host filesystem access');
    }

    const combinedGuidance = guidance.join('\n');
    expect(combinedGuidance).not.toContain('https://esm.sh');
    expect(combinedGuidance).not.toContain('Always use `importModule()`');
    expect(combinedGuidance).not.toContain('Modules cached per session');
    expect(combinedGuidance).not.toContain(
      'Sandboxed `fs` and `fsPromises` globals are available',
    );

    expect(SandboxWorkerSource).toContain('Remote module imports are disabled');
    expect(SandboxWorkerSource).toContain('Host filesystem access is disabled');
    expect(SandboxWorkerSource).not.toContain(
      'importModule() only supports https:// URLs',
    );
  });
});
