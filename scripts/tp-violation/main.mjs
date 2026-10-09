#!/usr/bin/env node
/**
 * tp-violation — message-sequence conformance, judged by the PROVIDER.
 *
 *   scripts/tp-violation/
 *     main.mjs       ← this file: CLI arg handling ONLY (routes to a provider leg)
 *     lib.mjs        ← fixtures: builders, isIllegal(), the 55 SEQUENCES + expectations
 *     deepseek.mjs   ← the STRICT leg  (grades against `wantDeepseek`)
 *     ollama.mjs     ← the PERMISSIVE leg (grades against `wantOllama`)
 *     lib/cli.mjs    ← shared bootstrap (tsx loader, flags, facade loader, phases 1/3)
 *     probe.mjs      ← legacy all-in-one, kept for continuity
 *
 * ─── The two provider invariants ────────────────────────────────────────────
 * (1) An assistant message carrying `tool_calls` MUST be followed by tool
 *     messages answering EACH `tool_call_id`, before any other role appears.
 * (2) A `tool` message MUST answer a tool_call_id announced by a preceding
 *     assistant — a tool result may never appear first, twice, or unannounced.
 * A third, measured rule: the conversation may not END with an unanswered
 * `tool_calls` block — there is no legal in-flight wire state.
 *
 * Ollama tolerates all of them; DeepSeek enforces them. That is why the defect
 * survived on the dev provider.
 *
 * ─── Usage ──────────────────────────────────────────────────────────────────
 *   node scripts/tp-violation/main.mjs                        # default: deepseek
 *   node scripts/tp-violation/main.mjs --provider=deepseek
 *   node scripts/tp-violation/main.mjs --provider=ollama
 *   node scripts/tp-violation/main.mjs --provider=both        # run both legs
 *   node scripts/tp-violation/main.mjs --provider=deepseek --sequences
 *   node scripts/tp-violation/main.mjs --mock                 # offline (phase 1)
 *
 * Exit 0 when every selected leg is conclusive, 1 otherwise.
 */
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flagOf = (n) => argv.find((a) => a.startsWith(`--${n}=`))?.split('=')[1];
const PROVIDER = flagOf('provider') ?? 'deepseek';

/** Forward everything EXCEPT `--provider`, which selects the leg itself. */
const forwarded = argv.filter((a) => !a.startsWith('--provider='));

const LEGS = { deepseek: 'deepseek.mjs', ollama: 'ollama.mjs' };

function runLeg(script) {
  return new Promise((resolve) => {
    // `--import tsx` so the child can load the TypeScript provider layer; the
    // legs also self-register tsx via lib/cli.mjs, but the loader must be in
    // force before the child's first static import graph links.
    const child = spawn(process.execPath, ['--import', 'tsx', join(HERE, script), ...forwarded], { stdio: 'inherit' });
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

const selected = PROVIDER === 'both' ? ['deepseek', 'ollama'] : [PROVIDER];
for (const p of selected) {
  if (!LEGS[p]) {
    console.error(`unknown provider "${p}" — expected one of: deepseek, ollama, both`);
    process.exit(2);
  }
}

let worst = 0;
for (const p of selected) {
  if (selected.length > 1) console.log(`\n\n████ ${p.toUpperCase()} LEG ████`);
  const code = await runLeg(LEGS[p]);
  if (code !== 0) worst = code;
}
process.exit(worst);
