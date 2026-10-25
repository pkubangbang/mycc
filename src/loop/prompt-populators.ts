/**
 * prompt-populators.ts - Project-context populators delivering live environment
 * sections (platform + calendar) to the LLM.
 *
 * These two sections (## Platform and ## Calendar) were historically baked into
 * the system prompt by prompts/common.ts via buildCommonSections() and rebuilt on
 * EVERY LLM call. But the system prompt is the FIRST tokens of the prompt-cache
 * prefix (system + projectContext + conversation + tools), so any change to it
 * mid-session (e.g. the date rolling over at midnight, or the coordinator PID)
 * invalidated the entire DeepSeek/Ollama prompt cache every turn.
 *
 * Moving them into a project-context populator (the pattern introduced in commit
 * ab73acc "refactor(projectContext): rebuild via populator registry on
 * compact/clear") freezes them between compact()/clear() boundaries — where the
 * conversation prefix already changes, so refreshing costs no cache penalty —
 * while keeping them delivered to the LLM in full. Between boundaries the
 * projectContext is byte-identical, so the cached prefix stays hot.
 *
 * This module exports ONE pure function, buildPlatformCalendarMessages()
 * (following the buildHookInfoMessages pattern from hook-bootstrap.ts), so both
 * the lead (agent-repl.ts) and teammate children (teammate-worker.ts) can
 * register it as a projectContext populator closure.
 */

import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { getShellInfo, type ShellKind } from '../utils/shell-detect.js';
import type { Message, TodoModule } from '../types.js';

// ============================================================================
// Platform Detection
// ============================================================================

function getPlatformInfo(): {
  platform: string;
  shell: string;
  pathSep: string;
  home: string;
  escapeChar: string;
  /** The detected shell kind, for per-shell prompt tailoring. */
  shellKind: ShellKind;
} {
  const info = getShellInfo();

  // Exhaustive per-shell labels — no catch-all default. If a new ShellKind is
  // added without a branch here, this throws loudly instead of silently
  // emitting a wrong/generic label.
  let shellLabel: string;
  if (info.shell === 'pwsh7') {
    shellLabel = 'PowerShell 7 (pwsh)';
  } else if (info.shell === 'powershell5') {
    shellLabel = 'PowerShell 5.1 (powershell)';
  } else if (info.shell === 'zsh') {
    shellLabel = 'zsh';
  } else if (info.shell === 'bash') {
    shellLabel = 'bash';
  } else {
    throw new Error(`getPlatformInfo: unknown shell kind '${info.shell as string}'`);
  }

  return {
    platform: info.platform,
    shell: shellLabel,
    pathSep: info.isWin ? 'backslash (\\)' : 'forward slash (/)',
    home: os.homedir(),
    escapeChar: info.isWin ? 'backtick (`)' : 'backslash (\\)',
    shellKind: info.shell,
  };
}

// ============================================================================
// Calendar Section
// ============================================================================

function buildCalendarSection(): string {
  const now = new Date();
  const currentDate = now.toISOString().split('T')[0];
  const currentYear = now.getFullYear();
  return `## Calendar\nCurrent date: ${currentDate} (year: ${currentYear})`;
}

// ============================================================================
// Platform Section
// ============================================================================

