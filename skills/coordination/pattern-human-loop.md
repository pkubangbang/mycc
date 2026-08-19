# Pattern 7: Human-in-the-Loop (Direct Supervision with Human Node)

**Theory basis:** Direct supervision with the human as an authoritative
node in the topology.

**When to use:** A human user is a participant in the coordination flow —
not a spectator. The human has their own turn and must not be automated
past.

## Communication topology — Human as authoritative node

```
LEAD ↔ HUMAN ↔ teammate(s)
```

The lead is the hub that relays between the human and teammates. The
human's turn is explicit and must not be skipped.

## Rules for human-in-the-loop coordination

1. **Define the protocol upfront** — tell all participants (including the
   human) who goes in what order and how each turn flows.
   ```
   # GOOD: State the protocol upfront
   "Here's our protocol: I'll ask you for input → you type in chat → I relay to John → John responds → I tell you the result. Your turn: please type your answer when I prompt you."

   # BAD: Assume the human knows when to interject
   "Let's play a game. John, pick a number. I'll guess."
   ```

2. **Hand off turns explicitly** — do NOT proceed through the human's turn
   automatically. When it's the human's turn, state clearly: "It's your
   turn now. Please [describe what they should do]." Then **stop and wait**
   for their response.

3. **Clarify the submission channel** — explain HOW the human submits their
   turn (e.g., "type your answer in the chat", "run this command in the
   terminal"). The `hand_over` tool creates an interactive terminal for
   SSH/vim/passwords; for chat-based input, simply ask in your response and
   wait.

4. **Do not bypass the human's turn** — if you are waiting for the human,
   actually stop and wait. Using `tm_await` on a teammate behind the
   human's back removes the human from the loop.

5. **Handle mixed turn orders** — when the team includes both agents and
   the human, the lead orchestrates the full sequence:
   ```
   lead → human (input) → lead → teammate (process) → lead → human (result) → ...
   ```

## Tool sequence

```
# Lead announces the protocol
issue_create(title="Activity with human participation", content="...")
tm_create(name="john", role="secret-keeper", prompt="Claim issue #1. Wait for guesses via mail. Respond higher/lower.")

# Lead explicitly tells the user
"I'll coordinate: you guess → I relay to John → John says higher/lower → I tell you. Your turn — make a guess!"

# User responds: "50"
# Lead relays to teammate
mail_to(name="john", title="Guess: 50", content="User guessed 50. Respond higher/lower.")
# (await john ONLY here, because you cannot proceed without his answer)
tm_await(name="john")

# Lead collects result and hands back to human
"John says: Lower. Your turn again — guess again!"

# Repeat the cycle — never skip the human's turn
```

## Key differences from Patterns 1–6

- The human cannot be given an issue to claim — you communicate via chat.
- The lead MUST stop and explicitly prompt the human at each turn.
- The human's input arrives via their chat response, not via a tool.
- Never use `tm_await` on a teammate in a way that bypasses the human turn.

## Pitfalls

- **Automating past the human** — the most common failure mode. The lead
  coordinates only between teammates and the user watches output scroll by.
- **Using `tm_await` to skip the human's turn** — if the human is next, do
  not block on a teammate.
- **Vague turn handoffs** — always state exactly what the human should do
  and how to submit it.

## See also

- `async-principles.md` — when tm_await is justified (here: only when a
  teammate's answer is required before the human's next turn).
- SKILL.md — the Tie-Breaking Rule (Human-in-the-Loop always wins priority).