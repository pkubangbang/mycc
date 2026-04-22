/**
 * ipc-helpers.ts - IPC communication primitives for child process
 *
 * IPC is transient and handles request-response concurrency only.
 * Mail from teammates goes through ctx.mail (file-based), not here.
 */

import type { TeammateStatus } from '../../types.js';

/**
 * Pending request tracking
 */
interface PendingRequest {
  resolve: (data: unknown) => void;
  reject: (error: Error) => void;
}

/**
 * Response message types from parent
 * All follow the same structure: reqId + success + optional data/error
 */
interface IpcResponse {
  type: 'db_result' | 'wt_result' | 'team_result' | 'question_result';
  reqId: number;
  success: boolean;
  data?: unknown;
  error?: string;
}

/**
 * Response types that resolve pending requests
 */
const RESPONSE_TYPES = new Set(['db_result', 'wt_result', 'team_result', 'question_result']);

/**
 * Type guard to check if a message is an IPC response
 */
function isResponse(msg: { type: string; reqId?: unknown; success?: unknown; data?: unknown; error?: unknown }): msg is IpcResponse {
  return RESPONSE_TYPES.has(msg.type) && typeof msg.reqId === 'number';
}

/**
 * IPC Client for child process communication with parent
 * Only handles request-response pattern (sendRequest) and fire-and-forget (sendNotification)
 */
export class IpcClient {
  private reqIdCounter = 0;
  private pendingRequests = new Map<number, PendingRequest>();

  /**
   * Send a notification to parent (no response expected)
   */
  sendNotification(type: string, payload: Record<string, unknown>): void {
    process.send?.({ type, ...payload });
  }

  /**
   * Send a request to parent and wait for response
   * @param type - Message type
   * @param args - Request arguments
   * @param timeoutMs - Timeout in milliseconds (0 = no timeout, default 30000)
   */
  sendRequest<T>(type: string, args: Record<string, unknown>, timeoutMs = 30000): Promise<T> {
    return new Promise((resolve, reject) => {
      const reqId = ++this.reqIdCounter;
      this.pendingRequests.set(reqId, {
        resolve: (data) => resolve(data as T),
        reject,
      });

      process.send?.({ type, reqId, ...args });

      if (timeoutMs > 0) {
        setTimeout(() => {
          if (this.pendingRequests.has(reqId)) {
            this.pendingRequests.delete(reqId);
            reject(new Error(`IPC request timeout: ${type}`));
          }
        }, timeoutMs);
      }
    });
  }

  /**
   * Handle incoming message from parent
   * Returns true if handled as a response, false otherwise
   */
  handleMessage(msg: { type: string; reqId?: unknown; success?: unknown; data?: unknown; error?: unknown }): boolean {
    if (isResponse(msg)) {
      this.handleResponse(msg);
      return true;
    }
    return false;
  }

  /**
   * Handle response from parent for a pending request
   */
  private handleResponse(msg: IpcResponse): void {
    const pending = this.pendingRequests.get(msg.reqId);
    if (!pending) return;

    this.pendingRequests.delete(msg.reqId);

    if (msg.success) {
      pending.resolve(msg.data);
    } else {
      pending.reject(new Error(msg.error || 'Unknown error'));
    }
  }
}

/**
 * Global IPC client instance
 */
export const ipc = new IpcClient();

/**
 * Send status notification to parent
 */
export function sendStatus(status: TeammateStatus): void {
  ipc.sendNotification('status', { status });
}