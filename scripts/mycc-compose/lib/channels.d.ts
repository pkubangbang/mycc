/**
 * Type declarations for scripts/mycc-compose/lib/channels.js.
 *
 * The implementation is plain ESM JavaScript (so a plain `node` process can
 * load it — see the .js header). TypeScript resolves the `./channels.js`
 * import specifier against this file, so the vitest channel-materializer tests
 * at src/tests/mycc-compose-channels.test.ts are fully type-checked even though
 * `allowJs` stays false. Same pattern as the sibling spec.d.ts.
 */

import type { ChannelFile } from '../../../src/types.js';

/**
 * The narrow STRUCTURAL subset of a spec that the materializer actually reads.
 * Declared separately from NormalizedSpec because the module's real input
 * contract is what matters here: it only ever touches group/peers[].name/
 * peers[].sessionId and channels[].from/.to/.label/.prompt. A NormalizedSpec
 * (with workdir/args/renew/parsedArgs) is assignable to this.
 */
export interface ChannelSpecInput {
  group: string;
  peers: Array<{ name: string; sessionId?: string | null }>;
  channels: Array<{ from: string; to: string; label: string; prompt: string }>;
}

/** Substitute {{from}} {{to}} {{peer}} {{label}} in a prompt template. */
export declare function fillTemplate(tpl: string, vars: Record<string, unknown>): string;

/** Append the reciprocal reply contract unless the prompt already has mail_to(. */
export declare function withReplyContract(prompt: string, peerSid: string, label: string): string;

/** Fields the peer may already have written back onto its own channel file. */
export interface ExistingChannelState {
  joined?: unknown;
  firstQuerySent?: unknown;
  createdAt?: unknown;
}

/** Arguments for {@link buildChannelFile}. */
export interface BuildChannelFileArgs {
  channelId: string;
  ownerSid: string;
  peerSid: string;
  title: string;
  prompt: string;
  /** The file already on disk, if any — preserves joined/firstQuerySent/createdAt. */
  existing?: ExistingChannelState | null;
}

/**
 * Build the ChannelFile document for ONE side of a pair. `peerSessionId` is the
 * OTHER side's session id (the pair is asymmetric by design).
 */
export declare function buildChannelFile(args: BuildChannelFileArgs): ChannelFile;

/** Read an existing channel file; null when absent / malformed / non-object. */
export declare function readChannelFile(file: string): ChannelFile | null;

/** Atomic write (tmp + rename) with a read-back verify of channelId/ownerSessionId/peerSessionId. */
export declare function writeChannelFileAtomic(file: string, data: Partial<ChannelFile> & Pick<ChannelFile, 'channelId' | 'ownerSessionId' | 'peerSessionId'>): void;

/** Per-channel materialization result. */
export interface MaterializeResult {
  label: string;
  ok: boolean;
  reason?: string;
  title?: string;
  files?: string[];
}

/** Write both files of every channel pair. */
export declare function materializeChannels(spec: ChannelSpecInput): MaterializeResult[];

/**
 * Remove exactly the channel files named in `files` (a FILENAME LIST, as
 * produced by {@link channelFileNames}). Returns the number removed.
 */
export declare function removeChannels(files: string[]): number;

/**
 * The exact set of channel filenames a spec owns: `<sid>-<label>.json` per
 * channel endpoint. Peers without a session id contribute nothing.
 */
export declare function channelFileNames(spec: ChannelSpecInput): string[];

/** Per-channel status row. */
export interface ChannelStatusRow {
  label: string;
  bothFilesPresent: boolean;
}

/** Report whether both files of each channel pair exist. */
export declare function channelStatus(spec: ChannelSpecInput): ChannelStatusRow[];
