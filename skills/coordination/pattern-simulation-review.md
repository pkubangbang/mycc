# Pattern 11: Simulation Review / Aggregation-Root Simulation

**Theory basis:** Bavelas Wheel (hub-and-spoke, centralized) + Mintzberg skill
standardization (a specialist role: the validator/debugger); ownership is
partitioned the way DDD partitions a domain — by **aggregation root**.

**When to use:** Reviewing a **lifecycle or state-machine change** (server
start/stop, resource allocation/teardown, async try/catch/finally,
re-entrancy guards) where the bug is usually **not in the edited lines but in
the path the edit leaves uncovered** — a failure branch that a read-and-
approve review would never trace. The lead assigns each teammate one
aggregation root and enumerates the exact file paths for it; the teammate
**runs those files line by line, following the control flow as a debugger
steps over each line**, then reports both the defects it finds and any
potential weakness it passes. The lead **collects and validates** the
harvested findings. This is a **specialization of Peer Review (Pattern 5)**:
the reviewer's task is simulation + weakness-harvesting, not negotiation.

## Ownership — the lead assigns files, one aggregation root per teammate

The unit of assignment is an **aggregation root** (bounded context), not a
diff hunk. Each teammate owns the root it validates and is responsible for
that root's ENTIRE lifecycle flow — every caller → callee transition that
enters the root, every allocation/teardown pair, every failure branch inside
it.

**The LEAD resolves each root into a concrete FILE LIST and puts those exact
paths in the teammate's prompt** — the teammate does not choose its own scope.
The teammate then LOADS the named files (plus any helper they call) and runs
them in order. The root is what the lead assigns; the enumerated file paths
are what the teammate runs. Confirming the file list up front keeps every
teammate's slice self-contained and prevents two teammates from silently
overlapping or drifting.

Derive the roots from the code, not from a fixed template. The right cut
depends on where the state actually lives:

- **By structural root** — when the change spans several independent owners
  (e.g. one root is `ServeHub`, another is `PeerWireAcceptor`), each teammate
  gets that root's files and runs its lifecycle end-to-end.
- **By path within one root** — when a single root is the real subject (one
  aggregation holds the mutable lifecycle), split by *execution path* through
  that root: one teammate follows the happy path, one the bind-failure path,
  one the retry path. They get the same file list because the bug lives in
  the interaction between those paths.
- **Both axes** — for a large change, a (root × path) grid; keep it small
  enough that every teammate can hold its slice in one head.

> Choose whichever cut keeps each teammate's slice *self-contained*: it must
> be able to run its files without needing to re-derive a neighbour's state.
> If a teammate keeps reaching outside its file list to reason, the cut is
> wrong — re-slice.

## Communication topology

Teammates report to the lead ONLY (no lateral mail, no source edits). The
lead is the collector and validator.

```
      SIM-1 (root A)   SIM-2 (root B)   SIM-3 (path C)
             \               |               /
              \              |              /
               ----------- LEAD -----------
                    (collect + validate)
```

## Tool sequence

