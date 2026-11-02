/**
 * Two-engine convergence test — the deterministic counterpart of the live
 * two-daemon simulation. Two engines with separate work dirs and sids are
 * cross-wired through in-memory ports; gossip → fetch → apply must converge,
 * and a local delete must tombstone on both sides.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { FilesEngine, type PeerPort, type EngineHooks } from '../engine.js';
import type { SyncMessage, SyncDataMessage } from '../protocol.js';

type AnyMsg = SyncMessage | SyncDataMessage;

interface Node { engine: FilesEngine; inbox: Array<{ peer: string; msg: AnyMsg }>; }

function makeNode(dir: string, sid: string, peers: () => string[]): Node {
  const inbox: Node['inbox'] = [];
  const node = {} as Node;
  const port: PeerPort = {
    async sendMessage(peer, msg) { inbox.push({ peer, msg }); },
    async sendData(peer, data) { inbox.push({ peer, msg: data }); },
    async partners() { return peers(); },
  };
  const hooks: EngineHooks = {
    appendLocalMail: () => {}, verbose: () => {}, getSelfSid: () => sid,
  };
  node.engine = new FilesEngine({
    share: 'sh', rootDir: path.join(dir, 'share'), stateDir: path.join(dir, 'state'), hooks, port,
  });
  node.inbox = inbox;
  return node;
}

/** Let the engine's async partner refresh + sends settle. */
const settle = () => new Promise((r) => setTimeout(r, 0));

/** Deliver every queued message to the other side until quiet. */
function pump(a: Node, b: Node, aSid: string, bSid: string, rounds = 12): void {
  for (let i = 0; i < rounds; i++) {
    const moved: Array<() => void> = [];
    for (const { msg } of a.inbox.splice(0)) moved.push(() => deliver(b, aSid, msg));
    for (const { msg } of b.inbox.splice(0)) moved.push(() => deliver(a, bSid, msg));
    if (!moved.length) return;
    for (const fn of moved) fn();
  }
}

function deliver(target: Node, from: string, msg: AnyMsg): void {
  if (msg.kind === 'piece') target.engine.onData(from, msg);
  else target.engine.onMessage(from, msg);
}

let dirA: string; let dirB: string;
beforeEach(() => {
  dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'fs2-a-'));
  dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'fs2-b-'));
});
afterEach(() => {
  fs.rmSync(dirA, { recursive: true, force: true });
  fs.rmSync(dirB, { recursive: true, force: true });
});

const A_SID = 'AAAA1111';
const B_SID = 'BBBB2222';

describe('two-engine convergence', () => {
  it('a file created on A reaches B through manifest → fetch → apply', async () => {
    const a = makeNode(dirA, A_SID, () => [B_SID]);
    const b = makeNode(dirB, B_SID, () => [A_SID]);
    a.engine.scan();
    b.engine.scan();
    fs.writeFileSync(path.join(a.engine.root, 'hello.txt'), 'hello-from-A');
    a.engine.scan();
    await settle();               // partner snapshot
    a.engine.gossip();
    await settle();               // sends queued
    pump(a, b, A_SID, B_SID);
    expect(fs.readFileSync(path.join(b.engine.root, 'hello.txt'), 'utf8')).toBe('hello-from-A');
  });

  it('both directions converge in one exchange', async () => {
    const a = makeNode(dirA, A_SID, () => [B_SID]);
    const b = makeNode(dirB, B_SID, () => [A_SID]);
    fs.writeFileSync(path.join(a.engine.root, 'a.txt'), 'alpha');
    fs.writeFileSync(path.join(b.engine.root, 'b.txt'), 'beta');
    a.engine.scan(); b.engine.scan();
    await settle();
    a.engine.gossip(); b.engine.gossip();
    await settle();
    pump(a, b, A_SID, B_SID);
    expect(fs.readFileSync(path.join(b.engine.root, 'a.txt'), 'utf8')).toBe('alpha');
    expect(fs.readFileSync(path.join(a.engine.root, 'b.txt'), 'utf8')).toBe('beta');
  });

  it('a local delete tombstones on both sides and does not resurrect', async () => {
    const a = makeNode(dirA, A_SID, () => [B_SID]);
    const b = makeNode(dirB, B_SID, () => [A_SID]);
    fs.writeFileSync(path.join(a.engine.root, 'x.txt'), 'x');
    a.engine.scan();
    await settle();
    a.engine.gossip();
    await settle();
    pump(a, b, A_SID, B_SID);
    expect(fs.existsSync(path.join(b.engine.root, 'x.txt'))).toBe(true);
    // Delete on A, exchange again.
    fs.unlinkSync(path.join(a.engine.root, 'x.txt'));
    a.engine.scan();
    await settle();
    a.engine.gossip();
    await settle();
    pump(a, b, A_SID, B_SID);
    expect(fs.existsSync(path.join(b.engine.root, 'x.txt'))).toBe(false);
    // A few more rounds must not bring it back.
    b.engine.gossip(); a.engine.gossip();
    await settle();
    pump(a, b, A_SID, B_SID);
    expect(fs.existsSync(path.join(a.engine.root, 'x.txt'))).toBe(false);
    expect(fs.existsSync(path.join(b.engine.root, 'x.txt'))).toBe(false);
  });
});
