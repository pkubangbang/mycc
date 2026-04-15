/**
 * wiki.ts - ChildWiki implementation for IPC-based wiki operations
 */

import type { WikiModule, WikiDocument, WikiDomain, PrepareResult, PutResult, GetOptions, SearchResult, WALEntry, RebuildResult } from '../../types.js';
import { ipc } from './ipc-helpers.js';

/**
 * Wiki module for child process
 * All operations go through IPC to parent
 */
export class ChildWiki implements WikiModule {
  async prepare(document: WikiDocument): Promise<PrepareResult> {
    const result = await ipc.sendRequest<PrepareResult>('wiki_prepare', { document });
    return result;
  }

  async put(hash: string, document: WikiDocument): Promise<PutResult> {
    const result = await ipc.sendRequest<PutResult>('wiki_put', { hash, document });
    return result;
  }

  async get(query: string, options?: GetOptions): Promise<SearchResult[]> {
    const result = await ipc.sendRequest<SearchResult[]>('wiki_get', { query, options });
    return result;
  }

  async getWAL(date?: string): Promise<WALEntry[]> {
    const result = await ipc.sendRequest<WALEntry[]>('wiki_wal_get', { date });
    return result;
  }

  parseWAL(asciiContent: string): WALEntry[] {
    // This is a local operation, no IPC needed
    // Parse the ASCII format locally
    const entries: WALEntry[] = [];
    const blocks = asciiContent.split(/\n(?=#)/);

    for (const block of blocks) {
      if (!block.trim()) continue;

      const entry = this.parseASCIIBlock(block);
      if (entry) {
        entries.push(entry);
      }
    }

    return entries;
  }

  private parseASCIIBlock(block: string): WALEntry | null {
    const lines = block.trim().split('\n');
    if (lines.length < 2) return null;

    let hash = '';
    let persistent = false;
    let approved = false;
    let timestamp = '';
    let domain = '';
    let title = '';
    let contentLines: string[] = [];
    let references: string[] = [];
    let section = '';

    for (const line of lines) {
      if (line.startsWith('# ')) {
        hash = line.slice(2);
      } else if (line === '!persistent') {
        persistent = true;
      } else if (line === '!approved') {
        approved = true;
      } else if (line.startsWith('[created_at]')) {
        timestamp = line.slice(12);
      } else if (line.startsWith('[domain]')) {
        domain = line.slice(8);
      } else if (line.startsWith('[title]')) {
        title = line.slice(7);
      } else if (line === '[content]') {
        section = 'content';
      } else if (line === '[references]') {
        section = 'references';
      } else if (section === 'content') {
        contentLines.push(line);
      } else if (section === 'references' && line.startsWith('- ')) {
        references.push(line.slice(2));
      }
    }

    return {
      timestamp,
      hash,
      document: {
        domain,
        title,
        content: contentLines.join('\n'),
        references,
      },
      approved,
      persistent,
    };
  }

  formatWAL(entries: WALEntry[]): string {
    // This is a local operation, no IPC needed
    const blocks: string[] = [];

    for (const entry of entries) {
      const lines: string[] = [];
      lines.push(`# ${entry.hash}`);
      if (entry.persistent) lines.push('!persistent');
      if (entry.approved) lines.push('!approved');
      lines.push(`[created_at]${entry.timestamp}`);
      lines.push(`[domain]${entry.document.domain}`);
      lines.push(`[title]${entry.document.title}`);
      lines.push('[content]');
      lines.push(entry.document.content);
      lines.push('[references]');
      for (const ref of entry.document.references) {
        lines.push(`- ${ref}`);
      }
      blocks.push(lines.join('\n'));
    }

    return blocks.join('\n\n');
  }

  async appendWAL(entry: WALEntry): Promise<void> {
    await ipc.sendRequest<void>('wiki_wal_append', { entry });
  }

  async rebuild(): Promise<RebuildResult> {
    const result = await ipc.sendRequest<RebuildResult>('wiki_rebuild', {});
    return result;
  }

  // Domain management
  async listDomains(): Promise<WikiDomain[]> {
    const result = await ipc.sendRequest<WikiDomain[]>('wiki_domains_list', {});
    return result;
  }

  async getDomain(name: string): Promise<WikiDomain | undefined> {
    const result = await ipc.sendRequest<WikiDomain | undefined>('wiki_domain_get', { name });
    return result;
  }

  async registerDomain(name: string, description?: string): Promise<void> {
    await ipc.sendRequest<void>('wiki_domain_register', { name, description });
  }
}