```
# 1. Create ONE shared issue per aggregation root (or per root×path slice),
#    so every teammate's findings land somewhere the lead can collect them.
issue_create(title="Validate lifecycle of <root A>", content="<the file list below>")
issue_create(title="Validate lifecycle of <root B>", content="<the file list below>")

# 2. The LEAD enumerates the exact file paths for each teammate — the teammate
#    does not choose its own scope. Put the paths straight into the prompt.
#    (List every file the root's run touches, plus the helpers it calls.)
#    sim-a files: src/serve/serve-hub.ts, src/serve/peer-wire.ts
#    sim-b files: <...>

# 3. Spawn each validator with the TEMPLATE below, POPULATED per teammate.
#    (a) fill <ROOT> and <FILES> from the file list above, (b) frame it as a
#    RUN line by line following control flow, (c) keep the ACK step, (d) keep
#    the defects-AND-weaknesses report to the lead.
tm_create(name="sim-a", role="line-by-line code validator / execution runner (read-only)", prompt="""
You are an intelligent code validator. You are about to load <FILES> — the
files implementing the <ROOT> aggregation root — and run them line by line,
following the control flow, spotting any potential defect along the run and
reporting it to the lead.

FIRST, ACK this file list back to the lead (mail_to name=lead) and state if
any file is missing for the run — do NOT start until the list is confirmed.

Then LOAD these files and RUN them line by line, following the control flow
as a debugger steps over each line — do not summarize the diff, and do not
produce a line-by-line trace; just run the flow and watch what each line does
to the state.

Follow the run through every branch it can take: the happy path, each
allocation/await step that can throw, and the retry / re-entry path that
exercises every catch block.

Along the run, spot ANY potential defect or weakness — not only proven bugs:
an unguarded assumption, a missing null check, an ordering that only works by
luck, a resource whose teardown depends on another's success, a comment that
no longer matches the code.

Report to the lead two lists:
  1. DEFECTS — prioritized CRITICAL / MEDIUM / LOW, each with the exact line
     and the run-path that reaches it.
  2. WEAKNESSES / INFO — anything suspicious you noticed along the run, even
     if uncertain.
End with a verdict: 'safe to merge as-is' or 'needs revision'.
Do NOT edit files.
""")

#    Populated instance of the same template (what the lead actually sends for
#    the serve-hub root):
#      <ROOT>  = ServeHub
#      <FILES> = src/serve/serve-hub.ts and src/serve/peer-wire.ts

# 4. CONFIRM the ack: wait for each teammate's file-list acknowledgement (or
#    have it mail back "missing <file>" so you can correct the list before it
#    runs). A validator that starts without a confirmed list may have picked
#    the wrong scope.

# 5. Let them run asynchronously; check with tm_print / issue_list, NOT
#    tm_await (async-first).
tm_print()

# 6. COLLECT: gather every validator's defect + weakness list. The lead does
#    not trust a finding just because a teammate reported it.
# 7. VALIDATE: for each reported item, replay the run yourself (or execute the
#    failure scenario) and decide: confirmed / false-positive / unprovable.
#    Keep unprovable-but-plausible items as open questions, not silent drops.

# 8. Integrate: on 'needs revision' (or any CONFIRMED defect), apply fixes;
#    on clean, proceed to the test suite before commit.
```

> ⚠️ `tm_create` above uses the **template** (the `<ROOT>` / `<FILES>` slots
> are populated by the lead per teammate). The branches named inside the
> template are also **one instance**: re-derive them for YOUR change — one
> branch per allocation/await step's failure point, plus the happy path and a
> retry. The value is in the *shape* (lead-assigned files + teammate ACK +
> flow-following + a defect/weakness split + lead validation), not the
> filenames.

## Why simulation, not read-and-approve

A read-and-approve review checks whether the change correctly restored
*state* and *immediate regressions*. It does NOT follow what the code
allocated before it could throw. Following the flow makes the reviewer walk
control flow through every branch, which surfaces:

- **Partial-initialization leaks** — `start()`/`open()` allocates resources
  1, 2, 3, then throws before 4, leaving 1–3 orphaned and a later retry
  overwriting the references.
- **Double-teardown / double-abort** — two catch paths (inner + caller) both
  releasing the same resource, or both aborting the same pending wait.
- **Re-entrancy hazards** — a guard flag (`stopping`, `restarting`) cleared in
  the wrong order relative to a `finally`.
- **Assignment / early-return drift** — a refactor that moves `this.port =
  port` or an `if (running) return` guard relative to a `try {`, silently
  changing what state is set on the failure path.

## Harvesting weaknesses (beyond proven defects)

Following the flow also exposes things that are not (yet) defects. The
teammate reports them so the lead can validate them, because a weakness that
is dismissed without a second look is exactly how the *next* failure-path bug
ships:

- An assumption that holds only because a caller happens to behave a certain
  way ("this is only safe because `stop()` ran first").
