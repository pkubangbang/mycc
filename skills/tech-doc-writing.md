---
name: tech-doc-writing
description: >
  Use when creating or updating technical documentation — API documentation,
  README files, technical guides, library documentation, or any developer-
  facing docs. Covers the full documentation process from pre-writing
  research to final verification. Pre-writing: gather information from
  official docs, web search, code examples, and live API experiments to
  verify behavior. Structure: getting started, installation, basic usage,
  data flow diagrams (showing what travels over the wire), exact request/
  response JSON structures, complete copy-paste-ready code examples, API
  reference, best practices, and troubleshooting. Key principle: show the
  wire format — users need to understand actual HTTP requests and responses.
  Documents common pitfalls: incomplete response field documentation,
  missing complete multi-step workflows (e.g., tool calling full cycle:
  define → send → receive tool_calls → execute → pass back → final answer),
  and ignoring streaming response differences (token-by-token chunks vs
  complete objects, accumulation strategies for thinking fields). Includes
  a verification checklist covering all response fields, request params,
  streaming examples, error handling, multi-turn conversations, and
  cross-referencing with official docs. Also covers PDF generation tips
  using pdfkit for Node.js. Use for writing API docs, README files,
  library guides, technical tutorials, or documenting any software
  interface.
keywords: [documentation, docs, api, writing, technical, readme, guide, library, tutorial, best-practices, reference, wire-format, response, request, streaming, tool-calling, verification, examples, pdf-generation]
---

# Technical Documentation Writing Skill

This skill captures lessons learned from creating technical documentation for APIs and libraries.

## Pre-Writing Research

### 1. Gather Information from Multiple Sources
- **Official Documentation**: Always start with official docs (e.g., docs.ollama.com, GitHub repos)
- **Web Search**: Search for "X API documentation", "X JS library guide"
- **Experiments**: Run actual API calls to verify behavior
- **Code Examples**: Look at example code in the official repository

### 2. Verify with Experiments
Before documenting any feature, test it:
```bash
# Test the actual API
curl http://localhost:11434/api/chat -d '{"model": "x", "messages": []}'
```

### 3. Identify Missing Information
- Compare what the docs say vs what experiments show
- Look for fields in responses that aren't documented
- Check for edge cases (streaming, errors, special parameters)

## Documentation Structure

### Essential Sections for API Documentation

1. **Getting Started** - Quick setup and prerequisites
2. **Installation** - Package manager commands
3. **Basic Usage** - Minimal working example
4. **Data Flow** - What goes where (critical for understanding)
5. **Request/Response Structures** - Exact JSON formats
6. **Complete Code Examples** - Copy-paste ready
7. **API Reference** - Method-by-method details
8. **Best Practices** - Production tips
9. **Troubleshooting** - Common issues

### Key Principle: Show the Wire Format

Users need to understand what actually travels over the network:
- Request body JSON
- Response body JSON
- Streaming chunk formats
- Error response formats

Example structure:
```
Your Code:
  const response = await ollama.chat({...})

HTTP Request Sent:
  POST http://localhost:11434/api/chat
  Content-Type: application/json
  {"model": "llama3.2", "messages": [...]}

HTTP Response Received:
  {"model": "llama3.2", "message": {...}, "done": true}
```

## Common Pitfalls

### 1. Incomplete Response Documentation

**WRONG:**
```json
{
  "message": {
    "content": "Hello",
    "tool_calls": [...]
  }
}
```

**CORRECT:**
```json
{
  "model": "llama3.2",
  "created_at": "2024-01-15T10:30:00Z",
  "message": {
    "role": "assistant",
    "content": "Hello",
    "thinking": "...",
    "tool_calls": [{
      "id": "call_x",
      "function": {
        "index": 0,
        "name": "get_weather",
        "arguments": {"city": "Tokyo"}
      }
    }]
  },
  "done": true,
  "done_reason": "stop",
  "total_duration": 1234567890,
  "eval_count": 8
}
```

### 2. Missing Complete Workflows

For complex features like tool calling, show the FULL cycle:
1. Define tools
2. Send request
3. Receive tool_calls
4. Execute tool locally
5. Pass result back with correct format
6. Receive final answer

### 3. Ignoring Streaming Differences

Streaming responses often have different structures:
- Token-by-token chunks vs complete objects
- Accumulation strategy for fields like `thinking`
- How `tool_calls` arrive (often as single chunk, not streamed)

## Verification Checklist

Before finalizing documentation:

- [ ] All response fields documented with types
- [ ] All request parameters documented
- [ ] Complete examples for each endpoint/method
- [ ] Streaming examples included
- [ ] Error handling examples
- [ ] Multi-turn conversation examples (for chat APIs)
- [ ] Tool calling complete cycle (if applicable)
- [ ] Thinking model examples (if applicable)
- [ ] Verified with actual API calls
- [ ] Compared against official documentation
- [ ] Checked for undocumented fields in experiments

## PDF Generation Tips

When generating PDFs:

1. **Use pdfkit** for Node.js PDF generation
2. **Code blocks**: Use monospace font with background color
3. **Structure**: Clear sections with visual hierarchy
4. **Page breaks**: Check for content overflow
5. **File size**: Keep images minimal; code is text-heavy

Example pdfkit setup:
```javascript
import PDFDocument from 'pdfkit';

const doc = new PDFDocument({
  size: 'Letter',
  margins: { top: 50, bottom: 50, left: 60, right: 60 }
});

doc.fontSize(18).fillColor('#1e293b').text('Section Title');
doc.fontSize(11).fillColor('#333333').text('Content...');
```

## Lessons from This Project

1. **Tool calling requires documenting:**
   - `id` field in tool_calls
   - `index` field for parallel calls
   - `role: "tool"` message format with `tool_name`
   - Complete cycle (not just initial call)

2. **Thinking models require documenting:**
   - `think` parameter to enable
   - `message.thinking` field in response
   - Streaming accumulation strategy

3. **Always include:**
   - `done_reason` field (stop, load, unload)
   - `load_duration` in timing
   - `created_at` timestamp

4. **Experimentation revealed:**
   - Streaming sends thinking first, then content
   - Tool calls arrive as complete objects (not token-by-token)
   - `id` field is auto-generated by the model