function buildPlatformSection(): string {
  const info = getPlatformInfo();

  // Exhaustive per-shell guidance — no catch-all default. Each known ShellKind
  // gets its own branch; an unknown kind throws so a new shell added without a
  // prompt branch fails loudly instead of emitting generic/wrong guidance.
  let shellCommands: string;
  if (info.shellKind === 'pwsh7') {
    shellCommands = '- Use PowerShell 7 (pwsh) syntax: `Get-Content file`, `Copy-Item src dest`\n- The bash tool executes commands via pwsh (not cmd). Multiple commands should be concatenated using ";"; `&&`/`||` chaining also works in pwsh 7.\n- pwsh 7 defaults to UTF-8 without BOM for both file reads and writes, so `Get-Content`/`Set-Content`/`Out-File` are UTF-8-safe by default (no mojibake, no BOM). Prefer the built-in `read_file`/`edit_file` tools which handle UTF-8 automatically.';
  } else if (info.shellKind === 'powershell5') {
    shellCommands = '- Use Windows PowerShell 5.1 syntax: `Get-Content file`, `Copy-Item src dest`\n- The bash tool executes commands via Windows PowerShell 5.1 (not cmd). Note that multiple commands should be concatenated using ";", not "&&" (5.1 lacks `&&`/`||` pipeline operators).\n- **File encoding (avoid mojibake):** `Get-Content`/`Set-Content` default to the system ANSI codepage on Windows PowerShell 5.1, garbling UTF-8 files with non-ASCII chars. ALWAYS pass `-Encoding UTF8` when reading/writing source files (e.g. `Get-Content file -Encoding UTF8`). Prefer the built-in `read_file`/`edit_file` tools which handle UTF-8 automatically.\n- **BOM trap (PowerShell 5.1):** `Set-Content -Encoding UTF8` prepends a UTF-8 BOM (EF BB BF) that corrupts formats needing pure ASCII headers (e.g. `jar cfm` fails with `invalid header field name`). For no-BOM writes use `[IO.File]::WriteAllText($path, $content, [Text.UTF8Encoding]::new($false))`. The `write_file` tool already writes UTF-8 without a BOM (pass `bom: true` only when needed).\n- Note: the bash tool already sets the default write encoding of `Set-Content`/`Add-Content`/`Out-File` to no-BOM UTF-8 via `$PSDefaultParameterValues`; an explicit `-Encoding UTF8` still writes a BOM, so prefer `[IO.File]::WriteAllText` or the built-in tools for no-BOM writes.';
  } else if (info.shellKind === 'zsh' || info.shellKind === 'bash') {
    shellCommands = '- Use bash/zsh syntax: `cat file`, `cp src dest`';
  } else {
    throw new Error(`buildPlatformSection: unknown shell kind '${info.shellKind as string}'`);
  }

  let escaping: string;
  if (info.shellKind === 'pwsh7' || info.shellKind === 'powershell5') {
    escaping = '- In PowerShell: use backtick ` to escape special chars (e.g., `$ for literal $)';
  } else if (info.shellKind === 'zsh' || info.shellKind === 'bash') {
    escaping = '- In bash/zsh: use backslash \\ to escape (e.g., \\$ for $)';
  } else {
    throw new Error(`buildPlatformSection: unknown shell kind '${info.shellKind as string}'`);
  }

  // --- Process PIDs ---
  // Expose the lead's own PID and the coordinator (parent) PID so the LLM
  // can avoid killing them when stopping dev servers or running broad kill
  // commands. The coordinator PID is injected by index.ts via env var; the
  // lead's own PID is available via process.pid.
  const coordinatorPid = process.env.MYCC_COORDINATOR_PID;
  const pidLines: string[] = [
    '',
    '### Process PIDs',
    `Your own process PID: ${process.pid}`,
  ];
  if (coordinatorPid) {
    pidLines.push(
      `Coordinator (parent) PID: ${coordinatorPid}`,
      '',
      '**WARNING**: Never kill the coordinator PID or your own PID. Killing the coordinator',
      'will terminate your own process as well. When stopping dev servers or running broad',
      'kill commands (e.g. `taskkill /F`, `kill $(lsof -t -i:PORT)`), always exclude these PIDs.',
    );
  } else {
    pidLines.push(
      '',
      'NOTE: Coordinator PID is not available. Be cautious when running broad kill commands',
      '— avoid killing processes you did not start.',
    );
  }

  return [
    '## Platform',
    `Platform: ${info.platform}`,
    `Shell: ${info.shell}`,
    `Path separator: ${info.pathSep}`,
    `Escape character: ${info.escapeChar}`,
    `Home: ${info.home}`,
    '',
    '### Shell Commands',
    shellCommands,
    '- Always use forward slashes (/) in file paths for cross-platform compatibility',
    '- Prefer relative paths. If you must use absolute paths, use forward slashes.',
    '',
    '### Escaping',
    escaping,
    '- For JSON/strings: use double quotes and escape inner quotes with backslash',
    '- When in doubt: use single quotes for literal strings in bash/zsh, double quotes in PowerShell',
    ...pidLines,
  ].join('\n');
}

