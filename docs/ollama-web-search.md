# Ollama Web Search & Web Fetch

Documentation from https://docs.ollama.com/capabilities/web-search

## Web Search

**Method:** `client.webSearch(query)`

Search the web for information. Returns search results with titles, URLs, and content snippets.

### Example

```javascript
import { Ollama } from "ollama";

const client = new Ollama();
const results = await client.webSearch("what is ollama?");
```

### Return Value

An object with a `results` array, where each result contains:
- `title` (string): page title
- `url` (string): page URL
- `content` (string): relevant content snippet

### Response Structure

```typescript
interface WebSearchResponse {
  results: Array<{
    title: string;
    url: string;
    content: string;
  }>;
}
```

---

## Web Fetch

**Method:** `client.webFetch(url)`

Fetch and parse content from a specific URL. Returns the page title, main content, and links.

### Example

```javascript
import { Ollama } from "ollama";

const client = new Ollama();
const fetchResult = await client.webFetch("https://ollama.com");
```

### Return Value

An object containing:
- `title` (string): page title
- `content` (string): main page content
- `links` (array): links found on the page

### Response Structure

```typescript
interface WebFetchResponse {
  title: string;
  content: string;
  links: string[];
}
```

---

## Authentication

Ensure `OLLAMA_API_KEY` is set in environment variables, or pass it in the Authorization header when creating the client:

```javascript
const client = new Ollama({
  headers: { Authorization: `Bearer ${OLLAMA_API_KEY}` }
});
```

---

## Additional Resources

- Example code: [github.com/ollama/ollama-js/blob/main/examples/websearch/websearch-tools.ts](https://github.com/ollama/ollama-js/blob/main/examples/websearch/websearch-tools.ts)