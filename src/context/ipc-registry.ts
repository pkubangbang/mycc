/**
 * ipc-registry.ts - IPC handler registry for module-based message handling
 *
 * Implements an IoC pattern where modules register handlers for IPC messages,
 * and TeamManager dispatches incoming messages to the appropriate handler.
 */

import type { IpcHandlerRegistration, AgentContext, SendResponseCallback } from '../types.js';

/**
 * Registry for IPC message handlers
 * Implements the IoC pattern: modules register handlers, TeamManager dispatches
 */
export class IpcRegistry {
  private handlers: Map<string, IpcHandlerRegistration> = new Map();
  private context: AgentContext | null = null;

  /**
   * Set the AgentContext for handlers to access modules
   */
  setContext(ctx: AgentContext): void {
    this.context = ctx;
  }

  /**
   * Register a handler for a message type
   * @throws Error if handler already registered for this message type
   */
  register(registration: IpcHandlerRegistration): void {
    if (this.hasHandler(registration.messageType)) {
      const existing = this.handlers.get(registration.messageType);
      throw new Error(
        `IPC handler already registered for "${registration.messageType}" ` +
          `(existing: ${existing?.module}, new: ${registration.module})`
      );
    }
    this.handlers.set(registration.messageType, registration);
  }

  /**
   * Unregister a handler
   */
  unregister(messageType: string): void {
    this.handlers.delete(messageType);
  }

  /**
   * Check if a handler exists for a message type
   */
  hasHandler(messageType: string): boolean {
    return this.handlers.has(messageType);
  }

  /**
   * Dispatch a message to the appropriate handler
   * @param sender - Name of the child process that sent the message
   * @param msg - The full message object with type field
   * @param sendResponse - Callback to send response back to child
   */
  async dispatch(
    sender: string,
    msg: { type: string; [key: string]: unknown },
    sendResponse: SendResponseCallback
  ): Promise<void> {
    const registration = this.handlers.get(msg.type);

    if (!registration) {
      // No handler registered - send error response instead of timing out
      sendResponse('error', false, undefined, `No handler registered for message type: ${msg.type}`);
      return;
    }

    if (!this.context) {
      throw new Error('IPC registry context not initialized');
    }

    // Extract payload without the type field
    const { type: _type, ...payload } = msg;

    try {
      await registration.handler(sender, payload, this.context, sendResponse);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      // Default response type for unhandled errors
      sendResponse('error', false, undefined, errorMessage);
    }
  }

  /**
   * List all registered handlers (for debugging)
   */
  listHandlers(): { messageType: string; module: string }[] {
    return Array.from(this.handlers.values()).map((h) => ({
      messageType: h.messageType,
      module: h.module,
    }));
  }
}