/**
 * path.test.ts - Tests for resolvePath utility
 */

import { describe, it, expect } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import { resolvePath, isInsideWorkspace } from '../../utils/path.js';

describe('resolvePath', () => {
  it('should resolve relative paths against workdir', () => {
    const workdir = '/home/user/project';
    const result = resolvePath('src/tools/read.ts', workdir);
    expect(result).toBe(path.resolve(workdir, 'src/tools/read.ts'));
  });

  it('should handle absolute paths unchanged', () => {
    const workdir = '/home/user/project';
    const absPath = '/tmp/some-file.txt';
    const result = resolvePath(absPath, workdir);
    expect(result).toBe(path.resolve(absPath));
  });

  it('should expand ~ to home directory', () => {
    const workdir = '/home/user/project';
    const result = resolvePath('~/skills/SKILL.md', workdir);
    const home = os.homedir();
    expect(result).toBe(path.join(home, 'skills/SKILL.md'));
  });

  it('should expand ~/ to home directory', () => {
    const workdir = '/home/user/project';
    const result = resolvePath('~/.mycc-store/skills', workdir);
    const home = os.homedir();
    expect(result).toBe(path.join(home, '.mycc-store/skills'));
  });

  it('should resolve . to workdir', () => {
    const workdir = '/home/user/project';
    const result = resolvePath('.', workdir);
    expect(result).toBe(path.resolve(workdir, '.'));
  });

  it('should resolve .. to parent of workdir', () => {
    const workdir = '/home/user/project';
    const result = resolvePath('..', workdir);
    expect(result).toBe(path.resolve(workdir, '..'));
  });

  it('should throw a clear error when path is undefined', () => {
    const workdir = '/home/user/project';
    expect(() => resolvePath(undefined as unknown as string, workdir)).toThrow(
      /path argument is required/
    );
  });

  it('should throw a clear error when path is a non-string value', () => {
    const workdir = '/home/user/project';
    expect(() => resolvePath(42 as unknown as string, workdir)).toThrow(
      /path argument is required/
    );
    expect(() => resolvePath(null as unknown as string, workdir)).toThrow(
      /path argument is required/
    );
  });

  it('should throw a clear error when path is an empty string', () => {
    const workdir = '/home/user/project';
    expect(() => resolvePath('', workdir)).toThrow(/path argument is required/);
  });
});

describe('isInsideWorkspace', () => {
  it('returns true for a path inside the workdir', () => {
    const workdir = '/home/user/project';
    expect(isInsideWorkspace(path.resolve(workdir, 'src', 'read.ts'), workdir)).toBe(true);
  });

  it('returns true when the resolved path IS the workdir', () => {
    const workdir = '/home/user/project';
    expect(isInsideWorkspace(workdir, workdir)).toBe(true);
  });

  it('returns false for the parent of the workdir', () => {
    const workdir = '/home/user/project';
    expect(isInsideWorkspace(path.resolve(workdir, '..'), workdir)).toBe(false);
  });

  it('returns false for a sibling directory sharing a name prefix', () => {
    // The classic bare-startsWith bug: '/home/user/project-evil' wrongly
    // passed '/home/user/project'.startsWith(...) and escaped the workspace.
    const workdir = '/home/user/project';
    const sibling = '/home/user/project-evil/escape.txt';
    expect(isInsideWorkspace(sibling, workdir)).toBe(false);
  });

  it('returns false for an unrelated absolute path', () => {
    const workdir = '/home/user/project';
    expect(isInsideWorkspace('/etc/passwd', workdir)).toBe(false);
  });

  it('returns false when workdir is empty', () => {
    expect(isInsideWorkspace('/home/user/project', '')).toBe(false);
  });

  it('returns false when resolved is an ancestor of workdir', () => {
    const workdir = '/home/user/project/sub';
    expect(isInsideWorkspace('/home/user/project', workdir)).toBe(false);
  });

  it('returns true for a nested subdirectory', () => {
    const workdir = '/home/user/project';
    expect(isInsideWorkspace(path.resolve(workdir, 'src', 'deep', 'nested'), workdir)).toBe(true);
  });

  it('returns false when workdir is a prefix but resolved is a sibling (case-insensitive on Windows)', () => {
    // The classic bare-startsWith bug: '/home/user/project-evil' shares the
    // '/home/user/project' prefix but is NOT inside the workspace.
    const workdir = '/home/user/project';
    expect(isInsideWorkspace('/home/user/project-evil', workdir)).toBe(false);
  });
});
