# @pkubangbang/filesync-manager

**Transport-agnostic local file sync engine.** One shared folder, many peers,
ordinary file operations converge — and the package knows nothing about the
network.

```
scan → chunk (FastCDC) → content-addressed piece store → manifest
     ⇄ host transport ⇄ → fetch missing pieces → atomic apply → LWW conflict
```

## Why a separate package

The engine is pure local file management: walk the folder, cut content-defined
chunks, keep a content-addressed piece store (simultaneously the resume cursor
and the dedupe cache), diff manifests, and apply verified files. Everything a
*transport* needs — sockets, framing, liveness, membership, authentication —
lives in the host application. mycc's peer wire is one such host
(`src/peer/filesync/` in the mycc repo: frame verbs, binary piece frames, and
pairwise partner discovery).

## Install

```sh
npm i @pkubangbang/filesync-manager
```

## Usage

```ts
import { FilesEngine, type PeerPort } from '@pkubangbang/filesync-manager';

const port: PeerPort = {
  // Deliver a message to ONE peer over your own transport.
  sendMessage(peer, message) { return myTransport.send(peer, message); },
  // Deliver piece bytes.
  sendData(peer, piece) { return myTransport.sendBinary(peer, piece); },
  // Which peers are currently reachable for this share (live transport).
  partners(share) { return myTransport.livePeers(share); },
};

const engine = new FilesEngine({
  share: 'photos',                       // validated: [A-Za-z0-9_-]{1,64}
  rootDir: '/srv/photos',                // the folder whose CONTENTS sync
  stateDir: '/var/lib/myapp/photos-state', // pieces/index/audit; outside rootDir
  port,                                  // async: sendMessage/sendData/partners
  hooks: {
    getSelfSid: () => myPeerId,
    appendLocalMail: (from, title, content) => notify(title, content),
    verbose: (tool, msg) => console.debug(`[${tool}] ${msg}`),
  },
});

engine.start();                      // scan + watch + periodic manifest
engine.onMessage(peer, message);     // from your transport
engine.onData(peer, pieceMessage);   // from your transport
```

The package imposes **no** filesystem layout: `rootDir` and `stateDir` are
yours. `stateDir` must be outside `rootDir` or the state would sync itself —
the constructor refuses it. (mycc maps them to
`<workDir>/.mycc/filesync/<share>/` and `<workDir>/.mycc/filesync/.sync/<share>/`.)

`PeerPort` is asynchronous — `sendMessage`/`sendData`/`partners` return
promises. The engine never reads a send result: delivery is best-effort and the
periodic manifest exchange is the retry, so a synchronous transport just
resolves immediately.

## Message vocabulary

Plain data, no wire verbs — see `src/protocol.ts`:

| Message | Direction | Meaning |
|---|---|---|
| `manifest` | both | whole-share state: files + tombstones |
| `want-list` | → peer | send me the piece list of this file |
| `piece-list` | reply | ordered piece hashes of a file |
| `want-pieces` | → peer | send me these pieces |
| `piece` | reply | one chunk's bytes (verified by sha256) |
| `deletion` | both | a path was deleted at generation *gen* |

## Guarantees & lifecycle

- **Integrity:** every piece is verified against its sha256 before storage;
  a file is verified against its `pieceListHash` and size before apply.
- **Confinement:** writes are checked against the *real* share root, so a
  symlinked (or Windows-junctioned) parent cannot redirect an apply outside it.
- **Deletes are first-class:** a delete is a tombstone with a generation, and
  it outranks an older live entry — a re-advertised file cannot resurrect a
  path that was deleted.
- **Transport drops abort in-flight transfers.** Pending fetches are pruned
  when their peer leaves `port.partners(share)`, and are bounded by
  `MAX_PENDING_FILES` / `PENDING_TTL_MS`. Resume is emergent: the piece store
  keeps what arrived, and the next manifest exchange asks only for the rest.
- **Conflicts are local knowledge.** A losing local edit is preserved as
  `<name>.conflict-<sid>-<ts>` and reported through `appendLocalMail`; the
  entry expires when the conflict copy is removed.

## Not included (by design)

Wire format, sockets, peer discovery, membership gossip, authentication,
compression, encryption, piece garbage collection, and storage quotas. The
host decides all of it.

## License

MIT
