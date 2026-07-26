/**
 * /wiki command - Manage knowledge base WAL files and domains
 *
 * Usage:
 *   /wiki                      - Show today's WAL file
 *   /wiki edit [date]          - Open WAL file for editing (YYYY-MM-DD)
 *   /wiki rebuild              - Rebuild vector store from all WAL files
 *   /wiki delete <hash>        - Delete document from vector store by hash
 *   /wiki domains              - List all domains
 *   /wiki domains add <name> <description>  - Add domain
 *   /wiki domains remove <name>             - Remove domain
 *   /wiki export [--domain domain] [file]   - Export wiki entries to JSON
 *   /wiki import <file>        - Import wiki entries from JSON
 */

import type { SlashCommand, WikiModule, WALEntry, WikiDocument, WikiDomain } from '../types.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import chalk from 'chalk';
import { getWikiLogsDir, getWikiDomainsFile, ensureDirs } from '../config.js';
import { openEditor } from '../utils/open-editor.js';

function formatDate(date: Date): string {
  return date.toISOString().split('T')[0];
}

export const wikiCommand: SlashCommand = {
  name: 'wiki',
  description: 'Manage knowledge base: show WAL, edit [date], rebuild, delete <hash>, domains [add|remove|list], export [--domain d] [file], import <file>',
  handler: async (context) => {
    const args = context.args.slice(1); // First arg is 'wiki'

    if (args[0] === 'edit') {
      // Edit WAL file
      const date = args[1] || formatDate(new Date());
      await handleEdit(context.ctx.wiki, date);
    } else if (args[0] === 'rebuild') {
      // Rebuild vector store
      await handleRebuild(context.ctx.wiki);
    } else if (args[0] === 'delete') {
      // Delete document by hash
      await handleDelete(context.ctx.wiki, args[1]);
    } else if (args[0] === 'domains') {
      // Domain management
      await handleDomains(context.ctx.wiki, args.slice(1));
    } else if (args[0] === 'export') {
      // Export wiki entries
      await handleExport(context.ctx.wiki, args.slice(1));
    } else if (args[0] === 'import') {
      // Import wiki entries
      await handleImport(context.ctx.wiki, args.slice(1));
    } else {
      // Show today's WAL
      const today = formatDate(new Date());
      await handleShow(context.ctx.wiki, today);
    }
  },
};

async function handleShow(wiki: WikiModule, date: string): Promise<void> {
  const entries = await wiki.getWAL(date);

  if (entries.length === 0) {
    console.log(chalk.yellow(`No WAL entries for ${date}`));
    return;
  }

  console.log(chalk.cyan(`\n=== WAL for ${date} ===\n`));
  console.log(wiki.formatWAL(entries));
}

async function handleEdit(wiki: WikiModule, date: string): Promise<void> {
  ensureDirs();
  const walDir = getWikiLogsDir();
  const walPath = path.join(walDir, `${date}.wal`);

  // Create file if it doesn't exist
  if (!fs.existsSync(walPath)) {
    fs.writeFileSync(walPath, '', 'utf-8');
  }

  // Get current entries
  const entries = await wiki.getWAL(date);
  const asciiContent = wiki.formatWAL(entries);

  // Write to temp file
  const tempFile = path.join(os.tmpdir(), `wiki-${date}-${Date.now()}.txt`);
  fs.writeFileSync(tempFile, asciiContent, 'utf-8');

  console.log(chalk.gray(`Opening ${date}.wal for editing...`));

  try {
    // Open editor using the utility (handles both terminal and GUI editors)
    await openEditor([tempFile]);

    // Read back edited content
    const editedContent = fs.readFileSync(tempFile, 'utf-8');

    // Parse and validate
    const newEntries = wiki.parseWAL(editedContent);

    // Write back to WAL file as JSON lines
    const jsonLines = newEntries.map((e: WALEntry) => JSON.stringify(e)).join('\n');
    fs.writeFileSync(walPath, `${jsonLines  }\n`, 'utf-8');

    console.log(chalk.green(`WAL updated: ${newEntries.length} entries`));
  } finally {
    // Clean up temp file
    if (fs.existsSync(tempFile)) {
      fs.unlinkSync(tempFile);
    }
  }
}

