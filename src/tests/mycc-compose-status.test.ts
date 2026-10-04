/**
 * mycc-compose-status.test.ts — `status --json` must be DETERMINISTIC.
 *
 * The command and docs/peer-topology.md both call the JSON report
 * deterministic: two identical invocations against the same on-disk state must
 * produce byte-identical JSON. A wall-clock `generatedAt` field broke that
 * (two runs a millisecond apart differ). This suite pins the fix: the
 * machine-readable report carries NO timestamp, and two consecutive runs are
 * byte-identical; the human-readable form may still print a timestamp.
 *
 * Seams: cmd-status reads the spec file (validateSpec(loadSpec(file))), so we
 * write a real spec into a temp dir. The peer/channel status rows depend on the
 * discovery store; we point MYCC_DISCOVERY_DIR at an empty temp store so both
 * runs see identical (empty) state, isolate from the real ~/.mycc-store, and
 * the only variable left would be a timestamp — which must be absent.
 * process.exit and process.stdout.write are stubbed.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const SID = 'abcdefab-1111-4111-8111-111111111111';

let tmp = '';
let specFile = '';

async function loadCmdStatus() {
  vi.resetModules();
  return import('../../scripts/mycc-compose/lib/cmd-status.js');
}

function captureStdout(): { text: () => string; restore: () => void } {
  let buf = '';
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    buf += String(chunk);
    return true;
  });
  return { text: () => buf, restore: () => spy.mockRestore() };
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mycc-compose-status-'));
  process.env.MYCC_DISCOVERY_DIR = path.join(tmp, 'discovery');
  fs.mkdirSync(process.env.MYCC_DISCOVERY_DIR, { recursive: true });
  specFile = path.join(tmp, 'spec.json');
  fs.writeFileSync(
    specFile,
    JSON.stringify({
      group: 'g',
      peers: [{ name: 'a', workdir: 'C:/Proj/mycc', args: '--auto', sessionId: SID }],
      channels: [],
    }),
  );
});

afterEach(() => {
  delete process.env.MYCC_DISCOVERY_DIR;
  vi.restoreAllMocks();
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

describe('cmdStatus --json: deterministic', () => {
  it('produces byte-identical JSON on two consecutive runs (no timestamp)', async () => {
    const mod = await loadCmdStatus();
    // cmdStatus writes the JSON then calls process.exit(0). Mocking exit as a
    // no-op would let execution fall through into the human-readable branch and
    // pollute the capture with a timestamped line, so make exit HALT by throwing
    // a sentinel we swallow — exactly what a real exit does.
    const sentinel = new Error('__exit__');
    vi.spyOn(process, 'exit').mockImplementation(() => {
      throw sentinel;
    });

    const run = (): string => {
      const cap = captureStdout();
      try {
        mod.cmdStatus(specFile, true);
      } catch (e) {
        if (e !== sentinel) throw e;
      } finally {
        cap.restore();
      }
      return cap.text();
    };

    const first = run();
    // Ensure the wall clock advances so any timestamp would differ.
    await new Promise((r) => setTimeout(r, 5));
    const second = run();

    expect(first).toBe(second);
    const parsed = JSON.parse(first);
    expect(parsed).not.toHaveProperty('generatedAt');
    expect(parsed.group).toBe('g');
  });
});
