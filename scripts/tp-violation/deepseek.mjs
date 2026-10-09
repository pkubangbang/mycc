#!/usr/bin/env node
/**
 * tp-violation / deepseek — the STRICT provider leg.
 *
 * Posts all 55 sequences in `lib.mjs` to live DeepSeek and grades each against
 * `wantDeepseek` (the DEEPSEEK expectation). DeepSeek enforces both tool-call pairing
 * invariants, so the measured verdict is 23 ACCEPTED / 32 REJECTED.
 *
 *   node scripts/tp-violation/deepseek.mjs              # all phases
 *   node scripts/tp-violation/deepseek.mjs --sequences  # phase 4 only
 *   node scripts/tp-violation/deepseek.mjs --verbose
 *
 * Exit 0 when conclusive; 1 on transport errors, a missed expectation, or the
 * all-accepted fingerprint (see the guard in `runSequences`).
 */
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { HERE, REPO, OFFLINE, ONLY_SEQ, VERBOSE, registerTsx, loadFacade } from './lib/cli.mjs';
import { SEQUENCES, wantFor, isIllegal, describe } from './lib.mjs';

export const PROVIDER = 'deepseek';

registerTsx();

// The provider layer reads API_PROVIDER (not our --provider flag), so pin it
// BEFORE importing chat-provider.ts. Without this the process defaults to
// ollama (from ~/.mycc-store/.env) and a "deepseek" run silently posts to the
// permissive provider — all 55 accepted, a clean sweep that proves nothing.
process.env.API_PROVIDER = PROVIDER;

let retryChat, MODEL, loadEnv;
{
  const load = async (rel) => import(pathToFileURL(join(REPO, rel)).href);
  ({ retryChat, MODEL } = await load('src/engine/chat-provider.ts'));
  ({ loadEnv } = await load('src/config.ts'));
  loadEnv();
}

let inconclusive = 0;
let invariantBreaches = 0;

function makeFacade() {
  return new loadFacade().Triologue({ onMessage: () => {}, tokenThreshold: 50000, resultThreshold: 100000 });
}

async function post(messages) {
  try {
    const resp = await retryChat(
      { model: MODEL, messages, tools: [], think: false },
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

export async function runSequences() {
  console.log(`\n── phase 4: sequence matrix vs LIVE ${PROVIDER} (${SEQUENCES.length} cases) ──\n`);
  let accepted = 0, rejected = 0, mismatches = 0, wrong = 0;

  for (const c of SEQUENCES) {
    process.stdout.write(`  ${c.name}... `);
    const r = await post(c.msgs);
    const localVerdict = isIllegal(c.msgs) ? 'illegal' : 'legal';
    const wantDeepseek = wantFor(c, PROVIDER);
    const informative = r.status !== 'TRANSPORT-ERROR';
    const agrees = wantDeepseek === localVerdict;
    const providerOk = informative && r.status === (wantDeepseek === 'legal' ? 'ACCEPTED' : 'REJECTED');

    if (r.status === 'ACCEPTED') accepted++;
    else if (r.status === 'REJECTED') rejected++;
    if (!agrees) mismatches++;
    if (informative && !providerOk) wrong++;

    const tag = !informative ? '???' : providerOk ? 'ok ' : 'BAD';
    if (VERBOSE || tag !== 'ok ' || !agrees) {
      console.log(`${r.status}  [${tag}]${agrees ? '' : `  ← EXPECTATION MISMATCH (expected ${wantDeepseek}, local checker says ${localVerdict})`}`);
      console.log(`          ${describe(c.msgs)}`);
      console.log(`          ${r.detail}`);
    } else {
      console.log(`${r.status}  [${tag}]`);
    }
  }

  console.log(`\n── phase 4 verdict (${PROVIDER}) ──`);
  console.log(`  cases: ${SEQUENCES.length}   accepted: ${accepted}   rejected: ${rejected}`);
  console.log(`  expectation mismatches: ${wrong}   checker-vs-provider mismatches: ${mismatches}`);

  // Reproducibility guard: on the STRICT provider, everything-accepted is the
  // fingerprint of a silent failure — the bytes never reached DeepSeek (wrong
  // config, a permissive fallback, a misrouted request). A strict provider
  // cannot accept an interposed or orphaned tool block. Fail loudly.
  if (rejected === 0) {
    console.log('\n  ⚠ all cases ACCEPTED on deepseek — expected 32 rejections.');
    console.log('    A strict provider cannot accept an interposed/orphaned tool block,');
    console.log('    so this run never reached it. Treating as inconclusive.');
    inconclusive++;
  }
  return { wrong, mismatches, accepted, rejected };
}

export async function main() {
  console.log('\n═══ tp-violation probe ═══');
  console.log(`provider: ${PROVIDER}   model: ${MODEL}`);
  console.log('facade:   real Triologue (never hand-mocked)\n');

  const seq = await runSequences();

  console.log('\n═══ summary ═══');
  console.log(`  provider                    : ${PROVIDER}`);
  console.log(`  sequence cases              : ${SEQUENCES.length} (${seq.accepted} accepted / ${seq.rejected} rejected)`);
  console.log(`  expectation mismatches      : ${seq.wrong}`);
  console.log(`  checker blind spots         : ${seq.mismatches}`);
  console.log(`  transport errors            : ${inconclusive}`);
  const ok = inconclusive === 0 && seq.wrong === 0;
  console.log(`\n  ${ok ? 'CONCLUSIVE ✓' : 'INCONCLUSIVE ✗'}\n`);
  return ok ? 0 : 1;
}

// Entry point: run only when invoked directly (`node --import tsx deepseek.mjs`),
// not when imported by another module.
if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('tp-violation/deepseek.mjs')) {
  process.exit(await main());
}
