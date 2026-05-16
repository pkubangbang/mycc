/**
 * path.test.ts - Tests for resolvePath utility
 */

import { describe, it, expect } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import { resolvePath } from '../../utils/path.js';

describe('resolvePath', () => {
  const workdir = '/home/user/project';

  it('should resolve relative paths against workdir', () => {
    const result = resolvePath('src/tools/read.ts', workdir);
    expect(result).toBe('/home/user/project/src/tools/read.ts');
  });

  it('should handle absolute paths unchanged', () => {
    const result = resolvePath('/tmp/some-file.txt', workdir);
    expect(result).toBe('/tmp/some-file.txt');
  });

  it('should expand ~ to home directory', () => {
    const result = resolvePath('~/skills/SKILL.md', workdir);
    const home = os.homedir();
    expect(result).toBe(path.join(home, 'skills/SKILL.md'));
  });

  it('should expand ~/ to home directory', () => {
    const result = resolvePath('~/.mycc-store/skills', workdir);
    const home = os.homedir();
    expect(result).toBe(path.join(home, '.mycc-store/skills'));
  });

  it('should resolve . to workdir', () => {
    const result = resolvePath('.', workdir);
    expect(result).toBe('/home/user/project');
  });

  it('should resolve .. to parent of workdir', () => {
    const result = resolvePath('..', workdir);
    expect(result).toBe('/home/user');
  });
});
