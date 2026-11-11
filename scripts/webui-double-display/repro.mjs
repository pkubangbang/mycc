/**
 * repro.mjs — automated loop for the "double [assistant] display" WebUI bug.
 *
 * ONE run = ONE attempt:
 *   1. serves a FRESH mycc on a spare port inside a THROWAWAY working
 *      directory (mycc keeps `./.mycc/sessions` under the cwd, so the run's
 *      journal and therefore /history contain only this run's query)
 *   2. opens the WebUI in agent-browser and waits for it to mount
 *   3. submits the query through the REAL composer (fill + click 发送)
 *   4. polls the rendered log until an assistant row exists, then waits for
 *      any trailing frame, and re-reads
 *   5. asserts: the assistant row is rendered EXACTLY ONCE and no two rows
 *      share a v-for key
 *   6. tears everything down and writes a JSON verdict
 *
 * Usage: node scripts/webui-double-display/repro.mjs --port 3291 --out v.json
 */
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO = resolve(import.meta.dirname, '../..');
const args = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const PORT = Number(argOf('port', '3291'));
const OUT = resolve(REPO, argOf('out', 'scripts/webui-double-display/verdict.json'));
const QUERY = argOf('query', 'Reply with exactly one short line and nothing else: icon button group fix.');
const SESSION = `doubledisp${PORT}`;
const BASE = `http://127.0.0.1:${PORT}`;

const verdict = { port: PORT, query: QUERY, steps: [], pass: false, reason: '', rows: [], error: null };
const step = (name, ok, detail) => {
  verdict.steps.push({ name, ok, detail: detail ?? '', at: Date.now() });
  console.log(`[${ok ? 'ok' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** One agent-browser command per call (its documented discipline). */
function browser(...a) {
  const win = process.platform === 'win32';
  try {
    return execFileSync('agent-browser', ['--session', SESSION, ...a], {
      encoding: 'utf8',
      timeout: 55000,
      windowsHide: true,
      // npm installs the CLI as a `.cmd` shim on Windows; spawning a .cmd
      // requires the shell (execFile without it fails EINVAL).
      shell: win
    });
  } catch (e) {
    return `__ERR__ ${e.stdout ?? ''} ${e.stderr ?? e.message}`;
  }
}
/** Evaluate JS in the page; agent-browser requires base64 for eval. */
function evalInPage(js) {
  const b64 = Buffer.from(js, 'utf8').toString('base64');
  const raw = browser('eval', '-b', b64);
  if (raw.startsWith('__ERR__')) return { error: raw };
  try {
    return JSON.parse(JSON.parse(raw.trim()));
  } catch {
    try {
      return JSON.parse(raw.trim());
    } catch {
      return { error: `unparsable eval output: ${raw.slice(0, 300)}` };
    }
  }
}

const READ_ROWS = `(() => {
  const rows = [...document.querySelectorAll('.chat-msg-row[data-msg-key]')];
  return JSON.stringify(rows.map((r) => ({
    key: r.getAttribute('data-msg-key'),
    label: (r.querySelector('.msg-label')?.textContent || '').trim(),
    text: (r.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 200)
  })));
})()`;
/** The assistant marker renders INSIDE the row text ("[12:10:47] [assistant] …"). */
const isAssistantRow = (x) => /\[assistant\]/.test(x.label) || /\[assistant\]/.test(x.text);

let child = null;
let workdir = null;

async function serveUp() {
  // A throwaway cwd: mycc's session store is `./.mycc/sessions`, so this run's
  // transcript is the only thing /history can project.
  workdir = mkdtempSync(join(tmpdir(), 'mycc-dd-'));
  mkdirSync(join(workdir, 'proj'), { recursive: true });
  child = spawn(
    process.execPath,
    [
      join(REPO, 'node_modules/tsx/dist/cli.mjs'),
      join(REPO, 'src/index.ts'),
      '--serve',
      String(PORT),
      '--skip-healthcheck'
    ],
    {
      cwd: join(workdir, 'proj'),
      env: { ...process.env, MYCC_SKIP_HEALTHCHECK: 'true' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    }
  );
  child.stdout.on('data', (d) => process.stdout.write(`  [mycc] ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`  [mycc!] ${d}`));
  for (let i = 0; i < 120; i++) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await sleep(1000);
  }
  return false;
}

