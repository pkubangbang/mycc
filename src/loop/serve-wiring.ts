/**
 * serve-wiring.ts - Wire the webui/serve integration into the agent loop
 *
 * Extracted from agent-repl.ts. Groups the three serve-related callbacks
 * registered at startup: autoState.onAutoChange (mirror auto state to the
 * webui), the channel-join callback (engage auto + abort a blocked PROMPT
 * when a peer channel joins mid-flight), and the webui "enter auto" provider
 * (the lightning-bolt button). Registered here to keep AutoState and
 * ChannelManager free of any serve-hub import (avoids the module-load cycle).
 */

import chalk from 'chalk';
import { agentIO } from './agent-io.js';
import { autoState } from './auto-state.js';
import { getServeHub } from '../serve/serve-registry.js';
import type { AgentContext } from '../types.js';

/**
 * Wire the serve/webui integration callbacks.
 *
 * 1. `autoState.onAutoChange` — mirror auto-state flips to the webui
 *    (broadcastAuto is a no-op when serve isn't running).
 * 2. `ctx.peer.setOnChannelJoin` — when a peer channel joins mid-PROMPT,
 *    grant read-only access to the peer's workDir, engage auto mode, and
 *    abort the blocked PROMPT wait so the loop redirects to AWAIT. Guarded by
 *    `agentIO.isPromptBlocked()` so it never flips auto mid-pass (COLLECT/
 *    LLM/HOOK/TOOL); a join while not blocked is caught by the Layer A
 *    hasActiveChannel() gate on the next PROMPT entry.
 * 3. `getServeHub().setEnterAutoProvider` — the webui "enter auto" button
 *    flips autoState (same as /auto); wakes a blocked PROMPT so pending mail
 *    is processed immediately.
 */
export function wireServeCallbacks(ctx: AgentContext): void {
  // ── onAutoChange: mirror auto-state flips to the webui ──
  // Previously agentIO.setAuto() called getServeHub().broadcastAuto directly;
  // now the singleton owns the flag and fires this callback on a real flip,
  // so the webui chat input box stays enabled for steering and the 停止 button
  // stays visible+spinning while the lead is in AWAIT. Best-effort: broadcastAuto
  // is a no-op when serve isn't running.
  autoState.onAutoChange = (value: boolean) => {
    try {
      getServeHub().broadcastAuto(value);
    } catch {
      // serve-hub import cycle or serve not running — best-effort, no throw
    }
  };

  // ── channel-join: engage auto + abort a blocked PROMPT ──
  // When a peer channel joins (the 5s poll sweep calls joinChannel, or
  // /channel does directly), ChannelManager fires this callback. Covers the
  // mid-PROMPT case: a channel joining AFTER the Layer A gate was checked but
  // WHILE ask()/waitForInput() is blocked. The callback:
  //   1. Engages auto mode (setAuto(true)) — the channel is a live automation
  //      feed; the loop should run autonomously now. Subsequent PROMPT entries
  //      take the Layer A hasActiveChannel() path.
  //   2. Aborts a blocked terminal PROMPT wait (agentIO.abortAsk) — rejects the
  //      blocked ask() Promise with a PromptAbortError, which propagates as a
  //      thrown exception through getInput() to the try/catch in prompt.ts
  //      (Layer B), returning AgentState.AWAIT. No-op if no ask() is blocked.
  //   3. Aborts a blocked serve PROMPT wait (getServeHub().rejectInput) — same
  //      rejection path for the webui's waitForInput(). No-op if not blocked.
  // GUARD: all three actions fire ONLY when a PROMPT wait is actually blocked
  //   (agentIO.isPromptBlocked()). Without this guard, a channel joining while
  //   the loop is in COLLECT/LLM/HOOK/TOOL would flip auto mode mid-pass — a
  //   subtle coupling. When not blocked, the join is caught by the Layer A
  //   hasActiveChannel() gate on the next PROMPT entry. abortAsk/rejectInput
  //   are already self-guarded no-ops, but setAuto(true) is not, so the
  //   isPromptBlocked() check is the real gate. Best-effort: each call swallows
  //   its own errors so a failure in one path doesn't block the other.
  ctx.peer.setOnChannelJoin((channelId: string) => {
    // Grant read-only access to the just-joined channel's peer workDir. The
    // peer's workDir is read from identity.json (keyed by peerSessionId). This
    // lets the LLM read the peer's project files (read_file/grep) without
    // per-access user prompts, but never write to them (folder_recursive_
    // readonly). Idempotent — addExternalAutoGrant overwrites the Map entry.
    // Teammates inherit via the IPC external_path_access handler.
    const ch = ctx.peer.listChannels().find(c => c.channelId === channelId);
    if (ch?.joined && ch.peerSessionId) {
      const peer = ctx.peer.listIdentities().find(e => e.sessionId === ch.peerSessionId);
      if (peer?.workDir) {
        ctx.core.addExternalAutoGrant(peer.workDir, false); // false = read-only
      }
    }

    if (!agentIO.isPromptBlocked()) {
      // Not blocked in PROMPT — the Layer A gate will catch this channel on
      // the next PROMPT entry. Do not flip auto mid-pass.
      return;
    }
    autoState.setAuto(true);
    try { agentIO.abortAsk(); } catch { /* best-effort */ }
    try { getServeHub().rejectInput(); } catch { /* best-effort */ }
  });

  // ── enter-auto provider: the webui "enter auto" lightning-bolt button ──
  // Sends an 'auto' WS message; ServeHub calls this provider to flip autoState
  // (which both Core and AgentIO delegate to) — exactly the /auto slash path.
  // Returns false when already in auto mode so the hub can surface
  // "已经是自动模式了".
  getServeHub().setEnterAutoProvider(() => {
    if (autoState.getAuto()) return false;
    autoState.resetStreak();
    autoState.setAuto(true);
    console.log(chalk.cyan('auto mode is on (webui). Mails will be auto-replied. Press esc to exit.'));

    // Wake a blocked PROMPT wait so the loop immediately redirects to AWAIT
    // (where mail/event polling happens). Same pattern as the channel-join
    // callback above. Without this, when the lead is blocked in PROMPT
    // (e.g. mail was written to unread-lead.jsonl while idle), the loop
    // stays stuck until a user message arrives — so auto mode appears
    // unresponsive to pending mail. Both calls are self-guarded no-ops
    // when not blocked.
    try { agentIO.abortAsk(); } catch { /* best-effort */ }
    try { getServeHub().rejectInput(); } catch { /* best-effort */ }

    return true;
  });
}