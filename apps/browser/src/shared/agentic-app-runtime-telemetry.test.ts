import { describe, expect, it } from 'vitest';
import { agenticAppRuntimeDogfoodTelemetrySchema } from './agentic-app-runtime-telemetry';

describe('Agentic App Runtime dogfood telemetry', () => {
  it('accepts bounded content-free observations', () => {
    expect(
      agenticAppRuntimeDogfoodTelemetrySchema.parse({
        activity: 'preview-session',
        outcome: 'started',
        principal_kind: 'agent',
        app_instance_hash: 'a'.repeat(64),
      }),
    ).toBeTruthy();
    expect(
      agenticAppRuntimeDogfoodTelemetrySchema.parse({
        activity: 'capability-invocation',
        outcome: 'success',
        principal_kind: 'package',
        capability_kind: 'mcp-read',
      }),
    ).toBeTruthy();
  });

  it('rejects identifiers, content and incomplete discriminators', () => {
    expect(() =>
      agenticAppRuntimeDogfoodTelemetrySchema.parse({
        activity: 'preview-session',
        outcome: 'started',
        principal_kind: 'agent',
        appId: 'private-app-id',
      }),
    ).toThrow();
    expect(() =>
      agenticAppRuntimeDogfoodTelemetrySchema.parse({
        activity: 'capability-invocation',
        outcome: 'success',
        principal_kind: 'agent',
        capability_kind: 'mcp-read',
        arguments: { query: 'private prompt' },
      }),
    ).toThrow();
  });
});
