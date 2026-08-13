# mycc Discovery Protocol (myccdp) — Complete Implementation Plan

> **Status**: Implemented. The 3 files (`src/peer/identity.ts`, `src/peer/channel.ts`, `src/peer/peer.ts`) and edits to `src/types.ts`, `src/config.ts`, `src/context/parent-context.ts`, `src/loop/agent-repl.ts` all shipped as described. Significant additions beyond the original plan:
> - **Heartbeat schema changed**: `{ timestamps: [...] }` → `{ heartbeats: [...], briefs: [...] }`. Briefs record the agent's recent status updates (via `recordBrief()`).
> - **Absolute freshness window**: `FRESHNESS_WINDOW_MS = 90_000` added to `isFresh()` — a remote whose latest heartbeat is older than 90s is stale regardless of the relative check.
> - **`PeerModule` interface extended**: `sendPeerMail()` (channel-independent peer mail), `hasActiveChannel()` (autofly gate), `getSelfSessionId()`, `recordBrief()`, `getBriefs()`, `getLatestHeartbeat()`, `setOnChannelJoin()`.
> - **`NoopPeerModule`** added for child processes (teammates) that don't participate in peer discovery.
> - **Channel join callback**: `setOnChannelJoin()` lets the agent loop abort a blocked PROMPT wait when a channel joins mid-flight.
> - **`register()` retry loop**: 5-attempt read-merge-write loop to handle concurrent registration from multiple instances.

## Overview

Two subsystems: **identity** (registration + heartbeat freshness) and **channel** (topic-based messaging). Implementation creates 3 new files in `src/peer/`, plus small edits to 4 existing files. The design follows the existing module pattern: interface in `types.ts` → manager class → wired into `ParentContext` → started/stopped in `agent-repl.ts`.

## Design Decisions

### D1. Freshness rule

**Core intent**: "the peer should be no later than 90s, even during system hibernation."

**Comparison**: `fresh ⟺ (remoteLatest > localOldest) AND (now - remoteLatest < FRESHNESS_WINDOW_MS)`

