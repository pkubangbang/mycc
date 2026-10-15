# Flappy Bird — demo for the `serve-public-dir` skill

This folder is the bundled **demo** for the [`serve-public-dir`](../../SKILL.md)
skill. It is a **tracked source artifact** that lives with the skill — it is
*not* served from here. To serve it, copy it into `.mycc/public/flappy/` (see
"Setting up the demo" below).

## Setting up the demo

The public dir is `.mycc/public/`, served at `/`. Copy the demo into it, then
open the URL:

```powershell
# from the project root
New-Item -ItemType Directory -Force .mycc/public/flappy | Out-Null
Copy-Item skills/serve-public-dir/demo/flappy/* .mycc/public/flappy/ -Force
```

Then the game is reachable in the WebUI at:

```
http://localhost:<port>/flappy/index.html
```

and you can point the user at it in a reply with `[/flappy/index.html](/flappy/index.html)`.

**Note:** a bare `/flappy/` request 404s — the static server does not
auto-resolve directory indexes, so always reference the explicit
`index.html` path. Subfolders are mirrored into the URL, which is why
`flappy/index.html` lives at `/flappy/index.html`.

`.mycc/public/` is git-ignored by default (it is a local publishing surface),
so the served copy is disposable — this tracked `demo/flappy/` folder is the
source of truth you re-copy whenever you want to serve it.

## Files

| File | Role |
|------|------|
| `index.html` | The game — a single self-contained HTML/canvas file (no external assets, no build). |
| `autopilot-ml.cjs` | Trainer for the **neural-net** pilot (key **M**). Evolutionary search over the exact game physics. |
| `autopilot-lin.cjs` | Trainer for the **linear-perceptron** pilot (key **L**). Population-based hill-climbing. |
| `train-net.json` | Trained NN weights (`ML_NET_JSON` embedded inline in `index.html`). |
| `lin-net.json` | Trained linear-pilot weights (`LIN_W` embedded inline in `index.html`). |
| `flappy-runtime-test.cjs` | Headless runtime test: loads the real inline script under a DOM/canvas stub and asserts the autopilots fly. |

The `*.cjs` extension is required because the repo's `package.json` is an ES
module (`"type": "module"`), so plain `.js` would be ESM and `require()` would
fail.

## Controls

- **Space / click** — flap.
- **M** — neural-net ML autopilot (green **matrix** helmet).
- **L** — linear-ML autopilot (red-**flag** helmet).
- **T** — classic heuristic autopilot (blue **radio** helmet).
- At most one autopilot (and thus one helmet) is active at a time.

## Running the test

```powershell
node skills/serve-public-dir/demo/flappy/flappy-runtime-test.cjs
```
