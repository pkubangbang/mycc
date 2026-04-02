# Configuration Refactoring Plan

## Executive Summary

This document outlines a refactoring plan to extract hardcoded constants, magic numbers, and configuration values from the codebase into a centralized configuration system.

**Current State**: Configuration values are scattered across multiple files, making it difficult to maintain and customize behavior.

**Target State**: Centralized, type-safe configuration with environment variable support and sensible defaults.

---

## Identified Constants

### 1. LLM Configuration (`src/ollama.ts`)

| Constant | Current Value | Location | Priority |
|----------|---------------|----------|----------|
| `OLLAMA_HOST` | `'http://127.0.0.1:11434'` | Line 10 | High |
| `OLLAMA_API_KEY` | `undefined` | Line 11 | High |
| `MODEL` | `'glm-5:cloud'` | Line 12 | High |

**Issue**: Default model is hardcoded. Should be configurable per deployment.

### 2. Agent Loop Configuration (`src/loop/agent-loop.ts`, `src/loop/agent-utils.ts`)

| Constant | Current Value | Location | Priority |
|----------|---------------|----------|----------|
| `TOKEN_THRESHOLD` | `50000` | agent-utils.ts:12 | High |
| `nextTodoNudge` | `3` | agent-loop.ts:19 | Medium |
| Teammate await timeout | `30000` | agent-loop.ts:87 | Medium |

**Issue**: Token threshold and timeouts are hardcoded, making it difficult to tune for different models.

### 3. Database Configuration (`src/context/db.ts`)

| Constant | Current Value | Location | Priority |
|----------|---------------|----------|----------|
| `MYCC_DIR` | `'.mycc'` | Line 7 | Medium |
| `DB_PATH` | `.mycc/state.db` | Line 8 | Medium |

**Issue**: Data directory name is hardcoded.

### 4. Bash Tool Configuration (`src/tools/bash.ts`)

| Constant | Current Value | Location | Priority |
|----------|---------------|----------|----------|
| Command timeout | `120000` (2 min) | Line 17 | High |
| Max buffer | `50 * 1024 * 1024` (50MB) | Line 18 | Medium |
| Output slice | `50000` chars | Line 20 | Medium |
| Dangerous commands | `['rm -rf /', 'sudo', 'shutdown', 'reboot']` | Line 15 | High |

**Issue**: Timeouts and buffer limits are not configurable.

### 5. Team Module Configuration (`src/context/team.ts`)

| Constant | Current Value | Location | Priority |
|----------|---------------|----------|----------|
| Default await timeout | `60000` (1 min) | Line 200, 214 | Medium |
| Worker path | Dynamic `__dirname` | Line 54 | Low |

### 6. Auto-Compact Configuration (`src/loop/agent-utils.ts`)

| Constant | Current Value | Location | Priority |
|----------|---------------|----------|----------|
| Conversation slice | `80000` chars | Line 68 | High |

**Issue**: Hardcoded limit for conversation summarization.

### 7. Transcript Configuration (`src/context/transcript.ts`)

| Constant | Current Value | Location | Priority |
|----------|---------------|----------|----------|
| Transcript directory | `transcripts/` | Line 63 | Low |

### 8. System Prompts (`src/loop/agent-utils.ts`)

| Constant | Current Value | Location | Priority |
|----------|---------------|----------|----------|
| Lead prompt (no team) | Multiple strings | Lines 90-105 | Low |
| Lead prompt (with team) | Multiple strings | Lines 78-87 | Low |
| Child prompt prefix | Multiple strings | Lines 64-72 | Low |

**Issue**: Prompts are embedded in code, making iteration difficult.

### 9. Tool Scope Definitions (`src/context/loader.ts`)

| Constant | Current Value | Location | Priority |
|----------|---------------|----------|----------|
| Main-only tools | `['tm_create', 'tm_remove', 'tm_await', 'broadcast']` | Implicit | Medium |

### 10. Agent Version (`src/loop/agent-loop.ts`)