// ============================================================================
// Public populator
// ============================================================================

/**
 * Build the platform + calendar projectContext deliverable as a user/assistant
 * pair. Register this via triologue.registerProjectContextPopulator(() =>
 * buildPlatformCalendarMessages()). The content is held steady between rebuilds
 * by the populator registry, so the prompt-cache prefix stays hot.
 *
 * Section order matches the original inline prompt composition: Platform before
 * Calendar.
 */
export function buildPlatformCalendarMessages(): Message[] {
  const content =
    `[System - Platform & Calendar]\n\n` +
    `${buildPlatformSection()}\n\n` +
    `${buildCalendarSection()}`;
  return [
    { role: 'user', content },
    {
      role: 'assistant',
      content:
        'Understood. I have noted the current date and platform/shell environment.',
    },
  ];
}

// ============================================================================
// Skill Keywords
// ============================================================================

// NOTE: The skill-keywords list is NO LONGER delivered via a project-context
// populator here. It was folded into extractKeywords() (now a private method
// on the SkillSuggester class in src/loop/states/collect-skill.ts):
// the extraction LLM call now receives the available skill keywords as a
// system-message input (so the LLM selects relevant keywords FROM the actual
// available list based on the X+Y+Z composite), instead of a separate
// always-on project-context populator that injected the full keyword list
// into the byte-stable system prompt. This removes a dynamic-content
// injection that broke the prompt-cache prefix on every skill reload
// (see the "do not inject dynamic content into projectContext" pitfall) and
// consolidates skill discovery into a single LLM-driven path
// (skillSuggester.suggestSkill in collect.ts step 6).

// ============================================================================
// node_modules Detection
// ============================================================================

/**
 * Build the node_modules exclusion reminder as a projectContext deliverable.
 *
 * The grep tool already auto-excludes node_modules (via ALWAYS_EXCLUDE_DIRS
 * in grep-search.ts), but the bash tool does NOT — and the LLM frequently
 * uses `ls` / `Get-ChildItem` via bash to explore the working directory,
 * which would dump thousands of node_modules entries. This populator detects
 * whether node_modules/ exists in the cwd and, if so, emits a reminder.
 *
 * The existence check runs at registration time and at every rebuild
 * (compact/clear boundary), not on every LLM call — so the prompt-cache
 * prefix stays stable between rebuilds. This matches the README populator
 * pattern (re-reads from disk on every rebuild) and the pitfall rule that
 * projectContext must be stable between rebuild boundaries.
 *
 * Returns an empty array when node_modules/ does not exist, so no messages
 * are injected for non-Node.js projects (a zero-cost no-op).
 */
export function buildNodeModulesReminderMessages(): Message[] {
  const nodeModulesPath = path.join(process.cwd(), 'node_modules');
  if (!fs.existsSync(nodeModulesPath)) return [];

  const content =
    `[System - node_modules detected]\n\n` +
    `A "node_modules" directory exists in the project root. This directory ` +
    `contains thousands of installed dependency files and should NEVER be ` +
    `listed or searched directly.\n\n` +
    `When using the bash tool for ls/directory listing:\n` +
    `- Exclude node_modules from recursive listings. On Unix: ` +
    `\`ls --ignore=node_modules\` or \`find . -not -path '*/node_modules/*'\`. ` +
    `On Windows PowerShell: \`Get-ChildItem -Recurse | Where-Object { $_.FullName -notmatch 'node_modules' }\`.\n\n` +
    `When using grep: the grep tool already auto-excludes node_modules, ` +
    `so prefer it over bash grep.\n\n` +
    `When using bash grep (fallback): always add --exclude-dir=node_modules ` +
    `(Unix) or pipe through \`Where-Object { $_ -notmatch 'node_modules' }\` ` +
    `(Windows PowerShell).`;

  return [
    { role: 'user', content },
    {
      role: 'assistant',
      content:
        'Understood. I will exclude node_modules from ls and grep commands ' +
        'to avoid listing or searching installed dependencies.',
    },
  ];
}

