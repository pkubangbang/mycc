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

/** How long an archive may summarize before its watchdog aborts it. */
const ARCHIVE_WATCHDOG_MS = Number(process.env.MYCC_ARCHIVE_WATCHDOG_MS ?? 120_000);

/** Boundary snapshot taken at TRIGGER time (see run()). */
interface Fingerprint {
  msg: Message | undefined;
  len: number;
  /** Full-compact epoch at trigger time (see SegmentArchiveDeps.compactionEpoch). */
  epoch: number;
}

export interface SegmentArchiveDeps {
  /** Live store, hole-filtered copy (getRaw()). */
  getRawMessages: () => Message[];
  /** Live store, provider-visible copy (getFullMessages()). */
  getFullMessages: () => Message[];
  /**
   * Copy of `[from, to)` in TRUE-array index space, holes filtered — the
   * slicing primitive for a range derived from at()/length. Using the
   * hole-filtered getRaw() for a true index would shift the window by the hole
   * count (peer review: B4).
   */
  sliceMessages: (from: number, to: number) => Message[];
  /** The last real user query, or undefined when none. */
  lastUserQuery: () => string | undefined;
  /** TRUE-array single-message read; sparse holes yield undefined. */
  messageAt: (index: number) => Message | undefined;
  /** TRUE-array end of the last complete title batch BEFORE `index`. */
  previousTitleAnchorEnd: (index: number) => number | undefined;
  onCompact: (transcriptPath: string) => void;
  /**
   * Enqueue on the facade's compaction chain — the SAME primitive a segment
   * archive uses, so two store-swapping compactions never interleave.
   */
  enqueueCompaction: <T>(run: () => Promise<T>) => Promise<T>;
  /**
   * Monotonic counter bumped by every FULL compact that lands. An archive
   * discards its result when this moved after the trigger: the conversation it
   * summarized has been replaced.
   */
  compactionEpoch: () => number;
  /**
   * Install the summary triple in front of the tail starting at `tailFrom`.
   * Returns false when the parity guard refused (store untouched); the
   * 'segment-archive' control record is journaled by the install itself, so a
   * refused install leaves no boundary behind.
   */
  installCompacted: (compacted: Message[], tailFrom: number) => boolean;
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
  ): Promise<Message[] | undefined> {
    if (this.active) {
      agentIO.brief('warn', 'triologue', 'compactSegment skipped: an archive is already queued/running');
      return undefined;
    }
    const anchorEnd = this.deps.previousTitleAnchorEnd(currentTitleAssistantIndex);
    if (anchorEnd === undefined) return undefined;

    // Snapshot the boundary AT TRIGGER TIME, not inside the queued body: the
    // queued body runs only after every earlier compaction settled, so a full
    // compact that landed meanwhile would otherwise be baked into the
    // fingerprint and be invisible — the archive would re-summarize the fresh
    // summary triple.
    const fingerprint: Fingerprint = {
      msg: this.deps.messageAt(anchorEnd),
      len: this.deps.getRawMessages().length,
      epoch: this.deps.compactionEpoch(),
    };

    // The archive task must never outlive the turn that will await the next
    // compaction: cap it with its own watchdog so an unbounded background
    // summarization cannot stall `llm.ts` behind the shared chain.
    const watchdog = new AbortController();
    const timeout = setTimeout(() => watchdog.abort(), ARCHIVE_WATCHDOG_MS);
    try {
      return await this.deps.enqueueCompaction(() => this.archive(anchorEnd, fingerprint, domains, signal ?? watchdog.signal));
    } finally {
      clearTimeout(timeout);
      this.active = false;
    }
  }

  /**
   * The queued body: fingerprint → summarize → verify → shrink gate → install.
   * @returns the installed summary triple, or undefined when any gate skipped
   *   or discarded the archive.
   */
  private async archive(
    anchorEnd: number,
    fingerprint: Fingerprint,
    domains: Array<{ domain_name: string; description?: string }>,
    signal?: AbortSignal,
  ): Promise<Message[] | undefined> {
    // Staleness gates, in order:
    //  - the boundary OBJECT must still be there (a shrink past it yields
    //    undefined, and `undefined !== undefined` is false, so this needs the
    //    explicit absent check — peer review, archiver #3);
    //  - the store must not have SHRUNK since trigger time (a full compact
    //    swapped it, or an earlier compaction landed while we queued);
    //  - the head must be SLICED in TRUE-array index space (getRaw()/at()), not
    //    through the hole-filtered copy, or k holes shift the window by k.
    if (fingerprint.msg === undefined || this.deps.messageAt(anchorEnd) !== fingerprint.msg) {
      agentIO.brief('warn', 'triologue', 'compactSegment aborted: store changed before summarization');
      return undefined;
    }
    if (this.deps.getRawMessages().length < fingerprint.len) {
      agentIO.brief('warn', 'triologue', 'compactSegment aborted: store shrank before summarization');
      return undefined;
    }
    const segment = this.deps.sliceMessages(0, anchorEnd + 1);
    if (estimateTokensForMessages(segment) < MIN_SEGMENT_TOKENS) return undefined;

    const compacted = await doRunAutoCompact(
      {
        // Sliced adapter: runAutoCompact summarizes ONLY the segment; the tail
        // is preserved verbatim by installCompacted(triple, anchorEnd + 1).
        getRawMessages: () => this.deps.sliceMessages(0, anchorEnd + 1),
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
    // keeps working during summarization — but a full compact that landed
    // meanwhile REPLACED the conversation, and a shrink or a changed boundary
    // message invalidates the slice. The epoch test is the one that catches a
    // full compact which happened to leave the array as long as before.
    if (this.deps.compactionEpoch() !== fingerprint.epoch) {
      agentIO.brief('warn', 'triologue', 'compactSegment discarded: a full compact ran during summarization');
      return undefined;
    }
    if (
      this.deps.messageAt(anchorEnd) !== fingerprint.msg ||
      this.deps.getRawMessages().length < fingerprint.len
    ) {
      agentIO.brief('warn', 'triologue', 'compactSegment aborted: store changed during summarization');
      return undefined;
    }
    // Shrink-ratio gate: slice-vs-slice with the SAME estimator, never the
    // whole-array tokenCount. Only splice if the triple actually shrinks.
    if (estimateTokensForMessages(compacted) >= estimateTokensForMessages(segment)) {
      agentIO.brief('warn', 'triologue', 'compactSegment skipped: summary did not shrink the segment');
      return undefined;
    }
    // The boundary is journaled by installCompacted itself (and ONLY when the
    // splice is actually installed) — a refused install must never leave a
    // 'segment-archive' record behind (peer review: archiver #1).
    if (!this.deps.installCompacted(compacted, anchorEnd + 1)) {
      agentIO.brief('warn', 'triologue', 'compactSegment skipped: install refused by the parity guard');
      return undefined;
    }
    return compacted;
  }
}