async function handleRebuild(wiki: WikiModule): Promise<void> {
  console.log(chalk.cyan('\nRebuilding vector store from WAL files...\n'));

  const result = await wiki.rebuild();

  if (result.success) {
    console.log(chalk.green(`\nRebuild complete: ${result.documentsProcessed} documents processed`));

    if (result.errors.length > 0) {
      console.log(chalk.yellow('\nErrors:'));
      for (const error of result.errors) {
        console.log(chalk.yellow(`  - ${error}`));
      }
    }
  } else {
    console.log(chalk.red('\nRebuild failed:'));
    for (const error of result.errors) {
      console.log(chalk.red(`  - ${error}`));
    }
  }
}

async function handleDelete(wiki: WikiModule, hash: string | undefined): Promise<void> {
  if (!hash) {
    console.log(chalk.red('Usage: /wiki delete <hash>'));
    console.log(chalk.gray('Use /wiki to view WAL entries and find the hash.'));
    return;
  }

  // Validate hash format (16 hex characters)
  if (!/^[a-f0-9]{16}$/.test(hash)) {
    console.log(chalk.red(`Invalid hash format: ${hash}`));
    console.log(chalk.gray('Hash must be 16 hexadecimal characters (e.g., a1b2c3d4e5f67890)'));
    return;
  }

  const deleted = await wiki.delete(hash);

  if (deleted) {
    console.log(chalk.green(`\nDocument ${hash} deleted successfully.`));
    console.log(chalk.gray('The deletion has been marked in the original WAL file.'));
  } else {
    console.log(chalk.yellow(`\nDocument ${hash} not found.`));
  }
}

async function handleDomains(wiki: WikiModule, args: string[]): Promise<void> {
  const subCommand = args[0];

  if (subCommand === 'add') {
    const name = args[1];
    const description = args.slice(2).join(' ') || '';

    if (!name) {
      console.log(chalk.red('Usage: /wiki domains add <name> [description]'));
      return;
    }

    await addDomain(name, description);
  } else if (subCommand === 'remove') {
    const name = args[1];

    if (!name) {
      console.log(chalk.red('Usage: /wiki domains remove <name>'));
      return;
    }

    await removeDomain(name);
  } else {
    // List domains
    await listDomains(wiki);
  }
}

async function listDomains(wiki: WikiModule): Promise<void> {
  const domains = await wiki.listDomains();

  if (domains.length === 0) {
    console.log(chalk.yellow('\nNo domains registered.'));
    console.log(chalk.gray('Use /wiki domains add <name> [description] to add a domain.'));
    return;
  }

  console.log(chalk.cyan('\n=== Registered Domains ===\n'));
  for (const domain of domains) {
    console.log(chalk.white(`  ${domain.domain_name}`));
    if (domain.description) {
      console.log(chalk.gray(`    ${domain.description}`));
    }
    console.log(chalk.gray(`    Created: ${domain.created_at}`));
    console.log(chalk.gray(`    Project: ${domain.project_folder}`));
    console.log();
  }
}

async function addDomain(name: string, description: string): Promise<void> {
  ensureDirs();
  const domainsFile = getWikiDomainsFile();

  // Load existing domains
  let domains: WikiDomain[] = [];
  if (fs.existsSync(domainsFile)) {
    try {
      domains = JSON.parse(fs.readFileSync(domainsFile, 'utf-8'));
    } catch {
      domains = [];
    }
  }

  // Check if domain already exists
  if (domains.find(d => d.domain_name === name)) {
    console.log(chalk.yellow(`Domain "${name}" already exists.`));
    return;
  }

  // Add new domain
  domains.push({
    domain_name: name,
    description,
    created_at: new Date().toISOString(),
    project_folder: process.cwd(),
  });

  // Save
  fs.writeFileSync(domainsFile, JSON.stringify(domains, null, 2), 'utf-8');
  console.log(chalk.green(`Domain "${name}" added.`));
}

async function removeDomain(name: string): Promise<void> {
  ensureDirs();
  const domainsFile = getWikiDomainsFile();

  // Load existing domains
  let domains: WikiDomain[] = [];
  if (fs.existsSync(domainsFile)) {
    try {
      domains = JSON.parse(fs.readFileSync(domainsFile, 'utf-8'));
    } catch {
      domains = [];
    }
  }

  // Find and remove domain
  const index = domains.findIndex(d => d.domain_name === name);
  if (index === -1) {
    console.log(chalk.yellow(`Domain "${name}" not found.`));
    return;
  }

  domains.splice(index, 1);

  // Save
  fs.writeFileSync(domainsFile, JSON.stringify(domains, null, 2), 'utf-8');
  console.log(chalk.green(`Domain "${name}" removed.`));
}

// ============================================================================
// Export / Import
// ============================================================================

