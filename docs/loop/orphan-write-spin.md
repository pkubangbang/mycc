# Orphaned write spin: how a mycc process burns a core forever

> Incident: PID 290457 on 2026-11-26. A `mycc` lead for `/home/student/proj/kvm`
> started 21:08:45, spun for 2h24m, and could only be stopped by `SIGKILL`.
> This document records the measured mechanism and the two fixes it produced.

## Measured signature

| Counter | Value | Reads as |
|---|---|---|
| `syscw` | 20.26 M | write(2) **attempts** |
| `wchar` | frozen (~135 KB, all early) | bytes actually accepted |
| bytes/write after freeze | **0.0000** | every attempt failed |
| `utime`:`stime` | 139822 : 2617 ≈ **53:1** | userspace-bound, not kernel |
| threads | 20, exactly **one** in state `R`, `wchan = 0` | one hot thread, rest parked |
| fd 0/1/2 | AF_UNIX **socketpairs** | inherited stdio from a dead parent |
| SIGTERM | never landed | no event-loop turn to deliver it |
| session dir | **never created** | died in the bootstrap window (one beat, 21:08:51) |

The decisive inference is the arithmetic: ~14k iterations/s, each one failing
immediately, with 53× more user than kernel time. That is not a network probe
(`startup.ts` health check: 1–5 ms per attempt, ~300 B per iteration) and not a
poll loop (all in-tree timers are ≤12.5/s and carry a progress token). It is
**one cheap failing `write(2)` plus userspace error/stack formatting per turn,
in a loop that never yields**.

## Mechanism

1. A `mycc` process has stdio fds that Node created as AF_UNIX socketpairs
   pointing at its parent. The parent (coordinator / lead) dies.
2. A **synchronous** write path — `fs.writeSync`, not the buffered
   `process.stdout.write` — keeps writing short chunks to those fds.
3. Each write fails (`EPIPE` once the peer is gone, `ENOSPC` on a full device).
4. The error is **swallowed by a handler that formats it and writes again**,
   through the same dead fd.
5. Because the loop is synchronous it never returns to the event loop, so
   **nothing in-process can recover**: timers do not fire, `close()` never runs,
   the `SIGTERM` handler (registered via `process.on`) is never dispatched, and
   the heartbeat stops — which is why such a process has exactly one beat.
   Only `SIGKILL` ends it.

A control run **without** the swallowing handler dies on the first `EPIPE`, so
the handler — not the broken pipe — is what makes the process immortal.
`uncaughtException` handlers that write to stdout/stderr are the common shape.

## Fixes applied

### 1. Latch a failed log fd (`src/utils/verbose-log.ts`)

`writeChunk` sets `verboseWriteFailed` **before** attempting its one-time
warning, so a failed write latches permanently and later chunks short-circuit.
The warning goes through the captured *unwrapped* stderr write, so it cannot be
fed back through the tee into the same dead fd.

- `src/tests/utils/verbose-log.test.ts` — 5 tests. The failure is induced for
  real (the pinned log path is symlinked to `/dev/full`, which opens fine and
  fails every write with `ENOSPC`), then 2 000 chunks are written; asserts a
  single warning, no per-line syscall, and that the chunk still reaches the
  real stdout.

### 2. Reap orphaned bg children (`src/context/shared/bg.ts`)

`bg_create` children are spawned `detached: true` + `unref()` with piped stdio,
so they inherit exactly the socketpair shape above. Teardown now:

- `killTask()` releases our pipe ends (`detachStdio`) and cancels drains before
  dropping the process entry — a killed task leaves nothing writable behind;
- `reapDeadTasks()` downgrades a `running` task whose pid is gone, closing our
  stdio ends. It **never signals** the pid (a recycled pid may belong to another
  process — it only ever downgrades status and closes *our* fds);
- `hasRunningBgTasks()` reaps first, so a dead child is not reported as work in
  flight forever.

The kill itself was already correct (`kill -PG SIGKILL` on Unix — SIGTERM is
useless against this spin class, which is why escalation is not a fix but the
baseline).

- `src/tests/bg.test.ts` — 5 new tests (29 total) pinning: pipes closed on reap,
  never signalling, live pids untouched, idempotence, and the reaping status query.

## Residual risk

Which exact call site formed the loop in the 2026-11-26 incident was **not**
determined: the process was gone before its JS stack could be read, and every
reachable in-tree writer was excluded by rate (`startup.ts:49` health-check retry
— 1–5 ms and ~300 B per attempt) or by latching. The tree at the time of the
incident was byte-identical to the tree after it, so **no code change caused or
fixed it**. The invariants above are what keep the class of failure bounded.

## Related

- `docs/loop/agent-loop.md` — the loop itself and why a sync spin starves it.
- `docs/context/child-context.md` — teammate IPC and child stdio.
