# Ollama Dependencies (HARD vs SOFT)

mycc's relationship with Ollama is **not uniform** across features. Some
features are architecturally hard-wired to Ollama with no fallback; others
have non-Ollama alternatives or are only needed conditionally. Knowing
which is which matters when choosing a deployment (local-only vs
DeepSeek-only vs cloud-Ollama) or when debugging "why does the README say I
still need Ollama even with DeepSeek?".

## HARD — architecturally enforced, no fallback

| Feature | Why it's hard | Evidence |
|---------|---------------|----------|
| **Embedding (wiki/RAG, skill matching)** | Both embedding backends construct the Ollama client with **only** `host` — no `Authorization` header. `OLLAMA_API_KEY` is **read but never passed** to the embedding client, so cloud embedding via an API key does NOT work. The chat client, by contrast, DOES inject the key (see SOFT row). Embedding therefore requires a reachable Ollama server that does not require auth — in practice a **local** Ollama. | `src/engine/rag-nomic.ts:11-13`: `new Ollama({ host: getOllamaHost() })` <br> `src/engine/rag-embeddinggemma.ts:14-16`: `new Ollama({ host: getOllamaHost() })` <br> Compare chat client `src/engine/ollama.ts:36-42`: `new Ollama({ host, ...(OLLAMA_API_KEY ? { headers: { Authorization: \`Bearer ${OLLAMA_API_KEY}\` } } : {}) })` <br> Accessors `src/config.ts:385` (`getOllamaHost`), `:392` (`getOllamaApiKey`) |

**Implication:** Even when `OLLAMA_HOST` points to a cloud URL and
`OLLAMA_API_KEY` is set, the embedding requests leave without an
`Authorization` header and are rejected by Ollama Cloud. The README's "an
embedding model via Ollama is still needed" (even for DeepSeek users) is
architecturally enforced: wiki/RAG and skill semantic-matching require a
local (non-auth) Ollama embedding endpoint. Supporting cloud embedding
would be a small fix — pass the same conditional `headers` object in both
RAG files that the chat client already uses.

## SOFT — has a non-Ollama alternative, or only needed conditionally

| Feature | Alternative / Condition | Evidence / Notes |
|---------|-------------------------|-------------------|
| **Chat / LLM** | **DeepSeek** can replace Ollama entirely for chat (`DEEPSEEK_API_KEY` / `DEEPSEEK_MODEL` / `API_PROVIDER=deepseek`). When Ollama is the chat provider, `OLLAMA_API_KEY` IS honored (cloud-compatible). | `src/engine/ollama.ts:36-42` injects `Authorization: Bearer` when `OLLAMA_API_KEY` is set. DeepSeek path is a separate provider. |
| **Vision (`read_picture` / `screen`)** | Only needed when those tools are actually used. Uses `OLLAMA_VISION_MODEL`. If unset, vision features are disabled with a warning (not a crash). Not available under DeepSeek. | Health check in `src/engine/ollama.ts` emits a warning when `OLLAMA_VISION_MODEL` is unset. |
| **Web search (`web_search` / `web_fetch`)** | Built-in mycc tools, independent of Ollama for their core plumbing — but routed through the Ollama provider's `webSearch`/`webFetch` helpers and gated behind cloud features. Not available under DeepSeek. | `src/engine/ollama.ts` `webSearch`/`webFetch`. |

## Rule of thumb

A DeepSeek-only deployment still needs a **local Ollama** for embeddings
(HARD). A pure local-Ollama deployment needs nothing else. A
cloud-Ollama deployment works for chat (key is honored) but NOT for
embedding (key is dropped on the embedding path) — so it still needs a
local embedding server.

## See also

- `configuration.md` — the env vars that control these dependencies.
- `launching-and-locating.md` — how to launch mycc with different providers.
- SKILL.md — the brief HARD vs SOFT summary.