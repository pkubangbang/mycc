/**
 * peer.ts - PeerManager facade implementing PeerModule
 *
 * Combines IdentityManager and ChannelManager into a single module
 * that is wired into ParentContext as ctx.peer.
 */

import type { PeerModule, IdentityEntry, ChannelFile } from '../types.js';
import { IdentityManager } from './identity.js';
import { ChannelManager } from './channel.js';

export class PeerManager implements PeerModule {
  private identity: IdentityManager;
  private channel: ChannelManager;

  constructor(sessionId: string, workDir: string, mailboxPath: string) {
    this.identity = new IdentityManager(sessionId, workDir, mailboxPath);
    this.channel = new ChannelManager(sessionId, this.identity, mailboxPath);
  }

  listIdentities(): IdentityEntry[] {
    return this.identity.listIdentities();
  }

  isFresh(sessionId: string): boolean {
    return this.identity.isFresh(sessionId);
  }

  listChannels(): ChannelFile[] {
    return this.channel.listChannels();
  }

  joinChannel(channelId: string): { joined: boolean; firstQuery?: string } {
    return this.channel.joinChannel(channelId);
  }

  sendMail(channelId: string, sessionId: string, topic: string, content: string): boolean {
    return this.channel.sendMail(channelId, sessionId, topic, content);
  }

  /**
   * True if there is at least one joined channel whose peer is fresh.
   * A channel is "active" when it is joined AND its peerSessionId is known
   * AND that peer's heartbeat is fresh. This is the autofly equivalent:
   * an active channel lets the PROMPT gate engage auto mode so the loop
   * keeps running without prompting the user.
   */
  hasActiveChannel(): boolean {
    const channels = this.channel.listChannels();
    for (const ch of channels) {
      if (ch.joined && ch.peerSessionId && this.identity.isFresh(ch.peerSessionId)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Start the peer subsystem: register identity + begin heartbeat + start channel poll.
   */
  start(): void {
    this.identity.register();
    this.identity.startHeartbeat();
    this.channel.startChannelPoll();
  }

  /**
   * Stop the peer subsystem: stop heartbeat + stop channel poll + unregister identity.
   */
  stop(): void {
    this.identity.stopHeartbeat();
    this.channel.stopChannelPoll();
    this.identity.unregister();
  }
}

/**
 * NoopPeerModule - a no-op PeerModule for child processes (teammates).
 *
 * Only the lead process participates in peer discovery; teammates are child
 * processes within the same instance and route all cross-instance work through
 * the lead via IPC. This satisfies the AgentContext.peer contract without
 * touching the shared discovery files.
 */
export class NoopPeerModule implements PeerModule {
  listIdentities(): IdentityEntry[] { return []; }
  isFresh(_sessionId: string): boolean { return false; }
  listChannels(): ChannelFile[] { return []; }
  joinChannel(_channelId: string): { joined: boolean; firstQuery?: string } { return { joined: false }; }
  sendMail(_channelId: string, _sessionId: string, _topic: string, _content: string): boolean { return false; }
  hasActiveChannel(): boolean { return false; }
  start(): void { /* no-op */ }
  stop(): void { /* no-op */ }
}