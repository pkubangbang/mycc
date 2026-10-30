/**
 * triologue/segment-archive.ts - Title-anchor segment archiving for the Triologue facade
 *
 * Summarizes the segment `[0 … anchorEnd]` — everything up to the PREVIOUS
 * `mycc_title` anchor — into the standard summary triple and splices it in
 * front of the untouched tail. Runs at most once at a time and is skipped
 * when a summary would not shrink the segment.
 *
 * Extracted from triologue.ts (layered refactor, same style as compact.ts /
 * wrap-up.ts): the class owns the "one archive at a time" flag and the
 * gates; the facade keeps the store, the compaction chain, and the install.
 * All facade state arrives as closures (SegmentArchiveDeps), so nothing
 * private is exposed.
 */

import { agentIO } from '../agent-io.js';
import type { Message } from '../../types.js';
import { estimateTokensForMessages } from '../../utils/token.js';
import { runAutoCompact as doRunAutoCompact } from './compact.js';

/** Segments below this token count are not worth an LLM call. */
const MIN_SEGMENT_TOKENS = 2000;

export interface SegmentArchiveDeps {
  /** Live store, hole-filtered copy (getRaw()). */
  getRawMessages: () => Message[];
  /** Live store, provider-visible copy (getFullMessages()). */
  getFullMessages: () => Message[];
  /** The last real user query, or undefined when none. */
  lastUserQuery: () => string | undefined;
  /** TRUE-array single-message read; sparse holes yield undefined. */
  messageAt: (index: number) => Message | undefined;
  /** TRUE-array end of the last complete title batch BEFORE `index`. */
  previousTitleAnchorEnd: (index: number) => number | undefined;
  onCompact: (transcriptPath: string) => void;
  /**
   * Enqueue on the facade's compaction chain — the SAME primitive a full
   * compact() uses, so two store-swapping compactions never interleave.
   */
  enqueueCompaction: (run: () => Promise<void>) => Promise<void>;
  /** Install the summary triple in front of the tail starting at `tailFrom`. */
  installCompacted: (compacted: Message[], tailFrom: number) => boolean;
  /** Journal the segment boundary as a control record. */
  emitControl: (event: 'segment-archive') => void;
}

export class SegmentArchiver {
  /**
   * One archive at a time. A trigger arriving while one is enqueued/running
   * is SKIPPED (not queued): the next title trigger still finds the same
   * previous anchor, so a skip is never permanent. Kept outside the queued
   * run so the flag flips synchronously at trigger time.
   */
  private active = false;

  constructor(private readonly deps: SegmentArchiveDeps) {}

  /**
   * Archive up to the previous title anchor of the mycc_title call at
   * `currentTitleAssistantIndex`. Fire-and-forget safe: failures are logged
   * by the caller (see states/tool.ts).
   */
  async run(
    currentTitleAssistantIndex: number,
    signal?: AbortSignal,
    domains: Array<{ domain_name: string; description?: string }> = [],
  ): Promise<void> {
    if (this.active) {
      agentIO.brief('warn', 'triologue', 'compactSegment skipped: an archive is already queued/running');
      return;
    }
    const anchorEnd = this.deps.previousTitleAnchorEnd(currentTitleAssistantIndex);
    if (anchorEnd === undefined) return;

    this.active = true;
    try {
      await this.deps.enqueueCompaction(() => this.archive(anchorEnd, domains, signal));
    } finally {
      this.active = false;
    }
  }

  /** The queued body: fingerprint → summarize → verify → shrink gate → install. */
  private async archive(
    anchorEnd: number,
    domains: Array<{ domain_name: string; description?: string }>,
    signal?: AbortSignal,
  ): Promise<void> {
    // Staleness fingerprint: identity of the anchor boundary message plus the
    // current length. If the store shrank between trigger and run (a full
    // compact swapped it, or another archive landed), the slice summarized is
    // no longer the live head — abort rather than splice a stale result.
    const fingerprintMsg = this.deps.messageAt(anchorEnd);
    const fingerprintLen = this.deps.getRawMessages().length;
    const segment = this.deps.getRawMessages().slice(0, anchorEnd + 1);
    if (estimateTokensForMessages(segment) < MIN_SEGMENT_TOKENS) return;

    const compacted = await doRunAutoCompact(
      {
        // Sliced adapter: runAutoCompact summarizes ONLY the segment; the tail
        // is preserved verbatim by installCompacted(triple, anchorEnd + 1).
        getRawMessages: () => this.deps.getRawMessages().slice(0, anchorEnd + 1),
        getFullMessages: () => this.deps.getFullMessages(),
        lastUserQuery: () => this.deps.lastUserQuery() ?? '',
        onCompact: (p) => this.deps.onCompact(p),
        domains,
      },
      undefined, // segment summaries are focus-free by design
      signal,
      undefined, // no focus fork on the segment path
    );

    // Re-check after the (slow) summarization. Appends are fine — the agent
    // keeps working during summarization — but a shrink or a changed boundary
    // message invalidates the slice.
    if (
      this.deps.getRawMessages().length < fingerprintLen ||
      this.deps.messageAt(anchorEnd) !== fingerprintMsg
    ) {
      agentIO.brief('warn', 'triologue', 'compactSegment aborted: store changed during summarization');
      return;
    }
    // Shrink-ratio gate: slice-vs-slice with the SAME estimator, never the
    // whole-array tokenCount. Only splice if the triple actually shrinks.
    if (estimateTokensForMessages(compacted) >= estimateTokensForMessages(segment)) {
      agentIO.brief('warn', 'triologue', 'compactSegment skipped: summary did not shrink the segment');
      return;
    }
    this.deps.installCompacted(compacted, anchorEnd + 1);
    // Journal the segment boundary as a control record: durable in the JSONL,
    // skipped by both collation projections (never loaded into the livelog).
    this.deps.emitControl('segment-archive');
  }
}
