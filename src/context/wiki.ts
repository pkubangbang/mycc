/**
 * wiki.ts - WikiManager for persistent memory
 *
 * Manages knowledge storage using LanceDB for vector similarity search.
 * Uses WAL files for audit and rebuild capabilities.
 */

import * as lancedb from '@lancedb/lancedb';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { ollama } from '../ollama.js';
import { getWikiLogsDir, getWikiDbDir, getWikiDomainsFile, ensureDirs } from '../config.js';
import type {
  WikiModule,
  WikiDocument,
  WikiDomain,
  PrepareResult,
  PutResult,
  GetOptions,
  SearchResult,
  WALEntry,
  RebuildResult,
} from '../types.js';
import type { CoreModule } from '../types.js';

// Embedding model configuration
const EMBEDDING_MODEL = process.env.OLLAMA_EMBEDDING_MODEL || 'nomic-embed-text';
const DUPLICATE_THRESHOLD = 0.95;
const MIN_CONTENT_LENGTH = 50;
const MAX_CONTENT_LENGTH = 1000;

// Hash is first 16 chars of SHA-256 hex digest
const HASH_PATTERN = /^[a-f0-9]{16}$/;

/**
 * WikiManager - Manages persistent knowledge storage
 */
export class WikiManager implements WikiModule {
  private db: lancedb.Connection | null = null;
  private table: lancedb.Table | null = null;
  private core: CoreModule;
  private tableName = 'wiki';
  private skillsDomainWarningShown = false;

  constructor(core: CoreModule) {
    this.core = core;
  }

  /**
   * Check if skills domain exists and show warning if not
   * Called during startup to prompt user to run /skills build
   */
  async checkSkillsDomain(): Promise<boolean> {
    try {
      const domains = await this.listDomains();
      const skillsDomain = domains.find(d => d.domain_name === 'skills');
      if (!skillsDomain && !this.skillsDomainWarningShown) {
        console.warn('Warning: Skills not indexed. Run /skills build to enable skill suggestions.');
        this.skillsDomainWarningShown = true;
        return false;
      }
      return true;
    } catch (err) {
      console.warn('Warning: Wiki not available. Skill suggestions disabled.');
      return false;
    }
  }

  /**
   * Initialize the database connection
   */
  private async initDb(): Promise<void> {
    if (this.db && this.table) return;

    ensureDirs();
    const dbPath = getWikiDbDir();

    this.db = await lancedb.connect(dbPath);

    // Check if table exists
    const tables = await this.db.tableNames();
    if (tables.includes(this.tableName)) {
      this.table = await this.db.openTable(this.tableName);
    } else {
      // Create table with initial empty schema
      // LanceDB needs at least one record to create a table
      const initialRecord: Record<string, unknown> = {
        hash: '__schema__',
        domain: '',
        title: '',
        content: '',
        references: '[]',
        embedding: new Array(768).fill(0), // nomic-embed-text dimension
        createdAt: new Date().toISOString(),
      };
      this.table = await this.db.createTable(this.tableName, [initialRecord]);
    }
  }

  /**
   * Generate embedding for text using Ollama
   */
  private async getEmbedding(text: string): Promise<number[]> {
    const response = await ollama.embed({
      model: EMBEDDING_MODEL,
      input: text,
    });

    if (!response.embeddings || response.embeddings.length === 0) {
      throw new Error('Failed to generate embedding');
    }

    return response.embeddings[0];
  }

  /**
   * Generate hash for document
   */
  private generateHash(document: WikiDocument): string {
    const content = `${document.domain}:${document.title}:${document.content}`;
    return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
  }

