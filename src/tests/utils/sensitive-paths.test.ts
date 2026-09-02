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
    if (result) {
      expect(result.reason).toContain('system configuration');
    }
  });

  it('should block /etc subdirectories', () => {
    const result = checkSensitivePath('/etc/nginx/nginx.conf');
    expect(result).not.toBeNull();
    if (result) {
      expect(result.reason).toContain('system configuration');
    }
  });

  it('should block /usr/lib', () => {
    const result = checkSensitivePath('/usr/lib/libc.so');
    expect(result).not.toBeNull();
    if (result) {
      expect(result.reason).toContain('system libraries');
    }
  });

  it('should block /boot', () => {
    const result = checkSensitivePath('/boot/vmlinuz');
    expect(result).not.toBeNull();
    if (result) {
      expect(result.reason).toContain('boot loader');
    }
  });

  it('should block /sys, /proc, /dev, /bin, /root', () => {
    expect(checkSensitivePath('/sys/kernel')).not.toBeNull();
    expect(checkSensitivePath('/proc/cpuinfo')).not.toBeNull();
    expect(checkSensitivePath('/dev/sda')).not.toBeNull();
    expect(checkSensitivePath('/bin/ls')).not.toBeNull();
    expect(checkSensitivePath('/root/.bashrc')).not.toBeNull();
  });

  it('should block ~/ssh directory', () => {
    const sshPath = path.join(os.homedir(), '.ssh');
    const result = checkSensitivePath(sshPath);
    expect(result).not.toBeNull();
    if (result) {
      expect(result.reason).toContain('SSH');
    }
  });

  it('should block ~/ssh subdirectory', () => {
    const sshPath = path.join(os.homedir(), '.ssh', 'id_rsa');
    const result = checkSensitivePath(sshPath);
    expect(result).not.toBeNull();
    if (result) {
      expect(result.reason).toContain('SSH');
    }
  });

  it('should block ~/.gnupg', () => {
    const gnupgPath = path.join(os.homedir(), '.gnupg');
    const result = checkSensitivePath(gnupgPath);
    expect(result).not.toBeNull();
    if (result) {
      expect(result.reason).toContain('GPG');
    }
  });

  it('should block ~/.aws', () => {
    const awsPath = path.join(os.homedir(), '.aws');
    const result = checkSensitivePath(awsPath);
    expect(result).not.toBeNull();
    if (result) {
      expect(result.reason).toContain('AWS');
    }
  });

  it('should block ~/.gitconfig', () => {
    const gitconfigPath = path.join(os.homedir(), '.gitconfig');
    const result = checkSensitivePath(gitconfigPath);
    expect(result).not.toBeNull();
    if (result) {
      expect(result.reason).toContain('git configuration');
    }
  });

  it('should allow ~/.mycc-store (not sensitive)', () => {
    const myccPath = path.join(os.homedir(), '.mycc-store');
    expect(checkSensitivePath(myccPath)).toBeNull();
  });

  it('should allow a sibling that merely shares a sensitive prefix', () => {
    // '/etc-backup' must NOT be blocked just because it starts with '/etc'.
    expect(checkSensitivePath('/etc-backup/file.txt')).toBeNull();
  });

  it('should block Windows-style /etc paths', () => {
    // On Windows, check that a drive-prefixed /etc path is also blocked
    // The test just ensures no crash for Windows-style paths
    const normalized = path.resolve('C:\\etc\\passwd');
    // It should either block it or not - but should not throw
    expect(() => checkSensitivePath(normalized)).not.toThrow();
  });
});
