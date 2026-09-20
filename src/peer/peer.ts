/**
 * peer.ts - PeerManager facade implementing PeerModule
 *
 * Combines IdentityManager and ChannelManager into a single module
 * that is wired into ParentContext as ctx.peer.
 */

import type { PeerModule, IdentityEntry, ChannelFile } from '../types.js';
import { IdentityManager } from './identity.js';
import { ChannelManager } from './channel.js';
import {
  findBySid,
  liveSocketOf,
  sendWireMail,
} from './wire-registry.js';
import { stopWireClient } from './wire-client.js';

export class PeerManager implements PeerModule {
  private identity: IdentityManager;
  private channel: ChannelManager;

  constructor(sessionId: string, workDir: string, mailboxPath: string, role?: string, daemon?: boolean) {
    this.identity = new IdentityManager(sessionId, workDir, mailboxPath, role, daemon);
    this.channel = new ChannelManager(sessionId, this.identity, mailboxPath);
  }

  listIdentities(): IdentityEntry[] {
    return this.identity.listIdentities();
  }

  /**
   * Route-aware freshness (docs/remote-peer-protocol.md §4): LOCAL branch =
   * identity.json + heartbeat window (unchanged); REMOTE branch = the wire
   * registry's socket state (open = alive — missed-pong terminate in the
   * dialer/acceptor keeps "OPEN" honest). Same signature, so mail_to's
   * fail-fast validation carries over unmodified. Local is authoritative:
   * a same-store sid is checked the way it always was; the remote registry
   * is consulted only when the sid is not a registered local identity.
   */
  isFresh(sessionId: string): boolean {
    const local = this.identity.isFresh(sessionId);
    if (local) return true;
    const remotePair = findBySid(sessionId);
    if (!remotePair) return false;
    return liveSocketOf(remotePair) !== null;
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
   * Route-aware sendPeerMail (docs/remote-peer-protocol.md §4, local-first):
   * the LOCAL branch is today's path, untouched — discovery mailbox append
   * gated on heartbeat freshness. Only when the sid is NOT local does the
   * REMOTE branch run: resolve the pair in the wire registry, check OPEN
   * before every send (queued-but-not-OPEN → false), and send the mail
   * frame — the receiver's WS handler appends to its OWN mailbox via
   * MailBox.appendMail. At-most-once: a send failure is LOSS; the sending
   * agent re-issues (no offline queue, no ack layer — plan §5).
   */
  sendPeerMail(sessionId: string, title: string, content: string): boolean {
    const local = this.channel.sendPeerMail(sessionId, title, content);
    if (local) return true;
    return sendWireMail(sessionId, title, content);
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
   * True if this instance owns a channel whose peer is the given session-id.
   * Delegates to ChannelManager. Used by mail_to to warn when a peer send
   * succeeded but no channel backs the pair (the reply path is channel-driven).
   */
  hasChannelWith(sessionId: string): boolean {
    return this.channel.hasChannelWith(sessionId);
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
   * Stop the peer subsystem: stop heartbeat + stop channel poll + unregister
   * identity + tear down the remote wire plane (plan §5): every DIALED
   * socket closed AND unref'd so process-exit semantics are unchanged (the
   * ref'd wire would otherwise keep a headless instance alive), all redial
   * timers cancelled. Accepted sockets are the acceptor's — ServeHub.stop
   * closes them; if the serve stack is already down there are none.
   */
  stop(): void {
    stopWireClient();
    this.identity.stopHeartbeat();
    this.channel.stopChannelPoll();
    this.identity.unregister();
  }

  getSelfSessionId(): string {
    return this.identity.getSelfSessionId();
  }

  /** {@inheritDoc PeerModule.recordBrief} */
  recordBrief(message: string, confidence: number): void {
    this.identity.recordBrief(message, confidence);
  }

  /** {@inheritDoc PeerModule.getBriefs} */
  getBriefs(sessionId: string): Array<{ time: number; content: string; confidence: number }> {
    return this.identity.getBriefs(sessionId);
  }

  /** {@inheritDoc PeerModule.getLatestHeartbeat} */
  getLatestHeartbeat(sessionId: string): number | null {
    return this.identity.getLatestHeartbeat(sessionId);
  }

  /** {@inheritDoc PeerModule.getPid} */
  getPid(sessionId: string): number | null {
    return this.identity.getPid(sessionId);
  }

  /**
   * Delegate the channel-join callback to the ChannelManager. Wired once at
   * startup by agent-repl.ts so a channel joining mid-PROMPT aborts the
   * blocked PROMPT wait and redirects the loop to AWAIT.
   */
  setOnChannelJoin(callback: (channelId: string) => void): void {
    this.channel.setOnChannelJoin(callback);
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
  sendPeerMail(_sessionId: string, _title: string, _content: string): boolean { return false; }
  hasActiveChannel(): boolean { return false; }
  hasChannelWith(_sessionId: string): boolean { return false; }
  start(): void { /* no-op */ }
  stop(): void { /* no-op */ }
  getSelfSessionId(): string { return ''; }
  recordBrief(_message: string, _confidence: number): void { /* no-op: children don't maintain a heartbeat */ }
  getBriefs(_sessionId: string): Array<{ time: number; content: string; confidence: number }> { return []; }
  getLatestHeartbeat(_sessionId: string): number | null { return null; }
  getPid(_sessionId: string): number | null { return null; }
  setOnChannelJoin(_callback: (channelId: string) => void): void { /* no-op: children don't participate in peer discovery */ }
}