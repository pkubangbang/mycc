# A tool to summarize extra-long content

The basic idea is that, split the content into equally-sized chunks that each can be stuffed into the llm's context about <60% full, and do a rolling summary. The interesting part is that we **take two turns of read**, thus the naming of "read_read".

## implementation details

1. A long content is given as a file, together with a constant CTL holding the context length of llm.
2. Find a proper integer N so that the content can be splited into N consecutive chunks (may or may not overlap with each other), with each chunk's length as large as possible but **less than 60% of CTL**.
3. Prepare a empty buffer of messages, and push the first chunk inside, then pre-pend the system prompt to summarize for continuity. After that `buffer == Summary(chunk1)`
4. Push the next chunk inside so `buffer == Summary(chunk1) + chunk2`, then summarize the two messages to get a new summary. Now `buffer == Summary(Summary(chunk1) + chunk2)`. We denote this as `buffer == RollingSummary(chunk1, chunk2)`
5. Do the same until chunkN is done. Now `buffer == RollingSummary(chunk1, chunk2, ..., chunkN)`.
6. **Continue with another turn**, so `buffer === RollingSummary(chunk1, chunk2, ..., chunkN, notice, chunk1, chunk2, ..., chunkN)`. The `notice` is a artificial chat that tells the llm to read again (plus the llm's acknowledgement).
7. output the buffer as the result.

## Special notice

In the system prompt, you must specify the rule of two-turn read clearly.