| Constant | Current Value | Location | Priority |
|----------|---------------|----------|----------|
| Version string | `'Coding Agent v1.0'` | Line 128 | Low |

---

## Recommended Configuration Structure

### Directory Structure

```
src/
├── config/
│   ├── index.ts          # Main config export
│   ├── schema.ts         # Config schema definition
│   ├── defaults.ts      # Default values
│   └── prompts.ts       # System prompts
├── ...
```

### Configuration Schema

```typescript
// src/config/schema.ts
export interface AgentConfig {
  // LLM Configuration
  llm: {
    host: string;
    model: string;
    apiKey?: string;
    tokenThreshold: number;
    conversationSlice: number;
  };

  // Agent Behavior
  agent: {
    todoNudgeInterval: number;
    version: string;
  };

  // Timeouts
  timeouts: {
    bashCommand: number;
    teammateAwait: number;
    teamAwait: number;
  };

  // Storage Paths
  storage: {
    dataDir: string;
    dbName: string;
    mailDir: string;
    toolsDir: string;
    skillsDir: string;
    transcriptsDir: string;
  };

  // Tool Configuration
  tools: {
    bashMaxBuffer: number;
    bashOutputLimit: number;
    dangerousCommands: string[];
    mainOnlyTools: string[];
  };

  // Prompts
  prompts: {
    leadWithTeam: string[];
    leadSolo: string[];
    childAgent: string[];
  };
}
```

### Default Configuration

```typescript
// src/config/defaults.ts
import type { AgentConfig } from './schema.js';

export const defaultConfig: AgentConfig = {
  llm: {
    host: process.env.OLLAMA_HOST || 'http://127.0.0.1:11434',
    model: process.env.OLLAMA_MODEL || 'glm-5:cloud',
    apiKey: process.env.OLLAMA_API_KEY,
    tokenThreshold: 50000,
    conversationSlice: 80000,
  },

  agent: {
    todoNudgeInterval: 3,
    version: '1.0.0',
  },

  timeouts: {
    bashCommand: 120000,
    teammateAwait: 60000,
    teamAwait: 60000,
  },

  storage: {
    dataDir: '.mycc',
    dbName: 'state.db',
    mailDir: 'mail',
    toolsDir: 'tools',
    skillsDir: 'skills',
    transcriptsDir: 'transcripts',
  },

  tools: {
    bashMaxBuffer: 50 * 1024 * 1024,
    bashOutputLimit: 50000,
    dangerousCommands: ['rm -rf /', 'sudo', 'shutdown', 'reboot'],
    mainOnlyTools: ['tm_create', 'tm_remove', 'tm_await', 'broadcast'],
  },

  prompts: {
    leadWithTeam: [
      'You are the lead of a coding agent team at {workDir}.',
      'You spawn teammates, create issues and collect results.',
      'Use tools to finish tasks. Use skills to access specialized knowledge.',
      'Report proactively using the brief tool.',
      'Read README.md or CLAUDE.md first if you feel lost about the context.',
      'You must ask for grant BEFORE "git commit" with no exception.',
      'Skills: {skills}',
    ],
    leadSolo: [
      'You are a coding agent at {workDir}.',
      'Use tools to finish tasks. Use skills to access specialized knowledge.',
      'Consider using issue_* to divide and conquor complex tasks, using todo_* for simple task tracking.',
      'You must ask for grant BEFORE "git commit" with no exception.',
      'Skills: {skills}',
    ],
    childAgent: [
      'You are a specialized agent working as part of a team.',
      'Use skills to access specialized knowledge.',
      'Use question tools to ask question to the user,',
      'use brief tools to report your progress,',
      'use mail_to tools to communicate with other teammates.',
      'Prefer concise and frank communication style. Act, but not explain.',
      'When you feel lost about the context, send mail to "lead".',
      '',
      '{identity}',
      '',
      'Skills: {skills}',
    ],
  },
};
```

---

## Implementation Plan

### Phase 1: Create Configuration Infrastructure (Priority: High)

1. Create `src/config/schema.ts` with type definitions
2. Create `src/config/defaults.ts` with default values
3. Create `src/config/index.ts` with config loader

