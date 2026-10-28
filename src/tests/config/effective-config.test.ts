/**
 * effective-config.test.ts — the effective configuration is attributable
 * (rows lead-012 / lead-013).
 *
 * `loadEnv()` flattens four layers (user .env → project .env → system env → CLI
 * flags) into process.env, so after boot nothing can say WHY a value is what it
 * is. `describeEffectiveConfig()` recomputes the layers and reports the winning
 * source. These tests pin the precedence order and the docs/code default
 * agreement (TOKEN_THRESHOLD used to be 100000 in code and 50000 in the README).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mycc-effcfg-'));

vi.mock('../../setup/paths.js', () => ({
  getUserConfigPath: () => process.env.__TEST_USER_CFG as string,
  getProjectConfigPath: () => process.env.__TEST_PROJ_CFG as string,
}));

import { describeEffectiveConfig, DEFAULT_TOKEN_THRESHOLD, getTokenThreshold } from '../../config.js';

describe('describeEffectiveConfig — layer provenance', () => {
  let userCfg: string;
  let projCfg: string;

  beforeEach(() => {
    userCfg = path.join(tmp, 'user.env');
    projCfg = path.join(tmp, 'proj.env');
    process.env.__TEST_USER_CFG = userCfg;
    process.env.__TEST_PROJ_CFG = projCfg;
    fs.writeFileSync(userCfg, 'OLLAMA_MODEL=from-user\nUSER_ONLY_KEY=u\n', 'utf-8');
    fs.writeFileSync(projCfg, 'OLLAMA_MODEL=from-project\n', 'utf-8');
    // The project layer wins over the user layer.
    process.env.OLLAMA_MODEL = 'from-project';
    delete process.env.TOKEN_THRESHOLD;
  });

  afterEach(() => {
    delete process.env.OLLAMA_MODEL;
    delete process.env.TOKEN_THRESHOLD;
    delete process.env.__TEST_USER_CFG;
    delete process.env.__TEST_PROJ_CFG;
  });

  it('attributes a value to the project .env when that layer supplied it', () => {
    const entry = describeEffectiveConfig(['OLLAMA_MODEL']).find((e) => e.key === 'OLLAMA_MODEL');
    expect(entry).toEqual({ key: 'OLLAMA_MODEL', value: 'from-project', source: 'project-env' });
  });

  it('attributes a value to the user .env when only that layer supplied it', () => {
    fs.writeFileSync(projCfg, '', 'utf-8');
    process.env.USER_ONLY_KEY = 'u';
    const entry = describeEffectiveConfig(['USER_ONLY_KEY']).find((e) => e.key === 'USER_ONLY_KEY');
    expect(entry?.source).toBe('user-env');
    delete process.env.USER_ONLY_KEY;
  });

  it('reports the shell environment when no .env layer matches', () => {
    process.env.OLLAMA_MODEL = 'from-shell';
    const entry = describeEffectiveConfig(['OLLAMA_MODEL']).find((e) => e.key === 'OLLAMA_MODEL');
    expect(entry).toEqual({ key: 'OLLAMA_MODEL', value: 'from-shell', source: 'env' });
  });

  it('reports the single named default for TOKEN_THRESHOLD, and the getter agrees with it', () => {
    const entry = describeEffectiveConfig(['TOKEN_THRESHOLD']).find((e) => e.key === 'TOKEN_THRESHOLD');
    expect(entry).toEqual({ key: 'TOKEN_THRESHOLD', value: DEFAULT_TOKEN_THRESHOLD, source: 'default' });
    expect(getTokenThreshold()).toBe(parseInt(DEFAULT_TOKEN_THRESHOLD, 10));
  });
});