async function main() {
  let rows = [];
  try {
    step('serve up', await serveUp(), `${BASE} (cwd ${workdir})`);
    if (!verdict.steps.at(-1).ok) throw new Error('serve did not come up');

    browser('open', `${BASE}/`);
    await sleep(2000);
    const boot = evalInPage(
      `JSON.stringify({ hasLog: !!document.querySelector('.chat-log'), send: !!document.querySelector('.send-btn') })`
    );
    step('webui mounted', !boot.error && boot.hasLog === true, JSON.stringify(boot));
    if (boot.error || !boot.hasLog) throw new Error(`webui did not mount: ${JSON.stringify(boot)}`);

    browser('fill', '.composer-box__textarea', QUERY);
    browser('click', '.send-btn');
    step('query sent', true, QUERY);

    for (let i = 0; i < 90; i++) {
      await sleep(1000);
      const r = evalInPage(READ_ROWS);
      if (r.error || !Array.isArray(r)) continue;
      rows = r;
      if (rows.some(isAssistantRow)) {
        // HOLD: the duplicate seen in the field arrived ~1 s AFTER the first
        // copy, so re-read on several consecutive passes and keep the widest
        // view. A single trailing read would race the second frame.
        for (let k = 0; k < 6; k++) {
          await sleep(1000);
          const again = evalInPage(READ_ROWS);
          if (!again.error && Array.isArray(again) && again.length > rows.length) rows = again;
        }
        break;
      }
    }
    const assistants = rows.filter(isAssistantRow);
    const keys = rows.map((r) => r.key);
    const dupKeys = keys.filter((k, i) => keys.indexOf(k) !== i);
    // A TURN may answer more once (one paragraph per tool round), so the
    // invariant is not "one assistant row" — it is "no assistant paragraph
    // rendered twice". Strip the [time] [assistant] header and the action
    // labels, then look for repeated bodies.
    const body = (t) =>
      t
        .replace(/^.*?\[assistant\]\s*/, '')
        .replace(/\s*(下载|复制|引用)+\s*$/, '')
        .trim();
    const bodies = assistants.map((a) => body(a.text));
    const twins = [...new Set(bodies.filter((b) => b && bodies.indexOf(b) !== bodies.lastIndexOf(b)))];

    step('assistant row rendered', assistants.length >= 1, `${assistants.length} assistant row(s)`);
    step(
      'no assistant paragraph rendered twice',
      twins.length === 0,
      twins.map((t) => t.slice(0, 60)).join(' | ') || 'none'
    );
    step('no duplicate v-for keys', dupKeys.length === 0, dupKeys.join(', ') || 'none');

    verdict.pass = verdict.steps.every((s) => s.ok);
    verdict.reason = verdict.pass ? 'no duplicate assistant display' : 'an assistant paragraph was rendered twice';
  } catch (e) {
    verdict.error = String(e?.stack ?? e);
    verdict.reason = verdict.reason || 'harness error';
  } finally {
    verdict.rows = rows;
    browser('close');
    if (child) {
      child.kill();
      await sleep(1200);
    }
    // EVIDENCE: keep the run's transcript and dump every journal record that
    // carries assistant prose, so a twin row can be traced to the two records
    // (and their `kind` / `seq` / `echoOf`) that produced it.
    const records = [];
    if (workdir) {
      const walk = (dir) => {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
          const p = join(dir, e.name);
          if (e.isDirectory()) walk(p);
          else if (e.name.endsWith('.jsonl')) {
            readFileSync(p, 'utf8')
              .split('\n')
              .filter(Boolean)
              .forEach((line, i) => {
                let rec;
                try {
                  rec = JSON.parse(line);
                } catch {
                  return;
                }
                if (rec.kind === 'note' || rec.role === 'assistant' || rec.note) {
                  records.push({
                    file: e.name,
                    line: i + 1,
                    kind: rec.kind,
                    role: rec.role,
                    seq: rec.seq,
                    echoOf: rec.note?.echoOf,
                    label: rec.note?.tool,
                    text: String(rec.content ?? rec.note?.text ?? rec.message?.content ?? '').slice(0, 90)
                  });
                }
              });
          }
        }
      };
      try {
        walk(workdir);
      } catch (e) {
        verdict.evidenceError = String(e);
      }
      verdict.journal = records;
      verdict.keptWorkdir = workdir; // always keep for evidence
    }
    writeFileSync(OUT, JSON.stringify(verdict, null, 2));
    console.log(`\nVERDICT: ${verdict.pass ? 'PASS' : 'FAIL'} — ${verdict.reason}`);
    if (verdict.keptWorkdir) console.log(`kept: ${verdict.keptWorkdir}`);
    console.log(rows.map((r) => `  ${r.key} [${r.label}] ${r.text}`).join('\n'));
    console.log('--- journal records touching assistant prose ---');
    console.log(
      records
        .map(
          (r) =>
            `  ${r.line} kind=${r.kind} role=${r.role} seq=${r.seq} echoOf=${r.echoOf} label=${r.label} :: ${r.text}`
        )
        .join('\n')
    );
    process.exit(verdict.pass ? 0 : 1);
  }
}

void main();