// ============================================================================
// Wiki Domains
// ============================================================================

/**
 * Build the live wiki-domain list as a projectContext deliverable.
 *
 * The wiki_get tool requires a valid `domain` argument, but the domain set is
 * per-project state (registered via wiki_prepare / wiki_put) and was previously
 * not surfaced anywhere: the tool description just told the LLM the domain was
 * "unknown at start, but you will find it during chat". This populator puts the
 * ACTUAL registered domain names in front of the agent so it stops inventing
 * domains (a failed lookup wastes a tool round-trip).
 *
 * The domain list is read through loadDomains() (domains.json) at registration
 * time and at every rebuild (compact/clear boundary) — NOT on every LLM call —
 * so the prompt-cache prefix stays byte-stable between rebuilds. This mirrors
 * the README populator (re-reads from disk on each rebuild) and the pitfall
 * rule that projectContext must not carry dynamic content between boundaries.
 *
 * Returns an empty array when there are no domains, so nothing is injected for
 * a project that has not registered any wiki domain yet (a zero-cost no-op).
 */
export function buildWikiDomainsMessages(
  domains: Array<{ domain_name: string; description?: string }>,
): Message[] {
  if (domains.length === 0) return [];

  const lines = domains.map((d) => {
    const description = d.description ?? '';
    return description.length > 0 ? `- ${d.domain_name}: ${description}` : `- ${d.domain_name}`;
  });

  const content =
    `[System - Wiki Domains]\n\n` +
    `The following wiki domains are registered for this project. When calling ` +
    `wiki_get, you MUST pass the \`domain\` param as one of these exact names — ` +
    `never invent a domain.\n\n` +
    `${lines.join('\n')}`;

  return [
    { role: 'user', content },
    {
      role: 'assistant',
      content: 'Understood. I will only query wiki_get with one of these registered domains.',
    },
  ];
}

// ============================================================================
// Collaboration Mechanisms
// ============================================================================

/**
 * Build the "similar collaboration mechanisms" map as a projectContext
 * deliverable. This populator helps the lead distinguish the four ways
 * agents can collaborate in mycc, which look similar (all route through
 * `mail_to`) but differ sharply in process model, scope, and mechanism:
 *
 *   1. Teammate  — same-session, in-process child agents (one instance).
 *   2. Peer      — cross-session but LOCAL (separate mycc on this machine).
 *   3. Remote    — cross-machine, via the webui peer wire (peer_connect).
 *   4. Compose   — a declarative TOPOLOGY FILE materializing a peer group.
 *
 * It names the governing skill for each so the agent can `skill_load` the
 * full procedure when it needs to wire agents together, rather than
 * improvising. This is a STATIC reference (no disk/env read): the four
 * mechanisms and their skills are stable tooling facts, so the content is
 * byte-identical between rebuilds and never breaks the prompt-cache prefix.
 *
 * LEAD-ONLY: registered in agent-repl.ts (the lead), NOT in
 * teammate-worker.ts. Teammates never spawn teammates/peers (tm_create,
 * broadcast, peer_connect are lead-only tools), so the map would be
 * misleading noise in a teammate's context. A lead, by contrast, is the
 * sole agent that can build a topology of any of the four kinds.
 */
