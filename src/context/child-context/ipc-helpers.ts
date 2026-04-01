/**
 * ipc-helpers.ts - IPC communication primitives for child process
 */

import type { TeammateStatus } from '../../types.js';

/**
 * Pending request tracking
 */
interface PendingRequest {
  resolve: (data: unknown) => void;
  reject: (error: Error) => void;
}

let reqIdCounter = 0;
const pendingRequests = new Map<number, PendingRequest>();

/**
 * Inbox for incoming messages from parent
 */
export const inboxMessages: Array<{ type: string; [key: string]: unknown }> = [];

/**
 * Send a notification to parent (no response expected)
 */
export function sendNotification(type: string, payload: Record<string, unknown>): void {
  process.send?.({ type, ...payload });
}

/**
 * Send a request to parent and wait for response
 * @param type - Message type
 * @param args - Request arguments
 * @param timeoutMs - Timeout in milliseconds (0 = no timeout, default 30000)
 */
export function sendRequest<T>(
  type: string,
  args: Record<string, unknown>,
  timeoutMs: number = 30000
): Promise<T> {
  return new Promise((resolve, reject) => {
    const reqId = ++reqIdCounter;
    pendingRequests.set(reqId, {
      resolve: (data) => resolve(data as T),
      reject,
    });

    process.send?.({ type, reqId, ...args });

    // Set up timeout (0 = no timeout, useful for user input)
    if (timeoutMs > 0) {
      setTimeout(() => {
        if (pendingRequests.has(reqId)) {
          pendingRequests.delete(reqId);
          reject(new Error(`IPC request timeout: ${type}`));
        }
      }, timeoutMs);
    }
  });
}

/**
 * Handle response from parent
 */
export function handleDbResult(msg: {
  reqId: number;
  success: boolean;
  data?: unknown;
  error?: string;
}): void {
  const pending = pendingRequests.get(msg.reqId);
  if (!pending) return;

  pendingRequests.delete(msg.reqId);

  if (msg.success) {
    pending.resolve(msg.data);
  } else {
    pending.reject(new Error(msg.error || 'Unknown error'));
  }
}

/**
 * Send status update to parent
 */
export function sendStatus(status: TeammateStatus): void {
  sendNotification('status', { status });
}

/**
 * Send log message to parent
 */
export function sendLog(message: string): void {
  sendNotification('log', { message });
}

/**
 * Send error message to parent
 */
export function sendError(error: string): void {
  sendNotification('error', { error });
}

/**
 * Process inbox messages
 * Returns messages of a specific type, removing them from inbox
 */
export function getMessages(type: string): Array<{ type: string; [key: string]: unknown }> {
  const matches: Array<{ type: string; [key: string]: unknown }> = [];
  const remaining: Array<{ type: string; [key: string]: unknown }> = [];

  for (const msg of inboxMessages) {
    if (msg.type === type) {
      matches.push(msg);
    } else {
      remaining.push(msg);
    }
  }

  // Clear inbox and add remaining
  inboxMessages.length = 0;
  inboxMessages.push(...remaining);

  return matches;
}

/**
 * Check if there are pending messages of a type
 */
export function hasMessage(type: string): boolean {
  return inboxMessages.some((msg) => msg.type === type);
}

/**
 * Clear all inbox messages
 */
export function clearInbox(): void {
  inboxMessages.length = 0;
}