**Estimated effort**: 2-3 hours

### Phase 2: Extract LLM Configuration (Priority: High)

1. Modify `src/ollama.ts` to use config
2. Update `.env.example` with all configurable options

**Estimated effort**: 1 hour

### Phase 3: Extract Timeout and Buffer Constants (Priority: High)

1. Update `src/tools/bash.ts` to use config
2. Update `src/loop/agent-loop.ts` timeouts
3. Update `src/loop/agent-utils.ts` thresholds

**Estimated effort**: 2 hours

### Phase 4: Extract Storage Paths (Priority: Medium)

1. Update `src/context/db.ts` to use config
2. Update `src/context/transcript.ts`

**Estimated effort**: 1 hour

### Phase 5: Extract System Prompts (Priority: Low)

1. Create `src/config/prompts.ts`
2. Update `src/loop/agent-utils.ts`

**Estimated effort**: 2 hours

---

## Configuration File Options

### Option A: TypeScript Config File (Recommended)

Create `mycc.config.ts` in project root:

```typescript
import { defineConfig } from 'mycc';

export default defineConfig({
  llm: {
    model: 'codellama:34b',
    tokenThreshold: 100000,
  },
  timeouts: {
    bashCommand: 300000,
  },
});
```

**Pros**: Type-safe, IDE autocomplete, can include logic
**Cons**: Requires build step for config changes

### Option B: JSON Config File

Create `mycc.config.json`:

```json
{
  "llm": {
    "model": "codellama:34b",
    "tokenThreshold": 100000
  },
  "timeouts": {
    "bashCommand": 300000
  }
}
```

**Pros**: Simple, no build step
**Cons**: No type safety, no logic

### Option C: Environment Variables Only

Expand `.env` support:

```bash
OLLAMA_HOST=http://127.0.0.1:11434
OLLAMA_MODEL=codellama:34b
MYCC_TOKEN_THRESHOLD=100000
MYCC_BASH_TIMEOUT=300000
MYCC_DATA_DIR=.mycc
```

**Pros**: Simple, follows 12-factor app
**Cons**: Limited to primitive values, namespacing issues

### Recommended: Hybrid Approach

1. **Environment variables** for deployment-specific values (host, model, API key)
2. **TypeScript config file** for behavior tuning (thresholds, prompts)
3. **Defaults** in code for everything else

---

## Migration Strategy

### Backward Compatibility

All changes should be backward compatible:

1. Keep existing environment variables working
2. Provide sensible defaults for all new config options
3. Config file is optional - defaults work out of box

### Migration Steps

1. Create config infrastructure without changing existing code
2. Add config imports to each module (no behavior change)
3. Gradually replace hardcoded values with config references
4. Add documentation for new config options

---

## Testing Checklist

- [ ] Verify environment variables override defaults
- [ ] Verify config file overrides environment variables
- [ ] Verify defaults work without config or env
- [ ] Test with various model names
- [ ] Test with custom timeout values
- [ ] Test with custom data directory
- [ ] Verify prompts still work correctly
- [ ] Test TypeScript type checking

---

## Additional Recommendations

### 1. Config Validation

Add runtime validation using a schema library (e.g., Zod):

```typescript
import { z } from 'zod';

const ConfigSchema = z.object({
  llm: z.object({
    host: z.string().url(),
    model: z.string().min(1),
    apiKey: z.string().optional(),
    tokenThreshold: z.number().positive(),
  }),
  // ...
});
```

### 2. Config Hot-Reload

For development, support config file hot-reloading similar to skills/tools.

### 3. Config Logging

Log loaded configuration at startup (sanitized) for debugging.

### 4. Config Documentation

Create `docs/configuration.md` with all options documented.

---

## Summary

This refactoring will:

1. **Improve maintainability**: All configuration in one place
2. **Enable customization**: Easy to tune for different environments
3. **Support testing**: Easy to mock config for tests
4. **Enhance documentation**: Self-documenting configuration schema

**Total estimated effort**: 8-10 hours