export function buildCollaborationMessages(): Message[] {
  const content =
    `[System - Collaboration Mechanisms]\n\n` +
    `mycc offers FOUR ways agents collaborate. They look alike (all route ` +
    `mail through \`mail_to\`) but differ in process model, scope, and ` +
    `mechanism. The **lead** picks among them; teammates and peers cannot ` +
    `spawn or wire others (tm_create / broadcast / peer_connect / ` +
    `mycc-compose \`up\` are lead-only).\n\n` +
    `1. **Teammate (same-session)** — a child process of THIS lead, sharing ` +
    `this instance's session directory. Spawned with \`tm_create\`, driven ` +
    `with \`mail_to\`/\`broadcast\`/\`issue_*\`. Cheapest, tightest coupling; ` +
    `used for parallel subtasks inside one instance. Governed by the ` +
    `\`coordination\` skill.\n\n` +
    `2. **Peer (cross-session, LOCAL)** — a SEPARATE mycc instance on the ` +
    `SAME machine (its own session id, process, and context). Discovered via ` +
    `\`~/.mycc-store/discovery/\` (identity.json + heartbeats + channel ` +
    `files); addressed with \`mail_to(name="<session-id>/lead", ...)\`. Wiring ` +
    `is by on-disk channel files. Governed by the \`mediator\` skill.\n\n` +
    `3. **Remote (cross-machine, via webui)** — an instance on ANOTHER ` +
    `machine, connected over the dialed WebSocket peer wire with ` +
    `\`peer_connect(<host:port>)\` (requires the remote to be serving its ` +
    `webui); \`peer_list\` shows liveness, \`peer_disconnect\` hangs up. Same ` +
    `\`mail_to("<session-id>/lead")\` interface — the LLM does not care where ` +
    `the peer lives. See \`docs/peers/remote-peer-protocol.md\`.\n\n` +
    `4. **Compose (most complex, via a topology FILE)** — a declarative, ` +
    `no-LLM materializer for a WHOLE GROUP of peers: you write a JSON ` +
    `topology spec (peers + launch args + which channels link them) and the ` +
    `\`mycc-compose\` CLI mints/reuses session ids, launches the peers ` +
    `detached, and writes every channel file. Reproducible and resumable ` +
    `(\`sync\`). Reach for it only when the group must survive restarts; it ` +
    `composes mechanisms 2 and 3. Governed by the \`mycc-compose\` skill.\n\n` +
    `Rule of thumb: one instance + parallelism → teammate; a few local ` +
    `instances/process isolation → peer; a peer on another machine → ` +
    `remote; a durable, relaunchable group → compose.`;
  return [
    { role: 'user', content },
    {
      role: 'assistant',
      content:
        'Understood. I can use four collaboration mechanisms — teammate ' +
        '(same-session child), peer (local cross-session), remote ' +
        '(cross-machine via peer_connect), and compose (a declarative ' +
        'topology file) — and I will load the matching skill (coordination / ' +
        'mediator / mycc-compose) when I need to wire agents together.',
    },
  ];
}

// ============================================================================
// Todo List (shared — lead and teammates)
// ============================================================================

/**
 * Build the todo context as a projectContext deliverable: the task-tracking
 * usage guidance PLUS a snapshot of the live todo list.
 *
 * Why a populator rather than the system prompt / a per-turn note:
 *
 *   - The todo USAGE prose ("## Task Management") used to live in the lead's
 *     system prompt while teammates got none of it; a populator delivers one
 *     identical copy to both agents from a single registration site.
 *   - The previous "Update your todos." REMINDER nudge (COLLECT, every 3
 *     passes) is gone, and `todo_create`/`todo_update`/`todo_pinning` no
 *     longer echo the whole list in their results. This populator is now the
 *     ONLY place the full list is rendered, which also means the list
 *     survives auto-compaction: compact() calls rebuildProjectContext(), so
 *     the snapshot is regenerated right after the transcript is summarised.
 *
 * Freshness contract: the snapshot is taken at REBUILD time only (startup,
 * compact(), clear()) — never on a per-LLM-call path — so the prompt-cache
 * prefix stays byte-stable between boundaries (the same invariant as every
 * other populator here). Mid-turn staleness is harmless: each todo_* tool
 * result carries the touched item and its current hash, and a stale hash is
 * resolved to the live one by `findByPreviousHash` (todo_update warm hint).
 *
 * `/todos` (the user's slash command) is NOT an escape hatch for the AGENT: it
 * is terminal-only input, and a teammate has no REPL at all. Any other writer
 * that mutates the store outside a rebuild boundary — the slash command itself,
 * the peer-wire pinned reminder (parent-context recordRemotePeerTodo) — must
 * rebuild explicitly, or this section goes stale until the next boundary.
 *
 * Starts EMPTY by design: a fresh session renders `No todos.` until the agent
 * creates one. `/clear` and the double-Ctrl+L clear both call ctx.todo.clear()
 * BEFORE triologue.clear() (which triggers the rebuild), so the refreshed
 * section is empty again rather than a resurrected list.
 *
 * Pinned todos / stop guard USAGE PROSE is NOT part of this deliverable — it is
 * lead-only and ships in its own populator (buildPinnedTodoMessages). The list
 * snapshot below is `printTodoList()` verbatim, so it DOES carry the 📌 marker
 * and the `[preventStop: …]` tag for any guarded item: those markers are how the
 * agent sees its own pinned reminders (this is now the only place the list is
 * rendered). Only the lead can create such an item — `todo_pinning` is scope
 * ['main'] — so a teammate's snapshot never contains one.
 */
