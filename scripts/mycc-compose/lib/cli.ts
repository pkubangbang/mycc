/**
 * cli.ts — usage text, argument parsing, and process-exit helpers.
 *
 * Kept separate from the entry shim so the entry stays a thin router and the
 * arg parser is unit-testable in isolation (parseCliArgs never exits).
 */

export const HELP = `mycc-compose — declarative peer-group orchestrator for mycc

Reads a JSON topology spec describing a group of mycc peers (how to launch
them, which channels connect them) and materializes it: launch/renew members,
mint or reuse their session ids, write both channel files per link, report.

Usage:
  mycc-compose check  <file>            Validate the spec; report match/stale. No mutation.
  mycc-compose up     <file>            Full pipeline: launch/renew peers + write channels.
  mycc-compose sync   <file>            Idempotent reconcile (up minus destructive stops). Cron target.
  mycc-compose down   <file>            Terminate the peers, then remove their channel pairs.
  mycc-compose status <file> [--json]   Deterministic report (peers + channels). --json for machines.
  mycc-compose --help, -h               Show this help.

Spec (schema v2):
  {
    "group": "pr26",
    "peers": [
      { "name": "leader", "workdir": "C:/Proj/mycc",
        "args": "--auto --skip-healthcheck --ollama-model glm-5:cloud",
        "sessionId": null, "renew": "onMismatch" }
    ],
    "channels": [
      { "from": "leader", "to": "reviewer", "label": "review",
        "prompt": "Peer is {{to}}. Reply via mail_to(name=\\"{{to}}/lead\\")..." }
    ]
  }

  - peers[].args is ONE whitespace-split string; it MUST include --auto or
    --daemon (else cleanupEmptySessions() can GC a re-pinned session dir).
  - peers[].sessionId: null → the tool mints a UUID and writes it back IN PLACE.
  - peers[].renew: "onMismatch" (default) | "always".
  - channels[].label becomes the channelId and the filename suffix; the title
    is "<group>-<label>". Templates support {{from}} {{to}} {{peer}} {{label}}.

Exit codes: 0 = OK, 1 = runtime/validation error, 2 = usage error.
`;

/** Parsed CLI args. */
export interface CliArgs {
  command: string | null;
  file: string | null;
  json: boolean;
  help: boolean;
}

export function dieUsage(msg: string): never {
  process.stderr.write(`${msg}\n\n${HELP}`);
  process.exit(2);
}

export function dieError(msg: string): never {
  process.stderr.write(`Error: ${msg}\n`);
  process.exit(1);
}

export function out(msg: string): void {
  process.stdout.write(`${msg}\n`);
}

export function warn(msg: string): void {
  process.stderr.write(`${msg}\n`);
}

/**
 * Minimal arg parser (kept dependency-light so the CLI runs after `npm link`
 * without resolving node_modules). First bare token = <file>.
 * Recognizes --json, --help/-h. Throws on an unknown option (the
 * caller in the entry turns that into dieUsage) — kept pure so it is testable.
 */
export function parseCliArgs(argv: string[]): CliArgs {
  const args: CliArgs = { command: null, file: null, json: false, help: false };
  for (const tok of argv) {
    if (tok === '--help' || tok === '-h') { args.help = true; continue; }
    if (tok === '--json') { args.json = true; continue; }
    if (tok.startsWith('-')) throw new Error(`unknown option: ${tok}`);
    if (args.command === null) { args.command = tok; continue; }
    if (args.file === null) { args.file = tok; continue; }
    throw new Error(`unexpected extra argument: ${tok}`);
  }
  return args;
}