# Pattern 9: Delphi / Structured Elicitation (Collect N Distinct Solutions)

**Theory basis:** The Delphi method (RAND, 1950s) — structured, iterative
elicitation of expert judgment until convergence or a target count of
distinct solutions is reached; Mintzberg output standardization (the
"distinct solution" is the standardized deliverable).

**When to use:** You need **N distinct candidate solutions** to a question,
collected from multiple teammates, continuing to query until you have N
genuinely *different* (non-duplicate) answers. Distinct from Broadcast
(Star): Broadcast sends the same task once and collects independent
perspectives; **Delphi iterates** — it sends the question, collects
answers, checks for distinctness, and re-queries (optionally feeding back
the collected set so teammates diverge from already-submitted solutions)
until N distinct solutions are gathered.

Examples: gather 3 distinct algorithm designs for a problem; collect 5
different debugging hypotheses; assemble N independent migration strategies
before picking one with a Funnel.

## Communication topology — Star with an iterative collection loop

```
            LEAD (collects, dedupes, re-queries)
           /  |  \
          /   |   \   (same question, possibly re-sent with feedback)
      tm-1  tm-2  tm-3
```

The lead broadcasts the question to all teammates. Each returns a solution
to the lead (no lateral mail — they must NOT see each other's answers, to
keep solutions independent). The lead **dedupes** the collected set; if
fewer than N distinct solutions, it re-queries (telling each teammate which
solution-IDs already exist, so they diverge) until N distinct are gathered.

## The collection loop (lead-run)

```
DELPHI COLLECTION PROCEDURE:
1. BROADCAST the question + the "produce a DISTINCT solution" instruction.
2. COLLECT: gather each teammate's solution from their issue close comment / mail.
3. DEDUPE: compare the collected solutions; merge near-duplicates into one.
   - Distinctness test: two solutions are DISTINCT if they differ in
     approach/mechanism, not merely in wording. "Use Redis" and "use Redis
     with TTL=300" are NOT distinct; "use Redis" and "use in-process LRU"
     ARE distinct.
4. CHECK COUNT: if ≥ N distinct solutions → STOP, return the set.
   If < N → RE-QUERY (step 5).
5. RE-QUERY: mail each teammate that has NOT yet contributed a distinct
   solution, telling them the solution-IDs already taken, and ask for a
   DIFFERENT approach. Loop back to step 2.
6. TERMINATION GUARD: if after K collection rounds you still have < N
   distinct, STOP and report the distinct solutions found (do not loop
   forever — see Pitfalls).
```

State **N** (target count) and **K** (max collection rounds) BEFORE the
first broadcast.

## Tool sequence

```
# 1. Create one issue per teammate (each produces a candidate solution).
#    Write N and K into the shared content so the contract is visible.
issue_create(title="Delphi: propose a dedup algorithm (solution 1)", content="Target: collect N=3 DISTINCT dedup algorithms. Max rounds K=2. Return ONE algorithm with rationale. Do NOT discuss with other teammates.")
issue_create(title="Delphi: propose a dedup algorithm (solution 2)", content="...same...")
issue_create(title="Delphi: propose a dedup algorithm (solution 3)", content="...same...")

# 2. Spawn teammates. They mail the LEAD only (independence is required).
#    They MAY NOT mail each other — seeing peers' answers would collapse distinctness.
tm_create(name="expert-1", role="algorithm designer", prompt="Claim issue #1. Propose ONE dedup algorithm with rationale. MAY mail: lead. MAY NOT mail: expert-2, expert-3 (independence required). Close your issue with the algorithm.")
tm_create(name="expert-2", role="algorithm designer", prompt="Claim issue #2. Propose ONE dedup algorithm. MAY mail: lead. MAY NOT mail: expert-1, expert-3. Close your issue with the algorithm.")
tm_create(name="expert-3", role="algorithm designer", prompt="Claim issue #3. Propose ONE dedup algorithm. MAY mail: lead. MAY NOT mail: expert-1, expert-2. Close your issue with the algorithm.")

# 3. BROADCAST the question (same to all — but they answer independently)
broadcast(title="Delphi round 1: propose a DISTINCT dedup algorithm", content="Propose ONE dedup algorithm with rationale. Return it to the lead only. Do NOT discuss with or read other experts.")

# 4. COLLECT + DEDUPE (per the Delphi Collection Procedure).
# 5. If < N distinct after round 1, RE-QUERY the experts whose solutions
#    were duplicates, telling them which approach-IDs are taken:
#      mail_to(name="expert-2", title="Delphi round 2: propose a DIFFERENT algorithm",
#        content="Already submitted: [hash-set approach]. Propose a DIFFERENT mechanism (e.g. bloom filter, sort-then-adjacent, etc.).")
# 6. Repeat collect/dedupe until N distinct OR round K reached.
# 7. Return the set of N distinct solutions (often handed off to a Funnel
#    integrator to pick the best — see Phase Transitions).
```

## Distinctness test (apply during DEDUPE)

```
Two solutions are DISTINCT iff they differ in APPROACH/MECHANISM:
- "Redis cache" vs "Redis cache with TTL"            → NOT distinct (same mechanism)
- "Redis cache" vs "in-process LRU" vs "no cache"    → distinct (3)
- "quicksort" vs "mergesort" vs "heapsort"           → distinct (3)
- "quicksort" vs "quicksort with 3-way partition"    → NOT distinct (same family)

When in doubt, keep them separate and let a downstream integrator (Funnel)
merge — over-merging loses candidates; over-splitting is cheap to dedupe later.
```

## Example

Collect 3 distinct dedup algorithms. Round 1 yields quicksort-based and
mergesort-based (2 distinct); expert-3 also proposed quicksort (duplicate).
The lead re-queries expert-3 with "quicksort and mergesort already taken,"
and expert-3 returns a bloom-filter approach — now 3 distinct, stop.

## Pitfalls

- **Teammates must NOT see each other's answers** — lateral mail collapses
  distinctness into consensus. Enforce lead-only mail (same as Broadcast).
- **No termination guard → infinite re-query** — always set a max-rounds K.
  If you can't reach N distinct after K rounds, return what you have rather
  than loop forever; some questions simply have fewer than N viable
  distinct solutions.
- **Re-query must tell experts what's already taken** — without feedback on
  taken approach-IDs, re-queried experts reproduce the same duplicates.
- **Delphi ≠ Broadcast** — Broadcast collects perspectives once; Delphi
  ITERATES to a target count of distinct solutions. Use Delphi when you
  need a specific number of candidates, Broadcast when you need varied
  perspectives on one artifact.
- **Delphi feeds Funnel** — the natural next phase is a Funnel/Y
  integrator that picks the best of the N distinct solutions. Don't pick
  the winner inside the Delphi loop; collect first, decide second.

## See also

- `pattern-broadcast.md` — the one-shot Star topology Delphi extends with
  iteration.
- `pattern-funnel.md` — the typical downstream consumer of a Delphi set.
- `enforcement.md` — detecting lateral-mail violations (independence breach).
- `async-principles.md` — the Polling Procedure for monitoring collection.
- SKILL.md — the "Choosing a Workflow" table and Phase Transitions.