/**
 * Manifest tying the bytes of an export file to its content, so transit
 * corruption (truncation, tampering, bit-flips) is detectable on import.
 *
 * `content_sha256` is the SHA-256 hex digest of the canonical JSON of
 * `{domains, entries}` (deterministic key ordering via JSON.stringify of a
 * rebuilt object, NOT the raw file bytes — so re-serialization that only
 * changes whitespace still passes). A v1.1 export always carries a manifest;
 * a v1.0 file (pre-manifest) imports with a warning that integrity is
 * unverified.
 */
interface WikiExportManifest {
  entry_count: number;
  content_sha256: string;
}

interface WikiExportData {
  version: '1.0' | '1.1';
  exported_at: string;
  project_dir: string;
  domains: WikiDomain[];
  entries: WALEntry[];
  manifest?: WikiExportManifest;
}

/**
 * Compute the content hash for a wiki document, mirroring the scheme used by
 * WikiManager.generateHash (sha256 of `${domain}:${title}:${content}`, first
 * 16 hex chars). Used on import to verify each entry's stored `hash` field
 * matches its `document` content, so tampered content is rejected before it
 * reaches put(). Lives here (not in wiki.ts) so the import slash command can
 * validate without touching the database layer.
 */
export function computeWikiHash(document: WikiDocument): string {
  const content = `${document.domain}:${document.title}:${document.content}`;
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
}

/**
 * Compute the manifest hash over the canonical JSON of the exportable content.
 * Deterministic: rebuilds the object with stable key order so re-serialization
 * (whitespace-only changes) still matches.
 */
export function computeManifestHash(domains: WikiDomain[], entries: WALEntry[]): string {
  const canonical = JSON.stringify({ domains, entries });
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

/**
 * Verify an entry's stored hash against its document content.
 * Returns true iff the hash matches; false on mismatch or malformed entry.
 */
export function verifyEntryHash(entry: WALEntry): boolean {
  if (!entry.hash || !entry.document) return false;
  if (!entry.document.domain || !entry.document.title || !entry.document.content) return false;
  return computeWikiHash(entry.document) === entry.hash;
}

function parseExportArgs(rawArgs: string[]): {
  domain: string | null;
  file: string;
} {
  let domain: string | null = null;
  const positional: string[] = [];

  for (let i = 0; i < rawArgs.length; i++) {
    if (rawArgs[i] === '--domain' && i + 1 < rawArgs.length) {
      if (domain !== null) {
        console.log(chalk.red('Error: --domain can only be specified once.'));
        throw new Error('duplicate --domain');
      }
      domain = rawArgs[i + 1];
      i++; // consume the value
    } else if (rawArgs[i].startsWith('--domain=')) {
      if (domain !== null) {
        console.log(chalk.red('Error: --domain can only be specified once.'));
        throw new Error('duplicate --domain');
      }
      domain = rawArgs[i].substring('--domain='.length);
    } else {
      positional.push(rawArgs[i]);
    }
  }

  return { domain, file: positional[0] || '' };
}

function buildDefaultExportFilename(domain: string | null): string {
  const now = new Date();
  const yyyy = now.getFullYear().toString();
  const MM = (now.getMonth() + 1).toString().padStart(2, '0');
  const dd = now.getDate().toString().padStart(2, '0');
  const hh = now.getHours().toString().padStart(2, '0');
  const mm = now.getMinutes().toString().padStart(2, '0');
  const ss = now.getSeconds().toString().padStart(2, '0');
  const domainSuffix = domain ? `-${domain}` : '';
  return `./wiki-export${domainSuffix}-${yyyy}${MM}${dd}-${hh}${mm}${ss}.json`;
}

async function handleExport(wiki: WikiModule, rawArgs: string[]): Promise<void> {
  let parsed: { domain: string | null; file: string };
  try {
    parsed = parseExportArgs(rawArgs);
  } catch {
    return; // error already printed
  }

  const { domain, file: exportFileArg } = parsed;
  const exportFile = exportFileArg || buildDefaultExportFilename(domain);

  // Read all WAL files
  const walDir = getWikiLogsDir();
  const allEntries: WALEntry[] = [];

  if (fs.existsSync(walDir)) {
    const walFiles = fs.readdirSync(walDir)
      .filter(f => f.endsWith('.wal'))
      .sort();

    for (const walFile of walFiles) {
      const walPath = path.join(walDir, walFile);
      const content = fs.readFileSync(walPath, 'utf-8');
      // WAL files are JSON lines, not ASCII format — parse each line as JSON
      for (const line of content.trim().split('\n')) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line) as WALEntry;
          // Skip deleted entries — they should not be exported (would revive on import)
          if (entry.deleted) continue;
          if (!domain || entry.document.domain === domain) {
            allEntries.push(entry);
          }
        } catch {
          // skip malformed lines
        }
      }
    }
  }

  // Gather domains relevant to the export
  let domains: WikiDomain[] = [];
  if (domain) {
    const targetDomain = await wiki.getDomain(domain);
    if (targetDomain) {
      domains = [targetDomain];
    } else {
      console.log(chalk.yellow(`Domain "${domain}" not found. Exporting entries without domain metadata.`));
    }
  } else {
    domains = await wiki.listDomains();
  }

  // Build export data
  const exportData: WikiExportData = {
    version: '1.1',
    exported_at: new Date().toISOString(),
    project_dir: process.cwd(),
    domains,
    entries: allEntries,
    manifest: {
      entry_count: allEntries.length,
      content_sha256: computeManifestHash(domains, allEntries),
    },
  };

  // Resolve file path (relative to cwd)
  const resolvedPath = path.isAbsolute(exportFile)
    ? exportFile
    : path.resolve(process.cwd(), exportFile);

  // Ensure parent directory exists
  const parentDir = path.dirname(resolvedPath);
  if (!fs.existsSync(parentDir)) {
    fs.mkdirSync(parentDir, { recursive: true });
  }

  // Write
  fs.writeFileSync(resolvedPath, JSON.stringify(exportData, null, 2), 'utf-8');

  const entryCount = allEntries.length;
  const domainInfo = domain ? `domain "${domain}"` : `${domains.length} domains`;
  const fileLabel = path.relative(process.cwd(), resolvedPath);

  console.log(
    chalk.green(`Exported ${entryCount} entries from ${domainInfo} to ${fileLabel}`),
  );
}

