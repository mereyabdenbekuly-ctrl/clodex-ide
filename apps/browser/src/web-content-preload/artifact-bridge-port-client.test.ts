import { describe, expect, it, vi } from 'vitest';
import type { ArtifactBridgeEnvelope } from '@shared/artifact-bridge';
import {
  ArtifactBridgePortClient,
  type ArtifactBridgeRendererPort,
} from './artifact-bridge-port-client';

class FakePort implements ArtifactBridgeRendererPort {
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onmessageerror: ((event: MessageEvent<unknown>) => void) | null = null;
  readonly sent: unknown[] = [];
  readonly start = vi.fn();
  readonly close = vi.fn();

  postMessage(message: unknown): void {
    this.sent.push(message);
  }

  deliver(message: unknown): void {
    this.onmessage?.({ data: message } as MessageEvent<unknown>);
  }
}

const binding = {
  sessionId: '11111111-1111-4111-8111-111111111111',
  navigationEpoch: 7,
};

describe('ArtifactBridgePortClient', () => {
  it('keeps the binding private and sends an exact session-bound request', async () => {
    const port = new FakePort();
    const client = new ArtifactBridgePortClient(port, {
      connectTimeoutMs: 1_000,
      requestTimeoutMs: 1_000,
    });
    port.deliver({
      __clodexArtifactBridge: 2,
      type: 'connect',
      ...binding,
    });

    const resultPromise = client.request('getCapabilities', {});
    await vi.waitFor(() => expect(port.sent).toHaveLength(1));
    const envelope = port.sent[0] as ArtifactBridgeEnvelope;
    expect(envelope).toMatchObject({
      __clodexArtifactBridge: 2,
      type: 'request',
      ...binding,
      request: { method: 'getCapabilities', params: {} },
    });

    port.deliver({
      __clodexArtifactBridge: 2,
      type: 'response',
      ...binding,
      id: envelope.request.id,
      ok: true,
      result: { capabilities: [] },
    });
    await expect(resultPromise).resolves.toEqual({ capabilities: [] });
    client.dispose();
  });

  it('rejects a response from a stale navigation epoch and closes the port', async () => {
    const port = new FakePort();
    const client = new ArtifactBridgePortClient(port, {
      connectTimeoutMs: 1_000,
      requestTimeoutMs: 1_000,
    });
    port.deliver({
      __clodexArtifactBridge: 2,
      type: 'connect',
      ...binding,
    });
    const resultPromise = client.request('getCapabilities', {});
    await vi.waitFor(() => expect(port.sent).toHaveLength(1));
    const envelope = port.sent[0] as ArtifactBridgeEnvelope;

    port.deliver({
      __clodexArtifactBridge: 2,
      type: 'response',
      ...binding,
      navigationEpoch: binding.navigationEpoch + 1,
      id: envelope.request.id,
      ok: true,
      result: {},
    });

    await expect(resultPromise).rejects.toThrow('response binding');
    expect(port.close).toHaveBeenCalledOnce();
  });

  it('fails closed on a malformed connect without sending a request', async () => {
    const port = new FakePort();
    const client = new ArtifactBridgePortClient(port, {
      connectTimeoutMs: 1_000,
    });
    const request = client.request('getCapabilities', {});

    port.deliver({
      __clodexArtifactBridge: 2,
      type: 'connect',
      sessionId: binding.sessionId,
      navigationEpoch: 0,
    });

    await expect(request).rejects.toThrow('Invalid Artifact Bridge connect');
    expect(port.sent).toEqual([]);
    expect(port.close).toHaveBeenCalledOnce();
  });

  it('bounds a missing connect after the broker closes or rejects the channel', async () => {
    vi.useFakeTimers();
    try {
      const port = new FakePort();
      const client = new ArtifactBridgePortClient(port, {
        connectTimeoutMs: 25,
      });
      const request = client.request('getCapabilities', {});
      const rejection = expect(request).rejects.toThrow(
        'Artifact Bridge connection timed out',
      );

      await vi.advanceTimersByTimeAsync(25);

      await rejection;
      expect(port.sent).toEqual([]);
      expect(port.close).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects a denied response and all pending work on dispose', async () => {
    const port = new FakePort();
    const client = new ArtifactBridgePortClient(port, {
      connectTimeoutMs: 1_000,
      requestTimeoutMs: 1_000,
    });
    port.deliver({
      __clodexArtifactBridge: 2,
      type: 'connect',
      ...binding,
    });
    const denied = client.request('getCapabilities', {});
    await vi.waitFor(() => expect(port.sent).toHaveLength(1));
    const envelope = port.sent[0] as ArtifactBridgeEnvelope;
    port.deliver({
      __clodexArtifactBridge: 2,
      type: 'response',
      ...binding,
      id: envelope.request.id,
      ok: false,
      error: 'denied',
    });
    await expect(denied).rejects.toThrow('denied');

    const pending = client.request('getCapabilities', {});
    await vi.waitFor(() => expect(port.sent).toHaveLength(2));
    client.dispose(new Error('navigated'));
    await expect(pending).rejects.toThrow('navigated');
  });
});
