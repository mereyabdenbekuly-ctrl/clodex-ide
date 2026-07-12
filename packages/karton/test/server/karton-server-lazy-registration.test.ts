import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { createKartonServer } from '../../src/server/karton-server.js';
import type { KartonServer } from '../../src/shared/types.js';
import { KartonProcedureError } from '../../src/shared/types.js';
import { createKartonClient } from '../../src/client/karton-client.js';
import type { KartonClient } from '../../src/shared/types.js';

type TestAppType = {
  state: {
    counter: number;
    message: string;
  };
  serverProcedures: {
    increment: (amount: number) => Promise<number>;
    nested: {
      getData: () => Promise<string>;
      process: (input: string) => Promise<{ result: string }>;
    };
  };
  clientProcedures: {
    notify: (message: string) => Promise<void>;
  };
};

describe('KartonServer Lazy Registration', () => {
  let server: KartonServer<TestAppType>;
  let client: KartonClient<TestAppType>;
  let httpServer: Server | undefined;
  let activeClients: KartonClient<TestAppType>[];

  beforeEach(() => {
    httpServer = undefined;
    activeClients = [];
  });

  afterEach(async () => {
    for (const activeClient of activeClients) {
      (activeClient as KartonClient<TestAppType> & { close(): void }).close();
    }

    if (server?.wss) {
      await new Promise<void>((resolve, reject) => {
        server.wss?.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }

    if (httpServer?.listening) {
      await new Promise<void>((resolve, reject) => {
        httpServer?.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }
  });

  async function startHttpServer(): Promise<string> {
    httpServer = createServer();
    const wss = server.wss;

    if (!wss) {
      throw new Error('Expected Karton to expose a WebSocket server');
    }

    httpServer.on('upgrade', (request, socket, head) => {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    });

    const listening = once(httpServer, 'listening');
    httpServer.listen(0, '127.0.0.1');
    await listening;

    const address = httpServer.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected HTTP server to listen on a TCP port');
    }

    return `ws://127.0.0.1:${address.port}`;
  }

  function createClientConnection(
    webSocketPath: string,
    procedures: TestAppType['clientProcedures'],
  ): { client: KartonClient<TestAppType>; ready: Promise<void> } {
    const isReady = (candidate: KartonClient<TestAppType> | undefined) =>
      candidate?.isConnected && candidate.state.message === 'initial';

    let resolveReady = () => {};
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });

    let createdClient: KartonClient<TestAppType> | undefined;
    createdClient = createKartonClient<TestAppType>({
      webSocketPath,
      procedures,
      fallbackState: { counter: 0, message: '' },
      onStateChange: () => {
        // Initial state sync is Karton's first application-level message. Waiting
        // for it verifies the full WebSocket/message pipeline, not just TCP open.
        if (isReady(createdClient)) {
          resolveReady();
        }
      },
    });

    activeClients.push(createdClient);
    if (isReady(createdClient)) {
      resolveReady();
    }

    return { client: createdClient, ready };
  }

  describe('registerServerProcedureHandler', () => {
    it('should allow registering a procedure handler after server creation', async () => {
      // Create server without procedures
      server = await createKartonServer<TestAppType>({
        initialState: {
          counter: 0,
          message: 'initial',
        },
      });

      // Register handler lazily
      const handler = vi.fn(async (clientId: string, amount: number) => {
        return server.state.counter + amount;
      });

      server.registerServerProcedureHandler('increment', handler);

      const webSocketPath = await startHttpServer();
      const connection = createClientConnection(webSocketPath, {
        notify: async (message: string) => {
          console.log('Client notified:', message);
        },
      });
      client = connection.client;
      await connection.ready;

      // Call the procedure
      const result = await client.serverProcedures.increment(5);

      expect(handler).toHaveBeenCalledWith(expect.any(String), 5);
      expect(result).toBe(5);
    });

    it('should allow registering nested procedure handlers', async () => {
      server = await createKartonServer<TestAppType>({
        initialState: {
          counter: 0,
          message: 'initial',
        },
      });

      const getDataHandler = vi.fn(async (clientId: string) => 'test data');
      const processHandler = vi.fn(async (clientId: string, input: string) => ({
        result: `processed: ${input}`,
      }));

      server.registerServerProcedureHandler('nested.getData', getDataHandler);
      server.registerServerProcedureHandler('nested.process', processHandler);

      const webSocketPath = await startHttpServer();
      const connection = createClientConnection(webSocketPath, {
        notify: async () => {},
      });
      client = connection.client;
      await connection.ready;

      const data = await client.serverProcedures.nested.getData();
      expect(data).toBe('test data');
      expect(getDataHandler).toHaveBeenCalledWith(expect.any(String));

      const result = await client.serverProcedures.nested.process('test');
      expect(result).toEqual({ result: 'processed: test' });
      expect(processHandler).toHaveBeenCalledWith(expect.any(String), 'test');
    });

    it('should apply handler to all existing connections', async () => {
      server = await createKartonServer<TestAppType>({
        initialState: {
          counter: 0,
          message: 'initial',
        },
      });

      const webSocketPath = await startHttpServer();
      const connection1 = createClientConnection(webSocketPath, {
        notify: async () => {},
      });
      const connection2 = createClientConnection(webSocketPath, {
        notify: async () => {},
      });
      const client1 = connection1.client;
      const client2 = connection2.client;

      await Promise.all([connection1.ready, connection2.ready]);

      // Register handler after clients are connected
      const handler = vi.fn(async (clientId: string, amount: number) => amount * 2);
      server.registerServerProcedureHandler('increment', handler);

      // Both clients should be able to call the procedure
      const result1 = await client1.serverProcedures.increment(5);
      const result2 = await client2.serverProcedures.increment(10);

      expect(result1).toBe(10);
      expect(result2).toBe(20);
      expect(handler).toHaveBeenCalledTimes(2);
    });

    it('should throw error when registering duplicate handler', async () => {
      server = await createKartonServer<TestAppType>({
        initialState: {
          counter: 0,
          message: 'initial',
        },
      });

      const handler1 = async (clientId: string, amount: number) => amount;
      const handler2 = async (clientId: string, amount: number) => amount * 2;

      server.registerServerProcedureHandler('increment', handler1);

      // Should throw when trying to register duplicate
      expect(() => {
        server.registerServerProcedureHandler('increment', handler2);
      }).toThrow(KartonProcedureError);

      expect(() => {
        server.registerServerProcedureHandler('increment', handler2);
      }).toThrow(/already registered/i);
    });
  });

  describe('removeServerProcedureHandler', () => {
    it('should remove a registered handler', async () => {
      server = await createKartonServer<TestAppType>({
        initialState: {
          counter: 0,
          message: 'initial',
        },
      });

      const handler = vi.fn(async (clientId: string, amount: number) => amount);
      server.registerServerProcedureHandler('increment', handler);

      // Remove the handler
      server.removeServerProcedureHandler('increment');

      // Should be able to register new handler now
      const newHandler = vi.fn(async (clientId: string, amount: number) => amount * 3);
      server.registerServerProcedureHandler('increment', newHandler);

      const webSocketPath = await startHttpServer();
      const connection = createClientConnection(webSocketPath, {
        notify: async () => {},
      });
      client = connection.client;
      await connection.ready;

      const result = await client.serverProcedures.increment(4);

      expect(result).toBe(12);
      expect(handler).not.toHaveBeenCalled();
      expect(newHandler).toHaveBeenCalledWith(expect.any(String), 4);
    });

    it('should remove handler from all connections', async () => {
      server = await createKartonServer<TestAppType>({
        initialState: {
          counter: 0,
          message: 'initial',
        },
      });

      const webSocketPath = await startHttpServer();
      const connection = createClientConnection(webSocketPath, {
        notify: async () => {},
      });
      client = connection.client;
      await connection.ready;

      const handler = async (clientId: string, amount: number) => amount * 2;
      server.registerServerProcedureHandler('increment', handler);

      // Verify handler works
      const result1 = await client.serverProcedures.increment(5);
      expect(result1).toBe(10);

      // Remove handler
      server.removeServerProcedureHandler('increment');

      // Should throw error when calling removed procedure
      await expect(client.serverProcedures.increment(5)).rejects.toThrow();
    });
  });

  describe('Error Handling', () => {
    it('should throw KartonProcedureError when calling procedure without handler', async () => {
      server = await createKartonServer<TestAppType>({
        initialState: {
          counter: 0,
          message: 'initial',
        },
      });

      const webSocketPath = await startHttpServer();
      const connection = createClientConnection(webSocketPath, {
        notify: async () => {},
      });
      client = connection.client;
      await connection.ready;

      // Try to call procedure without handler
      await expect(client.serverProcedures.increment(5)).rejects.toThrow(
        /procedure.*not.*registered/i
      );
    });

    it('should provide clear error message with procedure path', async () => {
      server = await createKartonServer<TestAppType>({
        initialState: {
          counter: 0,
          message: 'initial',
        },
      });

      const webSocketPath = await startHttpServer();
      const connection = createClientConnection(webSocketPath, {
        notify: async () => {},
      });
      client = connection.client;
      await connection.ready;

      try {
        await client.serverProcedures.nested.getData();
        expect.fail('Should have thrown error');
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain('nested.getData');
        expect((error as Error).message).toContain('not registered');
      }
    });
  });

  describe('Mixed registration scenarios', () => {
    it('should support both initial and lazy registration', async () => {
      const initialHandler = vi.fn(async (clientId: string) => 'initial data');

      // Create server with some initial procedures
      server = await createKartonServer<TestAppType>({
        initialState: {
          counter: 0,
          message: 'initial',
        },
        procedures: {
          nested: {
            getData: initialHandler,
          },
        } as any,
      });

      // Register additional handler lazily
      const lazyHandler = vi.fn(async (clientId: string, amount: number) => amount * 2);
      server.registerServerProcedureHandler('increment', lazyHandler);

      const webSocketPath = await startHttpServer();
      const connection = createClientConnection(webSocketPath, {
        notify: async () => {},
      });
      client = connection.client;
      await connection.ready;

      // Both procedures should work
      const dataResult = await client.serverProcedures.nested.getData();
      expect(dataResult).toBe('initial data');
      expect(initialHandler).toHaveBeenCalled();

      const incrementResult = await client.serverProcedures.increment(7);
      expect(incrementResult).toBe(14);
      expect(lazyHandler).toHaveBeenCalled();
    });

    it('should allow overriding initial procedures after removal', async () => {
      const initialHandler = vi.fn(async (clientId: string, amount: number) => amount);

      server = await createKartonServer<TestAppType>({
        initialState: {
          counter: 0,
          message: 'initial',
        },
        procedures: {
          increment: initialHandler,
        } as any,
      });

      const webSocketPath = await startHttpServer();
      const connection = createClientConnection(webSocketPath, {
        notify: async () => {},
      });
      client = connection.client;
      await connection.ready;

      // Initial handler works
      const result1 = await client.serverProcedures.increment(5);
      expect(result1).toBe(5);

      // Remove and replace
      server.removeServerProcedureHandler('increment');
      const newHandler = vi.fn(async (clientId: string, amount: number) => amount * 10);
      server.registerServerProcedureHandler('increment', newHandler);

      // New handler should be used
      const result2 = await client.serverProcedures.increment(5);
      expect(result2).toBe(50);
      expect(initialHandler).toHaveBeenCalledTimes(1);
      expect(newHandler).toHaveBeenCalledTimes(1);
    });
  });
});
