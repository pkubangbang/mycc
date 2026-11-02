/**
 * /share — bind and inspect filesync shared folders (docs/peers/filesync.md).
 *
 * Usage:
 *   /share                 — list bound shares + partners + conflicts
 *   /share <id>            — bind a share (creates .mycc/filesync/<id>/)
 *   /share <id> --unbind   — stop syncing a share (folder + files stay)
 *
 * The share id is a capability secret: every wired peer announcing the same
 * id is a sync partner (all members read-write). Local ops on
 * `.mycc/filesync/<id>/` (cp / rm / edit_file) sync automatically.
 */

import type { SlashCommand } from '../types.js';
import chalk from 'chalk';
import { getFilesyncManager } from '../peer/filesync/manager.js';
import { partnersForShare } from '../peer/wire-registry.js';
import { isDebugFilesync } from '../config.js';

const SHARE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export const shareCommand: SlashCommand = {
  name: 'share',
  description: 'Bind/inspect filesync shared folders (synced across wired peers)',
  handler: (context) => {
    const { args, ctx } = context;
    const mgr = getFilesyncManager();
    if (!mgr) {
      console.log(chalk.red('filesync is not available (wire plane not initialized).'));
      return;
    }

    // /share <id> --unbind
    const rawId = args[1];
    const unbind = args.includes('--unbind');

    if (rawId && unbind) {
      if (!SHARE_ID_RE.test(rawId)) { console.log(chalk.red(`Invalid share id: ${rawId}`)); return; }
      const ok = mgr.unbind(rawId);
      console.log(ok ? chalk.yellow(`Unbound share ${rawId} (folder kept).`) : chalk.gray(`Share ${rawId} was not bound.`));
      return;
    }

    // /share <id> — bind
    if (rawId) {
      if (!SHARE_ID_RE.test(rawId)) { console.log(chalk.red(`Invalid share id: ${rawId} (use [A-Za-z0-9_-]{1,64})`)); return; }
      const e = mgr.bind(rawId);
      // Pinned share todo (info-symmetry): survives compaction so the lead
      // always knows the folder is synced and where conflict mail arrives.
      try {
        const todo = (ctx as { todo?: { createTodo(n: string, note: string): { id: number; hash: string }; pinTodo(id: number, hash: string, p: boolean): unknown } }).todo;
        todo?.pinTodo(
          ...(() => { const c = todo.createTodo(
            `share ${rawId} — .mycc/filesync/${rawId}/ synced folder; resolve [sync-conflict] mail when it arrives`,
            'filesync share — pinned reminder',
          ); return [c.id, c.hash] as [number, string]; })(),
          true,
        );
      } catch { /* best-effort */ }
      console.log(chalk.green(`Bound share ${chalk.bold(rawId)}`) + chalk.gray(` → ${e.root}`));
      console.log(chalk.gray(`Wired peers announcing ${rawId} sync automatically. Debug frames: ${isDebugFilesync() ? 'ON' : 'off (enable with --debug-filesync)'}.`));
      return;
    }

    // /share — list
    const shares = mgr.shares();
    if (!shares.length) {
      console.log(chalk.gray('No shares bound. Use /share <id> to bind one (or --share <id> / MYCC_SHARES at launch).'));
      return;
    }
    console.log(chalk.bold('filesync shares:'));
    for (const share of shares) {
      const engine = mgr.get(share);
      const partners = partnersForShare(share);
      const conflicts = engine ? [...engine.index.conflicts.values()] : [];
      console.log(`  ${chalk.cyan(share)}  root: .mycc/filesync/${share}/`);
      console.log(chalk.gray(`    partners: ${partners.length ? partners.join(', ') : '(none connected)'}`));
      if (conflicts.length) {
        console.log(chalk.yellow(`    conflicts: ${conflicts.length} (resolve [sync-conflict] mail)`));
        for (const c of conflicts) console.log(chalk.gray(`      ${c.relPath} — kept ${c.keptGen.sid}, lost ${c.loserSid}`));
      }
    }
  },
};
