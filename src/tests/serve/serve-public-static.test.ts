/**
 * serve-public-static.test.ts - public-dir static serving after the HMR-hook fix.
 *
 * BACKGROUND (the bug this guards against):
 *
 * The Web UI serves `<cwd>/.mycc/public/` at the root path `/` (see the built-in
 * skill `serve-public-dir`). Two regressions chased each other across a couple
 * of fixes:
 *
 *   1. The "flicker": every `.html` the agent dropped into `.mycc/public`
 *      triggered a Vite full-reload of the whole page. The first fix blanket-
 *      ignored the whole `.mycc` tree in Vite's watcher, which silenced the
 *      reload but ALSO froze Vite's live `publicFiles` Set — so any public file
 *      created AFTER boot 404'd until a manual restart (the "new mini-game
 *      404s" bug).
 *
 *   2. The attempted fix for the flicker re-included `.mycc/public` in the
 *      watcher and added a `hotUpdate` hook returning a placeholder module
 *      `[{}]` to suppress the reload. That placeholder has no `importers` Set,
 *      so Vite's `propagateUpdate()` crashed at `!node.importers.size` with
 *      "Cannot read properties of undefined (reading 'size')" — surfacing as a
 *      Vite error overlay ("occasionally breaks the vite server").
 *
 * THE FIX: stop routing public files through Vite at all. Vite is configured
 * with `publicDir: false` and `.mycc` stays ignored by its watcher; the public
 * dir is served by OUR OWN `express.static` middleware registered before
 * `viteServer.middlewares`. A file created after boot is therefore served
 * immediately (no 404), and a public `.html` never enters Vite's HMR pipeline,
 * so neither the flicker nor the crash can occur.
 *
 * These tests boot a REAL ServeHub on an ephemeral port and exercise the two
 * behaviors the fix must guarantee. They deliberately write the public file
 * AFTER `start()` — that is the whole point (the pre-boot snapshot is what
 * regressed).
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { ServeHub } from '../../serve/serve-hub.js';

/** A free ephemeral port, reserved-then-released so start() can bind it. */
async function freePort(): Promise<number> {
  const srv = net.createServer();
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', () => resolve()));
  const port = (srv.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => srv.close(() => resolve()));
  return port;
}

async function fetchStatus(url: string): Promise<number> {
  const res = await fetch(url);
  // Drain the body so the socket is released (undici keep-alive).
  await res.arrayBuffer();
  return res.status;
}

describe('ServeHub public-dir static serving (post-boot files, no HMR crash)', () => {
  let hub: ServeHub | null = null;

  afterEach(async () => {
    if (hub) {
      await hub.stop(true).catch(() => { /* ignore */ });
      hub = null;
    }
  });

  it('serves a public file created AFTER start() at the root path', async () => {
    const port = await freePort();
    hub = new ServeHub();
    await hub.start(port, '127.0.0.1');

    // Write AFTER the server is up — the exact case the old blanket-ignore
    // fix froze (Vite's boot-time publicFiles snapshot → 404 forever).
    const publicDir = path.join(process.cwd(), '.mycc', 'public');
    fs.mkdirSync(publicDir, { recursive: true });
    const name = `serve-public-static-${process.pid}-${Date.now()}.txt`;
    const file = path.join(publicDir, name);
    fs.writeFileSync(file, 'hello-from-public-dir');

    try {
      const res = await fetch(`http://127.0.0.1:${port}/${name}`);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('hello-from-public-dir');
    } finally {
      fs.rmSync(file, { force: true });
    }
  });

  it('serves a public .html dropped after boot and does not crash the server', async () => {
    const port = await freePort();
    hub = new ServeHub();
    await hub.start(port, '127.0.0.1');

    const publicDir = path.join(process.cwd(), '.mycc', 'public');
    fs.mkdirSync(publicDir, { recursive: true });
    const name = `serve-public-static-${process.pid}-${Date.now()}.html`;
    const file = path.join(publicDir, name);
    fs.writeFileSync(file, '<!doctype html><title>mini-game</title><p>ok</p>');

    try {
      // A public .html is served as-is (no Vite transform, no HMR entry).
      const res = await fetch(`http://127.0.0.1:${port}/${name}`);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('mini-game');

      // Give Vite's watcher HMR dispatch a beat to run (in the buggy build the
      // crash landed asynchronously in onFileAddUnlink → handleHMRUpdate). With
      // the .mycc tree ignored, the public .html never reaches HMR; the server
      // must remain healthy rather than dying on the overlay error.
      await new Promise((r) => setTimeout(r, 500));
      expect(hub!.isRunning()).toBe(true);
      expect(await fetchStatus(`http://127.0.0.1:${port}/health`)).toBe(200);
    } finally {
      fs.rmSync(file, { force: true });
    }
  });

  it('refuses path traversal out of the public dir (no file outside root is served)', async () => {
    const port = await freePort();
    hub = new ServeHub();
    await hub.start(port, '127.0.0.1');

    // A sentinel OUTSIDE the public dir (in .mycc/, a sibling of public/).
    const secret = path.join(process.cwd(), '.mycc', `serve-public-secret-${process.pid}-${Date.now()}.txt`);
    fs.writeFileSync(secret, 'TOP-SECRET');

    try {
      // Classic traversal attempts; serve-static/send must reject them (403)
      // or fall through to Vite (404). Either way the body must NOT leak.
      for (const target of [
        `http://127.0.0.1:${port}/../${path.basename(secret)}`,
        `http://127.0.0.1:${port}/%2e%2e/${path.basename(secret)}`,
        `http://127.0.0.1:${port}/..%2f${path.basename(secret)}`,
        `http://127.0.0.1:${port}/subdir/../../${path.basename(secret)}`,
      ]) {
        const res = await fetch(target);
        const body = await res.text();
        expect(res.status).not.toBe(200);
        expect(body).not.toContain('TOP-SECRET');
      }
    } finally {
      fs.rmSync(secret, { force: true });
    }
  });

  it('does not serve dotfiles from the public dir (dotfiles: deny)', async () => {
    const port = await freePort();
    hub = new ServeHub();
    await hub.start(port, '127.0.0.1');

    const publicDir = path.join(process.cwd(), '.mycc', 'public');
    fs.mkdirSync(publicDir, { recursive: true });
    const name = `.serve-public-dotfile-${process.pid}-${Date.now()}`;
    const file = path.join(publicDir, name);
    fs.writeFileSync(file, 'DOTFILE-SECRET');

    try {
      const res = await fetch(`http://127.0.0.1:${port}/${name}`);
      const body = await res.text();
      expect(res.status).not.toBe(200);
      expect(body).not.toContain('DOTFILE-SECRET');
    } finally {
      fs.rmSync(file, { force: true });
    }
  });
});