- A resource whose teardown is *conditional on another resource's success* —
  fine today, fragile under a retry.
- A guard that is correct but whose *ordering* is undocumented and load-
  bearing.
- A comment that describes intent the code no longer implements.

The lead **validates** each: replay the run, execute the failure scenario, or
mark it an explicit open question. Do NOT silently drop a plausible weakness
just because the validator could not prove it.

## Stall Detection (Simulation Review)

```
- A validator may emit only '[PROGRESS]' mails and never a final report.
  Do NOT block forever in tm_await (see async-principles.md). If it exceeds
  its ETA / deadline without a verdict:
  1. mail it once: "wrap up now — deliver your findings or reply 'cancel'".
  2. If still no report, treat its partial progress as best-effort evidence,
     proceed with the fix + regression test yourself, and tm_remove(force=false)
     (or force=true only if stuck).
- The verdict is advisory, not a gate: a validator that concludes SAFE does
  not replace running the test suite / typecheck before commit.
```

## Pitfalls

- **Assign by aggregation root, not by file or diff hunk — but the LEAD names
  the files.** The lead resolves each root into an explicit file list and puts
  the paths in the prompt; the teammate does not pick its own scope. A slice
  that cannot run its file list without a neighbour's state is mis-cut —
  re-slice.
- **Confirm the ack.** The teammate must ACK the file list (or report a
  missing file) before it starts. A validator that begins without a confirmed
  list may have silently chosen the wrong scope.
- **The prompt must force FLOW-FOLLOWING.** If it reads like "review this
  diff", the validator approves the happy path and misses the failure
  branches. Name the files, name the branches, and require a verdict.
- **No step trace.** A line-by-line trace is heavy and drifts from the real
  execution; ask only for the defects and weaknesses found *while* running the
  flow. The trace is a means, not the deliverable.
- **Report weaknesses, not just confirmed defects.** A validator that only
  lists proven bugs throws away the highest-value signal (the fragile
  assumption that will break under the next change).
- **The lead validates; it does not merely aggregate.** Collect every finding,
  then replay the run or execute the failure scenario to confirm. An unvalidated
  "SAFE" or an unvalidated "CRITICAL" are both worthless.
- **No edits** — the validator is read-only; state the no-edit rule in BOTH
  the `tm_create` prompt and the follow-up mail.
- **Do not block on `tm_await`** — validators can stall emitting progress
  mails. Use the Stall Detection above; `tm_await` is a last resort.
- **Verdict ≠ green gate** — still run `pnpm test` + typecheck before commit;
  the validator cannot execute the failure scenario itself (source-level
  control-flow analysis only).

## Example

A serve-layer `restartServe`/`start`/`stop` refactor is split by aggregation
root: the lead assigns one validator the `ServeHub` files (following
`start → catch → disposeStack` and the retry path), another the
`PeerWireAcceptor` file (following its `stop()`/`createServer()` re-entry),
each ACKing its file list first. While following the `ServeHub` throw
path, the validator flags a **weakness** (not a proven defect at the time):
"`disposeStack()` is only safe here *because* `stop()` already cancelled the
disconnect timer — a future caller that invokes it directly would not be."
The lead replays the run, confirms the coupling is real but currently
guarded, and records it as a documented open question rather than dropping
it — the exact reasoning that later prevented a regression when a second
caller was added. A separate confirmed **DEFECT** (a handle assigned after the
`try`, so the failure path could not release it) is sent back for fix before
commit.

## See also

- `pattern-peer-review.md` — the review topology this specializes (same
  reviewer role family, different task: simulation + weakness harvest vs.
  negotiation).
- `async-principles.md` — the tm_await decision tree and tm_remove rules.
- `peer-review-fix-workflow` (project skill) — the retrospective lesson
  ("no further issues ≠ no issues exist"; state-recovery vs resource-recovery)
  that motivated this pattern.
- SKILL.md — the "Choosing a Workflow" table and Phase Transitions.
