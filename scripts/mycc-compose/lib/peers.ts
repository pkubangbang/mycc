/**
 * peers.ts — peer launch / stop / match / repair (§5 steps 1–3, §6.2, §6.4).
 *
 * BARREL MODULE. This file used to hold the whole peer subsystem; it was split
 * into four cohesive peers-* modules and now only RE-EXPORTS them, so every
 * existing `import … from './peers.js'` keeps working unchanged.
 *
 *   peers-types.ts      — Peer / PeerStatusRow, timing constants, sleep,
 *                         peerArgv, peerIdentityArgs, peerMailboxPath
 *   peers-lifecycle.ts  — launchPeer, stopPeer, isMyccProcess,
 *                         waitForHolderRelease, isSessionHeld, resolveMyccBin
 *   peers-state.ts      — sameWorkdir, findMatchingLiveEntry, repairIdentity,
 *                         peerStatus
 *
 * NOTE: this module carries no logic of its own. Add new behaviour to the
 * peers-* module that owns that concern, not here.
 */

export {
  LAUNCH_TIMEOUT_MS,
  LAUNCH_POLL_MS,
  HOLDER_RELEASE_TIMEOUT_MS,
  HOLDER_RELEASE_POLL_MS,
  WAVE_SIZE,
  WAVE_DELAY_MS,
  sleep,
  peerIdentityArgs,
  peerMailboxPath,
  isLauncherFlag,
} from './peers-types.js';
export type { Peer, PeerStatusRow } from './peers-types.js';

export {
  peerArgv,
  launchPeer,
  stopPeer,
  isMyccProcess,
  readProcessCommandLine,
  waitForHolderRelease,
  isSessionHeld,
  resolveMyccBin,
} from './peers-lifecycle.js';
export type { LaunchResult } from './peers-lifecycle.js';

export {
  sameWorkdir,
  findMatchingLiveEntry,
  repairIdentity,
  peerStatus,
} from './peers-state.js';
