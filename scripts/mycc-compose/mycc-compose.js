#!/usr/bin/env node
/**
 * mycc-compose.js — Declarative peer-group orchestrator for mycc (CLI entry).
 *
 * Thin CLI shim: registers the tsx ESM loader, dynamically imports the umbrella
 * `./lib/index.ts` (which re-exports the CLI helpers + subcommands from the
 * sibling .ts modules), parses argv, and routes to the matching subcommand via
 * main(). All implementation lives in .ts siblings (lib/), each subcommand in
 * its own module.
 *
 * Exposed as the `mycc-compose` bin by the parent mycc package
 * (see ../../package.json `bin`).
 *
 *   mycc-compose check  <file>          validate + report match, no mutation
 *   mycc-compose up     <file>          full pipeline (launch/renew + channels)
 *   mycc-compose sync   <file>          idempotent reconcile (up minus stops) — cron target
 *   mycc-compose down   <file> [--stop] remove channels; optionally stop peers
 *   mycc-compose status <file> [--json] deterministic report
 *   mycc-compose --help
 *
 * Run directly during development:
 *   node scripts/mycc-compose/mycc-compose.js check spec.json
 */

import { register } from 'tsx/esm/api';

register();

const {
  parseCliArgs,
  HELP,
  dieUsage,
  dieError,
  cmdCheck,
  cmdUp,
  cmdDown,
  cmdStatus,
} = await import('./lib/index.ts');

async function main() {
  let args;
  try {
    args = parseCliArgs(process.argv.slice(2));
  } catch (err) {
    dieUsage(err instanceof Error ? err.message : String(err));
  }
  if (args.help || args.command === null) {
    process.stdout.write(HELP);
    process.exit(args.help ? 0 : 2);
  }
  if (args.file === null) dieUsage(`command "${args.command}" requires a <file> argument`);

  switch (args.command) {
    case 'check':
      cmdCheck(args.file);
      break;
    case 'up':
      await cmdUp(args.file, { allowStop: true });
      break;
    case 'sync':
      await cmdUp(args.file, { allowStop: false });
      break;
    case 'down':
      cmdDown(args.file, args.stop);
      break;
    case 'status':
      cmdStatus(args.file, args.json);
      break;
    default:
      dieUsage(`unknown command: ${args.command}`);
  }
}

main().catch((err) => dieError(err && err.message ? err.message : String(err)));