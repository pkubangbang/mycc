/**
 * sensitive-paths.test.ts - Tests for checkSensitivePath
 */

import { describe, it, expect } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import { checkSensitivePath } from '../../utils/sensitive-paths.js';

describe('checkSensitivePath', () => {
  it('should return null for safe paths', () => {
    expect(checkSensitivePath('/home/user/project/file.ts')).toBeNull();
    expect(checkSensitivePath('/tmp/test.txt')).toBeNull();
    expect(checkSensitivePath('/home/user/Documents/readme.md')).toBeNull();
  });

  it('should block /etc paths', () => {
    const result = checkSensitivePath('/etc/passwd');
    expect(result).not.toBeNull();
    expect(result!.reason).toContain('system configuration');
  });

  it('should block /etc subdirectories', () => {
    const result = checkSensitivePath('/etc/nginx/nginx.conf');
    expect(result).not.toBeNull();
  });

  it('should block /usr/lib', () => {
    expect(checkSensitivePath('/usr/lib/libc.so')).not.toBeNull();
  });

  it('should block /boot', () => {
    expect(checkSensitivePath('/boot/vmlinuz')).not.toBeNull();
  });

  it('should block ~/ssh directory', () => {
    const sshPath = path.join(os.homedir(), '.ssh');
    const result = checkSensitivePath(sshPath);
    expect(result).not.toBeNull();
    expect(result!.reason).toContain('SSH');
  });

  it('should block ~/ssh subdirectory', () => {
    const sshPath = path.join(os.homedir(), '.ssh', 'id_rsa');
    const result = checkSensitivePath(sshPath);
    expect(result).not.toBeNull();
  });

  it('should block ~/.gnupg', () => {
    const gnupgPath = path.join(os.homedir(), '.gnupg');
    expect(checkSensitivePath(gnupgPath)).not.toBeNull();
  });

  it('should block ~/.aws', () => {
    const awsPath = path.join(os.homedir(), '.aws');
    expect(checkSensitivePath(awsPath)).not.toBeNull();
  });

  it('should allow ~/.mycc-store (not sensitive)', () => {
    const myccPath = path.join(os.homedir(), '.mycc-store');
    expect(checkSensitivePath(myccPath)).toBeNull();
  });
});
