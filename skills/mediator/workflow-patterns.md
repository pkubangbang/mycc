# Workflow Patterns (Cross-Instance)

> Sub-reference of the `mediator` skill. Loaded on demand via `read_file`.
> The entry point is `SKILL.md`.

These mirror the `coordination` skill's patterns but at instance granularity.
The mediator's lever is the **firstQuery** each instance receives — that
message defines the instance's role, its peer, and the reply contract.

## Pipeline (A → B → C)
Three instances in sequence. The mediator creates two channel pairs:
- Pair `stage1`: A (owner) ↔ B (peer). A's firstQuery = "produce the design
  artifact; when done, mail it to B via mail_to(name=\"<sessionB>/lead\", ...)."
- Pair `stage2`: B (owner) ↔ C (peer). B's firstQuery = "wait for the design
  from A; implement it; when done, mail the code to C via
  mail_to(name=\"<sessionC>/lead\", ...)."
- Pair `stage3`: C (owner) ↔ A (peer). C's firstQuery = "wait for the code
  from B; test it; mail the test report back to A."
Each instance knows only its upstream/downstream peer; the mediator encoded
the chain via the channel pairings.

## Peer Review (A ↔ B)
Two instances review each other's work:
- Pair `review`: A ↔ B. A's firstQuery = "draft the change; mail it to B for
  review; apply B's feedback; mail the final to B." B's firstQuery = "wait for
  A's draft; critique it; mail the critique to A; when A mails the final,
  approve it."
Both instances share one channel pair; each firstQuery assigns the review role.

## Fan-out (A → B, A → C)
One broker instance coordinates several workers — but note the broker is now a
mycc instance, not an outside mediator. The outside mediator creates:
- Pair `broker-b`: A ↔ B. A's firstQuery = "you are the broker; send task X to
  B and task Y to C; collect results." (C is reachable from A via a second pair.)
- Pair `broker-c`: A ↔ C.
The broker instance A uses `mail_to` to both B and C and waits for replies. This
is the cross-instance analogue of Divide-and-Conquer.