async function handleImport(wiki: WikiModule, rawArgs: string[]): Promise<void> {
  const file = rawArgs[0];
  if (!file) {
    console.log(chalk.red('Usage: /wiki import <file>'));
    console.log(chalk.gray('Provide the path to a wiki-export JSON file.'));
    return;
  }

  const resolvedPath = path.isAbsolute(file)
    ? file
    : path.resolve(process.cwd(), file);

  if (!fs.existsSync(resolvedPath)) {
    console.log(chalk.red(`File not found: ${resolvedPath}`));
    return;
  }

  // Read and parse
  let data: WikiExportData;
  try {
    const content = fs.readFileSync(resolvedPath, 'utf-8');
    data = JSON.parse(content) as WikiExportData;
  } catch (err) {
    console.log(chalk.red(`Failed to parse export file: ${(err as Error).message}`));
    return;
  }

  // Validate shape
  if (!data.version || !Array.isArray(data.entries)) {
    console.log(chalk.red('Invalid export file: missing "version" or "entries" array.'));
    return;
  }
  if (!Array.isArray(data.domains)) {
    data.domains = [];
  }

  // --- Layer A: file-level manifest verification ---------------------------
  // A v1.1 export carries a manifest whose content_sha256 ties the file's
  // bytes to {domains, entries}. A mismatch means transit corruption
  // (truncation, tampering, bit-flips) — abort before touching the DB so a
  // corrupted file can never silently pollute the wiki.
  let manifestVerified = false;
  if (data.version === '1.1') {
    if (!data.manifest || typeof data.manifest.content_sha256 !== 'string') {
      console.log(chalk.red('Invalid v1.1 export file: missing "manifest" with content_sha256.'));
      console.log(chalk.gray('Refusing to import — integrity cannot be verified.'));
      return;
    }
    const actual = computeManifestHash(data.domains, data.entries);
    if (actual !== data.manifest.content_sha256) {
      console.log(chalk.red('Manifest mismatch — export file is corrupted or was tampered with.'));
      console.log(chalk.gray(`  expected: ${data.manifest.content_sha256}`));
      console.log(chalk.gray(`  actual:   ${actual}`));
      console.log(chalk.gray('Refusing to import — no entries were written to the wiki.'));
      return;
    }
    if (data.manifest.entry_count !== data.entries.length) {
      console.log(chalk.red(`Manifest entry_count mismatch: manifest claims ${data.manifest.entry_count} but file has ${data.entries.length}.`));
      console.log(chalk.gray('Refusing to import — no entries were written to the wiki.'));
      return;
    }
    manifestVerified = true;
  } else {
    // v1.0 file (pre-manifest): import proceeds, but warn that integrity is
    // unverified. Per-entry hash verification (Layer B) still runs and will
    // skip tampered entries, but file-level corruption is undetectable.
    console.log(chalk.yellow(`Warning: importing v${data.version} file without manifest — file-level integrity cannot be verified.`));
  }

  // Register domains
  let domainsAdded = 0;
  for (const domain of data.domains) {
    const existing = await wiki.getDomain(domain.domain_name);
    if (!existing) {
      try {
        await wiki.registerDomain(domain.domain_name, domain.description || '');
        domainsAdded++;
      } catch {
        // skip if registration fails
      }
    }
  }

  // --- Layer B: per-entry hash verification + Layer C: honest put results --
  // For each entry: verify its stored hash matches its document content
  // (Layer B — reject tampered content before reaching put), then call put()
  // and READ its return value (Layer C — put returns {success:false} rather
  // than throwing on hash mismatch / unknown domain / length violations, so
  // the old loop that only caught throws silently miscounted failures as
  // imported). Surface a honest breakdown at the end.
  let imported = 0;
  let skipped = 0;
  let deletedSkipped = 0;
  let hashMismatch = 0;
  const hashMismatchHashes: string[] = [];
  let putFailed = 0;
  const putErrors: Array<{ hash: string; error: string }> = [];
  let alreadyPresent = 0;

  for (const entry of data.entries) {
    if (!entry.hash || !entry.document) continue;

    // Skip deleted entries — importing them would revive documents the user
    // explicitly removed. Also skip entries marked !approved (never stored).
    if (entry.deleted) { deletedSkipped++; continue; }
    if (entry.approved === false) { skipped++; continue; }

    // Layer B: verify the entry's hash matches its content. A mismatch means
    // the document was altered after export (or the hash field was corrupted)
    // — skip it rather than letting put() silently reject it and inflate the
    // imported counter.
    if (!verifyEntryHash(entry)) {
      hashMismatch++;
      hashMismatchHashes.push(entry.hash);
      continue;
    }

    // Layer C: read the PutResult. put() returns {success:false, error} for
    // hash mismatch (already caught above, but defensive), unknown domain,
    // content-length violations, or DB errors — it does NOT throw. Only
    // count as imported when put() actually stored the document.
    // put() also sets alreadyExisted:true when an exact copy (same hash AND
    // same references) is already in the store — count those separately so a
    // re-import on the same machine doesn't report misleading "imported" counts.
    try {
      const result = await wiki.put(entry.hash, entry.document);
      if (result.success) {
        if (result.alreadyExisted) {
          alreadyPresent++;
        } else {
          imported++;
        }
      } else {
        putFailed++;
        putErrors.push({ hash: entry.hash, error: result.error || 'unknown error' });
      }
    } catch (err) {
      // put() is not expected to throw (it catches internally), but defend
      // against unexpected DB/embedding failures so one bad entry doesn't
      // abort the whole import.
      putFailed++;
      putErrors.push({ hash: entry.hash, error: (err as Error).message });
    }
  }

  // --- Honest summary ------------------------------------------------------
  // Report exactly what happened, including skipped/failed counts that the
  // old loop silently folded into "imported". A corrupted file must never
  // report clean success. "already present" is reported separately so a
  // re-import on the same machine is honest: nothing new was written.
  const parts: string[] = [`${imported} entries imported`];
  if (alreadyPresent > 0) parts.push(`${alreadyPresent} already present`);
  if (skipped > 0) parts.push(`${skipped} unapproved skipped`);
  if (deletedSkipped > 0) parts.push(`${deletedSkipped} deleted entries ignored`);
  if (hashMismatch > 0) parts.push(chalk.yellow(`${hashMismatch} hash mismatch (skipped)`));
  if (putFailed > 0) parts.push(chalk.red(`${putFailed} put failed`));
  if (domainsAdded > 0) parts.push(`${domainsAdded} domains added`);
  const integrityNote = manifestVerified
    ? ' (integrity verified)'
    : ' (integrity UNVERIFIED — v1.0 file)';
  console.log(
    chalk.green(`Import complete${integrityNote}: ${parts.join(', ')}`),
  );

  if (hashMismatchHashes.length > 0) {
    console.log(chalk.yellow('\nHash mismatch entries (skipped — content did not match its hash):'));
    for (const h of hashMismatchHashes) {
      console.log(chalk.yellow(`  - ${h}`));
    }
  }
  if (putErrors.length > 0) {
    console.log(chalk.red('\nPut failures (entry was not written to the wiki):'));
    for (const e of putErrors) {
      console.log(chalk.red(`  - ${e.hash}: ${e.error}`));
    }
  }
}