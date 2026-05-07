# Ollama Client Design

This document describes the architecture and implementation of the Ollama client integration within the `mycc` project.

## Overview

The Ollama client serves as the primary interface between the agent system and the Ollama LLM provider. It provides a resilient wrapper around the official `ollama` JS library, focusing on stability, error recovery, and high-performance streaming.

## Architecture

### Core Components

The integration is split into three main areas:

1.  **`src/ollama.ts` (The Wrapper)**: The central utility that initializes the client and provides robust execution patterns (retries, timeouts, and stream collection).
2.  **`src/setup/ollama-setup.ts` (Environment Discovery)**: Handles cross-platform detection of the Ollama binary and service connectivity checks.
3.  **`src/setup/ollama-health-check.ts` (Validation)**: A startup sequence that ensures the server is reachable, the model is available, and the system configuration (like `TOKEN_THRESHOLD`) is compatible with the model's context window.

### Client Initialization

The client is initialized as a singleton exported from `src/ollama.ts`:

```typescript
export const ollama = new Ollama({
  host: getOllamaHost(),
  ...(getOllamaApiKey() ? { headers: { Authorization: `Bearer ${getOllamaApiKey()}` } } : {}),
});
```

Configuration is dynamically resolved via `src/config.js` to allow flexible environment-based overrides.

## Implementation Details

### Resiliency Patterns

#### 1. Exponential Backoff with Jitter
The client implements a `retryWithBackoff` utility to handle transient network errors. It uses exponential backoff with a $\pm 25\%$ jitter to prevent "thundering herd" synchronization when multiple requests fail simultaneously.

#### 2. Two-Tier Timeout System
To prevent the agent from hanging on slow responses, the `collectStream` utility implements two distinct timeout thresholds:
- **First-Token Timeout**: Ensures the model starts responding within a reasonable window.
- **Response Timeout**: Ensures the entire stream completes within a maximum time limit.

#### 3. Stream Collection and Cancellation
The `collectStream` function is provider-agnostic (working with any `AsyncIterable`) and integrates with an `AbortSignal`. This allows the agent to immediately terminate the underlying transport connection when a user cancels a request (e.g., via Ctrl+C).

### Error Categorization
Errors are categorized to determine the recovery strategy:
- **Transient Errors**: (e.g., `ECONNRESET`, `ETIMEDOUT`) $\rightarrow$ Trigger automatic retry.
- **User-Action Errors**: (e.g., Model not found, Authentication failure) $\rightarrow$ Stop and notify user.
- **Fatal Errors**: (e.g., `StreamAbortedError` from user cancellation) $\rightarrow$ Immediate stop without retry.

## Startup & Health Sequence

Before the agent enters its main loop, the following health check is performed:

1.  **Connectivity**: Verifies the Ollama server is reachable via `/api/tags`.
2.  **Model Availability**: Uses `ollama.show()` to ensure the configured model exists.
3.  **Capabilities Probe**: A specialized "startup tool" (`start_up`) is called. The model is asked to report its actual `context_length` and provide a "Message of the Day" (MOTD).
4.  **Configuration Validation**: The system checks if `TOKEN_THRESHOLD` $\le 80\%$ of the reported context length to prevent out-of-memory or truncation issues.

## Platform Support

The system supports cross-platform binary detection:
- **Windows**: Checks `LOCALAPPDATA` and `PROGRAMFILES` for `ollama.exe`.
- **macOS/Linux**: Relies on the system `PATH` via the `which` command.
