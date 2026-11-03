/**
 * Project tool/skill HOT-RELOAD watcher (chokidar).
 *
 * The hand-rolled `fs.watch(root, …)` this replaced was a dirty-bit: any event
 * reloaded *something*, and — worse — a DELETED tool or skill stayed
 * registered for the life of the process because the callback only ever
 * reloaded. These tests pin the events chokidar delivers and what the loader
 * does with each one:
 *
 *   add / change  → reload the file (once per settle, not once per event)
 *   unlink        → the tool/skill DISAPPEARS from the registry
 *
 * The loader resolves `.mycc/tools` and `.mycc/skills` from the cwd, so each
 * test runs inside its own temp project. The probe reload hooks are replaced
 * so the test asserts the WATCHER's decisions without importing real tool
 * modules (that path is covered elsewhere).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Loader } from '../../context/shared/loader.js';

const SETTLE_MS = 1_200;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

let tmp: unknown;
let prevCwd: string;
beforeEach(() => {
  prevCwd = process.cwd();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hotreload-'));
  process.chdir(tmp as string);
  fs.mkdirSync(path.join('..', '.x'), { recursive: true }); // no-op, keeps path real
});
afterEach(() => {
  process.chdir(prevCwd);
  fs.rmSync(tmp as string, { recursive: true, force: true });
});

/** A loader whose reload paths are recorded instead of executed, sharing the
 *  real `watchDirectories` / `onHotFile` / forget logic under test. */
function probeLoader(): { loader: Loader; seen: string[] } {
  const loader = new Loader(true);
  const seen: string[] = [];
  const anyLoader = loader as unknown as {
    reloadTool: (f: string) => Promise<void>;
    reloadSkill: (f: string, layer: string) => void;
    tools: Map<string, { layer: string }>;
    skills: Map<string, { layer: string; skill: { sourceFile: string } }>;
  };
  anyLoader.reloadTool = async (f: string) => { seen.push(`tool:${path.basename(f)}`); };
  anyLoader.reloadSkill = (f: string) => { seen.push(`skill:${path.basename(f)}`); };
  return { loader, seen };
}

const toolSource = (name: string) =>
  `export default { name: '${name}', description: 'd', inputSchema: { type: 'object', properties: {} }, handler: async () => 'ok' };\n`;
const skillSource = (name: string) => `---\nname: ${name}\ndescription: d\n---\nbody\n`;

describe('hot-reload watcher (chokidar)', () => {
  it('reloads an atomically saved tool exactly once (tmp + rename)', async () => {
    fs.mkdirSync('.mycc/tools', { recursive: true });
    fs.mkdirSync('.mycc/skills', { recursive: true });
    const { loader, seen } = probeLoader();
    loader.watchDirectories();
    await wait(300);

    // Editors save by writing a scratch file and renaming it into place: the
    // old fs.watch saw an unrelated pair of events, chokidar sees one add.
    fs.writeFileSync('.mycc/tools/.swap.tmp', toolSource('swap'));
    fs.renameSync('.mycc/tools/.swap.tmp', '.mycc/tools/swap.ts');
    await wait(SETTLE_MS);

    expect(seen).toEqual(['tool:swap.ts']);
    expect(fs.existsSync('.mycc/tools/.swap.tmp')).toBe(false);
    loader.stopWatching();
  });

  it('ignores deep files and non-entrypoint skill markdown', async () => {
    fs.mkdirSync('.mycc/tools/nested', { recursive: true });
    fs.mkdirSync('.mycc/skills/pkg', { recursive: true });
    const { loader, seen } = probeLoader();
    loader.watchDirectories();
    await wait(300);

    fs.writeFileSync('.mycc/tools/nested/deep.ts', toolSource('deep'));
    fs.writeFileSync('.mycc/skills/pkg/notes.md', 'not an entrypoint');
    await wait(SETTLE_MS);
    expect(seen).toEqual([]);

    // …while the real entrypoints in the same tree DO reload.
    fs.writeFileSync('.mycc/skills/pkg/SKILL.md', skillSource('pkg'));
    fs.writeFileSync('.mycc/skills/root.md', skillSource('root'));
    await wait(SETTLE_MS);
    expect(seen.sort()).toEqual(['skill:SKILL.md', 'skill:root.md']);
    loader.stopWatching();
  });

  it('drops a deleted tool and a deleted skill from the registry', async () => {
    fs.mkdirSync('.mycc/tools', { recursive: true });
    fs.mkdirSync('.mycc/skills/gone', { recursive: true });
    const { loader } = probeLoader();
    const typed = loader as unknown as {
      tools: Map<string, { layer: string }>;
      skills: Map<string, { layer: string; skill: { sourceFile: string } }>;
    };
    typed.tools.set('gone-tool', { layer: 'project' });
    typed.skills.set('gone-skill', { layer: 'project', skill: { sourceFile: 'project:gone/SKILL.md' } });
    fs.writeFileSync('.mycc/tools/gone-tool.ts', toolSource('gone-tool'));

    loader.watchDirectories();
    await wait(300);
    fs.unlinkSync('.mycc/tools/gone-tool.ts');
    fs.rmSync('.mycc/skills/gone', { recursive: true });
    await wait(SETTLE_MS);

    expect(typed.tools.has('gone-tool')).toBe(false);
    expect(typed.skills.has('gone-skill')).toBe(false);
    loader.stopWatching();
  });

  it('stopWatching() detaches: later file writes reload nothing', async () => {
    fs.mkdirSync('.mycc/tools', { recursive: true });
    fs.mkdirSync('.mycc/skills', { recursive: true });
    const { loader, seen } = probeLoader();
    loader.watchDirectories();
    await wait(300);
    loader.stopWatching();
    fs.writeFileSync('.mycc/tools/after.ts', toolSource('after'));
    await wait(SETTLE_MS);
    expect(seen).toEqual([]);
    vi.clearAllTimers();
  });
});
