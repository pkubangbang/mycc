/**
 * path.test.ts - Tests for resolvePath utility
 */

import { describe, it, expect } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import { resolvePath } from '../../utils/path.js';

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
});
