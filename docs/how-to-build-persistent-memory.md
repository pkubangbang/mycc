# Build persistent memory using the Vector store

Vector store is basically a key-value database, with the key as "embedding vector" and the value as the document.

The special ability of the vector store is that it can calculate `cosine similarity` to measure the distance between
two vectors. So if given many documents and already embedded (i.e. calculated the vector and store the key-value-pair
inside the vector store), you can use a query to retrieve near-best results.

To find the results, the engine first use the same algorithm to calculate the embedding vector of the query, then
search through the vector store to find the "close enough" vectors, then use some other tools to re-rank the 
candidates to return the result. The result together with the prompt will build up knowledge for llm.
**This is the technique called "RAG", retrieval-augmented-generation.**

Actually, is it possible for the llm to populate the vector store during the tool call -- just provide with
a `wiki_put` tool and when in need, the llm will use it to store important information.
 
## wiki_put and wiki_prepare
An important point to notice is that, although the core process is simple:

```
wiki_put call
-> calculate embedding vector 
   -> upsert into the vector store
```

we cannot let llm call this process directly, because this is too free-form and will soon fill the vector store
with garbage; a more practical way is to put-man-in-the-loop, to ask for grant before embedding:

```
wiki_put call
-> ask the user
   -> calculate embedding vector
      -> upsert into the vector store
```

but the above is also not ideal, in that the user will be bothered with duplicated/similar requests, because
llm does not effectively remember what knowledge has been embedded. So before asking the user, there must be
a validation step:

```
wiki_put call
-> if not "valuable", reject the request
-> else ask the user
   -> calculate embedding vector
      -> upsert into the vector store
```

So how to define "valuable"?
- The new document should not be duplicate of the existed.
- The new document is well formatted and has just enough context.
- The new document describes a rule or fact instead of an opinion

All the above can be done by llm itself. Then the challenge is that, to use llm
to evaluate the meaning, you must use the chat history;
**the chat history is slow to process**, so we cannot do it in sync mode, but must treat
it as a bg task that will show the result inside mailbox. In this manner, the `wiki_put`
tool call does not finish in one step, but will rely on the routine (the agent loop) to
proceed with the "ask the user" step. That's not a smooth experience.

To cope with this situation, we split the tool call into two: `wiki_prepare` + `wiki_put`:

- wiki_prepare will evaluate the document, and either permit it with a hash-of-embedding
(to make it friendly for the llm to refer to), or reject it with reason

- wiki_put will receive the hash-of-embedding + the document as the input, and perform
the embedding again to validate the request, then ask the user for grant to upsert into 
the vector store.

## document structure

The document should have 4 fields: domain, title, content, and references.

The domain is a "tag" to filter down the knowledge; The title and the content are what to
use to calculate the embedding vector; the references provide links to the sources or other
supplimental information that the llm can follow.

## wiki_get

The `wiki_get` tool retrieves relevant documents from the vector store based on a query.

```
wiki_get call
-> calculate embedding vector of the query
   -> search vector store using cosine similarity
      -> re-rank candidates
         -> return top-k results with full documents
```

The key parameters are:
- **query**: The search query text
- **domain** (optional): Filter results to a specific domain
- **top_k** (optional): Number of results to return (default: 5)

## maintanance

The vector store is maintained via write-ahead logs (WAL). Each day has its own WAL file,
stored in `~/.mycc-store/wiki/logs/` with the naming convention `YYYY-MM-DD.wal`.

### WAL Format

Every `wiki_put` operation appends an entry to today's WAL:

```json
{
  "timestamp": "2024-01-15T10:30:00Z",
  "hash": "abc123...",
  "document": {
    "domain": "project",
    "title": "...",
    "content": "...",
    "references": [...]
  },
  "approved": true
}
```

### `/wiki` Command

The `/wiki` slash command manages the WAL files:

- **`/wiki`**: Show today's WAL file
- **`/wiki edit`**: Open today's WAL file in an editor for manual modification
- **`/wiki edit <date>`**: Open the WAL file for a specific date (e.g., `/wiki edit 2024-01-15`)
- **`/wiki rebuild`**: Rebuild the entire vector store from all WAL files

### WAL Edit Format

`/wiki edit` converts WAL entries from JSON to a human-friendly ASCII wiki format for editing.
**The actual log files remain stored in JSON** - the edit format is only for display and editing convenience.

```
# hash-goes-here
!persistent
!approved
[created_at]xxxxxxxxxxx
[domain]xxxx
[title]yyyyyyyy
[content]
content goes here
[references]
- xxxxxxxxxxx
- xxxxxxxxxxx
```

The `!persistent` and `!approved` are flags that can be toggled. Multiple entries in the same day's WAL
are separated by blank lines. When saving, the ASCII format is converted back to JSON.

### Rebuild Process

The rebuild reads all WAL files in chronological order and replays the operations:

```
/wiki rebuild
-> read all *.wal files from ~/.mycc-store/wiki/logs/
   -> sort by filename (date order)
      -> for each entry, re-calculate embedding and upsert
```

This enables:
- **Manual editing**: Fix mistakes by editing WAL files directly
- **Disaster recovery**: Rebuild the store from logs after data loss
- **Migration**: Recreate the store with a different embedding algorithm
- **Audit**: Review the complete history of knowledge changes

No automatic compaction is performed. Future versions may introduce a clever way to compact WALs.

