import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RPCManager, RPCCallOptions } from '../../src/shared/rpc.js';
import {
  createRPCCallMessage,
  createRPCReturnMessage,
  createRPCExceptionMessage,
} from '../../src/shared/messages.js';
import {
  KartonRPCException,
  KartonRPCErrorReason,
} from '../../src/shared/types.js';
import type { WebSocketMessage } from '../../src/shared/types.js';

describe('RPC Manager', () => {
  let rpcManager: RPCManager;
  let mockSend: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockSend = vi.fn();
    rpcManager = new RPCManager(mockSend);
    vi.clearAllMocks();
  });

  describe('Making RPC Calls', () => {
    it('should generate sequential call ID and send RPC call message', async () => {
      const callPromise = rpcManager.call('math.add', [1, 2]);

      expect(mockSend).toHaveBeenCalledTimes(1);
      const sentMessage = mockSend.mock.calls[0][0] as WebSocketMessage;
      expect(sentMessage.type).toBe('rpc_call');
      expect((sentMessage.data as any).rpcCallId).toBe('c1');
      expect((sentMessage.data as any).procedurePath).toEqual('math.add');
      expect((sentMessage.data as any).parameters).toEqual([1, 2]);
    });

    it('should resolve promise when return message is received', async () => {
      const callPromise = rpcManager.call('test', []);

      const returnMessage = createRPCReturnMessage('c1', 42);
      rpcManager.handleMessage(returnMessage);

      const result = await callPromise;
      expect(result).toBe(42);
    });

    it('should reject promise when exception message is received', async () => {
      const callPromise = rpcManager.call('test', []);

      const error = new Error('Test error');
      const exceptionMessage = createRPCExceptionMessage('c1', error);
      rpcManager.handleMessage(exceptionMessage);

      await expect(callPromise).rejects.toThrow('Test error');
    });

    it('should handle multiple concurrent RPC calls', async () => {
      const call1 = rpcManager.call('proc1', []);
      const call2 = rpcManager.call('proc2', []);
      const call3 = rpcManager.call('proc3', []);

      // Sequential IDs: c1, c2, c3
      rpcManager.handleMessage(createRPCReturnMessage('c2', 'result-2'));
      rpcManager.handleMessage(createRPCReturnMessage('c1', 'result-1'));
      rpcManager.handleMessage(createRPCReturnMessage('c3', 'result-3'));

      expect(await call1).toBe('result-1');
      expect(await call2).toBe('result-2');
      expect(await call3).toBe('result-3');
    });

    it('should timeout RPC calls after specified duration', async () => {
      const callPromise = rpcManager.call('test', [], { timeout: 100 });

      await expect(callPromise).rejects.toThrow(KartonRPCException);

      try {
        await callPromise;
      } catch (error) {
        expect(error).toBeInstanceOf(KartonRPCException);
        expect((error as KartonRPCException).reason).toBe(
          KartonRPCErrorReason.CONNECTION_LOST,
        );
        expect((error as KartonRPCException).procedurePath).toEqual('test');
      }
    });

    it('should clean up pending call after timeout', async () => {
      const callPromise = rpcManager.call('test', [], { timeout: 100 });

      try {
        await callPromise;
      } catch {
        // Expected to throw
      }

      // Send a late response for the same call ID
      const returnMessage = createRPCReturnMessage('c1', 42);

      // Should not throw or cause issues
      expect(() => rpcManager.handleMessage(returnMessage)).not.toThrow();
    });

    it('should use custom clientId in error when provided', async () => {
      const callPromise = rpcManager.call('test', [], {
        timeout: 100,
        clientId: 'client-456',
      });

      try {
        await callPromise;
      } catch (error) {
        expect((error as KartonRPCException).clientId).toBe('client-456');
      }
    });
  });

  describe('Fire-and-forget calls', () => {
    it('should send message and return undefined', () => {
      const result = rpcManager.call('test', [1, 2], {
        fireAndForget: true,
      });

      expect(result).toBeUndefined();
      expect(mockSend).toHaveBeenCalledTimes(1);

      const sentMessage = mockSend.mock.calls[0][0] as WebSocketMessage;
      expect(sentMessage.type).toBe('rpc_call');
      expect((sentMessage.data as any).fireAndForget).toBe(true);
      expect((sentMessage.data as any).procedurePath).toBe('test');
      expect((sentMessage.data as any).parameters).toEqual([1, 2]);
    });

    it('should not create pending call entry', () => {
      rpcManager.call('test', [], { fireAndForget: true });

      // Cleanup should have nothing to cancel
      rpcManager.cleanup();
      // No error thrown means no pending calls existed
    });

    it('should execute handler on server side without sending response', async () => {
      const handler = vi.fn().mockResolvedValue('ignored-result');
      rpcManager.registerProcedure('test', handler);

      const callMessage = createRPCCallMessage('c1', 'test', ['arg1'], true);
      await rpcManager.handleMessage(callMessage);

      expect(handler).toHaveBeenCalledWith('arg1');
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('should silently ignore errors on server side for fire-and-forget', async () => {
      const handler = vi.fn().mockRejectedValue(new Error('boom'));
      rpcManager.registerProcedure('test', handler);

      const callMessage = createRPCCallMessage('c1', 'test', [], true);
      await rpcManager.handleMessage(callMessage);

      expect(handler).toHaveBeenCalled();
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('should silently ignore missing procedure on server side for fire-and-forget', async () => {
      const callMessage = createRPCCallMessage(
        'c1',
        'nonexistent',
        [],
        true,
      );
      await rpcManager.handleMessage(callMessage);

      expect(mockSend).not.toHaveBeenCalled();
    });
  });

  describe('Handling RPC Calls', () => {
    it('should execute procedure and send return message', async () => {
      const testProcedure = vi.fn().mockResolvedValue('test-result');
      rpcManager.registerProcedure('test.procedure', testProcedure);

      const callMessage = createRPCCallMessage(
        'call-123',
        'test.procedure',
        ['arg1', 'arg2'],
      );
      await rpcManager.handleMessage(callMessage);

      expect(testProcedure).toHaveBeenCalledWith('arg1', 'arg2');
      expect(mockSend).toHaveBeenCalledTimes(1);

      const sentMessage = mockSend.mock.calls[0][0] as WebSocketMessage;
      expect(sentMessage.type).toBe('rpc_return');
      expect((sentMessage.data as any).rpcCallId).toBe('call-123');
      expect((sentMessage.data as any).value).toBe('test-result');
    });

    it('should send exception message when procedure throws', async () => {
      const error = new Error('Procedure failed');
      const testProcedure = vi.fn().mockRejectedValue(error);
      rpcManager.registerProcedure('failing', testProcedure);

      const callMessage = createRPCCallMessage('call-123', 'failing', []);
      await rpcManager.handleMessage(callMessage);

      expect(mockSend).toHaveBeenCalledTimes(1);

      const sentMessage = mockSend.mock.calls[0][0] as WebSocketMessage;
      expect(sentMessage.type).toBe('rpc_exception');
      expect((sentMessage.data as any).rpcCallId).toBe('call-123');
      expect((sentMessage.data as any).error.message).toBe('Procedure failed');
    });

    it('should handle nested procedure paths', async () => {
      const nestedProcedure = vi.fn().mockResolvedValue('nested-result');
      rpcManager.registerProcedure('api.v1.users.create', nestedProcedure);

      const callMessage = createRPCCallMessage(
        'call-123',
        'api.v1.users.create',
        [{ name: 'Alice' }],
      );
      await rpcManager.handleMessage(callMessage);

      expect(nestedProcedure).toHaveBeenCalledWith({ name: 'Alice' });
    });

    it('should send exception when procedure not found', async () => {
      const callMessage = createRPCCallMessage(
        'call-123',
        'unknown.procedure',
        [],
      );
      await rpcManager.handleMessage(callMessage);

      expect(mockSend).toHaveBeenCalledTimes(1);

      const sentMessage = mockSend.mock.calls[0][0] as WebSocketMessage;
      expect(sentMessage.type).toBe('rpc_exception');
      expect((sentMessage.data as any).error.message).toContain(
        'not registered',
      );
    });

    it('should ignore non-RPC messages', async () => {
      const stateMessage = {
        type: 'state_sync',
        data: { state: {} },
      } as WebSocketMessage;

      await expect(
        rpcManager.handleMessage(stateMessage),
      ).resolves.not.toThrow();
      expect(mockSend).not.toHaveBeenCalled();
    });
  });

  describe('Cleanup', () => {
    it('should cancel all pending calls on cleanup', async () => {
      const call1 = rpcManager.call('proc1', []);
      const call2 = rpcManager.call('proc2', []);

      rpcManager.cleanup();

      await expect(call1).rejects.toThrow(KartonRPCException);
      await expect(call2).rejects.toThrow(KartonRPCException);
    });

    it('should clear all registered procedures on cleanup', async () => {
      const procedure = vi.fn().mockResolvedValue('result');
      rpcManager.registerProcedure('test', procedure);

      rpcManager.cleanup();

      const callMessage = createRPCCallMessage('call-123', 'test', []);
      await rpcManager.handleMessage(callMessage);

      expect(procedure).not.toHaveBeenCalled();
      expect(mockSend).toHaveBeenCalledTimes(1);

      const sentMessage = mockSend.mock.calls[0][0] as WebSocketMessage;
      expect(sentMessage.type).toBe('rpc_exception');
    });
  });
});
