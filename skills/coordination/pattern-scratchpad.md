# Pattern 10: Scratchpad / Notes-with-Memory (Hub-and-Query)

**Theory basis:** Mintzberg mutual adjustment + a shared **transactive
memory system** (Wegner, 1985) — one node holds the group's accumulated
notes and answers queries against them; Bavelas Wheel where the hub is a
**memory store**, not a router.

**When to use:** The lead is doing exploratory or fragmented work and
accumulating **notes** (observations, partial findings, open questions)
that it wants persisted and queryable by the team. A dedicated **scratchpad
teammate** collects and organizes the lead's notes; when the lead has a
question, it broadcasts a query and the scratchpad answers from the
collected notes. Distinct from Divide-and-Conquer (Wheel): there the hub
routes *tasks* to workers; here the hub *stores notes* and answers
*queries* against them.

Examples: long debugging sessions where the lead drops findings as it goes
and later asks "what did we learn about the timeout symptom?"; research
sprees where notes accumulate and the lead queries "summarize everything we
found about the WAL corruption theory."

## Communication topology — Hub with memory (Wheel, memory-variant)

```
   LEAD ──drops notes──→ SCRATCHPAD (memory store)
   LEAD ──broadcasts query──→ all teammates
                              (scratchpad answers from notes;
               others answer from their own work)
                 ↑
   SCRATCHPAD ──answer──→ LEAD
```

The scratchpad teammate is a **persistent memory node**: it receives the
lead's notes (via mail), organizes them, and — when the lead broadcasts a
query — responds from the accumulated notes. Other teammates may also
answer the broadcast from their own work, but the scratchpad is the
authoritative answerer for anything already in the notes.

## Two operating modes

```
MODE A — NOTE-DROP (ongoing): the lead mails notes to the scratchpad as it
  works. The scratchpad appends/organizes them (no response needed unless
  it needs clarification). This is a one-way write; it does NOT block the
  lead.

MODE B — QUERY (on demand): the lead has a question. It broadcasts the
  query to ALL teammates (broadcast is lead-only). The scratchpad answers
  from the collected notes; other teammates may answer from their own work.
  The lead collects answers and continues.
```

The broadcast in MODE B is intentional: the question may be answerable
from the scratchpad's notes OR from a working teammate's current context,
and broadcasting lets both sources respond. The scratchpad is the
*default/authoritative* answerer for note-derived questions.

## Tool sequence

```
# 1. Create a long-lived issue for the scratchpad's note store.
#    It stays OPEN for the session (do NOT close it until the session ends).
issue_create(title="Scratchpad: collect lead's notes and answer queries", content="""
Role: you are the team's MEMORY. The lead will mail you notes as it works —
append/organize them. When the lead BROADCASTS a query, answer it from the
collected notes (quote the relevant notes). Keep notes organized by topic.
This issue stays OPEN all session; close it only when told the session is ending.
""")

# 2. Spawn the scratchpad teammate (long-lived).
tm_create(name="scratchpad", role="notes keeper", prompt="""
Claim issue #1. You are the team's MEMORY store.
- When the lead mails you a NOTE: append/organize it into your notes. Do
  not reply unless you need clarification.
- When the lead BROADCASTS a query: answer it from your collected notes,
  quoting the relevant entries. If the notes don't cover it, say so.
- MAY mail: lead. MAY NOT mail: other teammates (you are a store, not a
  peer). Do NOT initiate queries — you answer, you don't ask.
- Keep issue #1 OPEN all session.
""")

# 3. MODE A — NOTE-DROP (do this whenever you have a finding):
mail_to(name="scratchpad", title="NOTE: timeout symptom reproduces under load",
  content="Observation: the timeout only reproduces when concurrency > 8. Stack trace shows block on WAL flush. Tentative theory: WAL contention.")
# (no await — the scratchpad just stores it; continue your own work)

# 4. MODE B — QUERY (when you have a question):
broadcast(title="QUERY: what do we know about the timeout symptom?", content="""
What have we learned about the timeout symptom? Scratchpad: answer from the
collected notes. Others: answer from your own work if relevant.
""")
# (collect answers from your mailbox; the scratchpad's is authoritative
#  for note-derived content)

# 5. When the session is winding down, close issue #1:
#      mail_to(name="scratchpad", title="Session ending — finalize notes",
#        content="Close issue #1 with a final organized summary of all notes.")
```

## Example

During a long debug, the lead mails the scratchpad notes as it finds them
("timeout reproduces at concurrency>8", "WAL flush blocks", "theory: WAL
contention"). Later the lead broadcasts "what do we know about the
timeout?" and the scratchpad replies quoting all three notes; a working
teammate adds a fresh observation from its current task. The lead combines
both.

## Pitfalls

- **The scratchpad is a MEMORY, not a router** — do not route work tasks
  through it. Send it notes; send work to workers. Routing tasks through
  the scratchpad turns it into a bottlenecked Wheel-hub and loses the
  memory benefit.
- **Note-drops are one-way; do NOT `tm_await` after each note** — the
  scratchpad just stores it. Awaiting on every note-drop serializes the
  lead and defeats async-first. Await only when you need a query ANSWERED.
- **Keep issue #1 OPEN all session** — closing it loses the note-store
  context. Close it only at session end with a final summary.
- **The scratchpad answers; it does not ask** — it must not initiate
  queries or mail other teammates. If it starts asking, it has become a
  peer, not a store.
- **Broadcast vs direct mail for queries** — broadcast lets working
  teammates contribute fresh context alongside the scratchpad's stored
  notes. If you only want the stored answer, mail the scratchpad directly
  instead. Reserve broadcast for queries where current work context also
  matters.
- **Querying is async** — after a broadcast query, do not block; collect
  answers from your mailbox on subsequent turns per the Polling Procedure.

## See also

- `pattern-divide-conquer.md` — the Wheel topology; Scratchpad is the
  memory-store variant (hub stores notes + answers, vs. hub routes tasks).
- `pattern-broadcast.md` — the broadcast query mechanism MODE B uses.
- `async-principles.md` — note-drops are non-blocking; the Polling
  Procedure for collecting query answers.
- `enforcement.md` — the Communication Constraint Template (the
  scratchpad's MAY/MAY NOT mail list).
- SKILL.md — the "Choosing a Workflow" table and Phase Transitions.