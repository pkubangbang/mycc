/**
 * channel.ts - Channel management + cross-instance mail delivery
 *
 * Channel files live at ~/.mycc-store/discovery/channels/[session-id]-[channel-id].json.
 * A channel is a pair of files with the same channelId suffix, one per participant.
 * Each file records which session owns it, who the peer is, and an optional
 * firstQuery that starts the conversation locally.
 *
 * Channel file creation is the responsibility of a mediator (script, mycc instance,
 * or human operator) and is OUT OF SCOPE of this implementation. joinChannel
 * throws if the channel file does not exist.
 *
 * sendMail appends a JSONL line directly to the remote's lead mailbox
 * (absolute path from identity.json), gated by freshness check.
 *
 * firstQuery is delivered to the LOCAL mailbox (not remote), wrapped with a
 * channel-based instruction so the LLM knows to respond via the channel.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { ChannelFile } from '../types.js';
import { getChannelsDir, getChannelFile } from '../config.js';
import { IdentityManager } from './identity.js';

/**
 * Atomic file write: write to temp file then rename.
 */
function atomicWrite(filePath: string, data: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmp = `${filePath}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, data, 'utf-8');
  fs.renameSync(tmp, filePath);
}

/**
 * Read and parse a channel file. Returns null if missing or malformed.
 * A malformed file (present but unparseable — e.g. a half-written JSON from
 * a concurrent/crashed writer) is logged via console.warn so corruption is
 * observable instead of silently degrading channel behavior.
 */
function readChannelFile(filePath: string): ChannelFile | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(content) as ChannelFile;
  } catch (err) {
    console.warn(`[channel] malformed channel file, ignoring: ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * Write a channel file atomically.
 */
function writeChannelFile(filePath: string, data: ChannelFile): void {
  atomicWrite(filePath, JSON.stringify(data, null, 2));
}

/**
 * Generate a unique mail ID (matches MailBox.generateId pattern from mail.ts).
 */
function generateMailId(): string {
  return Math.random().toString(36).substring(2, 10);
}

/**
 * Append a single JSONL mail line to a file path.
 * Matches the MailBox.appendMail format from src/context/shared/mail.ts.
 */
function appendMailToPath(mailboxPath: string, from: string, title: string, content: string): void {
  const dir = path.dirname(mailboxPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const mail = {
    id: generateMailId(),
    from,
    title,
    content,
    timestamp: new Date().toISOString(),
  };
  const line = `${JSON.stringify(mail)}\n`;
  fs.appendFileSync(mailboxPath, line, 'utf-8');
}

/**
 * ChannelManager handles channel listing, joining, and cross-instance mail.
 *
 * Channel discovery is automatic, driven by a 5-second poll on the channels
 * directory. Every 5s, listChannels() is called and any unjoined channel is
 * auto-joined. A short deterministic poll is more reliable than fs.watch for
 * multi-instance coordination on a shared directory.
 */
export class ChannelManager {
  private sessionId: string;
  private identityManager: IdentityManager;
  private mailboxPath: string;
  private pollHandle: ReturnType<typeof setInterval> | null = null;
  // Callback fired after a channel is joined (joinChannel sets joined=true and
  // injects the firstQuery). Set externally via setOnChannelJoin() so the peer
  // module stays a pure file+mail layer with no loop/autoState imports. The
  // agent loop wires a callback that aborts a blocked PROMPT wait so a channel
  // joining mid-PROMPT redirects the loop to AWAIT. Single listener (overwrite).
  private onChannelJoin: ((channelId: string) => void) | null = null;

  constructor(sessionId: string, identityManager: IdentityManager, mailboxPath: string) {
    this.sessionId = sessionId;
    this.identityManager = identityManager;
    this.mailboxPath = mailboxPath;
  }

  /**
   * Register the channel-join callback (see field comment). Overwrites any
   * previously registered callback. The agent loop (agent-repl.ts) wires this
   * once at startup to abort a blocked PROMPT wait on a mid-flight join.
   */
  setOnChannelJoin(callback: (channelId: string) => void): void {
    this.onChannelJoin = callback;
  }

  /**
   * Start the channel poll: fire once immediately, then every 5s.
   * Guard against double-start.
   */
  startChannelPoll(): void {
    if (this.pollHandle !== null) return;
    this.sweepChannels();
    this.pollHandle = setInterval(() => this.sweepChannels(), 5_000);
    this.pollHandle.unref?.();
  }

  /**
   * Stop the channel poll. Guard against double-stop.
   */
  stopChannelPoll(): void {
    if (this.pollHandle !== null) {
      clearInterval(this.pollHandle);
      this.pollHandle = null;
    }
  }

  /**
   * Sweep: list own channels, auto-join any that are not yet joined.
   */
  private sweepChannels(): void {
    const channels = this.listChannels();
    for (const channel of channels) {
      if (!channel.joined) {
        try {
          this.joinChannel(channel.channelId);
        } catch (err) {
          // joinChannel throws if the channel file went missing or is malformed
          // between listChannels() and joinChannel() — log it so a silently
          // failing channel is observable instead of swallowed every 5s.
          console.warn(`[channel] sweep auto-join failed for ${channel.channelId}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  }

  /**
   * List all channels owned by this instance, with peer info populated.
   *
   * Performs a single readdir on the channels directory. For each file starting
   * with own sessionId, also looks for the sibling file (same channelId suffix,
   * different session prefix) to populate peerSessionId.
   */
  listChannels(): ChannelFile[] {
    const channelsDir = getChannelsDir();
    if (!fs.existsSync(channelsDir)) return [];

    const ownPrefix = `${this.sessionId}-`;
    const allFiles = fs.readdirSync(channelsDir);

    // Collect own channel files
    const ownFiles = allFiles.filter(f => f.startsWith(ownPrefix) && f.endsWith('.json'));

    const channels: ChannelFile[] = [];
    for (const file of ownFiles) {
      const filePath = path.join(channelsDir, file);
      const channel = readChannelFile(filePath);
      if (!channel) continue;

      // Populate peer info: find sibling file with same channelId suffix
      if (channel.peerSessionId === null) {
        // Extract channelId from filename: [session-id]-[channel-id].json
        const suffix = file.slice(ownPrefix.length); // removes "sessionId-" prefix
        const channelId = suffix.replace(/\.json$/, '');

        // Scan allFiles (already read) for a sibling with same channelId
        const siblingSuffix = `-${channelId}.json`;
        for (const candidate of allFiles) {
          if (candidate === file) continue;
          if (!candidate.endsWith(siblingSuffix)) continue;
          // Extract peer session-id
          const peerSid = candidate.slice(0, candidate.length - siblingSuffix.length);
          if (peerSid && peerSid !== this.sessionId) {
            channel.peerSessionId = peerSid;
            // Persist discovered peer
            writeChannelFile(filePath, channel);
            break;
          }
        }
      }

      channels.push(channel);
    }
    return channels;
  }

  /**
   * Join a channel. The channel file must already exist (created by a mediator).
   * Throws if the channel file does not exist.
   *
   * Two responsibilities only:
   *  1. Set joined=true (so the poll sweep skips this channel on next cycle).
   *  2. Inject firstQuery to the LOCAL mailbox if not yet sent (conversation starter).
   *
   * Peer discovery (populating peerSessionId) is listChannels()'s job — it runs
   * every 5s via the poll and before any joinChannel call. joinChannel trusts
   * that peerSessionId is already populated and does NOT read the peer's file.
   * The peer's joined status is irrelevant: sendMail is gated by isFresh()
   * only, and the remote COLLECT picks up any mail in unread-lead.jsonl
   * regardless of channel join state.
   */
  joinChannel(channelId: string): { joined: boolean; firstQuery?: string } {
    const ownChannelFile = getChannelFile(this.sessionId, channelId);
    const ownChannel = readChannelFile(ownChannelFile);

    // Channel file must exist — creation is mediator's responsibility
    if (!ownChannel) {
      throw new Error(`Channel file not found: ${ownChannelFile}. Channel must be created by a mediator before joining.`);
    }

    // 1. Set joined flag
    ownChannel.joined = true;
    writeChannelFile(ownChannelFile, ownChannel);

    // 2. Deliver firstQuery to LOCAL mailbox (not remote), combining title + firstQuery
    if (ownChannel.firstQuery && !ownChannel.firstQuerySent) {
      const content = `[Channel: ${channelId}]\n\n${ownChannel.title ? `Channel theme: ${ownChannel.title}\n\n` : ''}${ownChannel.firstQuery}`;
      appendMailToPath(this.mailboxPath, 'system', `[${channelId}] channel-init`, content);
      ownChannel.firstQuerySent = true;
      writeChannelFile(ownChannelFile, ownChannel);
    }

    // 3. Surface the join event so the agent loop can abort a blocked PROMPT
    //    wait (mid-flight join). Channels that joined before PROMPT is reached
    //    are caught by the Layer A hasActiveChannel() gate; this callback covers
    //    the mid-PROMPT case. Guarded so a throw in the callback can't corrupt
    //    channel state (joined/firstQuery already persisted above).
    try {
      this.onChannelJoin?.(channelId);
    } catch {
      // Callback failure must not break the join — channel state is already
      // committed. Swallow so the poll sweep and future joins stay healthy.
    }

    return {
      joined: true,
      firstQuery: ownChannel.firstQuery ?? undefined,
    };
  }

  /**
   * Send mail to a remote session via its mailbox.
   * Gated by freshness check. Returns false if peer is stale or not found.
   *
   * The `topic` parameter is an ad-hoc subject for this specific message
   * (distinct from the channel's static `title` theme).
   */
  sendMail(channelId: string, sessionId: string, topic: string, content: string): boolean {
    // Freshness gate
    if (!this.identityManager.isFresh(sessionId)) {
      return false;
    }

    // Look up remote mailbox path
    const remoteMailbox = this.identityManager.getRemoteMailbox(sessionId);
    if (!remoteMailbox) {
      return false;
    }

    // Append mail to remote mailbox with channel-prefixed title
    const from = this.identityManager.getIdentityString();
    const fullTitle = `[${channelId}] ${topic}`;
    appendMailToPath(remoteMailbox, from, fullTitle, content);

    return true;
  }

  /**
   * Channel-independent peer mail: append a JSONL line to the remote mailbox
   * with the local identity string (sessionId/lead) as `from`. Freshness-gated.
   *
   * Unlike sendMail(), this does not require a channelId — it is the routing
   * path used by mail_to when the target name matches the session-id/lead
   * identity pattern. The title is used verbatim (no channel prefix).
   */
  sendPeerMail(sessionId: string, title: string, content: string): boolean {
    if (!this.identityManager.isFresh(sessionId)) {
      return false;
    }
    const remoteMailbox = this.identityManager.getRemoteMailbox(sessionId);
    if (!remoteMailbox) {
      return false;
    }
    const from = this.identityManager.getIdentityString();
    appendMailToPath(remoteMailbox, from, title, content);
    return true;
  }
}