  /**
   * Calculate cosine similarity between two vectors
   */
  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) return 0;

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    if (normA === 0 || normB === 0) return 0;
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  /**
   * Check if similar document exists
   */
  private async checkDuplicate(embedding: number[], threshold = DUPLICATE_THRESHOLD): Promise<boolean> {
    await this.initDb();
    if (!this.table) return false;

    try {
      const records = await this.table.query().toArray();
      for (const record of records) {
        const r = record as Record<string, unknown>;
        // Skip schema record
        if (r.hash === '__schema__') continue;

        const similarity = this.cosineSimilarity(embedding, r.embedding as number[]);
        if (similarity > threshold) {
          return true;
        }
      }
    } catch {
      // Table might be empty
    }
    return false;
  }

  /**
   * Check if hash already exists in database
   */
  private async hashExists(hash: string): Promise<boolean> {
    await this.initDb();
    if (!this.table) return false;

    try {
      const records = await this.table.query().toArray();
      for (const record of records) {
        const r = record as Record<string, unknown>;
        if (r.hash === hash) {
          return true;
        }
      }
    } catch {
      // Table might be empty
    }
    return false;
  }

  /**
   * Prepare document for storage - evaluate and return hash or rejection
   */
  async prepare(document: WikiDocument): Promise<PrepareResult> {
    // Validate document structure
    if (!document.domain || !document.title || !document.content) {
      return { accepted: false, reason: 'Missing required fields: domain, title, or content' };
    }

    if (document.content.length < MIN_CONTENT_LENGTH) {
      return { accepted: false, reason: `Content too short (minimum ${MIN_CONTENT_LENGTH} characters)` };
    }

    if (document.content.length > MAX_CONTENT_LENGTH) {
      return { accepted: false, reason: `Content too long (maximum ${MAX_CONTENT_LENGTH} characters)` };
    }

    // Generate hash
    const hash = this.generateHash(document);

    try {
      // Generate embedding for content
      const embedding = await this.getEmbedding(document.content);

      // Check for duplicates
      const isDuplicate = await this.checkDuplicate(embedding);
      if (isDuplicate) {
        return { accepted: false, reason: 'Similar document already exists in knowledge base' };
      }

      return { accepted: true, hash };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.core.brief('error', 'wiki', `Prepare failed: ${error}`);
      return { accepted: false, reason: `Failed to generate embedding: ${error}` };
    }
  }

  /**
   * Store document in knowledge base
   */
  async put(hash: string, document: WikiDocument): Promise<PutResult> {
    // Validate hash
    const expectedHash = this.generateHash(document);
    if (hash !== expectedHash) {
      return { success: false, hash, error: 'Hash mismatch - document may have been modified' };
    }

    // Short circuit: check if hash already exists
    if (await this.hashExists(hash)) {
      this.core.brief('info', 'wiki', `Document already exists: ${hash}`);
      return { success: true, hash };
    }

    try {
      await this.initDb();
      if (!this.table) {
        return { success: false, hash, error: 'Database not initialized' };
      }

      // Generate embedding
      const embedding = await this.getEmbedding(document.content);

      // Create record
      const record: Record<string, unknown> = {
        hash,
        domain: document.domain,
        title: document.title,
        content: document.content,
        references: JSON.stringify(document.references || []),
        embedding,
        createdAt: new Date().toISOString(),
      };

      // Add to LanceDB
      await this.table.add([record]);

      // Append to WAL
      await this.appendWAL({
        timestamp: new Date().toISOString(),
        hash,
        document,
        approved: true,
      });

      this.core.brief('info', 'wiki', `Stored document: ${document.title}`);
      return { success: true, hash };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.core.brief('error', 'wiki', `Put failed: ${error}`);
      return { success: false, hash, error };
    }
  }

  /**
   * Search for documents by similarity
   */
  async get(query: string, options?: GetOptions): Promise<SearchResult[]> {
    await this.initDb();
    if (!this.table) return [];

    const topK = options?.topK || 5;
    const threshold = options?.threshold || 0.0;

    try {
      // Generate embedding for query
      const queryEmbedding = await this.getEmbedding(query);

      // Get all records and filter manually (vector search requires embedding column)
      const records = await this.table.query().toArray();
      const results: SearchResult[] = [];

      for (const record of records) {
        const r = record as Record<string, unknown>;

        // Skip schema record
        if (r.hash === '__schema__') continue;

        // Apply domain filter if specified
        if (options?.domain && r.domain !== options.domain) {
          continue;
        }

        const embedding = r.embedding as number[];
        const similarity = this.cosineSimilarity(queryEmbedding, embedding);

        if (similarity >= threshold) {
          results.push({
            document: {
              domain: r.domain as string,
              title: r.title as string,
              content: r.content as string,
              references: JSON.parse(r.references as string || '[]'),
            },
            similarity,
            hash: r.hash as string,
          });
        }
      }

      // Sort by similarity and take top-k
      results.sort((a, b) => b.similarity - a.similarity);
      return results.slice(0, topK);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.core.brief('error', 'wiki', `Get failed: ${error}`);
      return [];
    }
  }

  /**
   * Delete a document by hash
   */
  async delete(hash: string): Promise<boolean> {
    // Validate hash format
    if (!HASH_PATTERN.test(hash)) {
      this.core.brief('error', 'wiki', `Invalid hash format: ${hash}. Expected 16 hex characters.`);
      return false;
    }

    await this.initDb();
    if (!this.table) {
      this.core.brief('error', 'wiki', 'Database not initialized');
      return false;
    }

    try {
      // Find the document and its createdAt date
      const records = await this.table.query().toArray();
      let foundRecord: Record<string, unknown> | null = null;

      for (const record of records) {
        const r = record as Record<string, unknown>;
        if (r.hash === hash) {
          foundRecord = r;
          break;
        }
      }

      if (!foundRecord) {
        this.core.brief('warn', 'wiki', `Document not found: ${hash}`);
        return false;
      }

      // Get the date from createdAt to find the WAL file
      const createdAt = foundRecord.createdAt as string;
      const walDate = this.formatDate(new Date(createdAt));

      // Mark as deleted in WAL first (before LanceDB deletion for consistency)
      await this.markWALDeleted(hash, walDate);

      // Delete from LanceDB
      await this.table.delete(`hash = '${hash}'`);

      this.core.brief('info', 'wiki', `Deleted document: ${hash}`);
      return true;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.core.brief('error', 'wiki', `Delete failed: ${error}`);
      return false;
    }
  }

  /**
   * Mark a WAL entry as deleted
   */
  private async markWALDeleted(hash: string, date: string): Promise<void> {
    ensureDirs();
    const walPath = path.join(getWikiLogsDir(), `${date}.wal`);

    if (!fs.existsSync(walPath)) {
      // WAL file no longer exists - this is OK, just log it
      this.core.brief('warn', 'wiki', `WAL file not found for date ${date}`);
      return;
    }

    // Read and parse WAL entries
    const content = fs.readFileSync(walPath, 'utf-8');
    const entries = this.parseWALFile(content);

    // Find and mark the entry as deleted
    let found = false;
    for (const entry of entries) {
      if (entry.hash === hash) {
        entry.deleted = true;
        found = true;
        break;
      }
    }

    if (!found) {
      this.core.brief('warn', 'wiki', `Entry ${hash} not found in WAL ${date}`);
      return;
    }

    // Write back as JSON lines
    const lines = entries.map(e => JSON.stringify(e)).join('\n');
    fs.writeFileSync(walPath, lines + '\n', 'utf-8');
  }

  /**
   * Get WAL entries for a specific date (default: today)
   */
  async getWAL(date?: string): Promise<WALEntry[]> {
    const targetDate = date || this.formatDate(new Date());
    const walPath = path.join(getWikiLogsDir(), `${targetDate}.wal`);

    if (!fs.existsSync(walPath)) {
      return [];
    }

    const content = fs.readFileSync(walPath, 'utf-8');
    return this.parseWALFile(content);
  }

  /**
   * Parse WAL file content (JSON lines format)
   */
  private parseWALFile(content: string): WALEntry[] {
    const entries: WALEntry[] = [];
    const lines = content.trim().split('\n');

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as WALEntry;
        entries.push(entry);
      } catch {
        // Skip malformed lines
      }
    }

    return entries;
  }

  /**
   * Parse ASCII WAL format to JSON entries
   */
  parseWAL(asciiContent: string): WALEntry[] {
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

  /**
   * Parse a single ASCII block
   */
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

  /**
   * Format WAL entries to ASCII format
   */
  formatWAL(entries: WALEntry[]): string {
    const blocks: string[] = [];

    for (const entry of entries) {
      const lines: string[] = [];
      lines.push(`# ${entry.hash}`);
      if (entry.deleted) lines.push('!deleted');
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

  /**
   * Append entry to today's WAL
   */
  async appendWAL(entry: WALEntry): Promise<void> {
    ensureDirs();
    const walDir = getWikiLogsDir();
    const today = this.formatDate(new Date());
    const walPath = path.join(walDir, `${today}.wal`);

    // Append as JSON line
    const line = JSON.stringify(entry) + '\n';
    fs.appendFileSync(walPath, line, 'utf-8');

    this.core.brief('info', 'wiki', `Appended to WAL: ${entry.hash}`);
  }

  /**
   * Rebuild vector store from all WAL files
   */
  async rebuild(): Promise<RebuildResult> {
    this.core.brief('info', 'wiki', 'Starting rebuild...');

    try {
      await this.initDb();
      if (!this.table) {
        return { success: false, documentsProcessed: 0, errors: ['Database not initialized'] };
      }

      // Clear existing data
      await this.table.delete('true');

      // Get all WAL files
      const walDir = getWikiLogsDir();
      if (!fs.existsSync(walDir)) {
        return { success: true, documentsProcessed: 0, errors: [] };
      }

      const walFiles = fs.readdirSync(walDir)
        .filter(f => f.endsWith('.wal'))
        .sort();

      let documentsProcessed = 0;
      const errors: string[] = [];

      // Process each WAL file
      for (const walFile of walFiles) {
        const walPath = path.join(walDir, walFile);
        const content = fs.readFileSync(walPath, 'utf-8');
        const entries = this.parseWALFile(content);

        for (const entry of entries) {
          // Skip deleted and unapproved entries
          if (entry.deleted) continue;
          if (!entry.approved) continue;

          try {
            // Generate embedding
            const embedding = await this.getEmbedding(entry.document.content);

            // Create record
            const record: Record<string, unknown> = {
              hash: entry.hash,
              domain: entry.document.domain,
              title: entry.document.title,
              content: entry.document.content,
              references: JSON.stringify(entry.document.references || []),
              embedding,
              createdAt: entry.timestamp,
            };

            // Add to LanceDB
            await this.table.add([record]);
            documentsProcessed++;
          } catch (err) {
            const error = err instanceof Error ? err.message : String(err);
            errors.push(`${walFile}:${entry.hash} - ${error}`);
          }
        }
      }

      this.core.brief('info', 'wiki', `Rebuild complete: ${documentsProcessed} documents processed`);
      return { success: true, documentsProcessed, errors };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.core.brief('error', 'wiki', `Rebuild failed: ${error}`);
      return { success: false, documentsProcessed: 0, errors: [error] };
    }
  }

  /**
   * Format date as YYYY-MM-DD
   */
  private formatDate(date: Date): string {
    return date.toISOString().split('T')[0];
  }

  // ============================================================
  // Domain Management
  // ============================================================

  /**
   * Load domains from domains.json
   */
  private loadDomains(): WikiDomain[] {
    ensureDirs();
    const domainsFile = getWikiDomainsFile();

    if (!fs.existsSync(domainsFile)) {
      return [];
    }

    try {
      const content = fs.readFileSync(domainsFile, 'utf-8');
      return JSON.parse(content) as WikiDomain[];
    } catch {
      return [];
    }
  }

  /**
   * Save domains to domains.json
   */
  private saveDomains(domains: WikiDomain[]): void {
    ensureDirs();
    const domainsFile = getWikiDomainsFile();
    fs.writeFileSync(domainsFile, JSON.stringify(domains, null, 2), 'utf-8');
  }

  /**
   * List all registered domains
   */
  async listDomains(): Promise<WikiDomain[]> {
    return this.loadDomains();
  }

  /**
   * Get a specific domain by name
   */
  async getDomain(name: string): Promise<WikiDomain | undefined> {
    const domains = this.loadDomains();
    return domains.find(d => d.domain_name === name);
  }

  /**
   * Register a new domain (if it doesn't exist)
   */
  async registerDomain(name: string, description?: string): Promise<void> {
    const domains = this.loadDomains();
    const existing = domains.find(d => d.domain_name === name);

    if (existing) {
      return; // Domain already exists
    }

    // Add new domain
    domains.push({
      domain_name: name,
      description: description || '',
      created_at: new Date().toISOString(),
      project_folder: process.cwd(),
    });

    this.saveDomains(domains);
    this.core.brief('info', 'wiki', `Registered domain: ${name}`);
  }
}