- `localOldest = local.heartbeats[0] || -Infinity` — if local has 0 beats (just started, no baseline), everything passes the relative check.
- `remoteLatest = remote.heartbeats[remote.heartbeats.length - 1] || (Date.now() - 30000)` — if remote has 0 beats (file missing/empty, but registered), assume it beat 30s ago (benefit of the doubt for a just-started peer that hasn't written its first heartbeat yet).
- **Absolute window** (`FRESHNESS_WINDOW_MS = 90_000`): even if the relative check passes, a remote whose latest heartbeat is older than 90s is NOT fresh. This prevents a dead/crashed instance from appearing fresh forever.
- Edge case: remote session-id not in `identity.json` → `false`.
- `start()` fires the first beat immediately, so a freshly started instance has at least 1 beat right away.

### D2. heartbeat directory spelling

Spec wrote "heatbeat" — treated as typo, using `heartbeat/`.

### D3. Channel file location

`~/.mycc-store/discovery/channels/` — a subfolder parallel to `identity.json` and `heartbeat/`.

### D4. sendMail `from` identity string

Uses the identity pattern `sessionId/lead` (e.g. `3b1b83d.../lead`) as the `from` field in the remote mailbox. The slash denotes remote nature. `agentName` is always "lead" — only leads participate in discovery, so it is not stored in identity.json.

### D5. Mailbox path stored in identity.json is absolute

The local mailbox is relative (`./mycc/sessions/{id}/unread-lead.jsonl`). identity.json stores `path.resolve()` of it so remote senders can append cross-instance directly.

### D6. Channel title vs mail topic — distinct concepts

The channel `title` is the **theme** of the channel — set once by the mediator, used as a prompt/instruction for the local agent. The mail `topic` (parameter of `sendMail`) is an **ad-hoc subject** that varies per message.

When joining a channel, if `firstQuery` exists and hasn't been sent yet, the local mycc injects a mail to **its own** `unread-lead.jsonl` combining `title + firstQuery` as the content. This acts as a conversation starter that the local agent picks up on join. The `title` provides context (what the channel is about), and the `firstQuery` is the opening question. The mail title field is `[channelId] channel-init`.

### D7. Channel creation is out of scope

`joinChannel` throws if the channel file does not exist. Channel file creation is the responsibility of a mediator (script, another mycc instance, or human operator) and is out of scope for this draft.

### D8. Auto-discover and join channels via 5s poll

Channel listing and joining is automatic, driven by a 5-second poll on the channels directory. Every 5s, `listChannels()` is called and any unjoined channel is auto-joined immediately. This means:

- A mediator creates the channel file pair (or one side), and the next poll cycle (within 5s) picks it up.
- No manual `joinChannel` call is needed — the poll loop handles it.
- `joinChannel` remains available as a programmatic API for explicit join on demand.
- On `start()`, the first poll fires immediately so pre-existing channels are joined without waiting 5s.
- 5s is chosen over fs.watch because fs.watch on a shared directory (multiple mycc instances writing to the same `~/.mycc-store/discovery/channels/`) can produce cross-platform inconsistencies (event coalescing, missing events on network drives, platform-specific behavior). A short deterministic poll is more reliable for multi-instance coordination.

## Data Structures

### `~/.mycc-store/discovery/identity.json`

A JSON object keyed by session-id. No `agentName` — only leads participate.

```json
{
  "3b1b83d-aaaa-bbbb-cccc-dddddddddddd": {
    "sessionId": "3b1b83d-aaaa-bbbb-cccc-dddddddddddd",
    "workDir": "/abs/path/to/project",
    "mailbox": "/abs/path/to/project/.mycc/sessions/3b1b83d-aaaa-bbbb-cccc-dddddddddddd/unread-lead.jsonl",
    "startedAt": 1722890000000
  }
}
```

### `~/.mycc-store/discovery/heartbeat/[session-id].json`

```json
{ "heartbeats": [t1, t2, t3], "briefs": [{ "time": 1722890000000, "content": "Working on X", "confidence": 7 }] }
```

Rolling array, max 3 heartbeats. Each `t` is `Date.now()` (ms epoch). Trim to last 3 on each beat.
The `briefs` array (max 3) stores recent agent status updates recorded via `recordBrief()`, each truncated to ~200 tokens. Backward-compat: the reader accepts both the legacy `{ timestamps: [...] }` schema and the current `{ heartbeats: [...], briefs: [...] }` schema.

### `~/.mycc-store/discovery/channels/[session-id]-[channel-id].json`

```json
{
  "channelId": "abc123",
  "ownerSessionId": "3b1b83d-aaaa-bbbb-cccc-dddddddddddd",
  "peerSessionId": "1f2e3cc-eeee-ffff-0000-111111111111",
  "title": "sync-status",
  "firstQuery": "Hello, are you there?",
  "joined": true,
  "firstQuerySent": false,
  "createdAt": 1722890000000
}
```

- `peerSessionId` may be `null` if a mediator created only one side.
- A channel is a **pair** of files with the same `channelId` suffix: `[mycc1]-[channel-id].json` + `[mycc2]-[channel-id].json`.
- `firstQuerySent` tracks whether the `firstQuery` has been delivered to avoid re-sending on re-join.
- `title` is the channel's theme/prompt (set by mediator, static).
- `firstQuery` is an optional opening query. When joining, `title + firstQuery` are combined and injected as a single local mail.

---

## Files to Create

### 1. `src/peer/identity.ts`

```ts
/**
 * identity.ts - Identity registration + heartbeat freshness
 *
 * Each mycc instance registers itself in a centralized identity.json file at
 * ~/.mycc-store/discovery/identity.json and maintains a rolling heartbeat at
 * ~/.mycc-store/discovery/heartbeat/[session-id].json.
 *
 * Freshness rule: fresh ⟺ remoteLatest > localOldest
 * - localOldest = local.timestamps[0] || -Infinity
 * - remoteLatest = remote.timestamps[last] || (Date.now() - 30000)
 */

import * as fs from 'fs';
import * as path from 'path';
import type { IdentityEntry } from '../types.js';
import {
  getIdentityFile,
  getHeartbeatDir,
  getHeartbeatFile,
  getDiscoveryDir,
} from '../config.js';

const HEARTBEAT_INTERVAL_MS = 30_000;
const MAX_HEARTBEATS = 3;

/**
 * Atomic file write: write to temp file then rename.
 * Matches the WAL-safe pattern used elsewhere in the codebase.
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
 * Read identity.json and parse into a session-keyed map.
 * Returns {} if file does not exist or is malformed.
 */
function readIdentityMap(): Record<string, IdentityEntry> {
  const identityFile = getIdentityFile();
  if (!fs.existsSync(identityFile)) return {};
  try {
    const content = fs.readFileSync(identityFile, 'utf-8');
    return JSON.parse(content) as Record<string, IdentityEntry>;
  } catch {
    return {};
  }
}

/**
 * Write the full identity map atomically.
 */
function writeIdentityMap(map: Record<string, IdentityEntry>): void {
  atomicWrite(getIdentityFile(), JSON.stringify(map, null, 2));
}

/**
 * Read a heartbeat file. Returns [] if missing or malformed.
 */
function readHeartbeats(sessionId: string): number[] {
  const hbFile = getHeartbeatFile(sessionId);
  if (!fs.existsSync(hbFile)) return [];
  try {
    const content = fs.readFileSync(hbFile, 'utf-8');
    const parsed = JSON.parse(content) as { timestamps: number[] };
    return Array.isArray(parsed.timestamps) ? parsed.timestamps : [];
  } catch {
    return [];
  }
}

/**
 * Write a heartbeat file atomically.
 */
function writeHeartbeats(sessionId: string, timestamps: number[]): void {
  atomicWrite(getHeartbeatFile(sessionId), JSON.stringify({ timestamps }, null, 2));
}

/**
 * IdentityManager handles registration and heartbeat for the local mycc instance.
 */
export class IdentityManager {
  private sessionId: string;
  private workDir: string;
  private mailboxPath: string;
  private intervalHandle: ReturnType<typeof setInterval> | null = null;

  constructor(sessionId: string, workDir: string, mailboxPath: string) {
    this.sessionId = sessionId;
    this.workDir = workDir;
    this.mailboxPath = mailboxPath;
  }

  /**
   * Register (upsert) this instance into identity.json.
   */
  register(): void {
    const map = readIdentityMap();
    map[this.sessionId] = {
      sessionId: this.sessionId,
      workDir: this.workDir,
      mailbox: this.mailboxPath,
      startedAt: Date.now(),
    };
    writeIdentityMap(map);
  }

  /**
   * Remove this instance from identity.json.
   */
  unregister(): void {
    const map = readIdentityMap();
    if (this.sessionId in map) {
      delete map[this.sessionId];
      writeIdentityMap(map);
    }
  }

  /**
   * List all registered identities.
   */
  listIdentities(): IdentityEntry[] {
    const map = readIdentityMap();
    return Object.values(map);
  }

  /**
   * Start the heartbeat: fire once immediately, then every 30s.
   * Guard against double-start.
   */
  startHeartbeat(): void {
    if (this.intervalHandle !== null) return;
    this.beat();
    this.intervalHandle = setInterval(() => this.beat(), HEARTBEAT_INTERVAL_MS);
    // Don't keep the process alive just for heartbeats
    this.intervalHandle.unref?.();
  }

  /**
   * Stop the heartbeat. Guard against double-stop.
   */
  stopHeartbeat(): void {
    if (this.intervalHandle !== null) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  /**
   * Write a single heartbeat: push Date.now(), trim to last 3, write atomically.
   */
  private beat(): void {
    const timestamps = readHeartbeats(this.sessionId);
    timestamps.push(Date.now());
    const trimmed = timestamps.slice(-MAX_HEARTBEATS);
    writeHeartbeats(this.sessionId, trimmed);
  }

  /**
   * Get the local heartbeat timestamps array.
   */
  getOwnHeartbeat(): number[] {
    return readHeartbeats(this.sessionId);
  }

  /**
   * Check freshness of a remote session.
   *
   * fresh ⟺ remoteLatest > localOldest
   *
   * - localOldest = local.timestamps[0] || -Infinity
   *   (if local has 0 beats, no baseline → everything is fresh)
   * - remoteLatest = remote.timestamps[last] || (Date.now() - 30000)
   *   (if remote has 0 beats but is registered, assume it just started 30s ago)
   */
  isFresh(sessionId: string): boolean {
    // 1. Check identity.json has an entry for sessionId
    const map = readIdentityMap();
    if (!(sessionId in map)) return false;

    // 2. Read remote heartbeat
    const remoteTimestamps = readHeartbeats(sessionId);
    const remoteLatest = remoteTimestamps.length > 0
      ? remoteTimestamps[remoteTimestamps.length - 1]
      : Date.now() - 30_000;

    // 3. Compute localOldest
    const localTimestamps = this.getOwnHeartbeat();
    const localOldest = localTimestamps.length > 0
      ? localTimestamps[0]
      : -Infinity;

    // 4. Compare
    return remoteLatest > localOldest;
  }

  /**
   * Get the identity string for this instance (sessionId/lead).
   */
  getIdentityString(): string {
    return `${this.sessionId}/lead`;
  }

  /**
   * Get the mailbox path for a remote session.
   * Returns null if session not found in identity.json.
   */
  getRemoteMailbox(sessionId: string): string | null {
    const map = readIdentityMap();
    const entry = map[sessionId];
    return entry ? entry.mailbox : null;
  }
}
```

### 2. `src/peer/channel.ts`

```ts
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
import { getChannelsDir, getChannelFile, getSessionDir, getSessionContext } from '../config.js';
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
 */
function readChannelFile(filePath: string): ChannelFile | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(content) as ChannelFile;
  } catch {
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
 * Get the local lead mailbox path (unread-lead.jsonl in the current session dir).
 */
function getLocalMailboxPath(): string {
  return path.join(getSessionDir(getSessionContext()), 'unread-lead.jsonl');
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

  constructor(sessionId: string, identityManager: IdentityManager, mailboxPath: string) {
    this.sessionId = sessionId;
    this.identityManager = identityManager;
    this.mailboxPath = mailboxPath;
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
        } catch {
          // joinChannel throws if channel file missing — skip silently
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
        const siblingPrefix = `-${channelId}.json`;
        for (const candidate of allFiles) {
          if (candidate === file) continue;
          if (!candidate.endsWith(siblingPrefix)) continue;
          // Extract peer session-id
          const peerSid = candidate.slice(0, candidate.length - siblingPrefix.length);
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
      appendMailToPath(getLocalMailboxPath(), 'system', `[${channelId}] channel-init`, content);
      ownChannel.firstQuerySent = true;
      writeChannelFile(ownChannelFile, ownChannel);
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
}
```

### 3. `src/peer/peer.ts`

```ts
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
```

---

## Files to Edit

### 4. `src/types.ts` — Add PeerModule interface + types + AgentContext.peer

**Insertion point 1**: After the `MailModule` interface (around line ~170, after `clearUnread(): void; }`), add:

```ts
// ============================================================================
// Peer Discovery (myccdp)
// ============================================================================

/**
 * Identity entry stored in ~/.mycc-store/discovery/identity.json
 */
export interface IdentityEntry {
  sessionId: string;
  workDir: string;
  mailbox: string;
  startedAt: number;
}

/**
 * Channel file stored at ~/.mycc-store/discovery/channels/[session-id]-[channel-id].json
 */
export interface ChannelFile {
  channelId: string;
  ownerSessionId: string;
  peerSessionId: string | null;
  title: string;
  firstQuery: string | null;
  joined: boolean;
  firstQuerySent: boolean;
  createdAt: number;
}

/**
 * Peer module interface — cross-instance discovery and messaging
 */
export interface PeerModule {
  /** Get all registered identities */
  listIdentities(): IdentityEntry[];
  /** Check freshness of a remote session (heartbeat within 90s window) */
  isFresh(sessionId: string): boolean;
  /** List all channels owned by this instance (with peer info populated) */
  listChannels(): ChannelFile[];
  /** Join a channel (sets joined=true, injects title+firstQuery as local mail).
   *  Does NOT read the peer's file — peer discovery is listChannels()'s job.
   *  Throws if channel file does not exist. */
  joinChannel(channelId: string): { joined: boolean; firstQuery?: string };
  /** Send mail to a remote session via its mailbox (gated by freshness).
   *  `topic` is an ad-hoc subject per message (distinct from the channel's static `title` theme). */
  sendMail(channelId: string, sessionId: string, topic: string, content: string): boolean;
}
```

**Insertion point 2**: In the `AgentContext` interface (around line ~830), add `peer` field:

```ts
export interface AgentContext {
  core: CoreModule;
  todo: TodoModule;
  mail: MailModule;
  skill: SkillModule;
  issue: IssueModule;
  bg: BgModule;
  team: TeamModule;
  wiki: WikiModule;
  peer: PeerModule;   // ← NEW
}
```

### 5. `src/config.ts` — Add discovery dir helpers

**Insertion point**: After the existing `getWikiDomainsFile()` function (around line ~470), before the "Directory Initialization" section. Add:

```ts
// ============================================================================
// Discovery Protocol (myccdp)
// ============================================================================

export function getDiscoveryDir(): string {
  return path.join(os.homedir(), '.mycc-store', 'discovery');
}

export function getIdentityFile(): string {
  return path.join(getDiscoveryDir(), 'identity.json');
}

export function getHeartbeatDir(): string {
  return path.join(getDiscoveryDir(), 'heartbeat');
}

export function getHeartbeatFile(sessionId: string): string {
  return path.join(getHeartbeatDir(), `${sessionId}.json`);
}

export function getChannelsDir(): string {
  return path.join(getDiscoveryDir(), 'channels');
}

export function getChannelFile(sessionId: string, channelId: string): string {
  return path.join(getChannelsDir(), `${sessionId}-${channelId}.json`);
}
```

**In `ensureDirs()`** — add discovery directories after the wiki dirs block (around line ~495, after the `wikiDirs` for-loop):

```ts
  // Discovery protocol directories (in ~/.mycc-store, not project .mycc)
  const discoveryDirs = [getDiscoveryDir(), getHeartbeatDir(), getChannelsDir()];
  for (const dir of discoveryDirs) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
```

### 6. `src/context/parent-context.ts` — Wire PeerManager

**Edit 1**: Add imports at the top (after existing imports, around line ~12):

```ts
import { PeerManager } from '../peer/peer.js';
import type { PeerModule } from '../types.js';
import { getSessionDir } from '../config.js';
import { getSessionId } from '../session/index.js';
import * as path from 'path';
```

**Edit 2**: Add private field (after `private wikiModule: WikiManager;`, around line ~37):

```ts
  private peerModule: PeerManager;
```

**Edit 3**: In the constructor (after `this.wikiModule = new WikiManager(this.coreModule);`, around line ~48), add:

```ts
    // Peer discovery: wire sessionId, workDir, and absolute mailbox path
    const peerSessionId = getSessionId(sessionFilePath);
    const peerWorkDir = process.cwd();
    const peerMailboxPath = path.resolve(getSessionDir(peerSessionId), 'unread-lead.jsonl');
    this.peerModule = new PeerManager(peerSessionId, peerWorkDir, peerMailboxPath);
```

**Edit 4**: Add getter (after `get wiki(): WikiModule { return this.wikiModule; }`, around line ~60):

```ts
  get peer(): PeerModule { return this.peerModule; }
```

**Note**: No IPC handler registration needed in `initializeIpcHandlers()` — peer runs in the lead process only; teammates are child processes within the same instance and don't need direct peer access.

### 7. `src/loop/agent-repl.ts` — Start/stop lifecycle

**Edit 1**: Start peer subsystem. Insert after `ctx.initializeIpcHandlers();` (line ~147), after the `ctx.core.addExternalAutoGrant` calls (around line ~152):

```ts
  // Start peer discovery protocol: register identity + begin heartbeat
  ctx.peer.start();
```

**Edit 2**: Stop peer on SIGINT. In the SIGINT handler (line ~511), add `ctx.peer.stop();` before `process.send!({ type: 'exit' });`:

```ts
  process.on('SIGINT', () => {
    const controller = agentIO.getLlmAbortController();
    if (controller) {
      controller.abort();
      console.log(chalk.yellow('\nInterrupting current operation...'));
      return;
    }
    console.log(chalk.yellow('\nShutting down...'));
    ctx.team.dismissTeam(false);
    ctx.peer.stop();                                    // ← NEW
    process.send!({ type: 'exit' });
  });
```

**Edit 3**: Stop peer on SIGTERM. In the SIGTERM handler (line ~522), add `ctx.peer.stop();` before `process.exit(0)`:

```ts
  process.on('SIGTERM', async () => {
    ctx.team.dismissTeam(false);
    ctx.peer.stop();                                    // ← NEW
    try { await getServeHub().stop(); } catch { /* stop() already best-effort internally */ }
    process.exit(0);
  });
```

**Edit 4**: Stop peer on normal exit. At the end of `main()`, after `await getServeHub().stop();` (line ~540), add:

```ts
  // Normal exit: shut down the serve hub (Vite dev server + HTTP port)
  // so no child processes are orphaned when the Lead process exits.
  await getServeHub().stop();

  // Stop peer discovery: stop heartbeat + unregister identity
  ctx.peer.stop();                                      // ← NEW

  // Signal Coordinator to exit
  process.send({ type: 'exit' });
```

**Edit 5**: Synchronous best-effort cleanup on `process.on('exit')`. Add a new handler (after the SIGTERM handler, around line ~527):

```ts
  // Best-effort synchronous cleanup on unexpected exit.
  // process.on('exit') cannot run async, so we do a synchronous stop.
  // The heartbeat interval is unref'd so it won't block exit.
  process.on('exit', () => {
    try {
      ctx.peer.stop();
    } catch {
      // Best-effort — ignore errors during exit
    }
  });
```

---

## Implementation Order

1. **`src/config.ts`** — Add 6 discovery dir helpers + `ensureDirs()` update. Foundation; all other files import from here.
2. **`src/types.ts`** — Add `IdentityEntry`, `ChannelFile`, `PeerModule` interfaces + `peer` field on `AgentContext`.
3. **`src/peer/identity.ts`** — `IdentityManager` class (register/unregister/heartbeat/isFresh/listIdentities).
4. **`src/peer/channel.ts`** — `ChannelManager` class (listChannels/joinChannel/sendMail).
5. **`src/peer/peer.ts`** — `PeerManager` facade implementing `PeerModule`.
6. **`src/context/parent-context.ts`** — Instantiate `PeerManager` + add `peer` getter.
7. **`src/loop/agent-repl.ts`** — `start()` after context creation, `stop()` on all exit paths.

## Concurrency / Safety Notes

- All discovery-dir file writes use read-modify-write with temp-file + atomic rename (write temp, `fs.renameSync`). Matches the existing WAL-safe pattern.
- `identity.json` is shared mutable state across instances. Writes are full-file rewrites. Low write frequency (register/unregister on startup/exit, heartbeat every 30s per instance) makes contention unlikely.
- Heartbeat `setInterval` handle is stored privately and `unref()`'d so it doesn't keep the process alive. `stopHeartbeat()` clears it with a null guard against double-stop.
- `process.on('exit')` handler calls `stop()` synchronously — `unregister()` uses `fs.readFileSync` + `fs.writeFileSync` (synchronous), so it's safe in the exit handler.
- Cross-instance `sendMail` uses `fs.appendFileSync` to the remote's mailbox — same pattern as `MailBox.appendMail` in `src/context/shared/mail.ts`.
- `listChannels()` performs a single `readdir` and uses the result to populate both own channels and peer info.

## Out of Scope

- **No `receiveMail`** — The existing COLLECT stage (`handleCollect` in `src/loop/states/collect.ts`) calls `ctx.mail.collectMails()` which reads from `unread-lead.jsonl`. Cross-instance mail lands there directly, so no new receive logic is needed.
- **No teammate-side peer module** — Teammates are child processes within the same instance. The lead owns the identity and heartbeat. If a teammate needs cross-instance mail, it would go through the lead via IPC (future extension, not in this spec).
- **No channel file creation** — `joinChannel` throws if the channel file does not exist. Channel creation is the responsibility of a mediator (script, mycc instance, or human operator) and is out of scope for this draft.
- **No UI/CLI tool exposure** — `ctx.peer.*` is accessible programmatically. Exposing it as LLM-callable tools is a separate concern.