export function buildTodoMessages(todo: TodoModule): Message[] {
  const content =
    `[System - Todo List]\n\n` +
    `## Task Management\n` +
    `Use issue_* for complex tasks (divide and conquer), todo_* for simple tracking.\n\n` +
    `## Todo List\n` +
    `${todo.printTodoList()}\n\n` +
    `This snapshot is rebuilt only at compaction / clear boundaries, so it can lag ` +
    `behind the current turn. Each todo_create / todo_update / todo_pinning result ` +
    `reports the touched item with its current hash — update by that hash, not by ` +
    `the list above. \`/todos\` is a USER-invoked slash command: mid-turn, rely on ` +
    `the tool results.`;
  return [
    { role: 'user', content },
    {
      role: 'assistant',
      content:
        'Understood. I am tracking work in the todo list above and will update items ' +
        'by the hash returned from each todo_* call.',
    },
  ];
}

// ============================================================================
// Pinned Todos & Stop Guard (lead-only — teammates never see it)
// ============================================================================

/**
 * Build the pinned-todo / stop-guard usage section as a projectContext
 * deliverable. LEAD-ONLY: registered in agent-repl.ts, never in
 * teammate-worker.ts — `todo_pinning` is `scope: ['main']` and the guard is
 * evaluated by the lead's STOP stage (forkChat), so the prose would describe
 * a capability a teammate does not have.
 *
 * The text is the former `buildPinnedTodoSection()` of prompts/common.ts,
 * moved here verbatim: it is static reference material (no state read), so it
 * belongs on the boundary-cadence channel with a built-in acknowledgement,
 * not in the per-call system prompt.
 *
 * It deliberately does NOT re-render the pinned items — buildTodoMessages'
 * snapshot already lists them with the 📌 marker and `[preventStop: …]` tag.
 */
export function buildPinnedTodoMessages(): Message[] {
  const body = [
      '### Pinned Todos',
      'Regular todos are auto-cleared when all are completed. Pinned todos persist:',
      '- Use `todo_pinning(id, hash, pinned=true)` to pin a todo after creating it with `todo_create`.',
      '- Pinned todos are NOT removed when all todos are completed.',
      '- Use pinned todos for persistent reminders (e.g., schema definitions, invariant rules, ' +
      'materialized view refresh tasks).',
      '',
      '### Stop Guard',
      'A pinned todo can carry a `preventStop` condition — a promise to yourself to keep working:',
      '- Use `todo_pinning(id, hash, pinned=true, preventStop="<natural language condition>")` to set it.',
      '- While the condition still holds you are NOT allowed to finish your turn: the turn continues, ' +
      'with a SYSTEM note naming the guard and why it held.',
      '- Leave it out, or unpin the todo (`pinned=false`), to let the turn end.',
      '- Use it for long-horizon work whose completion you cannot judge in a single turn ' +
      '(e.g. "until every test under src/loop passes", "until the migration is verified end-to-end").',
      '- Example: `todo_pinning(id=2, hash="abc12345", pinned=true, ' +
      'preventStop="until the users and orders migrations both pass their tests")`',
    ].join('\n');
  const content = `[System - Pinned Todos & Stop Guard]\n\n${body}`;
  return [
    { role: 'user', content },
    {
      role: 'assistant',
      content:
        'Understood. I will pin long-term todos and use a preventStop guard for work that ' +
        'cannot be judged complete in one turn.',
    },
  ];
}
