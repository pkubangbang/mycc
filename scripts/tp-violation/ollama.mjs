#!/usr/bin/env node
/**
 * tp-violation / ollama — the PERMISSIVE provider leg, across MODELS.
 *
 * Posts all 55 sequences in `lib.mjs` to live Ollama and grades each against
 * `wantOllama`. Ollama enforces NEITHER tool-call pairing invariant, so the
 * expected verdict is 55 ACCEPTED / 0 REJECTED for EVERY model — the asymmetry
 * with DeepSeek is the whole reason the defect survived on the dev provider.
 *
 * This leg runs the matrix once per model in `OLLAMA_MODELS` (default:
 * `deepseek-v4.1-flash:cloud` and `gemma4:cloud`), because "Ollama tolerates
 * it" is a claim about the SERVING LAYER, and must not silently depend on which
 * model happened to be configured. Override or extend with `--ollama-models=a,b`.
 *
 *   node scripts/tp-violation/ollama.mjs                          # all models
 *   node scripts/tp-violation/ollama.mjs --ollama-models=gemma4:cloud
 *   node scripts/tp-violation/ollama.mjs --sequences
 *   node scripts/tp-violation/ollama.mjs --verbose
 *
 * Exit 0 when EVERY model is conclusive; 1 on transport errors or if any model
 * rejects a shape (which would mean the permissive-provider assumption drifted).
 */
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { REPO, VERBOSE, registerTsx, flag } from './lib/cli.mjs';
import { SEQUENCES, wantFor, isIllegal, describe } from './lib.mjs';

export const PROVIDER = 'ollama';

/** The models this leg must clear. A comma list via `--ollama-models=` overrides. */
export const OLLAMA_MODELS = (flag('ollama-models') ?? 'deepseek-v4.1-flash:cloud,gemma4:cloud')
  .split(',')
  .map((m) => m.trim())
  .filter(Boolean);

await registerTsx();

// The provider layer reads API_PROVIDER (not our --provider flag), so pin it
// BEFORE importing chat-provider.ts. Without this the process silently uses
// whatever ~/.mycc-store/.env says and the leg could misroute.
process.env.API_PROVIDER = PROVIDER;

let retryChat, loadEnv;
{
  const load = async (rel) => import(pathToFileURL(join(REPO, rel)).href);
  ({ retryChat } = await load('src/engine/chat-provider.ts'));
  ({ loadEnv } = await load('src/config.ts'));
  loadEnv();
}

let inconclusive = 0;

/**
 * Ollama's tolerance split is the point of this leg: it answers HTTP 200 for
 * sequences DeepSeek rejects. Only record REJECTED when the failure is a real
 * provider rejection; anything else is a transport error.
 */
export async function post(messages, model) {
  try {
    const resp = await retryChat(
      { model, messages, tools: [], think: false },
      { signal: AbortSignal.timeout(120000) },
    );
    return { status: 'ACCEPTED', detail: `reply: ${String(resp?.message?.content ?? '').replace(/\s+/g, ' ').slice(0, 60)}` };
  } catch (err) {
    const code = err?.status ?? err?.statusCode;
    const msg = String(err?.message ?? err);
    const rejected =
      /40\d/.test(String(code)) ||
      /API error 4\d\d|invalid_request_error|must be followed by tool messages|must be a response to a preceding message/i.test(msg);
    if (!rejected) inconclusive++;
    return { status: rejected ? 'REJECTED' : 'TRANSPORT-ERROR', detail: msg.replace(/\s+/g, ' ').slice(0, 170) };
  }
}

/** Run the 55-case matrix once against ONE model; returns its tally. */
export async function runSequences(model) {
  console.log(`\n── phase 4: sequence matrix vs LIVE ${PROVIDER} model="${model}" (${SEQUENCES.length} cases) ──\n`);
  let accepted = 0, rejected = 0, mismatches = 0, wrong = 0;

  for (const c of SEQUENCES) {
    process.stdout.write(`  ${c.name}... `);
    const r = await post(c.msgs, model);
    const localVerdict = isIllegal(c.msgs) ? 'illegal' : 'legal';
    const want = wantFor(c, PROVIDER, model);
    const informative = r.status !== 'TRANSPORT-ERROR';
    const agrees = want === localVerdict;
    const providerOk = informative && r.status === (want === 'legal' ? 'ACCEPTED' : 'REJECTED');

    if (r.status === 'ACCEPTED') accepted++;
    else if (r.status === 'REJECTED') rejected++;
    if (!agrees) mismatches++;
    if (informative && !providerOk) wrong++;

    const tag = !informative ? '???' : providerOk ? 'ok ' : 'BAD';
    if (VERBOSE || tag !== 'ok ' || !agrees) {
      console.log(`${r.status}  [${tag}]${agrees ? '' : `  ← EXPECTATION MISMATCH (expected ${want}, local checker says ${localVerdict})`}`);
      console.log(`          ${describe(c.msgs)}`);
      console.log(`          ${r.detail}`);
    } else {
      console.log(`${r.status}  [${tag}]`);
    }
  }

  console.log(`\n── phase 4 verdict (${PROVIDER} / ${model}) ──`);
  console.log(`  cases: ${SEQUENCES.length}   accepted: ${accepted}   rejected: ${rejected}`);
  console.log(`  expectation mismatches: ${wrong}   checker-vs-provider mismatches: ${mismatches}`);
  if (mismatches > 0) {
    // EXPECTED, not a failure: `isIllegal()` models the STRICT provider, so it
    // flags every shape DeepSeek rejects. Ollama accepts those by design — that
    // disagreement IS the finding. (The deepseek leg is where the checker must
    // agree on all 55.)
    console.log(`  ↳ the ${mismatches} "mismatches" are EXPECTED: isIllegal() models the strict`);
    console.log(`    provider, and ${model} accepts those ${mismatches} shapes by design.`);
  }

  // Symmetric guard: the permissive provider is expected to accept EVERY shape.
  // A rejection here means the model/config drifted and the "Ollama tolerates
  // it" assumption no longer holds.
  if (rejected > 0) {
    console.log(`\n  ⚠ ${rejected} case(s) REJECTED by ${model} — the permissive provider was`);
    console.log('    expected to accept every shape. Check model/config drift.');
    inconclusive++;
  }
  return { model, wrong, mismatches, accepted, rejected };
}

export async function main() {
  console.log('\n═══ tp-violation probe ═══');
  console.log(`provider: ${PROVIDER}   models: ${OLLAMA_MODELS.join(', ')}`);
  console.log('facade:   real Triologue (never hand-mocked)\n');

  const results = [];
  for (const model of OLLAMA_MODELS) results.push(await runSequences(model));

  console.log('\n═══ summary ═══');
  console.log(`  provider                    : ${PROVIDER}`);
  for (const r of results) {
    console.log(`  ${r.model.padEnd(28)}: ${r.accepted} accepted / ${r.rejected} rejected  (expectation mismatches: ${r.wrong})`);
  }
  console.log(`  transport errors            : ${inconclusive}`);
  const ok = inconclusive === 0 && results.every((r) => r.wrong === 0);
  console.log(`\n  ${ok ? 'CONCLUSIVE ✓' : 'INCONCLUSIVE ✗'}\n`);
  return ok ? 0 : 1;
}

// Entry point: run only when invoked directly (`node --import tsx ollama.mjs`),
// not when imported by another module.
if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('tp-violation/ollama.mjs')) {
  process.exit(await main());
}
